# Session evidence audit — 13 September 2026

## Counting contract

Count distinct machine + harness + verified native session identities for a skill, not read or invocation totals. Preserve installation paths in the evidence index so a read from one installation cannot be attributed to every same-name skill. A Library row can merge matching paths and name-only evidence within one native session. Repeated reads, resumed sessions and duplicate copies of the same log must not increase this count.

The existing grouping already follows this contract. A regression test now covers one session reading two installations and invoking a name-only Skill tool: three attribution records, one Library session. Conflicting verified session attribution must remain unknown rather than depend on discovery order.

## Primary-source verification

### Codex

The local upstream checkout is `e1b23086acbf905592036c587cb37a12d68c441e`.

- [`SessionMeta`, protocol.rs](https://github.com/openai/codex/blob/e1b23086acbf905592036c587cb37a12d68c441e/codex-rs/protocol/src/protocol.rs#L3050) explicitly defines `session_id` as the root thread ID. `id` is the thread identity; subagent/fork metadata is separate. Count root sessions while retaining original thread/call identity for evidence deduplication.
- [Skill prompt loading](https://github.com/openai/codex/blob/e1b23086acbf905592036c587cb37a12d68c441e/codex-rs/ext/skills/src/host_prompt.rs) and [classified fragments](https://github.com/openai/codex/blob/e1b23086acbf905592036c587cb37a12d68c441e/codex-rs/ext/skills/src/fragments.rs) support the current selected-instruction adapter. Ordinary user text containing skill markup is not equivalent evidence.
- General JavaScript execution wrappers and attempted nested tool metadata cannot establish that a nested read succeeded. Missing original creation metadata in inherited child history prevents reliable new-session attribution; reading more bytes cannot reconstruct it.

### Claude Code

Current official [hook documentation](https://code.claude.com/docs/en/hooks#posttooluse) defines PostToolUse as successful completion. Its native `session_id` stays separate from subagent `agent_id`. The [subagent documentation](https://code.claude.com/docs/en/sub-agents#resume-subagents) describes nested transcript files, separate persistence and retention cleanup. A metadata-only sample of 20 MacBook subagent traces matched each record's native `sessionId` to its parent session directory; no transcript content was emitted.

The newly documented [UserPromptExpansion](https://code.claude.com/docs/en/hooks#userpromptexpansion) covers direct slash commands, but runs before delivery and can block expansion. It cannot alone prove successful skill loading. The public Claude Code repository does not provide its transcript writer implementation; structured traces and documented hooks remain the compatibility boundary.

### Pi

The local upstream checkout is `2edd6b432a4e1eed0a70270540d9a78d12aea7e9`.

- [`createBranchedSession` and `forkFrom`, session-manager.ts](https://github.com/badlogic/pi-mono/blob/2edd6b432a4e1eed0a70270540d9a78d12aea7e9/packages/coding-agent/src/core/session-manager.ts#L1286) create a new session header and copy previous entries unchanged. The current inherited-time boundary avoids crediting old reads to a new fork or resolving them against the fork's different cwd. Records at the same millisecond as fork creation remain ambiguous.
- [`_expandSkillCommand`, agent-session.ts](https://github.com/badlogic/pi-mono/blob/2edd6b432a4e1eed0a70270540d9a78d12aea7e9/packages/coding-agent/src/core/agent-session.ts#L1173) reads the skill and expands it into an ordinary user-message block. The retained text lacks a trusted successful-expansion marker. Counting pasted matching blocks would inflate usage, so this path remains unsupported historical evidence.
- Successful read tool results and the installed lifecycle collector retain actual native session IDs. Multiple branches within the same session stay one session; a newly created fork only receives evidence for new work.

## Completeness implications

A complete traversal of retained supported logs is achievable without loading transcripts together in memory. It does not establish every historical invocation: manual expansion gaps, disabled or deleted logs, unsupported custom tools and ambiguous copied history remain explicit limitations.

The previous implementation computed session summaries from a 10,000-event cache. That meant even a full traversal could lose distinct sessions when many reads displaced older events. Retention for recent activity must be separate from durable session accounting. Journal deduplication and conflict handling must survive that change; simply incrementing counters on each parsed record is incorrect.
