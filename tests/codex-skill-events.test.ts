import { expect, it } from "vitest";
import { extractCodexSkillEvents } from "../src/core/codex-skill-events.js";

// Wire contract: openai/codex e1b23086acbf905592036c587cb37a12d68c441e,
// codex-rs/ext/skills/src/fragments.rs and protocol/src/models.rs.
const at = "2026-09-09T01:00:00Z";
const block = (path = "/workspace/.agents/skills/review/SKILL.md") =>
  `<skill>\n<name>review</name>\n<path>${path}</path>\nprivate skill instructions\n</skill>`;
const fixture = () => ({
  timestamp: at,
  type: "response_item",
  payload: {
    type: "message",
    id: "original-message",
    role: "user",
    content: [{ type: "input_text", text: block() }],
    internal_chat_message_metadata_passthrough: {
      turn_id: "original-turn",
      content_item_kinds: ["skills.selected_skill_instructions"],
    },
  },
});

it("extracts only harness-classified selected skill loads without retaining contents", () => {
  const events = extractCodexSkillEvents(fixture());
  expect(events).toEqual([
    {
      id: expect.stringMatching(/^[a-f0-9]{64}$/),
      path: "/workspace/.agents/skills/review/SKILL.md",
      name: "review",
      evidence: "load",
      at,
    },
  ]);
  expect(JSON.stringify(events)).not.toContain("private skill instructions");
});

it("preserves event identity across copied records and rejects records without durable identity", () => {
  const original = fixture();
  const copy = { ...original, timestamp: "2026-09-10T01:00:00Z" };
  expect(extractCodexSkillEvents(copy)[0]?.id).toBe(
    extractCodexSkillEvents(original)[0]?.id,
  );
  original.payload.id = "";
  expect(extractCodexSkillEvents(original)).toEqual([]);
});

it("aligns classifications by content index and does not mine skill bodies for additional paths", () => {
  const record = fixture();
  record.payload.content.unshift({
    type: "input_text",
    text: block("/decoy/SKILL.md"),
  });
  record.payload.internal_chat_message_metadata_passthrough.content_item_kinds.unshift(
    "user_input",
  );
  record.payload.content[1]!.text = block().replace(
    "private skill instructions",
    block("/nested/SKILL.md"),
  );
  expect(extractCodexSkillEvents(record).map((event) => event.path)).toEqual([
    "/workspace/.agents/skills/review/SKILL.md",
  ]);
  record.payload.internal_chat_message_metadata_passthrough.content_item_kinds.pop();
  expect(extractCodexSkillEvents(record)).toEqual([]);
});

it.each(["skills.catalog", "user_input", "selected_skill_instructions", ""])(
  "ignores plain or catalog blocks classified as %s",
  (kind) => {
    const record = fixture();
    record.payload.internal_chat_message_metadata_passthrough.content_item_kinds =
      [kind];
    expect(extractCodexSkillEvents(record)).toEqual([]);
  },
);

it.each([
  "relative/SKILL.md",
  "~/skills/review/SKILL.md",
  "skill://package/SKILL.md",
  "\\workspace\\SKILL.md",
  "/workspace/README.md",
  "/workspace/SKILL.md\n/path/SKILL.md",
])("rejects non-exact local skill identity %s", (path) => {
  const record = fixture();
  record.payload.content[0]!.text = block(path);
  expect(extractCodexSkillEvents(record)).toEqual([]);
});

it("accepts exact Windows paths independently of the scanner host platform", () => {
  const record = fixture();
  record.payload.content[0]!.text = block("C:\\workspace\\review\\SKILL.md");
  expect(extractCodexSkillEvents(record)[0]?.path).toBe(
    "C:\\workspace\\review\\SKILL.md",
  );
});

it("prefers original creation time over a copied rollout envelope time", () => {
  const record = fixture();
  const events = extractCodexSkillEvents({
    ...record,
    timestamp: "2026-09-10T01:00:00Z",
    payload: {
      ...record.payload,
      internal_chat_message_metadata_passthrough: {
        ...record.payload.internal_chat_message_metadata_passthrough,
        create_time: Date.parse(at) / 1000,
      },
    },
  });
  expect(events[0]?.at).toBe("2026-09-09T01:00:00.000Z");
});

it("rejects wrong message roles, malformed records and prose surrounding a block", () => {
  for (const record of [null, [], {}, { ...fixture(), type: "event_msg" }]) {
    expect(extractCodexSkillEvents(record)).toEqual([]);
  }
  const record = fixture();
  record.payload.role = "assistant";
  expect(extractCodexSkillEvents(record)).toEqual([]);
  record.payload.role = "user";
  record.payload.content[0]!.text = `Pasted example: ${block()}`;
  expect(extractCodexSkillEvents(record)).toEqual([]);
});

it("does not mistake nested attempted calls or an outer exec success for a skill load", () => {
  expect(
    extractCodexSkillEvents({
      type: "response_item",
      timestamp: at,
      payload: {
        type: "custom_tool_call_output",
        output: "Script completed successfully",
        internal_chat_message_metadata_passthrough: {
          tool_calls_complete: true,
          executed_tool_calls: [
            {
              name: "exec_command",
              arguments: { cmd: "cat /review/SKILL.md" },
            },
          ],
        },
      },
    }),
  ).toEqual([]);
});

it("distinguishes root session identity from a subagent thread and rejects filename-style guesses", async () => {
  const { extractCodexSessionIdentity } = await import(
    "../src/core/codex-skill-events.js"
  );
  expect(
    extractCodexSessionIdentity({
      type: "session_meta",
      payload: {
        id: "child-thread",
        session_id: "root-session",
        parent_thread_id: "parent-thread",
        timestamp: at,
      },
    }),
  ).toEqual({
    threadId: "child-thread",
    sessionId: "root-session",
    inherited: true,
    startedAt: at,
  });
  expect(
    extractCodexSessionIdentity({
      type: "session_meta",
      payload: {
        id: "old-child",
        source: { subagent: { thread_spawn: { parent_thread_id: "root" } } },
      },
    }),
  ).toEqual({ threadId: "old-child", inherited: true });
  expect(
    extractCodexSessionIdentity({
      type: "session_meta",
      payload: { id: "old-root" },
    }),
  ).toEqual({ threadId: "old-root", sessionId: "old-root", inherited: false });
  expect(
    extractCodexSessionIdentity({
      type: "session_meta",
      payload: { id: "bad\nidentity" },
    }),
  ).toBeUndefined();
  expect(
    extractCodexSessionIdentity({
      type: "session_meta",
      payload: { session_id: "root" },
    }),
  ).toBeUndefined();
});
