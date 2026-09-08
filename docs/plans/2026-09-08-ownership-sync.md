# Ownership-aware synchronization

Implement the accepted project/global ownership contract and a local sync command.

- Git-tracked skill files belong to the project. Inventory displays them; reconciliation does not install over or remove them, including stale adoption records. Conflicting explicit requirements are reported.
- Workspace discovery excludes linked Git worktrees, retains independent clones, and deduplicates overlapping real paths. Git file layouts such as submodules are not automatically classified as worktrees.
- Adoption requires consistent personal installations across independent clones. It does not union their skills or create empty project policy entries.
- `add` defaults to the assigned global profile; `--project` targets personal canonical project policy; `--project --shared` edits the repository manifest.
- `connect REPOSITORY` migrates local configuration conservatively with a backup and without losing machine identity or installation ownership.
- `sync` pulls configuration, previews concrete checkout operations, applies with consent, verifies installed state, and publishes managed-storage observations. Dry runs never install. Failure or unresolved conflict cannot report convergence.
- Synchronization does not pull project Git repositories, run commands remotely, or upgrade skill content revisions. Exact revision locking remains future work and must not be implied by convergence.

Verification uses existing CLI/inventory seams, disposable Git clones and worktrees, and isolated skill installations. Run repository verification, package smoke checks and diff checks. No acceptance command may modify real user skills.
