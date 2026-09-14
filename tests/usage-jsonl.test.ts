import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readProjectedUsageRecord } from "../src/core/usage-jsonl.js";

const homes: string[] = [];
async function read(record: string) {
  const directory = await mkdtemp(join(tmpdir(), "skilloom-jsonl-"));
  homes.push(directory);
  const path = join(directory, "record.jsonl");
  await writeFile(path, record);
  const handle = await open(path, "r");
  try {
    return await readProjectedUsageRecord(handle, 0, Buffer.byteLength(record));
  } finally {
    await handle.close();
  }
}
afterEach(async () => {
  await Promise.all(
    homes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
  );
});

describe("streamed usage record projection", () => {
  it("retains successful results after multi-megabyte bodies without retaining their prose", async () => {
    const record = {
      type: "user",
      sessionId: "session",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "call",
            content: "x".repeat(4 * 1024 * 1024),
            is_error: false,
          },
        ],
      },
    };
    const result = await read(JSON.stringify(record) + "\n");
    expect(result.complete).toBe(true);
    expect(result.limitation).toBeUndefined();
    expect(JSON.stringify(result.record).length).toBeLessThan(10000);
    expect((result.record!.message as any).content[0].is_error).toBe(false);
  });
  it("projects nested serialized command results while preserving an exit code after huge output", async () => {
    const output = JSON.stringify({
      output: "x".repeat(4 * 1024 * 1024),
      exit_code: 0,
    });
    const result = await read(
      JSON.stringify({
        type: "response_item",
        payload: { type: "function_call_output", call_id: "call", output },
      }) + "\n",
    );
    expect(result.limitation).toBeUndefined();
    expect(JSON.parse((result.record!.payload as any).output).exit_code).toBe(
      0,
    );
    expect(JSON.stringify(result.record).length).toBeLessThan(15000);
  });
  it("preserves selected skill headers and their actual closing marker with unicode across chunks", async () => {
    const header =
      "<skill>\n<name>my-skill</name>\n<path>/home/leo/.agents/skills/my-skill/SKILL.md</path>\n";
    const result = await read(
      JSON.stringify({
        payload: {
          content: [
            {
              type: "input_text",
              text: header + "🙂é".repeat(1024 * 1024) + "\n</skill>",
            },
          ],
        },
      }) + "\n",
    );
    expect(result.limitation).toBeUndefined();
    const text = (result.record!.payload as any).content[0].text;
    expect(text.startsWith(header)).toBe(true);
    expect(text.endsWith("\n</skill>")).toBe(true);
    expect(text).not.toContain("�");
    expect(text.length).toBeLessThan(10000);
  });
  it("does not turn an oversized invocation input into another valid invocation", async () => {
    const result = await read(
      JSON.stringify({
        message: {
          content: [
            {
              type: "tool_use",
              input: { cmd: "cat " + "x".repeat(1024 * 1024) },
            },
          ],
        },
      }) + "\n",
    );
    expect(result.limitation).toBe("projection_limit");
    expect(result.record).toBeUndefined();
  });
  it("validates discarded body strings and stops exactly at the first newline", async () => {
    const invalid = '{"unused":"' + "x".repeat(1024 * 1024) + '\\x"}\n';
    const result = await read(invalid + '{"type":"session"}\n');
    expect(result.limitation).toBe("malformed_records");
    expect(result.nextOffset).toBe(Buffer.byteLength(invalid));
  });
  it("defers a torn final record without advancing its checkpoint", async () => {
    const result = await read(
      '{"message":{"content":"' + "x".repeat(1024 * 1024),
    );
    expect(result.complete).toBe(false);
    expect(result.nextOffset).toBe(0);
  });
});
