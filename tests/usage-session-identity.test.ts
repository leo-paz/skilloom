import { createHash } from "node:crypto";
import {
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
import {
  appendUsageEvents,
  mergeUsageEvent,
  readUsageJournal,
  usageDirectory,
} from "../src/core/usage-journal.js";

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const at = "2026-09-09T01:00:00.000Z";
const later = "2026-09-09T02:00:00.000Z";
const meta = (id: string, root?: string, inherited = false) => ({
  type: "session_meta",
  payload: {
    id,
    ...(root ? { session_id: root } : {}),
    timestamp: at,
    ...(inherited ? { parent_thread_id: "parent-thread" } : {}),
  },
});
const load = (id: string, path: string, createdAt = later) => ({
  type: "response_item",
  timestamp: later,
  payload: {
    type: "message",
    role: "user",
    id,
    content: [
      {
        type: "input_text",
        text: `<skill>\n<name>review</name>\n<path>${path}</path>\nsecret\n</skill>`,
      },
    ],
    internal_chat_message_metadata_passthrough: {
      create_time: Date.parse(createdAt) / 1000,
      content_item_kinds: ["skills.selected_skill_instructions"],
    },
  },
});
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "skilloom-session-"));
  const logs = join(home, ".codex/sessions");
  await mkdir(logs, { recursive: true });
  const skill = join(home, "review/SKILL.md");
  await mkdir(join(home, "review"));
  await writeFile(skill, "review");
  return {
    home,
    logs,
    skill,
    args: {
      env: { HOME: home },
      cachePath: join(home, "cache.json"),
      knownSkills: [{ name: "review", paths: [skill] }],
    },
  };
}
async function transcript(path: string, records: unknown[]) {
  await writeFile(
    path,
    records.map((record) => JSON.stringify(record)).join("\n") + "\n",
  );
}
it("groups Codex root and subagent evidence by root session while keeping distinct event IDs", async () => {
  const f = await fixture();
  await transcript(join(f.logs, "root.jsonl"), [
    meta("root"),
    load("root-load", f.skill),
  ]);
  await transcript(join(f.logs, "child.jsonl"), [
    meta("child", "root", true),
    load("child-load", f.skill),
  ]);
  await transcript(join(f.logs, "old-child.jsonl"), [
    meta("old-child", undefined, true),
    load("unknown-root-load", f.skill),
  ]);
  const scan = await scanSkillUsage(f.args);
  expect(scan.history).toHaveLength(3);
  expect(
    scan.history!.filter((event) => event.sessionId === digest("codex:root")),
  ).toHaveLength(2);
  expect(scan.history!.filter((event) => !event.sessionId)).toHaveLength(1);
  expect(
    scan.history!.every((event) => event.sessionIdentityVersion === 1),
  ).toBe(true);
});
it("ignores provably inherited selected loads in forks instead of reassigning original sessions", async () => {
  const f = await fixture();
  const inherited = load("original", f.skill, "2026-09-08T23:00:00.000Z");
  await transcript(join(f.logs, "parent.jsonl"), [meta("parent"), inherited]);
  await transcript(join(f.logs, "fork.jsonl"), [
    {
      ...meta("fork"),
      payload: { ...meta("fork").payload, forked_from_id: "parent" },
    },
    inherited,
    load("new-fork-load", f.skill),
  ]);
  const scan = await scanSkillUsage(f.args);
  expect(scan.history).toHaveLength(2);
  expect(new Set(scan.history!.map((event) => event.sessionId))).toEqual(
    new Set([digest("codex:parent"), digest("codex:fork")]),
  );
});
it("upgrades legacy root event attribution through bounded headers without replaying unchanged files", async () => {
  const f = await fixture();
  await transcript(join(f.logs, "root.jsonl"), [
    meta("thread", "root"),
    load("original", f.skill),
  ]);
  const first = await scanSkillUsage(f.args);
  const previous = first.history![0]!;
  const legacy = { ...previous, sessionId: digest("codex:thread") };
  delete legacy.sessionIdentityVersion;
  const cache = JSON.parse(await readFile(f.args.cachePath, "utf8"));
  cache.events = [legacy];
  for (const cursor of Object.values(cache.files) as Array<
    Record<string, unknown>
  >) {
    delete cursor.sessionIdentityVersion;
    delete cursor.groupSessionId;
  }
  await writeFile(f.args.cachePath, JSON.stringify(cache));
  // The earliest valid journal row is a legacy event, as on deployed collectors.
  const directory = usageDirectory(f.args.cachePath);
  await writeFile(
    join(directory, `events-${previous.at.slice(0, 10)}.jsonl`),
    JSON.stringify({ version: 1, ...legacy }) + "\n",
  );
  const next = await scanSkillUsage(f.args);
  expect(next.history![0]).toMatchObject({
    id: previous.id,
    sessionId: digest("codex:root"),
    sessionIdentityVersion: 1,
  });
  const nextCache = JSON.parse(await readFile(f.args.cachePath, "utf8"));
  expect(
    Object.values(nextCache.files).map((cursor: any) => cursor.offset),
  ).toEqual(Object.values(cache.files).map((cursor: any) => cursor.offset));
  expect((await readUsageJournal(directory)).events[0]).toMatchObject({
    sessionId: digest("codex:root"),
    sessionIdentityVersion: 1,
  });
});
it("keeps duplicate session conflicts unknown regardless of journal discovery order", async () => {
  const f = await fixture();
  const base = {
    id: digest("event"),
    name: "review",
    harness: "codex" as const,
    evidence: "load" as const,
    at,
    sessionIdentityVersion: 1 as const,
  };
  const a = { ...base, sessionId: digest("a") },
    b = { ...base, at: later, sessionId: digest("b") };
  const forward = mergeUsageEvent(a, b),
    reverse = mergeUsageEvent(b, a);
  expect(forward).toEqual(reverse);
  expect(forward.sessionId).toBeUndefined();
  expect(mergeUsageEvent(forward, a).sessionId).toBeUndefined();
  await appendUsageEvents(usageDirectory(f.args.cachePath), [a, b]);
  expect(
    (await readUsageJournal(usageDirectory(f.args.cachePath))).events,
  ).toEqual([forward]);
});

it("preserves thread-scoped read event IDs while sharing the root session count", async () => {
  const f = await fixture();
  const pair = (thread: string) => [
    meta(thread, "root", thread !== "root"),
    {
      type: "response_item",
      timestamp: later,
      payload: {
        type: "function_call",
        call_id: "same-call",
        name: "read_file",
        arguments: JSON.stringify({ path: f.skill }),
        internal_chat_message_metadata_passthrough: {
          create_time: Date.parse(later) / 1000,
        },
      },
    },
    {
      type: "response_item",
      timestamp: later,
      payload: {
        type: "function_call_output",
        call_id: "same-call",
        output: JSON.stringify({ exit_code: 0 }),
        internal_chat_message_metadata_passthrough: {
          create_time: Date.parse(later) / 1000,
        },
      },
    },
  ];
  await transcript(join(f.logs, "root.jsonl"), pair("root"));
  await transcript(join(f.logs, "child.jsonl"), pair("child"));
  const scan = await scanSkillUsage(f.args);
  expect(scan.history).toHaveLength(2);
  expect(new Set(scan.history!.map((event) => event.id)).size).toBe(2);
  expect(new Set(scan.history!.map((event) => event.sessionId))).toEqual(
    new Set([digest("codex:root")]),
  );
});

it("does not count Pi fork copies at the same millisecond as the fork header", async () => {
  const f = await fixture();
  const pi = join(f.home, ".pi/agent/sessions");
  await mkdir(pi, { recursive: true });
  const messages = (time: string, id: string) => [
    {
      type: "message",
      timestamp: time,
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", id, name: "read", arguments: { path: f.skill } },
        ],
      },
    },
    {
      type: "message",
      timestamp: time,
      message: { role: "toolResult", toolCallId: id, isError: false },
    },
  ];
  await transcript(join(pi, "parent.jsonl"), [
    { type: "session", id: "parent", timestamp: at },
    ...messages(later, "copied"),
  ]);
  await transcript(join(pi, "fork.jsonl"), [
    {
      type: "session",
      id: "fork",
      timestamp: later,
      parentSession: join(pi, "parent.jsonl"),
    },
    ...messages(later, "copied"),
    ...messages("2026-09-09T02:00:00.001Z", "new"),
  ]);
  const scan = await scanSkillUsage(f.args);
  expect(scan.history).toHaveLength(2);
  expect(
    scan.history!.filter((event) => event.sessionId === digest("pi:fork")),
  ).toHaveLength(1);
  expect(scan.coverage.limitsHit).toContain("history_window");
});

it("corrects a previously journaled Pi fork boundary event using cached fork metadata", async () => {
  const f = await fixture();
  const pi = join(f.home, ".pi/agent/sessions");
  await mkdir(pi, { recursive: true });
  await transcript(join(pi, "fork.jsonl"), [
    {
      type: "session",
      id: "fork",
      timestamp: later,
      parentSession: join(pi, "parent.jsonl"),
    },
  ]);
  await scanSkillUsage(f.args);
  const legacy = {
    id: digest("legacy-pi-boundary"),
    name: "review",
    harness: "pi" as const,
    evidence: "read" as const,
    at: later,
    sessionId: digest("pi:fork"),
    pathId: digest(await realpath(f.skill)),
  };
  const directory = usageDirectory(f.args.cachePath);
  await appendUsageEvents(directory, [legacy]);
  const cacheBefore = JSON.parse(await readFile(f.args.cachePath, "utf8"));
  const corrected = await scanSkillUsage(f.args);
  expect(corrected.usage[0]?.count).toBe(1);
  expect(corrected.history).toEqual([
    { ...legacy, sessionId: undefined, sessionIdentityVersion: 1 },
  ]);
  expect(corrected.sessions).toEqual([]);
  expect((await readUsageJournal(directory)).events[0]).toMatchObject({
    id: legacy.id,
    sessionIdentityVersion: 1,
  });
  expect(
    (await readUsageJournal(directory)).events[0]?.sessionId,
  ).toBeUndefined();
  const cacheAfter = JSON.parse(await readFile(f.args.cachePath, "utf8"));
  expect(
    Object.values(cacheAfter.files).map((cursor: any) => cursor.offset),
  ).toEqual(
    Object.values(cacheBefore.files).map((cursor: any) => cursor.offset),
  );
});
