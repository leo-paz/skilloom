# Skilloom

Skilloom keeps Agent Skills consistent across machines and projects. It resolves a small YAML policy, shows the difference from the installed state, then delegates every installation, removal, list, and update to the [`skills` CLI](https://github.com/vercel-labs/skills).

Skilloom does not copy skill directories itself. It does not replace `skills-lock.json`, run configuration as shell code, manage operating system packages, or contact remote machines.

## Requirements

- macOS or Linux
- Node.js 20 or newer, or Bun 1.2 or newer
- `npx`, `git`, and the current `skills` package

## Quick start

After the first canary workflow completes, test the current `main` build without cloning the repository:

```sh
npx skilloom@canary --help
```

Stable releases use the `latest` tag:

```sh
npx skilloom@latest --help
```

From a checkout:

```sh
npm install
npm run build
npm link
skilloom init
skilloom project init
skilloom plan
skilloom apply
```

Running `skilloom` in an interactive terminal opens a guided menu. Scripts should use a subcommand and pass `--yes` for mutations.

```sh
skilloom plan --check
skilloom plan --json
skilloom apply --yes --json
skilloom status --json
```

`plan --check` returns `0` when converged and `2` when it finds drift. Invalid input returns `3`, an upstream execution failure returns `4`, and cancellation returns `5`.

## User configuration

The default file is `~/.config/skilloom/config.yaml`. `XDG_CONFIG_HOME`, `SKILLOOM_CONFIG`, and `--config` can override that path. A local machine identifier in the same application directory selects the machine profile.

```yaml
version: 1
storage:
  mode: local
profiles:
  default:
    skills:
      - source: vercel-labs/agent-skills
        name: web-design-guidelines
        agents: [codex]
machines:
  96566df3-d264-4563-bc62-82dbafe2e111:
    profile: default
projectProfiles:
  web:
    skills:
      - source: vercel-labs/agent-skills
        name: web-design-guidelines
        agents: [codex]
projects: {}
```

`skilloom config` prints the active path and machine assignment. `skilloom config --profile NAME` changes the assignment to an existing global profile.

Profile and skill edits also have noninteractive forms:

```sh
skilloom config --add-profile work
skilloom config --add-skill review --source acme/skills --to-profile work --agent codex
skilloom config --remove-skill review --from-profile work
skilloom config --remove-profile work
```

## Project configuration

Commit `.skilloom.yaml` with the repository:

```yaml
version: 1
profile: web
skills:
  - source: acme/agent-skills
    name: repository-review
    agents: [codex]
```

Project policy is additive. A project cannot hide a global skill. Skilloom removes a project skill only when its local state file records that Skilloom previously added it. Unrelated installations remain untouched.

The guided menu can edit project requirements. Scripts can use the same service directly:

```sh
skilloom project add --source acme/agent-skills --skill repository-review --agent codex
skilloom project remove --skill repository-review
```

Skilloom runs project-scoped `npx skills` commands at the Git repository root. The upstream CLI owns `.agents/skills` and `skills-lock.json`.

## Storage modes

Local mode writes the default configuration directory:

```sh
skilloom init --storage local
```

External mode points at a file managed by dotfiles, Ansible, Nix, or another tool:

```sh
skilloom init --storage external --path /path/to/config.yaml
```

Managed mode clones a Git repository into the Skilloom application directory. Skilloom uses the user's existing Git credentials and performs fast-forward pulls plus ordinary commits and pushes.

```sh
skilloom init --storage managed --repository git@github.com:you/skilloom-config.git
```

Managed mode refuses to pull over uncommitted changes. It never resets, force-pushes, or merges a conflict.

## Commands

- `init` creates local, external, or managed user configuration.
- `plan` displays sorted add and remove operations with their reasons.
- `apply` confirms, then runs safe `npx skills` argument arrays without a shell.
- `status` reports convergence without the check exit code.
- `update` delegates project and global updates to `npx skills update`.
- `project init` writes an empty `.skilloom.yaml` in the current Git repository. `project add` and `project remove` edit its skill list.
- `config` reports paths, creates and removes profiles, edits profile skills, and changes the current machine profile.
- `doctor` checks the runtime, Git, npx, skills, project discovery, repository state, and configuration.

All commands that return structured data support `--json`. Errors use `{ "ok": false, "error": { "code": "...", "message": "..." } }`.

## Failure and recovery

Apply stops on the first failed upstream command. Its output separates completed operations from pending ones and returns exit code `4`. Skilloom records each successful operation before continuing. Rerunning apply reads the installed state again and creates a fresh plan.

Configuration cannot contain commands or extra executable arguments. Skill sources, names, agents, upstream JSON, and YAML versions are validated. Skilloom does not store credentials or telemetry.

## Development

```sh
npm test
npm run typecheck
npm run lint
npm run build
npm run smoke
npm run verify
npm run changeset
```

`npm run smoke` packs the package once and runs that tarball through Node and Bun projects. `npm run verify` runs local checks, the two-machine Git integration test, package smoke tests, and disposable real project-scope acceptance. Real global acceptance requires an isolated home and an explicit opt-in:

```sh
SKILLOOM_ALLOW_GLOBAL_ACCEPTANCE=1 bash scripts/global-acceptance.sh
```

The test refuses to start if it cannot create and verify an empty isolated Codex home. It never uses the normal user skill directory.

## Releases

Every ordinary pull request includes a Changeset. CI checks this with `npx changeset status --since=origin/main`.

When a pull request merges to `main`, the release workflow verifies the package, publishes a snapshot under the npm `canary` tag, and creates or updates `changeset-release/main`. Merging that generated release pull request publishes the stable version under `latest`, creates a Git tag and GitHub release, and skips the canary publish for that commit.

See [the release runbook](docs/releases.md) for the one-time npm and GitHub setup.

## Release policy

Publishing is owned by `.github/workflows/release.yml`. Windows support, hosted accounts, background services, remote execution, and automatic SSH setup are outside version 1.
