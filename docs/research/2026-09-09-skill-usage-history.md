# Skill usage history, 9 September 2026

## What the interface means

`i` and Enter open skill details. **Available to** describes installation coverage on that machine, not proof that an agent is installed, enabled in the current session, or has used the skill. **Invocation** describes declarations. Unknown means missing or incomplete declarations. Neither field is inferred from usage logs.

**Recent activity** presents at most 20 of the selected skill's retained events, newest first, across the selected machines. Each event shows UTC time, harness, evidence type and machine. Reads are matched to the current installation's canonical SKILL.md path. Successful Claude Skill calls that identify only a name are visibly separate and cannot establish which installation was loaded. Multiple occurrences on one machine do not duplicate the same event in this view. Machine filtering also filters history.

A successful read proves loading, not compliance with the instructions, usefulness, successful completion of the user's task, or the historical content of a file that has since changed. File and event identifiers are hashes. No prompt, tool output, skill body, command arguments or transcript pathname is published.

## Sources inspected

Existing Pi checkout reused without modifications. Codex and Claude Code repositories were absent and cloned under `~/dev/opensource`. The reviewed revisions are pinned below; later upstream revisions require adapter review.

| Harness | Primary source | Findings |
| --- | --- | --- |
| Codex | [rollout wire format](https://github.com/openai/codex/blob/e1b23086acbf905592036c587cb37a12d68c441e/codex-rs/history/src/rollout_payload.rs), [persistence policy](https://github.com/openai/codex/blob/e1b23086acbf905592036c587cb37a12d68c441e/codex-rs/rollout/src/policy.rs), [tool response headers](https://github.com/openai/codex/blob/e1b23086acbf905592036c587cb37a12d68c441e/codex-rs/core/src/tools/context.rs) | JSONL response items preserve function/custom calls and outputs. Call ID pairs requests and results. Native exec and shell output contain harness-generated status headers. Skilloom previously recognized JSON/MCP successes but missed the native header formats. |
| Claude Code | [public repository](https://github.com/anthropics/claude-code/tree/9cdc2a4d946c586a8472e504fb20b3e79106518c), [PostToolUse contract](https://code.claude.com/docs/en/hooks#posttooluse), [sessions](https://code.claude.com/docs/en/agent-sdk/sessions) | The public repository contains documentation, plugins and examples, not the implementation of its transcript writer. Use documented hooks and observed structured traces as the compatibility boundary. PostToolUse supplies successful tool input/result and tool_use_id. Subagent transcripts reside in nested subagents directories. |
| Pi | [session persistence and forks](https://github.com/badlogic/pi-mono/blob/2edd6b432a4e1eed0a70270540d9a78d12aea7e9/packages/coding-agent/src/core/session-manager.ts), [message persistence and skill command expansion](https://github.com/badlogic/pi-mono/blob/2edd6b432a4e1eed0a70270540d9a78d12aea7e9/packages/coding-agent/src/core/agent-session.ts), [extension event types](https://github.com/badlogic/pi-mono/blob/2edd6b432a4e1eed0a70270540d9a78d12aea7e9/packages/coding-agent/src/core/extensions/types.ts) | Session header includes id, cwd and timestamp. Message entries preserve toolCall/toolResult IDs and isError. A fork copies original entries unchanged under a new header and cwd. `/skill:name` expands into a user-message skill block rather than a read tool call. |

The three available machines were checked read-only. MacBook, mini and desktop each had Codex, Claude and Pi trace files. Recent Codex samples used `exec` custom calls and MCP output blocks; Pi samples had paired tool results with explicit error flags. These shape checks do not establish complete historical coverage or that every observed tool call loaded a skill.

## Initial collection contract (before collectors)

- Each machine reads its own supported log roots, respecting CODEX_HOME, CLAUDE_CONFIG_DIR and PI_CODING_AGENT_DIR. Codex active and archived sessions are included. Nested Claude subagent logs are included within discovery limits.
- Count only supported tool calls paired with a successful result. Claude `Skill` is name-only evidence. Exact read paths and simple literal `cat` commands can establish installation-path evidence. Codex native exec/shell status must be in the expected header; success-like text in the command output is ignored.
- No execution of trace contents, fuzzy basename matching, transcript keyword search, or LLM classification. Unsupported shell expressions and general JavaScript wrappers remain uncounted.
- Pi entries preceding a fork header's timestamp are excluded from that fork. Their original session is the evidence source. This prevents inherited relative paths from being resolved against the new cwd. Suppressed inherited history is reflected in partial coverage.
- The private usage cache advances byte cursors, carries pending calls across refreshes, and deduplicates retained events. Cache format 3 invalidates the earlier parser cache; public scan format 2 remains compatible with optional history fields. Older public scans without history remain usable for counts, while history is explicitly unavailable.
- Retain up to 10,000 derived events locally. Publish at most the latest 1,000 events per machine, with an explicit historyTruncated flag. TUI history deduplicates by machine plus event ID. Filters preserve the installation path boundary. Old collectors cannot manufacture remote history.
- Snapshot enrichment runs outside rendering. Saved inventory appears immediately. Scans currently budget 1.5 seconds, 48 files, 8 MiB total and 512 KiB per file, with bounded directory discovery. These are recent windows, not exhaustive backfills. A complete scan means the supported scan encountered no collection limit, not that all possible skill usage is observable.
- `observe --publish` transports the machine's derived snapshot through the shared configuration repo. Git does not probe machine liveness or start remote work. Remote history keeps its own collection time and stale-snapshot status.

## Initial gaps and remaining limits

1. Codex automatic skill loading and explicit selection are not uniformly read-tool events. The reviewed source provides a [selected-skill content kind](https://github.com/openai/codex/blob/e1b23086acbf905592036c587cb37a12d68c441e/codex-rs/ext/skills/src/fragments.rs), but older CLI and desktop builds differ. A future adapter should require harness-owned metadata and exact path identity; matching a `<skill>` block in ordinary user text is not sufficient.
2. Pi manual skill commands expand into user text. That representation alone cannot distinguish runtime expansion from an exact pasted copy. Do not classify either as a verified invocation merely from its text. An extension should emit an explicit event at the actual successful expansion boundary. `tool_execution_end` helps with automatic read tools but does not independently solve manual expansion.
3. Claude Skill calls name the skill; aliases and plugin-qualified names can be ambiguous. Keep this evidence separate until the resolved file identity is available. Do not assign an invocation to every same-name installed copy. Manual slash commands may also bypass the Skill tool.
4. General Codex `exec` JavaScript can contain branches, several commands and several results. Its outer success does not prove each nested read ran. Broad regex extraction would produce false positives. Prefer a structured nested-tool event adapter or an explicit instrumentation point.
5. Ephemeral/disabled logging, deleted sessions, expired retention, current-path changes, omitted historical windows, unsupported custom tools, and copied/forked histories beyond the supported Pi contract limit completeness. Counts are observed retained evidence, not lifetime totals. A hook added today cannot reconstruct yesterday's missing history.
6. The current scanner prioritizes recent files and tails oversized traces. Repeated refreshes are not a guaranteed full-history backfill. Per-harness coverage and an explicit resumable backfill are needed before offering a claim of historical completeness.

## Original next-stage proposal

Keep adapters local and deterministic. Prefer structured lifecycle records and successful call/result pairs. For Claude Code, use a PostToolUse hook for Skill, Read and narrowly supported Bash reads, writing only a small versioned event. For Pi, use its extension lifecycle for tool reads and add an upstream or extension-supported event at skill expansion. For Codex, first support verified metadata on selected-skill records across tested CLI/desktop versions, then structured nested tool completions where available. Do not add broad text inference to inflate coverage.

Use a private append-only event journal per machine. Record adapter/version, event ID, session lineage identity, actual event time, skill identity, harness and evidence kind. Keep local trace locators private so the user can later open the original session. Persist normalized derived records only after a successful completion; fail open on observer errors so instrumentation never breaks the agent. Add atomic writes and concurrency handling before installing hooks alongside refresh jobs.

Deduplicate against original event identities across exports and forks, with explicit handling of lineage rather than treating copied records as new executions. Track per-harness roots, availability, parser version, oldest/newest covered times, unreadable files, unsupported records, pending results and truncation. A resumable background backfill should advance through old files fairly, while a separate bounded tail pass keeps recent activity fresh. Never run the full walk synchronously when selecting a row.

Validate with disposable sessions for each harness and supported version: real successful read, failed read, explicit/manual invocation, automatic read, subagent, fork, resume, copied export, interrupted JSONL append, rotation/truncation, same-name skills in two checkouts, changed cwd, missing original session, disabled logs and concurrent collection. Compare actual event identities and timestamps, not just a nonzero counter. Publish only derived evidence after inspecting the resulting snapshot. At the initial research checkpoint, no hooks had been installed or remote snapshots published. The implementation below supersedes that checkpoint.


## Implementation follow-through

The journal, supported hooks, Codex metadata adapter and resumable scanner are now implemented. Private journal writes serialize with recoverable locks; interrupted tails are separated before append. Readers whitelist event fields, and snapshots contain only normalized metadata. Journal entries are preserved before applying the 10,000-event cached view and 1,000-event published view. Repeated hook/trace observations share an ID and use the earliest observed event time deterministically.

Codex selected instructions require the original message ID plus the harness-owned `skills.selected_skill_instructions` classification aligned with the exact content item. A selected load has its own evidence kind. Untagged user text still cannot establish usage. General nested `executed_tool_calls` remains insufficient: that metadata describes attempts, not successful completions.

Claude PostToolUse records Read and Skill. Pi's tool_result extension records successful read tools. Both collectors discard output bodies, fail open, and validate paths against the locally observed installation manifest. Configuration installation/uninstallation preserves unrelated settings and backs up modified files. No manual Pi expansion hook is claimed; upstream currently exposes no trustworthy completion event for it.

Backfill advances bounded directory and byte cursors, rescans changed directory checkpoints conservatively, refreshes pending file identities, and defers incomplete final lines instead of blocking all discovery. Oversized records and inherited Pi fork entries remain explicitly omitted. Per-harness coverage and backfill progress survive normal refresh and publication. Background passes execute outside rendering; the standalone CLI can run continuously or one pass at a time. The journal is durable history; visible counts and recent events remain bounded, not lifetime totals.

Validation includes disposable hook/trace deduplication; live Node execution of generated Claude hook commands; actual Pi CLI extension loading; and an actual Pi tool lifecycle against a localhost deterministic provider. The Pi acceptance executes successful installed-skill, failed-skill and ordinary-file reads, expecting exactly one journal event. This verifies runtime tool execution, not real-model skill selection or manual expansion. Unit coverage also exercises concurrent writers, dead/live locks, interrupted journals, directory churn, multi-batch discovery, large files and partial JSONL appends.

## Machine rollout

The collectors were installed on the MacBook, Mac mini and Desktop after previewing the settings changes in disposable homes. Existing Claude settings were preserved and backed up; Pi received a dedicated Skilloom extension. The installed worker is an immutable standalone bundle under each machine's `~/.local/share/skilloom/collectors/` directory. Existing Pi sessions need `/reload` or a restart to load the extension.

The generated Claude shell hook was exercised with synthetic successful-read payloads on all three machines, including hook/trace deduplication and uninstall. This is a real shell/collector check, not a real Claude model session. Mini and Desktop completed the first directory traversal; the MacBook's larger traversal was still running at this checkpoint. Completion of traversal does not remove parser, retention or unsupported-event limitations.

Derived publication previews were checked before publishing all three observations. A fresh MacBook inventory then loaded the published remote histories (16 retained events on Mini and 45 on Desktop at this checkpoint). Raw logs, hook payloads and installation manifests were not published.
