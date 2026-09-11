# skilloom

## 0.1.0

### Minor Changes

- bdbeb10: Publish the first stable Skilloom CLI with automated canary and production releases.
- 6d2126d: Add connect and verified local sync, default-profile and project add shortcuts, repository-owned skill protection, and linked worktree exclusion. Preserve differences between independent clones during adoption and show project skill observations by machine in the cached dashboard.
- ff1f590: Add declared invocation modes and observed harness usage to skill inventory and Library rows. Interpret supported harness declarations separately, cache bounded local trace scans, and show evidence counts and coverage in details. Publish only metadata and usage summaries; preserve remote snapshot boundaries and cached TUI startup.
- 9e0f537: Add workspace onboarding with existing-skill adoption, cross-project inventory and reconciliation, atomic policy commands, multi-machine observations, and a state-first terminal dashboard.

### Patch Changes

- ff1f590: Replace repeated scanner-status tables with selected-skill session counts by machine and agent. Explain missing evidence, unknown identity, uncollected observations and paused history in plain language, and remove duplicate installation-level usage totals.
- ff1f590: Use Left/Right to cycle machines in Results with a visible selector, preserving the selected skill when available. Keep search and scope filters while switching. In search, horizontal arrows move the text cursor and typing or backspace edits at that position.
- ff1f590: Limit historical usage collection to a two-minute run with saved progress and an explicit paused state. Keep recent-event refreshes active without restarting old-history scans; allow another bounded run through refresh or the CLI. Reduce repeated discovery and cache-processing work during historical collection.
- ff1f590: Attribute skill read evidence to verified installation paths on each machine, invalidate legacy name-only read caches, and distinguish unscanned and partial fleet coverage in the Library. Keep explicit name-only invocations separate in details.
- ff1f590: Simplify terminal browsing around explicit search, results, and full-page skill details. Escape preserves search and selection, arrow keys leave search editing, and Enter opens details consistently at every width. Replace the machine rail and dense inspector with a compact read-only preview, group repeated installations, and reveal paths, timestamps, and full agent coverage only when requested.
- ff1f590: Make Machines, Changes, and Settings selectable menus with consistent arrow, Enter, Escape, and reverse-Tab navigation. Show only relevant controls and selected-item context. Browse a machine with a return path, inspect saved changes separately from a fresh sync review, and open Settings actions without memorizing shortcuts.
- ff1f590: Show a concise Invocation column alongside skill names, with Automatic covering skills that support automatic invocation, including those also invoked manually, and Unknown for unavailable metadata. Keep exact declarations and read evidence in details and label machine counts clearly.
  
  Add machine-scoped recent activity in skill details, retain private trace content locally, and recognize successful native Codex shell results and archived sessions.
- ff1f590: Add an Ink terminal library for browsing skills across machines and scopes, inspecting sources and ownership, filtering observations, and reviewing sync or migration before applying changes. Include setup, profile copying and assignment, requirement editing, and source verification flows.
  
  Preserve distinct checkout facts in published observations without exposing local paths. Add cached inventory, occurrence queries, bounded scan concurrency, and progress reporting. Run pinned skills 1.5.25 directly and distinguish canonical installation coverage from detected agents to avoid repeated additions.
  
  Add verified local source provenance, preservation of machine-specific global profiles, and backed-up migration of obsolete adoption claims. Sync checks reviewed fingerprints, reports application, verification, and publication separately, and preserves partial-success results when publication fails.
  
  Migration requirement removals now use configuration version 2 with shared ownership releases, preventing another machine from deleting previously managed installations after pulling the policy change. Older clients reject version 2; participating machines must upgrade before their next sync. Releases are acknowledged once per checkout and preserve subsequent deliberate adoption and removal.
- ff1f590: Enrich older Library snapshots with local metadata in the background while browsing remains available. Explain missing evidence and unknown invocation modes. Make Enter and i open one complete details view, removing the hidden technical-details toggle while retaining grouped checkout facts.
- ff1f590: Present skill details as a responsive property sheet with separate installation and agent behavior sections, aligned values, readable path wrapping, and tabular machine scan coverage.
- ff1f590: Remove the Machines menu and expose sync prominently in Library. Keep machine browsing on left/right arrows, label the local sync target even while browsing remote observations, and preserve Library context when canceling a sync review. Renumber Changes and Settings to 2 and 3.
- efe7441: Read invocation declarations for installed skills with display names such as "Agent Browser" through their observed paths. Keep inferred paths restricted to safe directory names, and migrate older reader metadata without rejecting versioned snapshots.
- 7e58b8e: Run packaged CLI PTY acceptance on both macOS and Linux.
- ff1f590: Add bounded read-only installation diagnostics in Library and `doctor --installations`. Report exact missing targets, unreadable entries and invalid skill locations alongside root coverage, without inferring deletion, consolidation or update recommendations. Preserve Library selection on return, keep remote snapshots separate from local checks, and support uninitialized machines without writing state.
- ff1f590: Read OpenClaw invocation declarations and qualified skill names, and refresh cached declarations after reader upgrades. Keep missing requirements out of installed invocation summaries and explain unsupported readers in details.
- ff1f590: Show verified sessions using each skill instead of trace-file or repeated-read counts. Group retained evidence by native session, preserve installation and machine boundaries, and show recent sessions with last-use timestamps. Keep missing session identity explicit and group Codex subagents under verified root-session metadata without changing existing event identities or resetting backfill progress.
- ff1f590: Add private local usage journals, opt-in Claude Code and Pi read collectors, and verified Codex selected-skill metadata. Resume historical scans from persistent file and directory checkpoints, deduplicate hooks and transcripts, and show per-agent coverage in skill details without blocking navigation. Include a standalone worker for machine-local collectors and explicit preview/publication of derived observations.
