---
"skilloom": patch
---

Add bounded read-only installation diagnostics in Library and `doctor --installations`. Report exact missing targets, unreadable entries and invalid skill locations alongside root coverage, without inferring deletion, consolidation or update recommendations. Preserve Library selection on return, keep remote snapshots separate from local checks, and support uninitialized machines without writing state.
