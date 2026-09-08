# Skilloom

Skilloom shows and reconciles Agent Skills across machines and Git projects. It discovers repositories beneath a workspace such as `~/dev`, adopts existing installations, stores desired policy, and delegates installation work to the [`skills` CLI](https://github.com/vercel-labs/skills).

It never copies skill directories itself, contacts another machine, or removes an installation it does not own.

## Requirements

- macOS or Linux
- Node.js 20+ or Bun 1.2+
- `npx`, `git`, and the current `skills` package

## Start with Bun

Run the current canary without installing it:

```sh
bunx --bun skilloom@canary setup ~/dev
bunx --bun skilloom@canary
```

`setup` scans Git repositories up to three directories beneath `~/dev`, excluding linked Git worktrees. Independent clones remain separate installation targets. It inspects global and project installations through the upstream `skills` CLI. Known-source personal installations are eligible for adoption; Git-tracked skill files belong to the repository and remain under Git's control. Skills that differ between independent clones stay unmanaged instead of being copied between clones.

If you omit the workspace, Skilloom uses existing conventional roots such as `~/dev`, `~/Developer`, `~/projects`, `~/code`, and `~/src`. It does not scan the whole home directory.

The bare command opens the terminal dashboard from the saved observation when available, displaying its timestamp. Refresh explicitly to check current state. View skills selects a project and shows its local checkouts and published observations from other machines. An agent can inspect current state without prompts:

```sh
bunx --bun skilloom@canary inventory --json
```

Use `npx skilloom@canary` instead if you prefer Node. Stable releases use `@latest`.

No projects is a valid result. Add a workspace later by rerunning `setup /path/to/workspace`. Use `--depth 1` through `--depth 8` to change the bounded scan depth, or `--no-adopt` to inventory existing skills without managing them.

## Add and change skills

Global policy lives in profiles. A machine is assigned to one profile, which is the default destination for `add`:

```sh
skilloom add code-review tdd --source mattpocock/skills
skilloom edit tdd --in profile:default --agents codex,claude-code
skilloom move tdd --from profile:default --to project:skilloom
skilloom remove tdd --from project:skilloom
```

Project targets accept a canonical repository identity such as `project:github.com/leo-paz/skilloom` or an unambiguous short name such as `project:skilloom`.

These commands change desired policy; they do not immediately mutate installations. Sync pulls shared policy, previews changes, installs locally, verifies the result, and publishes an observation when Git storage is connected:

```sh
skilloom sync --dry-run --json
skilloom sync --yes --json
```

For a personal requirement that follows the same repository across your machines, run this inside the repository:

```sh
skilloom add code-review --source mattpocock/skills --project
skilloom sync
```

The repository's remote identifies the project, so local paths may differ. Machines without that repository skip it. Explicit project policy targets every discovered independent clone; each operation names its exact path. `--project` requires a remote and rejects linked worktrees.

Add `--shared` to write `.skilloom.yaml` for collaborators, then commit the file through your normal Git workflow:

```sh
skilloom add code-review --source mattpocock/skills --project --shared
```

Shared project policy can also be written directly:

```yaml
version: 1
skills:
  - source: acme/agent-skills
    name: repository-review
    agents: [codex]
```

From inside the repository, this creates the file on the first add—`project init` is optional:

```sh
skilloom project add --source acme/agent-skills --skill repository-review --agent codex
skilloom project remove --skill repository-review
```

Project policy is additive. Git-tracked skill contents and tracked skill links are repository-owned: Skilloom displays them but does not overwrite or remove them, even if old state recorded them as managed. Conflicting requirements block synchronization. Git distributes those tracked files; Skilloom never pulls your project repositories. A manifest whose skill files are untracked can declare dependencies that Skilloom installs.

Personal installations are removable only when local state records Skilloom ownership. The upstream CLI performs installation and maintains `skills-lock.json`.

## Multiple machines

Managed storage keeps desired policy in a private Git repository. The `--sync` form is the shortest first-run setup:

```sh
# Mac mini
skilloom setup ~/dev --sync git@github.com:you/skilloom-config.git --machine-name "Mac mini"

# MacBook
skilloom setup ~/dev --sync git@github.com:you/skilloom-config.git --machine-name "MacBook"
```

Each machine has its own workspace paths and stable identity. Those paths stay local. Profiles, personal project policy, machine names, and assignments are shared.

For an existing local setup, connect it without resetting installation state or machine identity:

```sh
skilloom connect git@github.com:you/skilloom-config.git
skilloom sync --dry-run --json
skilloom sync --yes --json
```

The repository must already exist and be accessible through your Git credentials. `connect` retains a local configuration backup and switches storage only after successful publication. Identical or disjoint configuration entries merge; conflicting entries require resolution. Local-only sources and project identities cannot be shared. Connecting does not repair policies previously created by older adoption behavior: inspect existing requirements before applying them.

Run `sync` on each machine. It never triggers execution on another computer. Without `--yes`, interactive sync previews installation changes and asks for confirmation; noninteractive mutation returns cancellation. `--dry-run` can fetch shared configuration but never installs or publishes an observation. Failed verification returns exit code 2 with pending work; failed upstream execution returns 4. An incomplete scan or repository ownership conflict blocks application.

Sync compares skill name, source, and agent coverage. It does not upgrade content, pin identical revisions across machines, or detect edits to untracked skill contents. Use an explicit `update` on each machine for source updates. Exact content revision tracking is not implemented, so convergence is a policy result, not proof of identical file contents.

`inventory` always observes the current machine. A machine can publish a path-redacted snapshot so the dashboard on another machine can show its last known state:

```sh
skilloom observe --publish --json
```

Publishing updates the managed Git repository only when the observed contents changed. It does not install, update, or remove a skill. Remote observations can be stale, and Skilloom never remotely executes on another computer.

There is no daemon in this release. A scheduler should eventually call a stable installed executable in observation-only mode; ephemeral `bunx` cache paths are not suitable launchd or systemd targets.

## Agent workflow

A coding agent can onboard and reconcile a machine without the TUI:

```sh
# 1. Discover projects and adopt existing installations.
skilloom setup ~/dev --json

# 2. Read normalized machine, project, skill, ownership, and drift state.
skilloom inventory --json

# 3. Make one atomic desired-policy change.
skilloom add research tdd --source mattpocock/skills --to profile:default --json

# 4. Review, then reconcile and publish this machine's result.
skilloom sync --dry-run --json
skilloom sync --yes --json
```

JSON failures use `{ "ok": false, "error": { "code": "...", "message": "..." } }`. `plan --check` returns `0` when converged and `2` for drift. Invalid input returns `3`, upstream execution failure returns `4`, and cancellation returns `5`.

## Configuration and compatibility

The default application directory is `~/.config/skilloom`. `XDG_CONFIG_HOME`, `SKILLOOM_CONFIG`, and `--config` can override the configuration path.

The shared YAML contains reusable global profiles, machine assignments, and personal project additions:

```yaml
version: 1
storage:
  mode: local
profiles:
  default:
    skills:
      - source: mattpocock/skills
        name: code-review
        agents: [codex]
machines:
  96566df3-d264-4563-bc62-82dbafe2e111:
    profile: default
    name: Mac mini
projectProfiles: {}
projects:
  github.com/leo-paz/skilloom:
    skills: []
```

Existing version 1 configuration and the original `init`, `config`, `project`, `plan`, `apply`, `status`, `update`, and `doctor` commands remain supported. The longer managed-storage form is also available:

```sh
skilloom init --storage managed --repository git@github.com:you/skilloom-config.git
```

Managed mode uses the user's existing Git credentials and permits only fast-forward pulls plus ordinary commits and pushes. It never resets, force-pushes, or automatically resolves a conflict.

## Command summary

- `setup [WORKSPACE]` initializes a machine, discovers projects, and adopts eligible existing skills.
- `connect REPOSITORY` migrates local configuration into shared Git storage with a backup.
- `sync [--dry-run] [--yes]` reconciles and verifies this machine, then publishes its observation when connected.
- `inventory` reports machines and profiles plus this machine's projects, installations, ownership, and drift.
- `add`, `edit`, `move`, and `remove` atomically edit global-profile or personal-project policy.
- `plan --all` and `apply --all` remain available for separate planning and application to independent clones plus global state.
- `observe [--publish]` refreshes local state and optionally publishes a redacted snapshot.
- `update [SKILL...] --scope global|project` delegates updates to `npx skills update`.
- `project add` and `project remove` edit shared `.skilloom.yaml` policy.
- `config` manages profiles and machine selection.
- `doctor` diagnoses the runtime, Git, `npx skills`, project discovery, and configuration.

## Development

```sh
npm test
npm run typecheck
npm run lint
npm run build
npm run smoke
npm run verify
```

`npm run smoke` packs the CLI once and executes that package under Node and Bun. `npm run verify` includes focused tests, two-machine Git integration, packaged execution, real disposable project-scope acceptance, PTY checks, and `npm pack --dry-run`.

Real global-scope acceptance is opt-in and replaces `HOME`, `XDG_CONFIG_HOME`, and `CODEX_HOME` with disposable directories before invoking upstream `npx skills`:

```sh
SKILLOOM_ALLOW_GLOBAL_ACCEPTANCE=1 bash scripts/global-acceptance.sh
```

The script refuses to start without the explicit opt-in and verifies the isolated global inventory is empty. It never uses the normal user skill directory.

## Releases

Every ordinary pull request includes a Changeset. After a merge to `main`, CI verifies and publishes a snapshot under the npm `canary` tag while Changesets opens or updates `changeset-release/main`. Merging that release PR publishes the stable version under `latest`, creates a Git tag and GitHub release, and skips the canary for that commit.

See [the release runbook](docs/releases.md) for npm and GitHub setup. The package is not published from developer machines.
