import { appendFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { scanSkillUsage } from "../src/core/skill-usage.js";
import { recordHookUsage, usageDirectory } from "../src/core/usage-journal.js";

const at = "2026-09-10T01:00:00Z";
const pair = (target: string, session: string) => [
  { type: "session", id: session, cwd: "/" },
  {
    type: "message",
    timestamp: at,
    message: {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          name: "read",
          id: "read",
          arguments: { path: target },
        },
      ],
    },
  },
  {
    type: "message",
    timestamp: at,
    message: { role: "toolResult", toolCallId: "read", isError: false },
  },
];
it("resumes through more than one discovery batch and reads the beginning of large files", async () => {
  const home = await mkdtemp(join(tmpdir(), "usage-backfill-"));
  const root = join(home, ".pi/agent/sessions");
  await mkdir(root, { recursive: true });
  const target = join(home, "review/SKILL.md");
  await mkdir(join(home, "review"));
  await writeFile(target, "private skill");
  const filler =
    JSON.stringify({ type: "user", message: { content: "x".repeat(10000) } }) +
    "\n";
  for (let i = 0; i < 65; i++)
    await writeFile(
      join(root, `${i}.jsonl`),
      pair(target, `s${i}`)
        .map((x) => JSON.stringify(x))
        .join("\n") +
        "\n" +
        (i === 0 ? filler.repeat(60) : ""),
    );
  const args = {
    env: { HOME: home },
    cachePath: join(home, "usage.json"),
    knownSkills: [{ name: "review", paths: [target] }],
    mode: "backfill" as const,
  };
  let result = await scanSkillUsage(args),
    passes = 1;
  while (!result.backfill?.complete && passes++ < 10)
    result = await scanSkillUsage(args);
  expect(result.backfill?.complete).toBe(true);
  expect(result.backfill?.filesDiscovered).toBe(65);
  expect(result.usage[0]?.count).toBe(65);
  expect(
    result.harnessCoverage?.find((c) => c.harness === "pi")?.filesScanned,
  ).toBe(65);
  await recordHookUsage(usageDirectory(args.cachePath), {
    harness: "pi",
    sessionId: "s0",
    callId: "read",
    at,
    evidence: "read",
    path: target,
  });
  const repeat = await scanSkillUsage(args);
  expect(repeat.usage[0]?.count).toBe(65);
});
it("carries pending results across file appends and does not duplicate refreshed events", async () => {
  const home = await mkdtemp(join(tmpdir(), "usage-append-"));
  const root = join(home, ".pi/agent/sessions");
  await mkdir(root, { recursive: true });
  const target = join(home, "review/SKILL.md");
  await mkdir(join(home, "review"));
  await writeFile(target, "skill");
  const records = pair(target, "s1");
  const log = join(root, "one.jsonl");
  await writeFile(
    log,
    records
      .slice(0, 2)
      .map((x) => JSON.stringify(x))
      .join("\n") + "\n",
  );
  const args = {
    env: { HOME: home },
    cachePath: join(home, "usage.json"),
    knownSkills: [{ name: "review", paths: [target] }],
  };
  expect((await scanSkillUsage(args)).history).toEqual([]);
  const final = JSON.stringify(records[2]);
  await appendFile(log, final.slice(0, 30));
  expect((await scanSkillUsage(args)).history).toEqual([]);
  await appendFile(log, final.slice(30) + "\n");
  expect((await scanSkillUsage(args)).history).toHaveLength(1);
  expect((await scanSkillUsage(args)).history).toHaveLength(1);
});
