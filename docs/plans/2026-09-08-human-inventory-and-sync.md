# Human inventory and dependable synchronization

The primary human flow starts by running `skilloom`: open a full-screen library of skills across machines, search by name/source/project/agent, inspect ownership and observation age, then review local changes before applying. The same inventory and operations power JSON commands for agents.

Use Ink 6.8 and React 19 for layout, input, focus, rendering, and testing while keeping the supported Node 20 runtime. The terminal session owns alternate-screen entry/exit. Preserve the user's terminal on cancellation and errors. Avoid nested prompt menus and terminal scrollback dumps.

## Design

Use the terminal's default background, a quiet blue selection (#77A7DF), sea-green source/installed accent (#6FC1AD), amber pending state (#DDB66E), muted slate metadata (#8392A5), and the terminal's default foreground. Text uses the user's terminal font. Headings are bold, body text regular, secondary metadata dimmed. Color never carries state alone.

Wide terminals use a left navigation/machine rail, a searchable skill table, and an inspector. The inspector is the defining interaction: one selected skill shows source differences and installation locations across machines without forcing users through project menus. Compact terminals preserve the list and move details to Enter. Text is left-aligned, rows have consistent columns, and navigation/filters stay visible.

```
 Skilloom                         Library  Machines  Changes  Settings
 / search skills, sources, projects                         cached time
 All machines    Skill                 Ownership   Machines | Skill name
 MacBook         code-review           Managed     2        | Source
 Studio          research              Git         1        | Installations
 Build host      test-driven-dev       Unmanaged   3        | Agents / age
                 ...                                        | Actions
 / search  m machine  g scope  o ownership  Enter inspect  r refresh
```

Review against the brief: a prompt menu would hide the cross-machine inventory and make the user choose a project before finding a skill. This layout instead makes all skill occurrences searchable and displays ownership, unknown sources, and remote observation timestamps directly. Narrow terminals use the same interaction rather than dropping data.

## Work and validation

- Replace guided prompt UI with full-screen library, machine overview, change review, settings, and first-run setup. Reuse domain commands for mutations; preview and explicit confirmation precede installation or migration.
- Add migration preview/application, safe profile bootstrap, and verified provenance attribution without reinstallation.
- Correct upstream universal-agent coverage; pin and reuse the upstream CLI, scan read-only checkouts with bounded concurrency, emit progress without polluting JSON stdout.
- Add cached/all-machine inventory queries with explicit observation age and provenance/ownership filters.
- Separate sync phase outcomes, safely retry observation-only publication, and avoid timestamp-driven no-op commits.
- Test temporary installations, concurrent Git publications and conflict boundaries, library navigation/search/resize, preview-confirmation behavior, first run, and terminal restoration. Run the repository verification suite and package under Node and Bun. Inspect the actual full-screen UI at wide and narrow dimensions.

Development stays in the new worktree. Tests do not mutate the user's installed skills or shared configuration. A release or live migration is separate from implementation verification.
