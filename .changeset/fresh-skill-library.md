---
"skilloom": patch
---

Add an Ink terminal library for browsing skills across machines and scopes, inspecting sources and ownership, filtering observations, and reviewing sync or migration before applying changes. Include setup, profile copying and assignment, requirement editing, and source verification flows.

Preserve distinct checkout facts in published observations without exposing local paths. Add cached inventory, occurrence queries, bounded scan concurrency, and progress reporting. Run pinned skills 1.5.25 directly and distinguish canonical installation coverage from detected agents to avoid repeated additions.

Add verified local source provenance, preservation of machine-specific global profiles, and backed-up migration of obsolete adoption claims. Sync checks reviewed fingerprints, reports application, verification, and publication separately, and preserves partial-success results when publication fails.

Migration requirement removals now use configuration version 2 with shared ownership releases, preventing another machine from deleting previously managed installations after pulling the policy change. Older clients reject version 2; participating machines must upgrade before their next sync. Releases are acknowledged once per checkout and preserve subsequent deliberate adoption and removal.
