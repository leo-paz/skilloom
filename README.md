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

`setup` scans Git repositories up to three directories beneath `~/dev`. It asks the upstream `skills` CLI for global installations and for project installations in every repository it finds. Installations with a known source and agent are adopted without being reinstalled; unknown installations remain visible and unmanaged.

If you omit the workspace, Skilloom uses existing conventional roots such as `~/dev`, `~/Developer`, `~/projects`, `~/code`, and `~/src`. It does not scan the whole home directory.

The bare command opens the terminal dashboard. An agent can inspect the same state without prompts:

```sh
bunx --bun skilloom@canary inventory --json
```

Use `npx skilloom@canary` instead if you prefer Node. Stable releases use `@latest`.

No projects is a valid result. Add a workspace later by rerunning `setup /path/to/workspace`. Use `--depth 1` through `--depth 8` to change the bounded scan depth, or `--no-adopt` to inventory existing skills without managing them.

## Add and change skills

Global policy lives in profiles. A machine is assigned to one profile:

```sh
skilloom add code-review tdd --source mattpocock/skills --to profile:default
skilloom edit tdd --in profile:default --agents codex,claude-code
skilloom move tdd --from profile:default --to project:skilloom
skilloom remove tdd --from project:skilloom
```

Project targets accept a canonical repository identity such as `project:github.com/leo-paz/skilloom` or an unambiguous short name such as `project:skilloom`.

These commands change desired policy; they do not immediately mutate installations. Review and apply all local changes explicitly:

```sh
skilloom plan --all --json
skilloom apply --all --yes --json
```

Shared project policy can be committed as `.skilloom.yaml`:

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

Project policy is additive. Skilloom only removes a project installation when its local state records that Skilloom previously added or adopted it. The upstream CLI continues to own `.agents/skills` and `skills-lock.json`.

## Multiple machines

Managed storage keeps desired policy in a private Git repository. The `--sync` form is the shortest first-run setup:

```sh
# Mac mini
skilloom setup ~/dev --sync git@github.com:you/skilloom-config.git --machine-name "Mac mini"

# MacBook
skilloom setup ~/dev --sync git@github.com:you/skilloom-config.git --machine-name "MacBook"
```

Each machine has its own workspace paths and stable identity. Those paths stay local. Profiles, personal project policy, machine names, and assignments are shared.

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

# 4. Review and apply this machine's global and project changes.
skilloom plan --all --json
skilloom apply --all --yes --json

# 5. Optionally publish an observation when managed storage is configured.
skilloom observe --publish --json
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
- `inventory` reports machines and profiles plus this machine's projects, installations, ownership, and drift.
- `add`, `edit`, `move`, and `remove` atomically edit global-profile or personal-project policy.
- `plan --all` and `apply --all` reconcile every discovered checkout plus global state.
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
