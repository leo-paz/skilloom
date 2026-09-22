import { constants } from "node:fs";
import { open, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { SkillUsageEvent } from "./skill-usage.js";
import { atomicUsageJson, publicUsageEvent } from "./usage-journal.js";
import { updateUsageSessionIndex } from "./usage-session-index.js";

interface JournalCursor {
  identity: string;
  offset: number;
  errors: string[];
}
const ROW_LIMIT = 16 * 1024;
function eventFromRow(row: string): SkillUsageEvent | undefined {
  const event = JSON.parse(row);
  if (
    event.version !== 1 ||
    !/^[a-f0-9]{64}$/.test(event.id) ||
    typeof event.name !== "string" ||
    !event.name.length ||
    event.name.length > 256 ||
    !["codex", "claude", "pi"].includes(event.harness) ||
    !["read", "invoke", "load"].includes(event.evidence) ||
    !Number.isFinite(Date.parse(event.at)) ||
    (event.pathId && !/^[a-f0-9]{64}$/.test(event.pathId)) ||
    (event.sessionId && !/^[a-f0-9]{64}$/.test(event.sessionId)) ||
    (event.sessionIdentityVersion !== undefined &&
      event.sessionIdentityVersion !== 1)
  )
    return undefined;
  return publicUsageEvent(event);
}
/** Incrementally imports ALL normalized journal rows. The UI's recent-history
 * window does not constrain session totals. Durable offsets advance only after
 * the matching batch of event identities is safely written to the index.
 */
export async function indexUsageJournal(
  directory: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const progressPath = join(directory, "journal-index-cursors.json");
  let cursors: Record<string, JournalCursor> = {};
  try {
    cursors = JSON.parse(await readFile(progressPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const limitations = new Set<string>();
  for (const name of (await readdir(directory))
    .filter((entry) => /^events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(entry))
    .sort()) {
    signal?.throwIfAborted();
    const handle = await open(
      join(directory, name),
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );
    try {
      const info = await handle.stat();
      if (!info.isFile()) {
        limitations.add("journal_invalid_file");
        continue;
      }
      const identity = `${info.dev}:${info.ino}`;
      let cursor = cursors[name];
      if (
        !cursor ||
        cursor.identity !== identity ||
        !Number.isSafeInteger(cursor.offset) ||
        cursor.offset < 0 ||
        cursor.offset > info.size
      )
        cursor = { identity, offset: 0, errors: [] };
      const errors = new Set(cursor.errors);
      if (cursor.offset === info.size) {
        for (const error of errors) limitations.add(error);
        continue;
      }
      let position = cursor.offset,
        line = "",
        skipping = false,
        checkpoint = position;
      const buffer = Buffer.alloc(64 * 1024);
      const decoder = new StringDecoder("utf8");
      let batch: SkillUsageEvent[] = [];
      const flush = async () => {
        await updateUsageSessionIndex(directory, batch);
        batch = [];
        cursors[name] = { identity, offset: checkpoint, errors: [...errors] };
        await atomicUsageJson(progressPath, cursors);
      };
      while (position < info.size) {
        signal?.throwIfAborted();
        const read = await handle.read(
          buffer,
          0,
          Math.min(buffer.length, info.size - position),
          position,
        );
        if (!read.bytesRead) break;
        let start = 0;
        while (start < read.bytesRead) {
          const newline = buffer.subarray(0, read.bytesRead).indexOf(10, start);
          const end = newline < 0 ? read.bytesRead : newline;
          // Normalized rows are tiny, unlike transcripts. Oversized/corrupt rows
          // are explicit gaps; their content never grows an unbounded string.
          if (!skipping) {
            line += decoder.write(buffer.subarray(start, end));
            if (line.length > ROW_LIMIT) {
              skipping = true;
              line = "";
              errors.add("journal_invalid_record");
            }
          }
          if (newline < 0) break;
          if (!skipping && line) {
            try {
              const event = eventFromRow(line);
              if (event) batch.push(event);
              else errors.add("journal_invalid_record");
            } catch {
              errors.add("journal_invalid_record");
            }
          }
          checkpoint = position + newline + 1;
          line = "";
          skipping = false;
          start = newline + 1;
          if (batch.length >= 192) await flush();
        }
        position += read.bytesRead;
      }
      if (checkpoint < info.size) limitations.add("journal_partial_record");
      await flush();
      for (const error of errors) limitations.add(error);
    } finally {
      await handle.close();
    }
  }
  return [...limitations];
}
