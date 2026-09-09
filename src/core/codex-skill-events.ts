import { createHash } from "node:crypto";
import { posix, win32 } from "node:path";

export interface CodexSkillEvent {
  /** Stable original message/content identity; independent of the containing log. */
  id: string;
  path: string;
  name: string;
  evidence: "load";
  at?: string;
}

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/**
 * Recognizes selected instructions persisted by Codex, not skill-looking user text.
 * Reviewed wire contract: openai/codex e1b23086acbf905592036c587cb37a12d68c441e:
 * - codex-rs/ext/skills/src/fragments.rs (kind and exact generated prefix)
 * - codex-rs/ext/skills/src/host_prompt.rs (emitted after successful load)
 * - codex-rs/protocol/src/models.rs (metadata aligned with content entries)
 *
 * Builds without these classifications or original message IDs are unsupported.
 * Nested executed_tool_calls record attempted calls, while tool_calls_complete
 * describes inventory completeness, not success. Neither establishes a load.
 * Only call this on locally persisted harness records, never imported user JSON.
 */
export function extractCodexSkillEvents(record: unknown): CodexSkillEvent[] {
  const outer = object(record);
  if (outer.type !== "response_item") return [];
  const message = object(outer.payload);
  if (
    message.type !== "message" ||
    message.role !== "user" ||
    typeof message.id !== "string" ||
    message.id.length === 0 ||
    message.id.length > 1024 ||
    !Array.isArray(message.content)
  )
    return [];
  const metadata = object(message.internal_chat_message_metadata_passthrough);
  const kinds = metadata.content_item_kinds;
  if (!Array.isArray(kinds) || kinds.length !== message.content.length)
    return [];

  // The message creation time survives history copies; the envelope timestamp
  // can describe when a copied rollout record was written.
  const created = metadata.create_time;
  const timestamp =
    typeof created === "number" &&
    created >= 0 &&
    created <= 253402300799 &&
    Number.isFinite(created)
      ? new Date(created * 1000).toISOString()
      : outer.timestamp;
  const at =
    typeof timestamp === "string" &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(
      timestamp,
    ) &&
    Number.isFinite(Date.parse(timestamp))
      ? timestamp
      : undefined;
  const events: CodexSkillEvent[] = [];
  for (let index = 0; index < message.content.length; index++) {
    if (kinds[index] !== "skills.selected_skill_instructions") continue;
    const item = object(message.content[index]);
    if (item.type !== "input_text" || typeof item.text !== "string") continue;
    // Anchor to the harness-generated header. Skill bodies may themselves contain
    // examples with <path> tags and must never be scanned for additional loads.
    const match =
      /^<skill>\n<name>([^<>\r\n]{1,256})<\/name>\n<path>([^<>\r\n]{1,4096})<\/path>\n/.exec(
        item.text,
      );
    if (!match || !item.text.endsWith("\n</skill>")) continue;
    const name = match[1]!;
    const path = match[2]!;
    if (
      /[\x00-\x1f\x7f]/.test(name + path) ||
      (!posix.isAbsolute(path) &&
        !(
          win32.isAbsolute(path) &&
          /^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+\\)/.test(path)
        )) ||
      !/(?:\/|\\)SKILL\.md$/.test(path)
    )
      continue;
    events.push({
      id: createHash("sha256")
        .update(JSON.stringify(["codex-selected-skill-v1", message.id, index]))
        .digest("hex"),
      name,
      path,
      evidence: "load",
      ...(at ? { at } : {}),
    });
  }
  return events;
}
