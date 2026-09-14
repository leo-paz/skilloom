import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { indexUsageJournal } from "../src/core/usage-journal-index.js";
import {
  isUsageSessionIndexDirty,
  readUsageSessionIndex,
} from "../src/core/usage-session-index.js";

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
it("imports the whole journal beyond the UI window with resumable offsets and distinct session identities", async () => {
  const directory = await mkdtemp(join(tmpdir(), "skilloom-journal-index-"));
  try {
    const event = (session: string) => ({
      version: 1,
      id: hash(session),
      name: "Agent Browser",
      harness: "pi",
      evidence: "read",
      at: "2026-09-10T01:00:00Z",
      sessionId: hash(session),
    });
    const first = JSON.stringify(event("old-session")) + "\n";
    const repeated =
      JSON.stringify({ ...event("one-session"), padding: "é".repeat(3000) }) +
      "\n";
    const data = first + repeated.repeat(1500);
    expect(Buffer.byteLength(data)).toBeGreaterThan(8 * 1024 * 1024);
    await writeFile(join(directory, "events-2026-09-10.jsonl"), data);
    expect(await indexUsageJournal(directory)).toEqual([]);
    const result = await readUsageSessionIndex(directory);
    expect(
      result.cohorts.reduce((sum, cohort) => sum + cohort.sessionCount, 0),
    ).toBe(2);
    expect(await isUsageSessionIndexDirty(directory)).toBe(false);
    expect(await indexUsageJournal(directory)).toEqual([]);
    expect(await isUsageSessionIndexDirty(directory)).toBe(false);
    const saved = JSON.parse(
      await readFile(join(directory, "journal-index-cursors.json"), "utf8"),
    );
    expect(saved["events-2026-09-10.jsonl"].offset).toBe(
      Buffer.byteLength(data),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
