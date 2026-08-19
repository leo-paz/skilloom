# Skilloom design

## Purpose

Skilloom keeps Agent Skills consistent across a user's machines and projects while delegating installation, removal, listing, and updates to the `skills` CLI. It is a focused skill-policy manager, not a general machine configuration system.

The product is public and must work for users who have never used a dotfiles manager, Ansible, or Nix. Experienced users can compose Skilloom with those tools through non-interactive commands and configurable file paths.

## Product boundary

Skilloom owns:

- reusable global skill profiles;
- machine-to-profile assignments;
- project-level skill requirements;
- desired-state resolution and drift detection;
- human-readable plans before changes;
- an interactive terminal workflow;
- non-interactive commands and JSON output for automation; and
- managed Git synchronization or user-selected configuration storage.

Skilloom does not:

- copy skill directories directly;
- replace the `skills` CLI or its `skills-lock.json` files;
- manage operating system packages, services, or general dotfiles;
- execute arbitrary shell commands from configuration;
- push configuration to remote machines over SSH; or
- require a hosted Skilloom account or backend.

## Name and distribution

The product, repository, npm package, executable, and configuration namespace use the same name:

- Product: Skilloom
- Repository: `github.com/leo-paz/skilloom`
- npm package: `skilloom`
- Commands: `npx skilloom` and `bunx skilloom`
- User configuration: `~/.config/skilloom/`
- Project manifest: `.skilloom.yaml`

The name combines "skill" with "loom," the frame used to weave threads into cloth. Skilloom combines global profiles, machine selection, and project requirements into one resolved skill set.

The repository will be MIT licensed. Publishing the npm package requires separate approval.

## User experience

Running `skilloom` without a subcommand opens a guided terminal interface. The initial menu supports:

- reviewing planned changes;
- applying configuration;
- managing global profiles;
- configuring the current project;
- selecting the current machine profile;
- updating installed skills; and
- diagnosing the local setup.

The same operations remain available as scriptable commands:

```text
skilloom init
skilloom plan
skilloom apply
skilloom status
skilloom update
skilloom project init
skilloom config
skilloom doctor
```

Mutating commands show a plan first in interactive sessions. Automation can opt into changes with `--yes`. Commands support `--json` where structured output is useful. `plan --check` exits nonzero when the installed state differs from the desired state.

## Configuration and synchronization

During `skilloom init`, users select one storage mode:

1. Managed Git, the default. Skilloom creates or connects to a configuration repository and manages pull, commit, and push operations.
2. Existing config file. Skilloom reads and writes a user-selected path, which may be managed by dotfiles, Nix Home Manager, Ansible, or another tool.
3. Local only. Skilloom stores configuration in the platform-appropriate user configuration directory without remote synchronization.

The shared YAML configuration contains reusable profiles and machine assignments. It contains no credentials or access tokens. Git uses the user's existing credential setup.

Each machine pulls shared desired state and applies it locally. A stable local machine identifier selects the assigned profile. Machine-specific paths stay local unless the user deliberately includes them in shared configuration.

## Project configuration

A project may commit `.skilloom.yaml` so its skill requirements travel with the repository. Personal project overrides remain in the user's shared or local Skilloom configuration.

Project requirements are additive. A project cannot reliably disable a globally installed skill because an agent may still discover the global copy. A project manifest may extend a named project profile and add skills or agent targets.

Skilloom inspects the current Git repository and user-configured code directories. It does not scan the entire disk or require access to every GitHub repository. A repository that is not cloned has no local skill state to reconcile.

Skilloom invokes project-scoped `skills` commands from the project root and preserves the underlying `skills-lock.json` behavior. It does not introduce another package lock format.

## Resolution and execution

The resolver combines:

1. the selected global profile;
2. the current machine assignment;
3. an optional reusable project profile;
4. the project's committed requirements; and
5. personal project additions.

The result is a normalized desired state grouped by scope and agent. Skilloom compares this state with `npx skills list --json` for project scope and `npx skills list --global --json` for user scope.

The planner produces typed operations such as add, remove, and update. The executor converts only those operations into supported `npx skills` commands. Arguments are passed without a shell to prevent command injection. Skill sources and names are validated before execution.

Applying the same desired state repeatedly is idempotent. Partial failures retain command output, mark remaining operations as unapplied, and return a nonzero exit code. A later apply recomputes state rather than assuming the previous plan completed.

## Technical architecture

Skilloom starts as one TypeScript package:

```text
src/core/       schemas, configuration, profiles, resolution, planning
src/cli/        commands, output formats, process execution
src/tui/        guided terminal workflows
tests/          unit, integration, and packaged-command tests
```

Technology choices:

- Node.js and Bun supported runtimes;
- `citty` for commands and arguments;
- `@clack/prompts` for interactive terminal flows;
- Zod for external data validation;
- YAML for user-authored configuration;
- Vitest for unit and integration tests;
- `tsup` for an ESM npm package; and
- Biome for formatting and linting.

The package avoids React, Ink, a local web server, and a browser UI in version 1. Git operations use the installed `git` executable. The GitHub CLI is an optional onboarding helper, not a runtime requirement.

## Compatibility

Version 1 supports macOS and Linux. Node and Bun compatibility is tested independently in CI. Packaged smoke tests run the built executable through both runtimes.

Skilloom remains friendly to external configuration managers:

- configuration paths are overridable;
- interactive actions have non-interactive equivalents;
- plans have stable JSON output;
- drift has a documented exit code; and
- apply is idempotent.

Windows support is deferred until path, process, symlink, and terminal behavior can be tested on Windows.

## Security and privacy

Skilloom stores no GitHub, npm, or agent tokens. It inherits credentials from existing tools. Telemetry is disabled by default. Configuration cannot define arbitrary commands.

Plans display the executable and arguments before changes. Logs redact environment values and avoid recording credentials that child processes may emit. Managed Git refuses to overwrite uncommitted configuration changes and reports the conflict for the user to resolve.

## Verification

Core behavior is developed test-first. Tests cover schema errors, profile resolution, project precedence, drift calculation, command construction, idempotency, partial failures, and malicious input rejection.

Integration tests use temporary directories and a fake `skills` executable to verify filesystem and process behavior without changing the developer's installed skills. Packaged smoke tests verify `--help`, `--version`, `plan`, and JSON output under Node and Bun.

Before release, a manual terminal pass covers initialization, profile editing, project initialization, plan review, apply confirmation, narrow terminals, cancellation, invalid configuration, and an unavailable Git remote.

## Initial non-goals

- Browser or desktop UI
- Hosted accounts or cloud database
- Background daemon or automatic login hook
- Remote execution over SSH
- Direct Ansible, Nix, or dotfiles-manager integrations
- npm publication without explicit approval
- Windows support
