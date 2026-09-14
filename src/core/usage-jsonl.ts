import type { FileHandle } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import parser, { type Token } from "stream-json/core/parser.js";

const CHUNK_BYTES = 64 * 1024;
const STRING_PREFIX = 8 * 1024;
const STRING_SUFFIX = 64;
const PROJECTED_VALUES = 32768;
// The evidence adapters never inspect transcript prose or image data. Keep only
// their wire-contract fields when a record is too large for the fast JSON path.
const FIELDS = new Set([
  "type",
  "payload",
  "message",
  "sessionId",
  "id",
  "session_id",
  "cwd",
  "timestamp",
  "parentSession",
  "parent_thread_id",
  "forked_from_id",
  "source",
  "subagent",
  "thread_source",
  "role",
  "content",
  "internal_chat_message_metadata_passthrough",
  "create_time",
  "content_item_kinds",
  "text",
  "call_id",
  "name",
  "arguments",
  "input",
  "output",
  "path",
  "file_path",
  "skill",
  "cmd",
  "command",
  "workdir",
  "tool_use_id",
  "is_error",
  "toolCallId",
  "isError",
  "exit_code",
]);

interface Frame {
  value: Record<string, unknown> | unknown[] | undefined;
  key: string;
  index: number;
}
interface Scalar {
  kind: "key" | "string" | "number";
  keep: boolean;
  field: string;
  prefix: string;
  suffix: string;
  length: number;
  nested?: Projection | undefined;
  nestedFailed?: boolean;
}

/** Token projection bounds memory independently of raw string/record length.
 * Known free-text bodies retain their exact beginning and end. JSON encoded
 * inside tool-result strings is itself streamed, preserving exit status even
 * when it follows megabytes of stdout. Oversized input/identity fields are an
 * explicit gap instead of being shortened into a different valid invocation.
 */
class Projection {
  // stream-json 3.x returns an async generator here; its TokenSource type still
  // describes the underlying synchronous tokenizer rather than the gen wrapper.
  private readonly tokenize = parser({ packValues: false }) as unknown as (
    input: string,
  ) => AsyncIterable<Token>;
  private readonly stack: Frame[] = [];
  private scalar: Scalar | undefined;
  private count = 0;
  private characters = 0;
  constructor(private readonly depth = 0) {}
  private roots = 0;
  value: unknown;
  limited = false;

  private kept(): boolean {
    const parent = this.stack.at(-1);
    return (
      !parent ||
      (parent.value !== undefined &&
        (Array.isArray(parent.value) || FIELDS.has(parent.key)))
    );
  }
  private field(): string {
    const parent = this.stack.at(-1);
    return parent && !Array.isArray(parent.value) ? parent.key : "";
  }
  private put(value: unknown): void {
    const parent = this.stack.at(-1);
    if (!parent) {
      this.value = value;
      this.roots++;
      return;
    }
    if (this.kept()) {
      if (typeof value === "string") this.characters += value.length;
      if (
        ++this.count > PROJECTED_VALUES ||
        this.characters > 4 * 1024 * 1024
      ) {
        this.limited = true;
        return;
      }
      if (Array.isArray(parent.value)) parent.value.push(value);
      else if (parent.value)
        Object.defineProperty(parent.value, parent.key, {
          value,
          configurable: true,
          enumerable: true,
          writable: true,
        });
    }
    parent.index++;
  }
  async write(input: string): Promise<void> {
    for await (const item of this.tokenize(input)) {
      // The parser is a streaming generator, not an assembler: a giant string
      // only emits bounded stringChunk tokens, never a packed stringValue.
      const token = item as Token;
      switch (token.name) {
        case "startObject":
        case "startArray": {
          if (this.stack.length >= 256) throw new Error("JSON nesting limit");
          const value =
            this.kept() && this.count < PROJECTED_VALUES
              ? token.name === "startArray"
                ? []
                : Object.create(null)
              : undefined;
          if (this.count >= PROJECTED_VALUES) this.limited = true;
          this.put(value);
          this.stack.push({ value, key: "", index: 0 });
          break;
        }
        case "endObject":
        case "endArray":
          this.stack.pop();
          break;
        case "startKey":
        case "startString":
        case "startNumber":
          this.scalar = {
            kind:
              token.name === "startKey"
                ? "key"
                : token.name === "startNumber"
                  ? "number"
                  : "string",
            keep: token.name === "startKey" || this.kept(),
            field: this.field(),
            prefix: "",
            suffix: "",
            length: 0,
          };
          break;
        case "stringChunk":
        case "numberChunk": {
          const scalar = this.scalar!;
          if (!scalar.keep) break;
          if (
            !scalar.length &&
            scalar.kind === "string" &&
            this.depth < 4 &&
            ["text", "output", "arguments"].includes(scalar.field) &&
            /^\s*\{/.test(token.value)
          )
            scalar.nested = new Projection(this.depth + 1);
          scalar.length += token.value.length;
          scalar.prefix += token.value.slice(
            0,
            Math.max(0, STRING_PREFIX - scalar.prefix.length),
          );
          scalar.suffix = (scalar.suffix + token.value).slice(-STRING_SUFFIX);
          if (scalar.nested && !scalar.nestedFailed) {
            try {
              await scalar.nested.write(token.value);
            } catch {
              scalar.nestedFailed = true;
              scalar.nested = undefined;
            }
          }
          break;
        }
        case "endKey": {
          const scalar = this.scalar!;
          this.stack.at(-1)!.key =
            scalar.length <= STRING_PREFIX ? scalar.prefix : "";
          this.scalar = undefined;
          break;
        }
        case "endString":
        case "endNumber": {
          const scalar = this.scalar!;
          if (scalar.keep) {
            let value: unknown = scalar.prefix;
            if (scalar.length > STRING_PREFIX) {
              const nested = scalar.nested?.result();
              if (nested && !scalar.nested!.limited)
                value = JSON.stringify(nested);
              else if (["text", "output", "content"].includes(scalar.field)) {
                // This cannot fabricate a header or final marker: both retained
                // sections exceed every bounded prefix/suffix adapter pattern.
                value = `${scalar.prefix}\n[body omitted]\n${scalar.suffix}`;
                // Structured output whose status could not be projected is not
                // equivalent to an ordinary unstructured prose/body string.
                if (/^\s*\{/.test(scalar.prefix)) this.limited = true;
              } else {
                this.limited = true;
                value = undefined;
              }
            }
            if (scalar.kind === "number") value = Number(value);
            this.put(value);
          } else this.put(undefined);
          this.scalar = undefined;
          break;
        }
        case "nullValue":
        case "trueValue":
        case "falseValue":
          this.put(token.value);
          break;
      }
    }
  }
  result(): Record<string, unknown> | undefined {
    return this.roots === 1 &&
      !this.stack.length &&
      !this.scalar &&
      this.value !== null &&
      typeof this.value === "object" &&
      !Array.isArray(this.value)
      ? (this.value as Record<string, unknown>)
      : undefined;
  }
}

export interface ProjectedUsageRecord {
  record?: Record<string, unknown>;
  nextOffset: number;
  bytesRead: number;
  complete: boolean;
  limitation?: "malformed_records" | "projection_limit";
}

/** Read one large JSONL record without buffering the line. Stop at its newline,
 * respecting the size captured at discovery so append-only live logs cannot
 * keep the historical scan running forever. Cancellation never commits a
 * partial record's cursor; restarting safely replays that one record.
 */
export async function readProjectedUsageRecord(
  handle: FileHandle,
  offset: number,
  size: number,
  signal?: AbortSignal,
): Promise<ProjectedUsageRecord> {
  const projection = new Projection();
  const decoder = new StringDecoder("utf8");
  const buffer = Buffer.alloc(CHUNK_BYTES);
  let position = offset,
    bytesRead = 0;
  let limitation: ProjectedUsageRecord["limitation"];
  while (position < size) {
    signal?.throwIfAborted();
    const read = await handle.read(
      buffer,
      0,
      Math.min(buffer.length, size - position),
      position,
    );
    if (!read.bytesRead) break;
    bytesRead += read.bytesRead;
    const end = buffer.subarray(0, read.bytesRead).indexOf(10);
    const consumed = end < 0 ? read.bytesRead : end + 1;
    if (!limitation) {
      try {
        await projection.write(decoder.write(buffer.subarray(0, consumed)));
      } catch {
        limitation = "malformed_records";
      }
    }
    position += consumed;
    if (end >= 0) {
      const record = projection.result();
      if (!record && !limitation) limitation = "malformed_records";
      if (projection.limited && !limitation) limitation = "projection_limit";
      return {
        ...(record && !limitation ? { record } : {}),
        nextOffset: position,
        bytesRead,
        complete: true,
        ...(limitation ? { limitation } : {}),
      };
    }
  }
  // JSONL permits a final complete value without a trailing newline. A torn
  // value remains pending, but a valid finished value is useful evidence now.
  const record = projection.result();
  if (record && !limitation)
    return {
      ...(projection.limited ? {} : { record }),
      nextOffset: position,
      bytesRead,
      complete: true,
      ...(projection.limited
        ? { limitation: "projection_limit" as const }
        : {}),
    };
  return { nextOffset: offset, bytesRead, complete: false };
}
