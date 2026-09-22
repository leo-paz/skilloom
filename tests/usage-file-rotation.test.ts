import fs, {
  appendFile,
  mkdir,
  mkdtemp,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const race: { beforeOpen?: ((path: unknown) => Promise<void>) | undefined } =
  {};
const originalOpen = fs.open;

import { scanSkillUsage } from "../src/core/skill-usage.js";

const homes: string[] = [];
afterEach(async () => {
  race.beforeOpen = undefined;
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  await Promise.all(
    homes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
  );
});
const filler =
  JSON.stringify({ type: "user", message: { content: "x".repeat(10000) } }) +
  "\n";
async function fixture() {
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    await race.beforeOpen?.(args[0]);
    return originalOpen(...args);
  });
  syncBuiltinESMExports();
  const home = await mkdtemp(join(tmpdir(), "skilloom-rotation-"));
  homes.push(home);
  const root = join(home, ".pi/agent/sessions"),
    target = join(home, "review/SKILL.md"),
    log = join(root, "one.jsonl");
  await mkdir(root, { recursive: true });
  await mkdir(join(home, "review"));
  await writeFile(target, "skill");
  const session = (id: string) =>
    [
      { type: "session", id, cwd: "/" },
      {
        type: "message",
        timestamp: "2026-09-10T01:00:00Z",
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
        timestamp: "2026-09-10T01:00:00Z",
        message: { role: "toolResult", toolCallId: "read", isError: false },
      },
    ]
      .map((value) => JSON.stringify(value))
      .join("\n") + "\n";
  return {
    home,
    log,
    session,
    args: {
      env: { HOME: home },
      cachePath: join(home, "usage.json"),
      knownSkills: [{ name: "review", paths: [target] }],
      mode: "backfill" as const,
    },
  };
}

it("reads a replacement inode encountered between discovery and open without leaving it pending", async () => {
  const { home, log, session, args } = await fixture();
  await writeFile(log, session("old") + filler.repeat(60));
  let replaced = false;
  race.beforeOpen = async (path) => {
    if (path !== log || replaced) return;
    replaced = true;
    await rename(log, join(home, "rotated-original"));
    await writeFile(log, session("new"));
  };
  const result = await scanSkillUsage(args);
  expect(replaced).toBe(true);
  expect(result.backfill?.complete).toBe(true);
  expect(result.backfill?.filesPending).toBe(0);
  expect(
    result.sessionCohorts?.reduce((sum, item) => sum + item.sessionCount, 0),
  ).toBe(1);
  expect(
    result.harnessCoverage?.find((item) => item.harness === "pi")?.limitations,
  ).toContain("changed_file");
});

it("rewinds a file truncated between discovery and open, recording the lost-content gap", async () => {
  const { log, session, args } = await fixture();
  await writeFile(log, session("old") + filler.repeat(60));
  let truncated = false;
  race.beforeOpen = async (path) => {
    if (path !== log || truncated) return;
    truncated = true;
    await writeFile(log, session("new"));
  };
  const result = await scanSkillUsage(args);
  expect(result.backfill?.complete).toBe(true);
  expect(
    result.sessionCohorts?.reduce((sum, item) => sum + item.sessionCount, 0),
  ).toBe(1);
  expect(
    result.harnessCoverage?.find((item) => item.harness === "pi")?.limitations,
  ).toContain("changed_file");
});

it("finishes a discovered snapshot even when the file grows faster than each read batch", async () => {
  const { log, session, args } = await fixture();
  await writeFile(log, session("original") + filler.repeat(60));
  let opens = 0;
  race.beforeOpen = async (path) => {
    if (path !== log) return;
    opens++;
    await appendFile(log, session(`appended-${opens}`) + filler.repeat(60));
  };
  let result = await scanSkillUsage(args);
  for (let pass = 0; !result.backfill?.complete && pass < 4; pass++)
    result = await scanSkillUsage(args);
  expect(opens).toBe(2);
  expect(result.backfill?.complete).toBe(true);
  expect(
    result.sessionCohorts?.reduce((sum, item) => sum + item.sessionCount, 0),
  ).toBe(1);
  expect(
    result.harnessCoverage?.find((item) => item.harness === "pi")?.limitations,
  ).toEqual([]);
});

it("discovers a changed Codex home even when the previous historical traversal was complete", async () => {
  const { home, log, session, args } = await fixture();
  await writeFile(log, session("pi-original"));
  const first = await scanSkillUsage(args);
  expect(first.backfill?.complete).toBe(true);
  const codexHome = join(home, "another-codex-home"),
    root = join(codexHome, "sessions");
  await mkdir(root, { recursive: true });
  const target = args.knownSkills[0]!.paths[0]!;
  const records = [
    { type: "session_meta", payload: { id: "codex-original", cwd: home } },
    {
      type: "response_item",
      timestamp: "2026-09-10T01:00:00Z",
      payload: {
        type: "function_call",
        name: "read_file",
        call_id: "codex-read",
        arguments: JSON.stringify({ path: target }),
      },
    },
    {
      type: "response_item",
      timestamp: "2026-09-10T01:00:00Z",
      payload: {
        type: "function_call_output",
        call_id: "codex-read",
        output: { exit_code: 0 },
      },
    },
  ];
  await writeFile(
    join(root, "new.jsonl"),
    records.map((value) => JSON.stringify(value)).join("\n") + "\n",
  );
  const changed = await scanSkillUsage({
    ...args,
    env: { HOME: home, CODEX_HOME: codexHome },
  });
  expect(changed.backfill?.complete).toBe(true);
  expect(changed.backfill?.filesDiscovered).toBe(2);
  expect(
    changed.sessionCohorts
      ?.filter((item) => item.harness === "codex")
      .reduce((sum, item) => sum + item.sessionCount, 0),
  ).toBe(1);
});
