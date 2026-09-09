import { createHash } from "node:crypto";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { scanSkillUsage } from "../src/core/skill-usage.js";

it("counts successful structured skill events, excludes catalogs and errors, and caches incrementally without text", async () => {
  const home = await mkdtemp(join(tmpdir(), "skilloom-usage-"));
  const root = join(home, ".claude/projects/project");
  await mkdir(root, { recursive: true });
  const log = join(root, "session.jsonl");
  const secret = "private-conversation-marker";
  const at = "2026-09-09T01:00:00Z";
  const lines = [
    {
      type: "attachment",
      attachment: { type: "skill_listing", content: `review ${secret}` },
    },
    { type: "user", message: { content: `Use review ${secret}` } },
    {
      type: "assistant",
      timestamp: at,
      message: {
        content: [
          {
            type: "tool_use",
            id: "one",
            name: "Skill",
            input: { skill: "review", args: secret },
          },
        ],
      },
    },
    {
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "one", content: secret }],
      },
    },
    {
      type: "assistant",
      timestamp: at,
      message: {
        content: [
          {
            type: "tool_use",
            id: "two",
            name: "Skill",
            input: { skill: "review" },
          },
        ],
      },
    },
    {
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "two",
            is_error: true,
            content: secret,
          },
        ],
      },
    },
  ];
  await writeFile(log, lines.map((x) => JSON.stringify(x)).join("\n") + "\n");
  const args = {
    env: { HOME: home },
    cachePath: join(home, "cache.json"),
    knownSkills: [{ name: "review" }],
  };
  const first = await scanSkillUsage(args);
  expect(first.usage).toEqual([
    {
      name: "review",
      harness: "claude",
      evidence: "invoke",
      count: 1,
      lastUsedAt: at,
    },
  ]);
  expect(await readFile(args.cachePath, "utf8")).not.toContain(secret);
  expect((await scanSkillUsage(args)).usage).toEqual(first.usage);
  await appendFile(
    log,
    JSON.stringify({
      type: "assistant",
      timestamp: at,
      message: {
        content: [
          {
            type: "tool_use",
            id: "three",
            name: "Skill",
            input: { skill: "review" },
          },
        ],
      },
    }) + "\n",
  );
  await scanSkillUsage(args);
  await appendFile(
    log,
    JSON.stringify({
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "three", content: secret },
        ],
      },
    }) + "\n",
  );
  expect((await scanSkillUsage(args)).usage[0]?.count).toBe(2);
});

it("recognizes Pi reads and conservative Codex commands, never mentioned or merely listed paths", async () => {
  const home = await mkdtemp(join(tmpdir(), "skilloom-usage-"));
  const at = "2026-09-09T01:00:00Z";
  const target = join(home, ".agents/skills/review/SKILL.md");
  await mkdir(join(home, ".agents/skills/review"), { recursive: true });
  await writeFile(target, "skill");
  const pathId = createHash("sha256")
    .update(await realpath(target))
    .digest("hex");
  const pi = join(home, ".pi/agent/sessions/project");
  const codex = join(home, ".codex/sessions/2026/09/09");
  await mkdir(pi, { recursive: true });
  await mkdir(codex, { recursive: true });
  const events = [
    {
      type: "message",
      timestamp: at,
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "pi-read",
            name: "read",
            arguments: { path: target },
          },
        ],
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "pi-read",
        toolName: "read",
        isError: false,
        content: [{ type: "text", text: "secret text" }],
      },
    },
  ];
  await writeFile(
    join(pi, "one.jsonl"),
    events.map((x) => JSON.stringify(x)).join("\n") + "\n",
  );
  await writeFile(
    join(pi, "export.jsonl"),
    events.map((x) => JSON.stringify(x)).join("\n") + "\n",
  );
  const command = (id: string, cmd: string) => [
    {
      type: "response_item",
      timestamp: at,
      payload: {
        type: "function_call",
        name: "exec_command",
        call_id: id,
        arguments: JSON.stringify({ cmd }),
      },
    },
    {
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: id,
        output: JSON.stringify({ exit_code: 0, output: "secret text" }),
      },
    },
  ];
  await writeFile(
    join(codex, "one.jsonl"),
    [
      ...command("read", `cat '${target}'`),
      ...command("concatenation", `cat '${target}'.backup`),
      ...command("escaped-space", `cat other\\ '${target}'`),
      ...command("listing", `ls '${target}'`),
      ...command("mention", `echo "cat '${target}'"`),
    ]
      .map((x) => JSON.stringify(x))
      .join("\n") + "\n",
  );
  const result = await scanSkillUsage({
    env: { HOME: home },
    cachePath: join(home, "cache.json"),
    knownSkills: [{ name: "review", paths: [target] }],
  });
  expect(result.usage, JSON.stringify(result.coverage)).toEqual(
    expect.arrayContaining([
      {
        name: "review",
        harness: "pi",
        evidence: "read",
        pathId,
        count: 1,
        lastUsedAt: at,
      },
      {
        name: "review",
        harness: "codex",
        evidence: "read",
        pathId,
        count: 1,
        lastUsedAt: at,
      },
    ]),
  );
});

it("reports bounded sampling and cancellation instead of claiming complete history", async () => {
  const home = await mkdtemp(join(tmpdir(), "skilloom-usage-"));
  const controller = new AbortController();
  controller.abort();
  const result = await scanSkillUsage({
    env: { HOME: home },
    cachePath: join(home, "cache.json"),
    knownSkills: [],
    signal: controller.signal,
  });
  expect(result.coverage.status).toBe("incomplete");
  expect(result.coverage.limitsHit).toContain("aborted");
});

it("replays changed skill catalogs and keeps unchanged scan metadata stable", async () => {
  const home = await mkdtemp(join(tmpdir(), "skilloom-usage-"));
  const root = join(home, ".claude/projects/project");
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "one.jsonl"),
    [
      {
        type: "assistant",
        timestamp: "2026-09-09T01:00:00Z",
        message: {
          content: [
            {
              type: "tool_use",
              id: "catalog-b",
              name: "Skill",
              input: { skill: "b" },
            },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "catalog-b",
              content: "private",
            },
          ],
        },
      },
    ]
      .map((x) => JSON.stringify(x))
      .join("\n") + "\n",
  );
  const base = { env: { HOME: home }, cachePath: join(home, "cache.json") };
  expect(
    (await scanSkillUsage({ ...base, knownSkills: [{ name: "a" }] })).usage,
  ).toEqual([]);
  const second = await scanSkillUsage({
    ...base,
    knownSkills: [{ name: "a" }, { name: "b" }],
  });
  expect(second.usage[0]?.name).toBe("b");
  expect(
    await scanSkillUsage({
      ...base,
      knownSkills: [{ name: "a" }, { name: "b" }],
    }),
  ).toEqual(second);
});

it("ignores non-regular trace entries without blocking", async () => {
  const { execFileSync } = await import("node:child_process");
  const home = await mkdtemp(join(tmpdir(), "skilloom-usage-"));
  const root = join(home, ".claude/projects/project");
  await mkdir(root, { recursive: true });
  execFileSync("mkfifo", [join(root, "pipe.jsonl")]);
  const result = await scanSkillUsage({
    env: { HOME: home },
    cachePath: join(home, "cache.json"),
    knownSkills: [{ name: "review" }],
  });
  expect(result.coverage.filesScanned).toBe(0);
});

it("matches successful literal Codex exec wrappers and excludes arbitrary JavaScript and failed reads", async () => {
  const home = await mkdtemp(join(tmpdir(), "skilloom-usage-"));
  const root = join(home, ".codex/sessions/2026/09/09");
  await mkdir(root, { recursive: true });
  const target = join(home, ".agents/skills/review/SKILL.md");
  await mkdir(join(home, ".agents/skills/review"), { recursive: true });
  await writeFile(target, "skill");
  const pathId = createHash("sha256")
    .update(await realpath(target))
    .digest("hex");
  const input = `text(await tools.exec_command({cmd: ${JSON.stringify(`cat '${target}'`)}, workdir: ${JSON.stringify(home)}, max_output_tokens: 1000}));`;
  const records = (id: string, source: string, code: number) => [
    {
      type: "response_item",
      timestamp: "2026-09-09T01:00:00Z",
      payload: {
        type: "custom_tool_call",
        name: "exec",
        call_id: id,
        input: source,
      },
    },
    {
      type: "response_item",
      payload: {
        type: "custom_tool_call_output",
        call_id: id,
        output: [
          { type: "text", text: "Script completed" },
          {
            type: "text",
            text: JSON.stringify({
              exit_code: code,
              output: "private skill contents",
            }),
          },
        ],
      },
    },
  ];
  await writeFile(
    join(root, "one.jsonl"),
    [
      ...records("ok", input, 0),
      ...records("failed", input, 1),
      ...records("branch", `if(false) { ${input} }`, 0),
    ]
      .map((x) => JSON.stringify(x))
      .join("\n") + "\n",
  );
  const result = await scanSkillUsage({
    env: { HOME: home },
    cachePath: join(home, "cache.json"),
    knownSkills: [{ name: "review", paths: [target] }],
  });
  expect(result.usage).toEqual([
    {
      name: "review",
      harness: "codex",
      evidence: "read",
      pathId,
      count: 1,
      lastUsedAt: "2026-09-09T01:00:00Z",
    },
  ]);
});

it("requires installed path identity, resolves known aliases, and preserves distinct sessions across copies", async () => {
  const { symlink } = await import("node:fs/promises");
  const home = await mkdtemp(join(tmpdir(), "skilloom-identity-"));
  const root = join(home, ".pi/agent/sessions");
  const installed = join(home, "installed/review");
  const unrelated = join(home, "elsewhere/review");
  await Promise.all(
    [root, installed, unrelated].map((path) =>
      mkdir(path, { recursive: true }),
    ),
  );
  await writeFile(join(installed, "SKILL.md"), "installed");
  await writeFile(join(unrelated, "SKILL.md"), "unrelated");
  const alias = join(home, "alias");
  await symlink(installed, alias);
  const records = (session: string, path: string) =>
    [
      { type: "session", id: session, cwd: home },
      {
        type: "message",
        timestamp: "2026-09-09T01:00:00Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "same-call-id",
              name: "read",
              arguments: { path },
            },
          ],
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "same-call-id",
          isError: false,
        },
      },
    ]
      .map((record) => JSON.stringify(record))
      .join("\n") + "\n";
  await writeFile(
    join(root, "one.jsonl"),
    records("one", join(alias, "SKILL.md")),
  );
  await writeFile(
    join(root, "copy.jsonl"),
    records("one", join(alias, "SKILL.md")),
  );
  await writeFile(
    join(root, "two.jsonl"),
    records("two", await realpath(join(installed, "SKILL.md"))),
  );
  await writeFile(
    join(root, "unrelated.jsonl"),
    records("unrelated", join(unrelated, "SKILL.md")),
  );
  const base = { env: { HOME: home }, cachePath: join(home, "cache.json") };
  expect(
    (await scanSkillUsage({ ...base, knownSkills: [{ name: "review" }] }))
      .usage,
  ).toEqual([]);
  const result = await scanSkillUsage({
    ...base,
    knownSkills: [{ name: "review", paths: [alias] }],
  });
  expect(result.version).toBe(2);
  expect(result.usage).toEqual([
    {
      name: "review",
      harness: "pi",
      evidence: "read",
      pathId: createHash("sha256")
        .update(await realpath(join(installed, "SKILL.md")))
        .digest("hex"),
      count: 2,
      lastUsedAt: "2026-09-09T01:00:00Z",
    },
  ]);
  expect(
    (
      await scanSkillUsage({
        ...base,
        knownSkills: [{ name: "review", paths: [alias] }],
      })
    ).usage,
  ).toEqual(result.usage);
});
