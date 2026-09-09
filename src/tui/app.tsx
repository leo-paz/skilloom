import { Box, Text, useApp, useInput, useStdout } from "ink";
import React, { useEffect, useMemo, useState } from "react";
import wrapAnsi from "wrap-ansi";
import type { InventoryProgress, MachineInventory } from "../core/types.js";
import {
  buildLibrary,
  filterLibrary,
  type LibraryEntry,
  observedLabel,
  ownershipLabel,
  safeText,
} from "./catalog.js";

export interface CommandResult {
  code: number;
  value: Record<string, unknown>;
}
export interface DashboardBackend {
  cancelRead?: () => Promise<void>;
  load: (
    refresh: boolean,
    progress: (event: InventoryProgress) => void,
  ) => Promise<MachineInventory>;
  execute: (
    args: string[],
    progress: (
      event: InventoryProgress | { phase: string; detail: string },
    ) => void,
  ) => Promise<CommandResult>;
}
interface Props {
  initialInventory?: MachineInventory | undefined;
  backend: DashboardBackend;
  width?: number;
  height?: number;
}
interface Review {
  kind: "sync" | "migrate" | "remove";
  title: string;
  lines: string[];
  issues: string[];
  args: string[];
}
interface Field {
  label: string;
  value: string;
  choices?: string[];
}
interface Form {
  title: string;
  hint: string;
  fields: Field[];
  submit: (fields: Field[]) => string[];
}
const color = {
  accent: "#77A7DF",
  good: "#6FC1AD",
  warning: "#DDB66E",
  muted: "#8392A5",
  error: "#E58C8C",
};
const scopes = ["all", "global", "project"];
const ownerships = ["all", "managed", "git-owned", "unmanaged", "unknown"];
function cycle(values: string[], value: string): string {
  return values[(values.indexOf(value) + 1) % values.length]!;
}
function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((x) => (typeof x === "string" ? x : JSON.stringify(x)))
    : [];
}
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : safeText(error);
}
function operationLines(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(
    (item: Record<string, unknown>) =>
      `${item.kind === "remove" ? "−" : "+"} ${safeText(item.name)}  ${safeText(item.scope)}  source: ${safeText(item.source ?? "Unknown")}${item.cwd ? `  ${safeText(item.cwd)}` : ""}${Array.isArray(item.agents) ? `  [${item.agents.join(", ")}]` : ""}`,
  );
}
function KeyHint({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <Text>
      <Text color={color.accent} bold>
        {k}
      </Text>{" "}
      <Text dimColor>{children}</Text>{" "}
    </Text>
  );
}
function Line({
  children,
  tone,
  bold = false,
}: {
  children: React.ReactNode;
  tone?: string | undefined;
  bold?: boolean | undefined;
}) {
  return (
    <Text {...(tone ? { color: tone } : {})} bold={bold} wrap="truncate-end">
      {children}
    </Text>
  );
}
interface DetailLine {
  text: string;
  tone?: string;
  bold?: boolean;
}
function wrapLines(lines: DetailLine[], width: number): DetailLine[] {
  return lines.flatMap((line) =>
    wrapAnsi(safeText(line.text), Math.max(8, width), {
      hard: true,
      trim: false,
    })
      .split("\n")
      .map((text) => ({ ...line, text })),
  );
}
function inspectorLines(entry: LibraryEntry, width: number): DetailLine[] {
  const content: DetailLine[] = [
    { text: entry.name, bold: true },
    {
      text: `${entry.machines.length} machine${entry.machines.length === 1 ? "" : "s"} · ${entry.occurrences.length} location${entry.occurrences.length === 1 ? "" : "s"}`,
      tone: color.muted,
    },
  ];
  if (entry.sources.length > 1)
    content.push({
      text: "Sources differ between locations",
      tone: color.warning,
    });
  for (const record of entry.occurrences) {
    content.push(
      { text: " " },
      {
        text: `${record.machine.name} · ${record.scope === "global" ? "Global" : record.projectName}`,
        bold: true,
      },
      {
        text: `${record.installed ? "Installed" : "Missing"} · ${ownershipLabel(record)}${record.desired ? " · Required" : ""}`,
        tone: color.muted,
      },
      {
        text: `Source: ${record.source ?? "Unknown source"}`,
        tone: record.source ? color.good : color.warning,
      },
      { text: `Agents: ${record.agents.join(", ") || "Unknown"}` },
    );
    if (record.detectedAgents)
      content.push({
        text: `Detected: ${record.detectedAgents.join(", ")}`,
        tone: color.muted,
      });
    if (record.checkoutPath)
      content.push({ text: record.checkoutPath, tone: color.muted });
    else if (record.checkoutId)
      content.push({
        text: `Checkout: ${record.checkoutId}`,
        tone: color.muted,
      });
    content.push({
      text: `Last observed ${observedLabel(record.observedAt)}`,
      tone: color.muted,
    });
    if (record.stale)
      content.push({
        text: "Saved observation; refresh on that machine",
        tone: color.warning,
      });
    if (record.conflict)
      content.push({ text: record.conflict, tone: color.error });
  }
  if (entry.occurrences.every((x) => x.ownership === "repository"))
    content.push({
      text: "Git manages these files. Skilloom observes them.",
      tone: color.muted,
    });
  return wrapLines(content, width - 2);
}
function Inspector({
  entry,
  lines,
  width,
  offset,
  focused,
}: {
  entry: LibraryEntry | undefined;
  lines: number;
  width: number;
  offset: number;
  focused: boolean;
}) {
  if (!entry)
    return <Text dimColor>Select a skill to inspect its installations.</Text>;
  const wrapped = inspectorLines(entry, width);
  const page = Math.max(1, lines - 1);
  const start = Math.min(offset, Math.max(0, wrapped.length - page));
  return (
    <Box flexDirection="column" paddingX={1}>
      {wrapped.slice(start, start + page).map((line, i) => (
        <Line key={i} tone={line.tone} bold={line.bold}>
          {line.text}
        </Line>
      ))}
      <Line tone={color.accent}>
        {focused ? "↑↓ scroll · Esc back" : "Enter focus inspector"} {start + 1}
        –{Math.min(start + page, wrapped.length)}/{wrapped.length}
      </Line>
    </Box>
  );
}
export function SkilloomApp({
  initialInventory,
  backend,
  width,
  height,
}: Props) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [size, setSize] = useState({
    width: width ?? stdout.columns ?? 100,
    height: height ?? stdout.rows ?? 30,
  });
  const [inventory, setInventory] = useState(initialInventory);
  const [view, setView] = useState("Library");
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [machine, setMachine] = useState("all");
  const [scope, setScope] = useState("all");
  const [ownership, setOwnership] = useState("all");
  const [index, setIndex] = useState(0);
  const [details, setDetails] = useState(false);
  const [detailOffset, setDetailOffset] = useState(0);
  const [viewOffset, setViewOffset] = useState(0);
  const [outcome, setOutcome] = useState<string[]>();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [review, setReview] = useState<Review>();
  const [reviewOffset, setReviewOffset] = useState(0);
  const [form, setForm] = useState<Form>();
  const [field, setField] = useState(0);
  const [help, setHelp] = useState(false);
  useEffect(() => {
    if (width && height) {
      setSize({ width, height });
      return;
    }
    const resize = () =>
      setSize({
        width: width ?? stdout.columns ?? 100,
        height: height ?? stdout.rows ?? 30,
      });
    stdout.on("resize", resize);
    return () => {
      stdout.off("resize", resize);
    };
  }, [stdout, width, height]);
  const report = (
    event: InventoryProgress | { phase: string; detail: string },
  ) =>
    setProgress(
      "detail" in event
        ? `${event.phase}: ${event.detail}`
        : `${event.phase} ${event.completed}/${event.total}${event.path ? `  ${event.path}` : ""}`,
    );
  const load = async (refresh: boolean) => {
    setBusy(true);
    setError("");
    setProgress(
      refresh ? "Refreshing local inventory" : "Opening saved inventory",
    );
    try {
      setInventory(await backend.load(refresh, report));
      setNotice(
        refresh
          ? "Local inventory refreshed. Remote machines show their last published observation."
          : "Opened saved inventory. Press r to refresh.",
      );
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
      setProgress("");
    }
  };
  useEffect(() => {
    if (!initialInventory) void load(false);
  }, []);
  const entries = useMemo(
    () => (inventory ? buildLibrary(inventory) : []),
    [inventory],
  );
  const rows = useMemo(
    () => filterLibrary(entries, { query, machine, scope, ownership }),
    [entries, query, machine, scope, ownership],
  );
  const selected = rows[Math.min(index, Math.max(0, rows.length - 1))];
  useEffect(() => {
    setIndex((current) => Math.min(current, Math.max(0, rows.length - 1)));
  }, [rows.length]);
  useEffect(() => {
    setIndex(0);
  }, [query, machine, scope, ownership]);
  const narrow = size.width < 100;
  const tiny = size.width < 65;
  const bodyHeight = Math.max(5, size.height - 8);
  const pageSize = Math.max(1, bodyHeight - 3);
  useEffect(() => {
    setDetailOffset(0);
  }, [selected?.name]);
  useEffect(() => {
    setViewOffset(0);
  }, [view]);
  const execute = async (args: string[], refresh = true) => {
    setBusy(true);
    setError("");
    setProgress("Working");
    try {
      const result = await backend.execute(args, report);
      if (args[0] === "sync" || result.code !== 0) {
        const phases = result.value.phases as
          | Record<string, { status?: string; error?: unknown }>
          | undefined;
        const failure = result.value.error as
          | { message?: string; recovery?: string }
          | undefined;
        setReviewOffset(0);
        setOutcome([
          args[0] === "sync" ? "Sync result" : "Command result",
          ...(phases
            ? Object.entries(phases).map(
                ([name, phase]) =>
                  `${name}: ${phase.status}${phase.error ? ` — ${safeText(phase.error)}` : ""}`,
              )
            : []),
          ...(result.value.converged === true
            ? ["Local requirements verified."]
            : []),
          ...(failure?.message ? [failure.message] : []),
          ...(failure?.recovery ? [failure.recovery] : []),
          ...strings(result.value.issues),
          ...(result.code
            ? [`Exit ${result.code}. Review the result before retrying.`]
            : ["Completed successfully."]),
        ]);
      }
      if (result.code !== 0) {
        const failure = result.value.error as { message?: string } | undefined;
        setError(
          failure?.message ??
            (strings(result.value.issues).join("; ") ||
              `Command finished with exit ${result.code}`),
        );
      } else {
        setNotice(
          args[0] === "sync"
            ? "Sync complete. Local requirements verified."
            : args[0] === "source"
              ? "Source verified. Installed files were preserved."
              : "Configuration saved. Review sync before changing installations.",
        );
      }
      if (refresh) {
        try {
          setInventory(await backend.load(args[0] !== "sync", report));
        } catch (e) {
          setError((previous) =>
            [previous, `Inventory refresh failed: ${errorText(e)}`]
              .filter(Boolean)
              .join(" · "),
          );
        }
      }
      return result;
    } catch (e) {
      setError(errorText(e));
      return undefined;
    } finally {
      setBusy(false);
      setProgress("");
    }
  };
  const preview = async (kind: "sync" | "migrate") => {
    setBusy(true);
    setError("");
    setProgress(
      kind === "sync"
        ? "Checking local changes"
        : "Inspecting legacy ownership",
    );
    try {
      const result = await backend.execute([kind, "--dry-run"], report);
      const value = result.value;
      const migration = (value.preview ?? value) as Record<string, unknown>;
      const fingerprint = (kind === "sync" ? value : migration).fingerprint;
      const issues = strings(
        kind === "sync" ? value.issues : migration.blockers,
      );
      if (result.code && !issues.length)
        issues.push(
          (value.error as { message?: string } | undefined)?.message ??
            `Preview failed with exit ${result.code}`,
        );
      const lines =
        kind === "sync"
          ? operationLines(value.operations)
          : Array.isArray(migration.requirements)
            ? migration.requirements.map(
                (x: Record<string, unknown>) =>
                  `${safeText(x.projectId)} · ${safeText((x.skill as { name?: string } | undefined)?.name ?? x.name)}  ${safeText((x.skill as { source?: string } | undefined)?.source)}  ${safeText(x.explanation)}`,
              )
            : [];
      const released = value.ownershipRelease as
        | { releasedKeys?: string[] }
        | undefined;
      if (kind === "sync" && released?.releasedKeys?.length)
        lines.push(
          `${released.releasedKeys.length} legacy ownership records will be released. Installed files stay in place.`,
        );
      if (kind === "migrate")
        lines.push(
          `${Array.isArray(migration.stateKeys) ? migration.stateKeys.length : 0} obsolete ownership records will be released. Installed files stay in place.`,
        );
      setReviewOffset(0);
      setReview({
        kind,
        title: kind === "sync" ? "Review local sync" : "Review migration",
        lines,
        issues,
        args: [
          kind,
          "--yes",
          ...(typeof fingerprint === "string" ? ["--expect", fingerprint] : []),
        ],
      });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
      setProgress("");
    }
  };
  const showForm = (value: Form) => {
    setField(0);
    setForm(value);
    setError("");
  };
  const setupForm = () =>
    showForm({
      title: "Set up this machine",
      hint: "Existing personal skills are adopted without reinstalling. Git-owned files stay under Git.",
      fields: [
        { label: "Workspace", value: "~/dev" },
        { label: "Machine name", value: inventory?.machine.name ?? "" },
        {
          label: inventory ? "Global profile" : "Own global profile",
          value: inventory?.machine.profile ?? "personal",
        },
      ],
      submit: (f) => [
        "setup",
        f[0]!.value,
        "--machine-name",
        f[1]!.value || "This machine",
        inventory ? "--profile" : "--preserve-global-profile",
        f[2]!.value,
      ],
    });
  const addForm = () => {
    const targets = [
      ...(inventory?.profiles ?? ["default"]).map((name) => ({
        label: `Global · ${name}`,
        value: `profile:${name}`,
      })),
      ...(inventory?.projects ?? []).map((project) => ({
        label: `Project · ${project.name} (${project.id})`,
        value: `project:${project.id}`,
      })),
    ];
    const initial =
      targets.find(
        (x) => x.value === `profile:${inventory?.machine.profile}`,
      ) ?? targets[0]!;
    showForm({
      title: "Add a requirement",
      hint: "Choose a target with ←/→. Agents are comma-separated. Installation happens after you review sync.",
      fields: [
        { label: "Skill name", value: "" },
        { label: "Source repository", value: "" },
        { label: "Agents", value: "codex" },
        {
          label: "Target",
          value: initial.label,
          choices: targets.map((x) => x.label),
        },
      ],
      submit: (f) => [
        "add",
        f[0]!.value,
        "--source",
        f[1]!.value,
        "--agents",
        f[2]!.value,
        "--to",
        targets.find((x) => x.label === f[3]!.value)!.value,
      ],
    });
  };
  const sourceForm = () => {
    const candidates =
      selected?.occurrences.filter(
        (x) =>
          x.machine.id === inventory?.machine.id && x.installed && !x.source,
      ) ?? [];
    if (!candidates.length) {
      setNotice(
        "Select a local installation with an unknown source to verify its provenance.",
      );
      return;
    }
    const labels = candidates.map((x) =>
      x.scope === "global" ? "Global on this machine" : x.checkoutPath!,
    );
    const skillName = selected!.name;
    showForm({
      title: `Verify source for ${skillName}`,
      hint: "Choose the installation with ←/→. Compare its files without reinstalling or changing ownership.",
      fields: [
        { label: "Installation", value: labels[0]!, choices: labels },
        { label: "Source repository", value: "" },
      ],
      submit: (f) => {
        const local = candidates[labels.indexOf(f[0]!.value)]!;
        return [
          "source",
          "verify",
          skillName,
          "--source",
          f[1]!.value,
          "--scope",
          local.scope,
          ...(local.checkoutPath ? ["--checkout", local.checkoutPath] : []),
          "--yes",
        ];
      },
    });
  };
  const removeRequirement = () => {
    const candidates =
      selected?.occurrences.filter(
        (x) =>
          x.machine.id === inventory?.machine.id &&
          x.desired &&
          x.ownership !== "repository" &&
          (x.scope === "global" ||
            x.reasons.includes("personal project additions")),
      ) ?? [];
    if (!candidates.length) {
      setNotice(
        "Select a personal requirement. Git-owned skills and project manifests are edited in their repository.",
      );
      return;
    }
    const targets = [
      ...new Set(
        candidates.map((x) =>
          x.scope === "global"
            ? `profile:${inventory!.machine.profile}`
            : `project:${x.projectId}`,
        ),
      ),
    ];
    const name = selected!.name;
    showForm({
      title: `Remove requirement for ${name}`,
      hint: "Choose the requirement with ←/→. You will review the change before saving.",
      fields: [{ label: "Requirement", value: targets[0]!, choices: targets }],
      submit: (f) => ["remove", name, "--from", f[0]!.value],
    });
  };
  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      if (busy) {
        setProgress(
          "Stopping read operation; an active installation must finish safely.",
        );
        void backend.cancelRead?.();
        return;
      }
      exit();
      return;
    }
    if (busy) return;
    if (outcome) {
      if (key.escape || key.return || input === "q") {
        setOutcome(undefined);
        return;
      }
      if (key.downArrow || key.pageDown)
        setReviewOffset((x) =>
          Math.min(
            Math.max(
              0,
              wrapLines(
                outcome.map((text) => ({ text })),
                size.width - 4,
              ).length -
                bodyHeight +
                2,
            ),
            x + (key.pageDown ? pageSize : 1),
          ),
        );
      if (key.upArrow || key.pageUp)
        setReviewOffset((x) => Math.max(0, x - (key.pageUp ? pageSize : 1)));
      return;
    }
    if (help) {
      if (key.escape || input === "?" || input === "q") setHelp(false);
      return;
    }
    if (form) {
      if (key.escape) {
        setForm(undefined);
        return;
      }
      if (key.tab) {
        setField(
          (field + (key.shift ? -1 : 1) + form.fields.length) %
            form.fields.length,
        );
        return;
      }
      if (key.return) {
        if (field < form.fields.length - 1) {
          setField(field + 1);
          return;
        }
        const args = form.submit(form.fields);
        if (args[0] === "remove") {
          setForm(undefined);
          setReviewOffset(0);
          setReview({
            kind: "remove",
            title: "Remove requirement",
            lines: [
              `${args[1]} will no longer be required in ${args[3]}.`,
              "Installed files stay in place until you review and apply sync.",
            ],
            issues: [],
            args,
          });
          return;
        }
        void execute(args).then((result) => {
          if (result?.code === 0) setForm(undefined);
        });
        return;
      }
      const activeField = form.fields[field]!;
      if (activeField.choices) {
        if (key.leftArrow || key.rightArrow) {
          const choices = activeField.choices;
          const next =
            (choices.indexOf(activeField.value) +
              (key.leftArrow ? -1 : 1) +
              choices.length) %
            choices.length;
          setForm({
            ...form,
            fields: form.fields.map((x, i) =>
              i === field ? { ...x, value: choices[next]! } : x,
            ),
          });
        }
        return;
      }
      setForm({
        ...form,
        fields: form.fields.map((x, i) =>
          i !== field
            ? x
            : {
                ...x,
                value:
                  key.ctrl && input === "u"
                    ? ""
                    : key.backspace || key.delete
                      ? Array.from(x.value).slice(0, -1).join("")
                      : x.value +
                        (!key.ctrl && !key.meta ? safeText(input) : ""),
              },
        ),
      });
      return;
    }
    if (review) {
      if (key.escape || input === "n") {
        setReview(undefined);
        return;
      }
      if (key.downArrow || key.pageDown)
        setReviewOffset(
          Math.min(
            Math.max(0, reviewRows.length - 1),
            reviewOffset + (key.pageDown ? pageSize : 1),
          ),
        );
      if (key.upArrow || key.pageUp)
        setReviewOffset(
          Math.max(0, reviewOffset - (key.pageUp ? pageSize : 1)),
        );
      if (input === "y" && review.issues.length === 0) {
        const args = review.args;
        setReview(undefined);
        void execute(args);
      }
      return;
    }
    if (searching) {
      if (key.escape || key.return) {
        setSearching(false);
        return;
      }
      if (key.backspace || key.delete)
        setQuery(Array.from(query).slice(0, -1).join(""));
      else if (!key.ctrl && !key.meta) setQuery(query + safeText(input));
      return;
    }
    if (key.escape) {
      if (details) setDetails(false);
      else {
        setQuery("");
        setMachine("all");
        setScope("all");
        setOwnership("all");
      }
      return;
    }
    if (input === "q") {
      exit();
      return;
    }
    if (input === "?") {
      setHelp(true);
      return;
    }
    if (input === "/") {
      setView("Library");
      setSearching(true);
      return;
    }
    if (["1", "2", "3", "4"].includes(input)) {
      setView(
        ["Library", "Machines", "Changes", "Settings"][Number(input) - 1]!,
      );
      setDetails(false);
      return;
    }
    if (key.tab) {
      setView(cycle(["Library", "Machines", "Changes", "Settings"], view));
      setDetails(false);
      return;
    }
    if (input === "r") {
      void load(true);
      return;
    }
    if (input === "s" && inventory) {
      void preview("sync");
      return;
    }
    if (!inventory) {
      if (key.return || input === "u") setupForm();
      return;
    }
    if (view === "Settings") {
      if (input === "m") {
        void preview("migrate");
        return;
      }
      if (input === "u") {
        setupForm();
        return;
      }
      if (input === "p")
        showForm({
          title: "Create a global profile",
          hint: "Copy an existing profile or leave the second field empty for a new set.",
          fields: [
            { label: "New profile", value: "" },
            { label: "Copy from (optional)", value: "" },
          ],
          submit: (f) => [
            "config",
            "--add-profile",
            f[0]!.value,
            ...(f[1]!.value ? ["--copy-profile", f[1]!.value] : []),
          ],
        });
      if (input === "b")
        showForm({
          title: "Choose this machine's profile",
          hint: `Available: ${inventory.profiles.join(", ")}. Review sync before applying.`,
          fields: [{ label: "Profile", value: inventory.machine.profile }],
          submit: (f) => ["config", "--profile", f[0]!.value],
        });
      if (input === "c")
        showForm({
          title: "Connect shared configuration",
          hint: "Uses your Git credentials. Existing policy is merged; conflicts require resolution.",
          fields: [{ label: "Repository URL", value: "" }],
          submit: (f) => ["connect", f[0]!.value],
        });
      return;
    }
    if (input === "m") {
      setMachine(
        cycle(["all", ...inventory.machines.map((x) => x.id)], machine),
      );
      return;
    }
    if (input === "g") {
      setScope(cycle(scopes, scope));
      return;
    }
    if (input === "o") {
      setOwnership(cycle(ownerships, ownership));
      return;
    }
    if (input === "x") {
      setQuery("");
      setMachine("all");
      setScope("all");
      setOwnership("all");
      return;
    }
    if (input === "a") {
      addForm();
      return;
    }
    if (input === "d") {
      removeRequirement();
      return;
    }
    if (input === "v") {
      sourceForm();
      return;
    }
    if (key.return && view === "Library") {
      setDetails(!details);
      setDetailOffset(0);
      return;
    }
    if (details || view === "Machines" || view === "Changes") {
      const update = details ? setDetailOffset : setViewOffset;
      const max = details
        ? Math.max(
            0,
            (selected
              ? inspectorLines(
                  selected,
                  narrow
                    ? size.width
                    : Math.max(30, Math.floor((size.width - 21) * 0.48)) - 2,
                ).length
              : 0) -
              (bodyHeight - (narrow ? 1 : 3)),
          )
        : Math.max(
            0,
            (view === "Machines"
              ? inventory.machines.length
              : inventory.operations.length) - 1,
          );
      if (key.downArrow || input === "j" || key.pageDown)
        update((x) => Math.min(max, x + (key.pageDown ? pageSize : 1)));
      if (key.upArrow || input === "k" || key.pageUp)
        update((x) => Math.max(0, x - (key.pageUp ? pageSize : 1)));
      if (key.home) update(0);
      if (key.end) update(max);
      return;
    }
    if (key.downArrow || input === "j")
      setIndex(Math.min(Math.max(0, rows.length - 1), index + 1));
    if (key.upArrow || input === "k") setIndex(Math.max(0, index - 1));
    if (key.pageDown)
      setIndex(Math.min(Math.max(0, rows.length - 1), index + pageSize));
    if (key.pageUp) setIndex(Math.max(0, index - pageSize));
    if (key.home) setIndex(0);
    if (key.end) setIndex(Math.max(0, rows.length - 1));
  });
  const offset = Math.floor(Math.max(0, index) / pageSize) * pageSize;
  const selectedMachine =
    inventory?.machines.find((x) => x.id === machine)?.name ?? "All machines";
  const reviewRows = wrapLines(
    [
      ...(review?.issues.map((text) => ({ text, tone: color.error })) ?? []),
      ...(review?.lines.length
        ? review.lines
        : [
            "No installation changes. Sync will verify and publish local status.",
          ]
      ).map((text) => ({ text })),
    ],
    size.width - 4,
  );
  const footer = outcome
    ? "↑↓ scroll   Enter/Esc close"
    : form
      ? tiny
        ? "Tab next · Enter save · Esc cancel"
        : "Tab next · Ctrl-U clear · Enter save · Esc cancel"
      : review
        ? "↑↓ review · y Apply · Esc cancel"
        : details
          ? "↑↓ scroll · Esc back · q quit"
          : tiny
            ? "/ find · Enter view · ? help · q quit"
            : "/ search   m machine   g scope   o ownership   Enter inspect   ? help   q quit";
  let content: React.ReactNode;
  if (outcome) {
    const lines = wrapLines(
      outcome.map((text, i) => ({ text, bold: i === 0 })),
      size.width - 4,
    );
    const start = Math.min(
      reviewOffset,
      Math.max(0, lines.length - bodyHeight + 2),
    );
    content = (
      <Box flexDirection="column" padding={1}>
        {lines.slice(start, start + bodyHeight - 2).map((line, i) => (
          <Line key={i} bold={line.bold}>
            {line.text}
          </Line>
        ))}
      </Box>
    );
  } else if (help)
    content = (
      <Box flexDirection="column" padding={1}>
        <Line bold>Keyboard guide</Line>
        {[
          "1 Library   2 Machines   3 Changes   4 Settings",
          "/ Search names, repositories, sources, and agents",
          "↑↓ or j/k Select   Page Up/Down Scroll   Home/End Jump",
          "m Cycle machine   g Cycle global/project   o Cycle ownership",
          "Enter Inspect   Esc Back or clear filters   x Reset filters",
          "r Refresh this machine and pull published observations",
          "s Preview local sync, then explicitly confirm to apply",
          "a Add requirement   d Remove requirement   v Verify source",
          "Settings: p Create profile   b Choose profile   c Connect   m Migrate",
          "Remote snapshots describe the last observation, never live execution.",
          "? or Esc Close help",
        ].map((x) => (
          <Line key={x}>{x}</Line>
        ))}
      </Box>
    );
  else if (form)
    content = (
      <Box flexDirection="column" padding={1}>
        <Line bold>{form.title}</Line>
        <Text dimColor>{form.hint}</Text>
        <Text> </Text>
        {(tiny || bodyHeight < 20) && (
          <Line tone={color.muted}>
            Field {field + 1} of {form.fields.length} · Tab changes field
          </Line>
        )}
        {form.fields.map((f, i) =>
          (tiny || bodyHeight < 20) && i !== field ? null : (
            <Box key={f.label} flexDirection="column" marginBottom={1}>
              <Line tone={i === field ? color.accent : color.muted}>
                {f.label}
                {f.choices ? "  ←/→ choose" : ""}
              </Line>
              <Line bold={i === field}>
                {i === field ? "› " : "  "}
                {Array.from(safeText(f.value))
                  .slice(-Math.max(8, size.width - 8))
                  .join("")}
                {i === field ? "▏" : ""}
              </Line>
            </Box>
          ),
        )}
        <Text dimColor>
          Enter on the final field saves. Esc returns without saving.
        </Text>
      </Box>
    );
  else if (review)
    content = (
      <Box flexDirection="column" padding={1}>
        <Line bold>{review.title}</Line>
        <Line tone={color.muted}>
          {inventory?.machine.name} only · review every target before applying
        </Line>
        <Text> </Text>
        {reviewRows
          .slice(
            Math.min(reviewOffset, Math.max(0, reviewRows.length - 1)),
            Math.min(reviewOffset, Math.max(0, reviewRows.length - 1)) +
              Math.max(1, bodyHeight - (tiny ? 9 : 7)),
          )
          .map((line, i) => (
            <Line key={i} tone={line.tone}>
              {line.text}
            </Line>
          ))}
        <Box marginTop={1}>
          <Text color={review.issues.length ? color.error : color.warning}>
            {review.issues.length
              ? "Resolve these issues before applying."
              : "Apply this reviewed change? Press y. Esc cancels."}
          </Text>
        </Box>
      </Box>
    );
  else if (!inventory)
    content = (
      <Box flexDirection="column" padding={1}>
        <Line bold>Bring your skills into view</Line>
        <Text>
          Browse the skills on this machine and compare them with your other
          machines.
        </Text>
        <Text> </Text>
        <Text dimColor>
          Choose a workspace and preserve your existing global skills in a
          personal profile.
        </Text>
        <Text> </Text>
        <Line tone={color.accent}>Enter Set up this machine</Line>
      </Box>
    );
  else if (view === "Machines")
    content = (
      <Box flexDirection="column" padding={1}>
        <Line bold>Machines</Line>
        <Line tone={color.muted}>
          Local inspection and last published remote observations
        </Line>
        <Text> </Text>
        {inventory.machines
          .slice(
            Math.min(viewOffset, Math.max(0, inventory.machines.length - 1)),
            Math.min(viewOffset, Math.max(0, inventory.machines.length - 1)) +
              Math.max(1, Math.floor((bodyHeight - 3) / 4)),
          )
          .map((m) => (
            <Box key={m.id} flexDirection="column" marginBottom={1}>
              <Line
                bold
                tone={m.id === inventory.machine.id ? color.accent : undefined}
              >
                {safeText(m.name)}{" "}
                {m.id === inventory.machine.id
                  ? "This machine"
                  : "Remote observation"}
              </Line>
              <Line>
                {m.profile} ·{" "}
                {m.id === inventory.machine.id
                  ? inventory.discovery.projectsFound
                  : (m.projects ?? "?")}{" "}
                projects ·{" "}
                {m.id === inventory.machine.id
                  ? inventory.operations.length
                  : (m.changes ?? "?")}{" "}
                pending
              </Line>
              <Line tone={color.muted}>
                {m.id === inventory.machine.id
                  ? observedLabel(inventory.observedAt)
                  : m.observedAt
                    ? `Last observed ${observedLabel(m.observedAt)}`
                    : "No observation published yet"}
              </Line>
            </Box>
          ))}
      </Box>
    );
  else if (view === "Settings")
    content = (
      <Box flexDirection="column" padding={1}>
        <Line bold>Settings for {safeText(inventory.machine.name)}</Line>
        <Line>Global profile: {safeText(inventory.machine.profile)}</Line>
        <Text> </Text>
        <Line tone={color.muted}>Workspace roots</Line>
        {inventory.discovery.roots.map((r) => (
          <Line key={r.path}>
            {safeText(r.path)} depth {r.depth} {r.status}
          </Line>
        ))}
        <Text> </Text>
        {[
          "u  Set up a workspace and preserve global skills",
          "p  Create or copy a global profile",
          "b  Choose this machine's profile",
          "c  Connect a shared configuration repository",
          "m  Review old adoption requirements",
          "",
          "Git-owned skills stay under Git's control.",
          "Source verification is available in the library with v.",
          "Configuration changes are reviewed before installation.",
        ].map((x, i) => (
          <Line key={i}>{x}</Line>
        ))}
      </Box>
    );
  else if (view === "Changes")
    content = (
      <Box flexDirection="column" padding={1}>
        <Line bold>Changes on {safeText(inventory.machine.name)}</Line>
        <Line tone={color.muted}>
          Saved plan · press s to refresh and review before applying
        </Line>
        <Text> </Text>
        {inventory.operations.length ? (
          inventory.operations
            .slice(
              Math.min(
                viewOffset,
                Math.max(0, inventory.operations.length - 1),
              ),
              Math.min(
                viewOffset,
                Math.max(0, inventory.operations.length - 1),
              ) +
                bodyHeight -
                5,
            )
            .map((op, i) => (
              <Line
                key={i}
                tone={op.kind === "remove" ? color.warning : color.good}
              >
                {op.kind === "add" ? "+" : "−"} {safeText(op.skill.name)}{" "}
                {op.skill.scope} {safeText(op.skill.source)}{" "}
                {safeText(op.checkoutPath)}
              </Line>
            ))
        ) : (
          <>
            <Line tone={color.good}>
              No pending changes in this observation.
            </Line>
            <Text> </Text>
            <Text dimColor>
              Convergence covers declared requirements. Unmanaged and Git-owned
              skills remain visible in the library.
            </Text>
          </>
        )}
      </Box>
    );
  else if (details && narrow)
    content = (
      <Inspector
        entry={selected}
        lines={bodyHeight}
        width={size.width}
        offset={detailOffset}
        focused={details}
      />
    );
  else
    content = (
      <Box flexDirection="row" flexGrow={1}>
        {!narrow && (
          <Box
            width={21}
            flexDirection="column"
            borderStyle="single"
            borderColor={color.muted}
            paddingX={1}
          >
            <Line bold>Machines</Line>
            <Text> </Text>
            {[{ id: "all", name: "All machines" }, ...inventory.machines]
              .slice(0, bodyHeight - 8)
              .map((m) => (
                <Line
                  key={m.id}
                  tone={machine === m.id ? color.accent : undefined}
                  bold={machine === m.id}
                >
                  {machine === m.id ? "› " : "  "}
                  {safeText(m.name)}
                </Line>
              ))}
            <Text> </Text>
            <Line tone={color.muted}>m change machine</Line>
            <Line tone={color.muted}>
              {inventory.discovery.excludedWorktrees ?? 0} excluded
            </Line>
          </Box>
        )}
        <Box
          flexDirection="column"
          flexGrow={1}
          width={
            narrow
              ? size.width
              : Math.max(35, Math.floor((size.width - 21) * 0.52))
          }
          borderStyle="single"
          borderColor={color.muted}
          paddingX={1}
        >
          <Box>
            <Box flexGrow={1}>
              <Text bold>Skill</Text>
            </Box>
            {!tiny && (
              <Box width={12}>
                <Text dimColor>Ownership</Text>
              </Box>
            )}
            <Box width={4}>
              <Text dimColor>On</Text>
            </Box>
          </Box>
          {rows.length === 0 ? (
            <Box flexDirection="column" marginTop={1}>
              <Text>No matching skills.</Text>
              <Text dimColor>Press x to clear filters or r to refresh.</Text>
            </Box>
          ) : (
            rows.slice(offset, offset + pageSize).map((row, i) => (
              <Box key={row.name}>
                <Box flexGrow={1}>
                  <Text
                    wrap="truncate-end"
                    {...(offset + i === index ? { color: color.accent } : {})}
                    bold={offset + i === index}
                  >
                    {offset + i === index ? "› " : "  "}
                    {safeText(row.name)}
                  </Text>
                </Box>
                {!tiny && (
                  <Box width={12}>
                    <Text
                      wrap="truncate-end"
                      color={
                        row.ownership === "Unmanaged"
                          ? color.warning
                          : color.muted
                      }
                    >
                      {row.ownership}
                    </Text>
                  </Box>
                )}
                <Box width={4}>
                  <Text color={color.muted}>{row.machines.length}</Text>
                </Box>
              </Box>
            ))
          )}
        </Box>
        {!narrow && (
          <Box
            width={Math.max(30, Math.floor((size.width - 21) * 0.48))}
            borderStyle="single"
            borderColor={color.muted}
          >
            <Inspector
              entry={selected}
              lines={bodyHeight - 2}
              width={Math.max(30, Math.floor((size.width - 21) * 0.48)) - 2}
              offset={detailOffset}
              focused={details}
            />
          </Box>
        )}
      </Box>
    );
  return (
    <Box
      width={size.width}
      height={Math.max(12, size.height - 1)}
      flexDirection="column"
    >
      <Box paddingX={1} justifyContent="space-between">
        <Text bold color={color.accent}>
          Skilloom
        </Text>
        <Text>
          {tiny ? (
            <Text color={color.accent}>{view} · Tab switch</Text>
          ) : (
            ["Library", "Machines", "Changes", "Settings"].map((name, i) => (
              <Text
                key={name}
                color={view === name ? color.accent : color.muted}
                bold={view === name}
              >
                {i + 1} {name}{" "}
              </Text>
            ))
          )}
        </Text>
      </Box>
      <Box paddingX={1}>
        <Text
          wrap="truncate-end"
          color={searching ? color.accent : color.muted}
        >
          /{" "}
          {query ||
            (searching ? "" : "Search skills, sources, projects, agents")}
          {searching ? "▏" : ""}
        </Text>
      </Box>
      <Box paddingX={1} justifyContent="space-between">
        <Text wrap="truncate-end">
          {safeText(selectedMachine)} · {scope} · {ownership} · {rows.length}{" "}
          skills
        </Text>
        {!tiny && (
          <Text dimColor>
            {inventory
              ? `Observed ${observedLabel(inventory.observedAt)}`
              : "First run"}
          </Text>
        )}
      </Box>
      <Box height={bodyHeight} overflow="hidden" flexDirection="column">
        {content}
      </Box>
      <Box paddingX={1}>
        <Text
          wrap="truncate-end"
          color={busy ? color.accent : error ? color.error : color.good}
        >
          {safeText(
            busy
              ? progress
              : error ||
                  notice ||
                  (inventory?.cached
                    ? "Saved inventory · r refreshes this machine"
                    : "Installation changes require review."),
          )}
        </Text>
      </Box>
      <Box paddingX={1}>
        <Text wrap="truncate-end" dimColor>
          {footer}
        </Text>
      </Box>
      {!tiny && (
        <Box paddingX={1}>
          <KeyHint k="s">review sync</KeyHint>
          <KeyHint k="a">add</KeyHint>
          <KeyHint k="d">remove requirement</KeyHint>
          <KeyHint k="v">verify source</KeyHint>
          <KeyHint k="r">refresh</KeyHint>
        </Box>
      )}
    </Box>
  );
}
