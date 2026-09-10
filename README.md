# Skilloom

Skilloom is a full-screen terminal library for Agent Skills across your machines and Git projects. Find a skill, inspect where it is installed and who manages it, then review the changes needed on this machine. The same operations are available as CLI commands with JSON output.

Skilloom discovers repositories beneath workspaces such as `~/dev`, stores desired policy, and delegates installation work to the [`skills` CLI](https://github.com/vercel-labs/skills).

It never copies skill directories itself, contacts another machine, or removes an installation it does not own.

## Requirements

- macOS or Linux
- Node.js 20+ or Bun 1.2+
- `git`

Skilloom includes an exact `skills@1.5.25` dependency. Installation and inventory commands run that executable directly; a separate global skills installation is unnecessary. `doctor` checks the active runtime, Git, and that pinned executable.

## Start with Bun

Run the current canary without installing it:

```sh
bunx --bun skilloom@canary setup ~/dev --preserve-global-profile macbook
bunx --bun skilloom@canary
```

`setup` scans Git repositories up to three directories beneath `~/dev`, excluding linked Git worktrees. Independent clones remain separate installation targets. It inspects global and project installations through the upstream `skills` CLI. Known-source personal installations are eligible for adoption; Git-tracked skill files belong to the repository and remain under Git's control. Skills that differ between independent clones stay unmanaged instead of being copied between clones.

If you omit the workspace, Skilloom uses existing conventional roots such as `~/dev`, `~/Developer`, `~/projects`, `~/code`, and `~/src`. It does not scan the whole home directory.

The bare command or `skilloom tui` opens the Ink interface in the terminal's alternate screen. It starts with the saved observation when available and shows its timestamp. Press `r` to refresh local state. If no configuration exists, the interface offers setup.

Skilloom executes on the computer where it is launched. The shared Git repository stores machine IDs, profiles, requirements, and published observations. A listed remote machine is registered, not necessarily reachable: Skilloom does not probe SSH or dispatch commands remotely. Run sync on each machine to apply its own configuration.

## Browse the skill library

The Library combines global and project skills across local checkouts and published remote observations. The list is always the active control while browsing. Its read-only preview summarizes the selected skill by source, ownership and machine. Enter or `i` opens the same full-width details view; repeated installations with the same facts are grouped. Details include checkout paths, full agent coverage, invocation declarations, usage evidence, and observation timestamps; use ↑/↓ to scroll and Esc to return. Details use aligned labels and values, with installation facts and agent behavior side by side in wide terminals and stacked in narrow ones. Machine and repository headings identify each installation without nesting. Session usage appears in a machine-by-agent table, long checkout paths wrap at directory boundaries, and observation times appear once per machine. Different sources and ownership remain distinct between independent clones. Unknown sources remain visible.

The Ownership column shows **Git** for repository-controlled skills, **Skilloom** for installations managed by Skilloom, and **External** for installations outside its management. When copies have different owners, the row uses **Git → Skilloom → External** priority. The preview lists every owner present, and details show ownership per location. Machine, scope and ownership filters recalculate the summary from the matching copies.


Rows show the skill name and **Invocation**, followed by ownership and machine count when space permits. Invocation shows **Automatic**, **Manual**, or **Disabled**. **Automatic** includes skills that support both automatic and manual invocation. **Mixed** means copies have different invocation modes after grouping automatic-capable skills together; **Unknown** means declarations are unknown or incomplete for the selected occurrences. The column respects the machine filter. Exact declarations and read evidence stay in the full details view opened with Enter or `i`.

Invocation describes supported declarations, not runtime settings or permissions. Details identify the agents whose declarations were read and preserve differences between them. Claude frontmatter flags, Codex `agents/openai.yaml` policy, and Pi declarations are interpreted separately.

Read evidence identifies OpenAI, Claude, and Pi only when a supported trace records a successful read of a verified installed `SKILL.md` path. Codex harness-classified selected instructions are recorded separately as **Loaded skill**. A read proves that the file was loaded, not that its instructions were followed or that its current contents match the historical contents. Matching uses machine identity plus canonical installation-path hashes; same-name copies in other checkouts are kept separate. Name-only Claude Skill invocations remain separately labelled because their installation cannot be established.

The session table compares machines across OpenAI, Claude and Pi. It distinguishes verified counts, zero recorded matches, unknown identities, missing observations and absent installations. No recorded evidence never means “never used.” Details show how many distinct recorded sessions used the selected installation, with last-use time. Repeated reads and loads in one session count once. **Recent sessions** lists the latest 20 sessions, with UTC last-use time, agent, an abbreviated opaque session ID and machine. A compact "What may be missing" section explains actual gaps such as omitted earlier history, unknown session identities or the two-minute pause. Repeated generic scan-status tables are omitted. Name-only invocations are labelled separately. Older collectors without session summaries show “Sessions not collected.” Evidence without a trustworthy session identity is shown as unknown and does not increase session counts. Coverage includes registered machines even when they have no published installations. Availability and declared invocation mode are independent of evidence.

Session summaries use all retained normalized events, up to 10,000 per machine, before the separate 1,000-event history display cap. Counts are observed sessions, not lifetime totals; omitted older evidence is labelled. Session IDs are scoped to a machine and harness. Codex subagent threads group under the root session when its metadata identifies it. Claude Code uses its session ID, including subagent work within that session. Pi uses its native session ID and excludes inherited fork history. Name-only invocations remain separate from verified installation usage. Legacy ambiguous Codex identities do not become session counts until a bounded scan verifies their original metadata.

Each machine collects its own logs. `skilloom usage install` adds a Claude Code PostToolUse hook and a Pi extension while preserving existing configuration and writing backups. Reload Pi or start a new session after installation. `skilloom usage status` reports configuration; `skilloom usage uninstall` removes only Skilloom's collectors. Codex is observed through structured rollout metadata and successful tool results without changing its configuration.

`skilloom usage backfill` resumes historical scanning for at most two minutes, then checkpoints and reports `paused: true` if work remains. This is a normal pause, not completion or failure. Run it again to continue. Use `--max-seconds 180` for a three-minute budget, `--once` for one pass, or `--restart` to traverse the directories again with existing file cursors preserved. Ctrl-C also pauses safely. The current bounded batch finishes saving its checkpoint at the limit, so slow filesystem writes can add a short overrun. `skilloom usage refresh` collects recent evidence. The TUI gives historical backfill a two-minute window while idle. At the limit it pauses old-history work and continues bounded recent-event refreshes every 30 seconds. Press `r` to refresh and allow another two-minute window, or reopen the TUI. Selecting rows never starts filesystem work.

The append-only journal lives in the private Skilloom `usage` directory, alongside a private installation manifest and collection state. Shared event IDs deduplicate hooks and traces. Historical scanning can finish with partial evidence because malformed/oversized records, forks, missing files and unsupported events remain visible limitations. Machine-readable diagnostics retain scanned-file and pending-result counts; the TUI presents session usage and explains evidence gaps.

`skilloom usage publish --dry-run` previews the derived saved observation, and `skilloom usage publish` publishes it without rediscovering projects or changing skills. Raw transcripts, the private journal and installation manifest are never published.

 Run `skilloom observe --publish` on each machine using a version with this collector, then refresh the shared observations. Git transports summaries; it does not discover online machines or run remote collectors. Raw traces and absolute skill paths stay local. Published summaries contain machine identity, canonical-path hashes, harness, counts, last-seen times, bounded event history, session summaries with opaque identities, and scan coverage. Legacy usage summaries are treated as unscanned until recollected.

Saved inventory renders immediately. Older snapshots missing metadata or history are enriched in the background using bounded local file reads, without project discovery or Git access; browsing remains available. Snapshots already containing declarations and history need no startup scan. Explicit refresh/observe scans declarations and updates a bounded incremental usage cache outside the render path. Trace content remains local; published observations contain only invocation metadata and derived usage evidence. Remote rows keep the publication timestamp and remain snapshots.

| Key | Action |
| --- | --- |
| `1`–`3`, `Tab`, or `Shift-Tab` | Switch views directly, forward, or backward |
| `/` | Search the library |
| `↑` / `↓` or `j` / `k` | Select a skill |
| `←` / `→` | Cycle machines in Results; move the cursor while editing search |
| `Enter` | Finish searching, or open the selected skill from Results |
| `Esc` | Finish searching or return from details; keep search, filters and selection |
| `i` | Open the selected skill’s full details (same as Enter) |
| `m`, `g`, `o` | Cycle machine, scope, and ownership filters in Results |
| `x` | Clear filters |
| `r` | Refresh local inventory with scan progress |
| `s` | Scan and review a fresh sync plan |
| `a`, `d` | Add or remove a desired requirement |
| `v` | Verify an unknown source for a local installation |
| `?`, `q` | Show help or quit |

Settings provides workspace setup, profile creation or copying, this machine's profile assignment, connection to shared Git storage, and migration review. Use ↑/↓ and Enter to open a Settings action; Escape cancels and keeps your selection. The Changes view lists the saved plan: Enter on a change opens its details, while Enter on **Review sync** (or `s`) checks current installations before review. Sync and migration reviews require `y` to apply and accept `n` or Escape to cancel. Saving a requirement or changing a profile does not install skills; review sync when ready.

Switch machines directly in Library with ←/→. Remote skills are published observations; browsing them does not change the sync target. The prominent **s Sync [machine name]** action starts a fresh review for this computer from Library. Escape cancels back to the same search, filters, and selected skill. Run `observe --publish` or `sync` on another machine to update its published state.

The views are **1 Library**, **2 Changes**, and **3 Settings**. Changes is available for inspecting the saved plan; you do not need to visit it to start a sync.

Use `npx skilloom@canary` instead if you prefer Node. Stable releases use `@latest`.

No projects is a valid result. Add a workspace later by rerunning `setup /path/to/workspace`. Use `--depth 1` through `--depth 8` to change the bounded scan depth, or `--no-adopt` to inventory existing skills without managing them.

## Inspect from the CLI

```sh
skilloom inventory --json
skilloom inventory --cached --json
skilloom inventory --machine macbook --scope global
skilloom inventory --ownership repository --query review
skilloom inventory --source unknown --json
```

Live inventory scans the current machine and reads published observations for configured machines. Cached inventory reads the last saved local snapshot without scanning or contacting Git; `observe` saves a snapshot. Both forms expose observation timestamps. Remote records are always marked stale because they describe a previous observation.

`--machine` accepts a machine ID or exact name. `--scope` accepts `global` or `project`; `--ownership` accepts `repository`, `personal`, or `unknown`; `--source` matches an exact source or `unknown`. `--query` searches names, sources, machines, projects, local paths, and agents. Filters apply to the additive JSON `records` array; existing full-inventory fields remain available for compatibility.

Local records preserve each checkout path. New remote snapshots preserve separate checkout occurrences using opaque IDs, without publishing paths. Older snapshots may contain only project aggregates or lack global skill details; absent data stays unknown.

Scans inspect up to four checkouts concurrently and report progress on stderr, keeping JSON stdout separate. Agent coverage follows the pinned upstream installation model: a verified canonical `.agents/skills` installation covers upstream universal agents in either scope. `agents` describes installation coverage; `detectedAgents` preserves the upstream-reported subset. Coverage does not claim that each agent is installed or running.

The skill details view shows **Installed in** folders instead of expanding agent coverage into an availability list. Locations are verified on the originating machine, including matching symlink aliases; they are not inferred from agent names. `~` means that machine's home directory (including the Windows user profile), and `./` means the displayed project checkout. Display paths use `/` on every platform. Custom roots outside the home can appear as `<CODEX_HOME>`, `<CLAUDE_CONFIG_DIR>`, or `<PI_CODING_AGENT_DIR>`; these are labels, not shell commands. Other external locations appear as `Custom directory (path private)`. Absolute home paths, checkout roots, and symlink targets are not published. Older remote snapshots show `Not recorded in this snapshot` until that machine refreshes and publishes.


For supported trace formats, collection limits, and the next steps toward fuller history, see [the usage evidence research](docs/research/2026-09-09-skill-usage-history.md).

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
skilloom sync --yes --expect FINGERPRINT --json
```

Use the `fingerprint` from the dry-run result as `FINGERPRINT`. If the plan has changed, sync cancels with `plan_changed` and exit code 5 so you can review again. Interactive sync also checks for a changed plan after confirmation.

For a personal requirement that follows the same repository across your machines, run this inside the repository:

```sh
skilloom add code-review --source mattpocock/skills --project
skilloom sync
```

The repository's remote identifies the project, so local paths may differ. Machines without that repository skip it. Explicit project policy targets every discovered independent clone; each operation names its exact path. Personal `--project` requires a remote and rejects linked worktrees. Selecting an independent repository also registers its path locally for future syncs.

Add `--shared` to write `.skilloom.yaml` for collaborators, then commit the file through your normal Git workflow:

```sh
skilloom add code-review --source mattpocock/skills --project --shared
```

Shared additions accept one skill per invocation and allow normal Git file editing inside a worktree without enrolling that worktree. Setup does not copy manifest requirements into personal policy.

Shared project policy can also be written directly:

```yaml
version: 1
skills:
  - source: acme/agent-skills
    name: repository-review
    agents: [codex]
```

From inside the repository, the first add creates the file. `project init` is optional:

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
skilloom setup ~/dev --sync git@github.com:you/skilloom-config.git --machine-name "Mac mini" --preserve-global-profile mini

# MacBook
skilloom setup ~/dev --sync git@github.com:you/skilloom-config.git --machine-name "MacBook" --preserve-global-profile macbook
```

Each machine has its own workspace paths and stable identity. Those paths stay local. Profiles, personal project policy, machine names, and assignments are shared.

`--preserve-global-profile NAME` adopts this machine's eligible existing global skills into its own profile, preserving different global sets between machines. It cannot be combined with `--profile` or `--no-adopt`. The name must be new; an existing profile cannot be reused by this preservation flow. Unknown-source skills remain unmanaged until their provenance is verified.

You can copy a profile as a starting point, then select it for this machine:

```sh
skilloom config --add-profile workstation --copy-profile macbook
skilloom config --profile workstation
skilloom sync --dry-run --json
```

Copies are independent. Assigning two machines to the same profile intentionally shares their desired global set.

For an existing local setup, connect it without resetting installation state or machine identity:

```sh
skilloom connect git@github.com:you/skilloom-config.git
skilloom sync --dry-run --json
skilloom sync --yes --json
```

The repository must already exist and be accessible through your Git credentials. `connect` retains a local configuration backup and switches storage only after successful publication. Identical or disjoint configuration entries merge; conflicting entries require resolution. Local-only sources and project identities cannot be shared. Connecting does not repair policies previously created by older adoption behavior. Use the migration preview below before applying them.

Run `sync` on each machine. It never triggers execution on another computer. Without `--yes`, interactive sync previews installation changes and asks for confirmation; noninteractive mutation returns cancellation. `--dry-run` can fetch shared configuration but never installs or publishes an observation. Failed verification returns exit code 2 with pending work; failed upstream execution returns 4. An incomplete scan or repository ownership conflict blocks application.

Sync compares skill name, source, and agent coverage. It does not upgrade content, pin identical revisions across machines, or compare all skill contents across machines. Use an explicit `update` on each machine for source updates. Exact content revision tracking is not implemented, so convergence is a policy result, not proof of identical file contents.

`inventory` scans only the current machine. A machine can publish a snapshot without local paths so another machine can show its last known state:

```sh
skilloom observe --publish --json
```

Publishing updates the managed Git repository only when the local observed contents changed. It commits only this machine's observation; unrelated dirty files block publication. It does not install, update, or remove a skill. Remote observations can be stale, and Skilloom never remotely executes on another computer.

There is no daemon in this release. A scheduler should eventually call a stable installed executable in observation-only mode; ephemeral `bunx` cache paths are not suitable launchd or systemd targets.

## Verify an unknown source

An unknown source is not inferred from a desired requirement. Compare the installed skill against its source repository before recording local provenance:

```sh
skilloom source verify review --source acme/skills --dry-run --json
skilloom source verify review --source acme/skills --yes --json
skilloom source verify review --source acme/skills --scope project --checkout /path/to/repo --yes
```

The default scope is global. Verification compares the installed contents with the matching skill in the repository. A mismatch saves nothing. A successful write records a local proof; subsequent scans use it only while the installed path, resolved target, and content hash still match. This does not reinstall or adopt the skill. Local proof files are not shared configuration.

## Repair older adoption policy

Older setups may have recorded Git-owned skills as personal requirements or adopted a skill from one clone into policy for every clone. Migration reviews those cases against current checkouts and ownership records:

```sh
skilloom migrate --dry-run --json
skilloom migrate --yes --expect FINGERPRINT --json
```

Use `preview.fingerprint` from the dry run. A changed fingerprint refuses application. Migration releases obsolete ownership claims and removes supported legacy requirements while keeping installed skill files intact. It leaves missing-project policy and explicit source changes alone. An incomplete scan blocks migration.

When migration removes a requirement, it writes a shared ownership release and upgrades that configuration to version 2. Upgrade Skilloom on all participating machines before their next sync. Older clients reject version 2 instead of applying a requirement deletion without the matching ownership release.

Each upgraded machine releases the obsolete ownership once for each matching checkout before planning. Dry runs simulate this without writing state; apply saves the acknowledgements even when no installation changes are needed. A checkout discovered later still receives its release. Setup acknowledges existing releases before fresh adoption, so future intentional ownership and removals continue to work.

Migration identifies candidates from current installations and managed records, which cannot prove why a requirement was originally added. Review the listed sources and checkouts, especially after a partially completed intentional sync.

Applying creates a backup of configuration and managed state in the local application directory. Managed configuration must be clean before application. If publication fails after local migration, the error identifies the backup and the Git state to resolve before syncing.

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

Command errors include `{ "ok": false, "error": { "code": "...", "message": "..." } }`. Sync results also include `phases.apply`, `phases.verify`, and `phases.publish`, each with a status and optional error. A successful installation followed by failed verification or publication reports `partialSuccess`; it does not claim complete sync. Unchanged publication is marked skipped.

| Exit | Meaning |
| --- | --- |
| `0` | Command succeeded; `plan --check` is converged |
| `1` | Blocked migration preview |
| `2` | Drift, blocked reconciliation, or unresolved verification |
| `3` | Invalid or unavailable input/state |
| `4` | Upstream or Git execution failure, or failed diagnostics |
| `5` | Cancellation, including a changed sync plan |

A successful `sync --dry-run` can contain operations and still return 0. Read `converged`, `operations`, and `issues` before applying.

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

Readers accept version 1 and version 2 configuration. Version 2 adds migration ownership releases; ordinary setup keeps version 1 until a migration needs those records. The original `init`, `config`, `project`, `plan`, `apply`, `status`, `update`, and `doctor` commands remain supported. The longer managed-storage form is also available:

```sh
skilloom init --storage managed --repository git@github.com:you/skilloom-config.git
```

Managed mode uses the user's existing Git credentials and permits only fast-forward pulls plus ordinary commits and pushes. It never resets, force-pushes, or automatically resolves a conflict.

## Command summary

- `setup [WORKSPACE]` initializes a machine, discovers projects, and adopts eligible existing skills.
- `connect REPOSITORY` migrates local configuration into shared Git storage with a backup.
- `sync [--dry-run] [--yes]` reconciles and verifies this machine, then publishes its observation when connected.
- `inventory [--cached]` reports full inventory plus filterable local and remote occurrence records.
- `tui` opens the full-screen library, changes, and settings.
- `migrate --dry-run` previews legacy ownership repairs; `--yes --expect FINGERPRINT` applies a reviewed preview.
- `source verify NAME --source REPOSITORY` verifies local source provenance.
- `add`, `edit`, `move`, and `remove` atomically edit global-profile or personal-project policy.
- `plan --all` and `apply --all` remain available for separate planning and application to independent clones plus global state.
- `observe [--publish]` refreshes local state and optionally publishes a redacted snapshot.
- `update [SKILL] --scope global|project` delegates updates to the pinned skills executable.
- `project add` and `project remove` edit shared `.skilloom.yaml` policy.
- `config` manages profiles and machine selection.
- `doctor` diagnoses the active runtime, Git, the pinned skills executable, project discovery, and configuration.

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
