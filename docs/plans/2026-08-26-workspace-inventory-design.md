# Workspace inventory and dashboard design

## Outcome

Skilloom onboarding discovers projects beneath approved workspace roots, inventories existing skills through the upstream `skills` CLI, adopts eligible installations, and opens a state-first terminal dashboard. Agents receive the same normalized state through JSON commands.

## Compatibility

- Existing version 1 configuration remains valid.
- Existing `init`, `config`, `project`, `plan`, `apply`, `status`, `update`, and `doctor` commands remain available.
- Unrelated and source-unknown installations remain untouched.
- All skill listing and mutation continues through the upstream `skills` CLI.
- A background daemon remains out of scope.

## Public interfaces

### Setup

`skilloom setup [WORKSPACE]` initializes or connects configuration, records a local workspace root, discovers Git repositories to a bounded depth, inventories existing global and project skills, and adopts eligible installations. `--no-adopt` keeps every existing installation unmanaged. Setup never installs or removes a skill.

### Inventory

`skilloom inventory` returns the current machine, configured machines and profiles, discovered projects and checkouts, installed skills, ownership, desired state, and drift. JSON output is the agent interface. The terminal dashboard renders the same result.

### Policy editing

`skilloom add`, `edit`, `move`, and `remove` update profile or personal project policy in one configuration transaction. A project target resolves by normalized repository identity or an unambiguous repository name. Shared project policy remains available through the existing project commands.

### Observation

`skilloom observe` refreshes and stores the local inventory. `--publish` writes a path-redacted observation to managed Git storage and commits only when its semantic contents changed. Observation never applies desired state.

## Discovery

- Scan only explicit workspace roots.
- Default to depth three.
- Recognize `.git` directories and worktree files.
- Stop descending after finding a repository.
- Ignore hidden directories, dependency directories, caches, and build output.
- Normalize common SSH and HTTPS remotes into one project identity.
- Use a machine-local identity when a repository has no remote.

An empty scan succeeds and reports whether no repositories were found, no skills were found, paths were skipped, or the scan failed.

## Adoption

Setup queries global installations once and project installations once per discovered checkout. An installation is eligible when upstream reports a source and at least one agent. Eligible global skills enter the selected profile. Eligible project skills become personal project policy. Setup records adopted installations as managed without reinstalling them. Unknown-source or unknown-agent installations remain visible and unmanaged. Machine-local sources also remain unmanaged when the configuration is Git-synchronized, so onboarding cannot publish a private path or create broken desired state on another machine.

## Multi-machine state

Managed Git distributes desired policy. It does not execute on remote machines. Each machine must run Skilloom to apply policy locally. Published observations are per-machine reports and may be stale. They omit absolute checkout paths.

## TUI

Running `skilloom` in a terminal shows machine identity, active profile, global skill counts, project counts, drift, and remote observation age before offering actions. Detailed actions move behind the overview rather than occupying the first screen.

## Scheduling

Long-lived daemons and automatic reconciliation remain deferred. A future scheduler may use launchd or systemd to run a stable installed executable in observation-only mode. Bunx cache paths are not suitable scheduled executable paths.

## Verification seams

- Inventory behavior through one injected inventory interface.
- CLI behavior through commands and JSON results.
- Reconciliation through `plan` and `apply`.
- TUI behavior through its rendered view model and packaged PTY acceptance.

Internal scanner helpers and prompt plumbing do not receive separate tests.
