import { Box, Text, useApp, useInput, useStdout } from "ink";
import React, { useEffect, useMemo, useState } from "react";
import wrapAnsi from "wrap-ansi";
import type { InventoryProgress, MachineInventory } from "../core/types.js";
import {
  buildLibrary,
  filterLibrary,
  harnessLabel,
  invocationLabel,
  type LibraryEntry,
  observedLabel,
  ownershipLabel,
  safeText,
} from "./catalog.js";

import { SelectionMenu } from "./selection-menu.js";

export interface CommandResult {
  code: number;
  value: Record<string, unknown>;
}
export interface DashboardBackend {
  enrich?: (inventory: MachineInventory) => Promise<MachineInventory>;
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
  repository: "#C4B5E8",
  good: "#6FC1AD",
  warning: "#DDB66E",
  muted: "#8392A5",
  error: "#E58C8C",
};
const scopes = ["all", "global", "project"];
const ownerships = ["all", "managed", "git-owned", "unmanaged", "unknown"];
function cycle(values: string[], value: string, direction = 1): string {
  return values[
    (values.indexOf(value) + direction + values.length) % values.length
  ]!;
}
const settingsActions = [
  {
    key: "u",
    label: "Workspace setup",
    description: "Add a folder of projects and keep this machine's profile.",
  },
  {
    key: "p",
    label: "Create a profile",
    description: "Start an empty global skill set or copy an existing profile.",
  },
  {
    key: "b",
    label: "Choose global profile",
    description: "Choose the global requirements used by this machine.",
  },
  {
    key: "c",
    label: "Connect shared configuration",
    description:
      "Connect a Git repository to share configuration and observations.",
  },
  {
    key: "m",
    label: "Review legacy adoption",
    description:
      "Preview old ownership claims before migrating. Installed files are preserved.",
  },
];
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
interface DetailCell {
  text: string;
  width: number;
  tone?: string | undefined;
  bold?: boolean | undefined;
}
interface DetailLine {
  text: string;
  cells?: DetailCell[];

  tone?: string | undefined;
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
const wrapText = (text: string, width: number): string[] =>
  wrapAnsi(safeText(text), Math.max(4, width), {
    hard: true,
    trim: false,
  }).split("\n");
function wrapPath(value: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const part of safeText(value).split(/(?<=\/)/)) {
    if (line && wrapText(line + part, width).length > 1) {
      lines.push(line);
      line = "";
    }
    const wrapped = wrapText(line + part, width);
    lines.push(...wrapped.slice(0, -1));
    line = wrapped.at(-1) ?? "";
  }
  if (line || !lines.length) lines.push(line);
  return lines;
}
function field(
  label: string,
  value: string,
  width: number,
  tone?: string,
): DetailLine[] {
  const labelWidth = Math.min(14, Math.floor(width * 0.36));
  const labels = wrapText(label, labelWidth);
  const values = (label === "Checkout" ? wrapPath : wrapText)(
    value,
    width - labelWidth - 3,
  );
  return Array.from(
    { length: Math.max(labels.length, values.length) },
    (_, index) => ({
      text: "",
      cells: [
        { text: labels[index] ?? "", width: labelWidth + 3, tone: color.muted },
        { text: values[index] ?? "", width: width - labelWidth - 3, tone },
      ],
    }),
  );
}
function beside(
  left: DetailLine[],
  right: DetailLine[],
  width: number,
): DetailLine[] {
  const cells = (line: DetailLine | undefined): DetailCell[] =>
    line?.cells ?? [
      { text: line?.text ?? "", width, tone: line?.tone, bold: line?.bold },
    ];
  return Array.from(
    { length: Math.max(left.length, right.length) },
    (_, index) => ({
      text: "",
      cells: [
        ...cells(left[index]),
        { text: "", width: 6 },
        ...cells(right[index]),
      ],
    }),
  );
}
const scanLabel = (status: string): string =>
  status === "unscanned"
    ? "Unscanned"
    : status === "incomplete"
      ? "Partial scan"
      : "Complete scan";
function inspectorLines(entry: LibraryEntry, width: number): DetailLine[] {
  const usableWidth = Math.min(112, Math.max(12, width - 2));
  const wide = usableWidth >= 96;
  const columnWidth = wide ? Math.floor((usableWidth - 6) / 2) : usableWidth;
  const content: DetailLine[] = [
    { text: `Skill details · ${entry.name}`, bold: true },
  ];
  if (entry.occurrences.length > 1)
    content.push({
      text: `${entry.machines.length} machine${entry.machines.length === 1 ? "" : "s"}, ${entry.occurrences.length} locations`,
      tone: color.muted,
    });
  const groups = new Map<
    string,
    {
      record: LibraryEntry["occurrences"][number];
      count: number;
      paths: string[];
    }
  >();
  for (const record of entry.occurrences) {
    const key = JSON.stringify([
      record.machine.id,
      record.projectId,
      record.source,
      record.agents,
      record.detectedAgents,
      record.ownership,
      record.managed,
      record.installed,
      record.desired,
      record.conflict,
      record.metadata,
      record.usedBy,
      record.nameEvidence,
      record.usageCoverage,
    ]);
    const group = groups.get(key);
    if (group) {
      group.count++;
      if (record.checkoutPath) group.paths.push(record.checkoutPath);
    } else
      groups.set(key, {
        record,
        count: 1,
        paths: record.checkoutPath ? [record.checkoutPath] : [],
      });
  }
  // Keep every machine's installations together even if occurrence order interleaves them.
  const machineOrder = [
    ...new Set(entry.occurrences.map((record) => record.machine.id)),
  ];
  let activeMachine: string | undefined;
  for (const { record, count, paths } of [...groups.values()].sort(
    (a, b) =>
      machineOrder.indexOf(a.record.machine.id) -
      machineOrder.indexOf(b.record.machine.id),
  )) {
    const firstOnMachine = activeMachine !== record.machine.id;
    if (firstOnMachine) {
      content.push(
        { text: " " },
        {
          text: record.machine.name,
          bold: true,
          tone: color.accent,
        },
      );
      activeMachine = record.machine.id;
    } else content.push({ text: " " });
    const heading =
      record.scope === "global"
        ? "Global installation"
        : record.projectId && !record.projectId.startsWith("local:")
          ? record.projectId
          : `Local project: ${record.projectName ?? "Unknown"}`;
    content.push(
      {
        text: `${heading}${count > 1 ? ` (${count} locations)` : ""}`,
        tone: color.repository,
        bold: true,
      },
      { text: " " },
    );
    const installation: DetailLine[] = [
      { text: "Installation", bold: true },
      { text: " " },
    ];
    const behavior: DetailLine[] = [
      { text: "Agent behavior", bold: true },
      { text: " " },
    ];
    const owner = ownershipLabel(record);
    installation.push(
      ...field(
        "Status",
        record.installed ? "Installed" : "Missing",
        columnWidth,
        record.installed ? color.good : color.warning,
      ),
    );
    installation.push(
      ...field(
        "Ownership",
        owner === "Managed" ? "Skilloom managed" : owner,
        columnWidth,
      ),
    );
    if (record.desired)
      installation.push(...field("Policy", "Required", columnWidth));
    installation.push(
      { text: " " },
      ...field(
        "Skill source",
        record.source ?? "Unknown",
        columnWidth,
        record.source ? color.repository : color.muted,
      ),
    );
    for (const path of [...new Set(paths)])
      installation.push(...field("Checkout", path, columnWidth));
    if (!paths.length && record.checkoutId)
      installation.push(
        ...field("Checkout ID", record.checkoutId, columnWidth),
      );
    if (firstOnMachine)
      installation.push(
        { text: " " },
        ...field(
          "Last observed",
          observedLabel(record.observedAt),
          columnWidth,
          color.muted,
        ),
      );
    const variants = record.metadata?.variants ?? [];
    const mode = record.metadata?.invocation ?? "unknown";
    const modeLabel =
      mode === "unknown"
        ? "Unknown"
        : mode === "both"
          ? "Manual + automatic"
          : invocationLabel(mode);
    behavior.push(...field("Invocation", modeLabel, columnWidth));
    const known = variants.filter(
      (variant) =>
        variant.status === "read" && variant.invocation !== "unknown",
    );
    const uniform =
      known.length > 0 && known.every((variant) => variant.invocation === mode);
    const declaresAllAvailable =
      new Set(known.map((variant) => variant.agent)).size ===
        new Set(record.agents).size &&
      record.agents.every((agent) =>
        known.some((variant) => variant.agent === agent),
      );
    if (uniform && mode !== "unknown" && !declaresAllAvailable)
      behavior.push(
        ...field(
          "Declared for",
          known.map((variant) => variant.agent).join(", "),
          columnWidth,
          color.muted,
        ),
      );
    behavior.push(
      ...field(
        "Available to",
        record.agents.join(", ") || "Unknown",
        columnWidth,
      ),
    );
    for (const variant of variants.filter(
      (variant) =>
        variant.status !== "unsupported" &&
        !(uniform && known.includes(variant)),
    )) {
      if (
        variant.status === "read" &&
        variant.invocation === "unknown" &&
        mode === "unknown"
      )
        continue;
      behavior.push(
        ...field(
          variant.agent,
          variant.invocation === "unknown"
            ? variant.status
            : invocationLabel(variant.invocation),
          columnWidth,
          color.muted,
        ),
      );
    }
    const unsupported = variants.filter(
      (variant) => variant.status === "unsupported",
    );
    if (unsupported.length && mode !== "unknown")
      behavior.push(
        ...field(
          "Unknown for",
          unsupported.map((variant) => variant.agent).join(", "),
          columnWidth,
          color.muted,
        ),
      );
    if (record.detectedAgents)
      behavior.push(
        ...field(
          "Detected here",
          record.detectedAgents.join(", "),
          columnWidth,
          color.muted,
        ),
      );
    behavior.push({ text: " " });
    if (record.usedBy?.length) {
      for (const usage of record.usedBy) {
        behavior.push(
          ...field(
            harnessLabel(usage.harness),
            `${usage.count} ${usage.evidence === "invoke" ? "invocations" : "skill reads"}`,
            columnWidth,
            color.good,
          ),
        );
        behavior.push(
          ...field(
            "Last read",
            observedLabel(usage.lastUsedAt),
            columnWidth,
            color.muted,
          ),
        );
      }
    } else
      behavior.push(
        ...field(
          "Read evidence",
          record.usageCoverage ? "None recorded" : "Not collected",
          columnWidth,
          color.muted,
        ),
      );
    for (const usage of record.nameEvidence ?? [])
      behavior.push(
        ...field(
          "Name-only use",
          `${harnessLabel(usage.harness)}: ${usage.count} invocations. Installation unknown.`,
          columnWidth,
          color.muted,
        ),
      );
    if (record.conflict)
      installation.push(
        { text: " " },
        ...field("Conflict", record.conflict, columnWidth, color.error),
      );
    content.push(
      ...(wide
        ? beside(installation, behavior, columnWidth)
        : [...installation, { text: " " }, ...behavior]),
    );
  }
  content.push(
    { text: " " },
    { text: " " },
    { text: "Evidence coverage", bold: true },
    { text: " " },
  );
  if (usableWidth >= 76) {
    const widths = [
      Math.floor(usableWidth * 0.34),
      Math.floor(usableWidth * 0.26),
    ];
    widths.push(usableWidth - widths[0]! - widths[1]!);
    const tableRow = (values: string[], header = false) => {
      const columns = values.map((value, index) =>
        wrapText(value, widths[index]! - 3),
      );
      return Array.from(
        { length: Math.max(...columns.map((column) => column.length)) },
        (_, i) => ({
          text: "",
          cells: columns.map((column, index) => ({
            text: column[i] ?? "",
            width: widths[index]!,
            tone: header ? color.muted : undefined,
            bold: header,
          })),
        }),
      );
    };
    content.push(...tableRow(["Machine", "Scan", "Collected"], true), {
      text: " ",
    });
    for (const machine of entry.usageMachines)
      content.push(
        ...tableRow([
          machine.name,
          scanLabel(machine.status),
          machine.observedAt ? observedLabel(machine.observedAt) : "—",
        ]),
      );
  } else {
    for (const machine of entry.usageMachines) {
      content.push(
        ...field(machine.name, scanLabel(machine.status), usableWidth),
      );
      if (machine.observedAt)
        content.push(
          ...field(
            "Collected",
            observedLabel(machine.observedAt),
            usableWidth,
            color.muted,
          ),
        );
      content.push({ text: " " });
    }
  }
  return content.flatMap((line) =>
    line.cells ? [line] : wrapLines([line], usableWidth),
  );
}
function Preview({
  entry,
  lines,
  width,
}: {
  entry: LibraryEntry | undefined;
  lines: number;
  width: number;
}) {
  if (!entry)
    return (
      <Box paddingX={1}>
        <Text dimColor>No skill selected.</Text>
      </Box>
    );
  const machines = new Map<string, number>();
  for (const record of entry.occurrences)
    machines.set(
      record.machine.name,
      (machines.get(record.machine.name) ?? 0) + 1,
    );
  const content: DetailLine[] = [
    { text: "Preview", tone: color.muted },
    ...(entry.occurrences.some((record) => record.stale)
      ? [{ text: "Saved observations", tone: color.muted }]
      : []),
    { text: entry.name, bold: true },
    { text: " " },
    {
      text:
        entry.sources.length === 1
          ? entry.sources[0]!
          : `${entry.sources.length} sources across locations`,
      tone: color.muted,
    },
    {
      text:
        entry.ownership === "Managed" ? "Managed by Skilloom" : entry.ownership,
      tone: color.muted,
    },
    { text: " " },
    ...[...machines].slice(0, 4).map(([name, count]) => ({
      text: `${name}  ${count} location${count === 1 ? "" : "s"}`,
    })),
    ...(machines.size > 4
      ? [{ text: `+${machines.size - 4} more machines`, tone: color.muted }]
      : []),
  ];
  return (
    <Box flexDirection="column" paddingX={1}>
      {wrapLines(content, width - 2)
        .slice(0, Math.max(1, lines - 2))
        .map((line, i) => (
          <Line key={i} tone={line.tone} bold={line.bold}>
            {line.text}
          </Line>
        ))}
      <Text> </Text>
      <Line tone={color.accent}>Enter or i opens full details</Line>
    </Box>
  );
}
function Inspector({
  entry,
  lines,
  width,
  offset,
}: {
  entry: LibraryEntry | undefined;
  lines: number;
  width: number;
  offset: number;
}) {
  if (!entry)
    return <Text dimColor>Select a skill to inspect its installations.</Text>;
  const wrapped = inspectorLines(entry, width);
  const page = Math.max(1, lines - 1);
  const start = Math.min(offset, Math.max(0, wrapped.length - page));
  return (
    <Box flexDirection="column" paddingX={1}>
      {wrapped.slice(start, start + page).map((line, i) =>
        line.cells ? (
          <Box key={i} height={1} flexShrink={0}>
            {line.cells.map((cell, column) => (
              <Box key={column} width={cell.width} flexShrink={0}>
                <Text
                  {...(cell.tone ? { color: cell.tone } : {})}
                  bold={cell.bold ?? false}
                  wrap="truncate-end"
                >
                  {cell.text}
                </Text>
              </Box>
            ))}
          </Box>
        ) : (
          <Line key={i} tone={line.tone} bold={line.bold}>
            {line.text}
          </Line>
        ),
      )}
      {wrapped.length > page && (
        <Line tone={color.accent}>
          Details · {start + 1}–{Math.min(start + page, wrapped.length)}/
          {wrapped.length}
        </Line>
      )}
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
  const [searchCursor, setSearchCursor] = useState(0);
  const [searching, setSearching] = useState(false);
  const [machine, setMachine] = useState("all");
  const [scope, setScope] = useState("all");
  const [ownership, setOwnership] = useState("all");
  const [index, setIndex] = useState(0);
  const [details, setDetails] = useState(false);
  const [enriching, setEnriching] = useState(false);
  const [detailOffset, setDetailOffset] = useState(0);
  const [settingsIndex, setSettingsIndex] = useState(0);
  const [changeIndex, setChangeIndex] = useState(0);
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
  useEffect(() => {
    if (!inventory || !backend.enrich) return;
    const localSkills = [
      ...inventory.globalSkills,
      ...inventory.projects.flatMap((project) =>
        project.checkouts.flatMap((checkout) => checkout.skills ?? []),
      ),
    ];
    if (
      inventory.skillUsage?.version === 2 &&
      localSkills.every((skill) => !skill.installed || skill.metadata)
    ) {
      setEnriching(false);
      return;
    }
    let active = true;
    const original = inventory;
    setEnriching(true);
    void backend
      .enrich(original)
      .then((enriched) => {
        if (active) {
          setEnriching(false);
          setInventory((current) =>
            current === original ? enriched : current,
          );
        }
      })
      .catch((error) => {
        if (active) {
          setEnriching(false);
          setNotice(
            `Metadata unavailable: ${errorText(error)}. Press r to retry.`,
          );
        }
      });
    return () => {
      active = false;
    };
  }, [backend, inventory]);
  const entries = useMemo(
    () => (inventory ? buildLibrary(inventory) : []),
    [inventory],
  );
  const rows = useMemo(
    () => filterLibrary(entries, { query, machine, scope, ownership }),
    [entries, query, machine, scope, ownership],
  );
  const evidenceMachines = (entries[0]?.usageMachines ?? []).filter(
    (item) => machine === "all" || item.id === machine,
  );
  const selected = rows[Math.min(index, Math.max(0, rows.length - 1))];
  useEffect(() => {
    setIndex((current) => Math.min(current, Math.max(0, rows.length - 1)));
  }, [rows.length]);
  useEffect(() => {
    setIndex(0);
  }, [query, scope, ownership]);
  const changeMachine = (direction: number) => {
    if (!inventory) return;
    const machines = [
      "all",
      ...new Set(inventory.machines.map((machine) => machine.id)),
    ];
    const current = Math.max(0, machines.indexOf(machine));
    const next =
      machines[(current + direction + machines.length) % machines.length]!;
    const nextRows = filterLibrary(entries, {
      query,
      machine: next,
      scope,
      ownership,
    });
    setIndex(
      Math.max(
        0,
        nextRows.findIndex((row) => row.name === selected?.name),
      ),
    );
    setMachine(next);
  };
  const narrow = size.width < 120;
  const tiny = size.width < 65;
  const showLibrarySync =
    view === "Library" &&
    inventory &&
    !searching &&
    !details &&
    !form &&
    !review &&
    !outcome &&
    !help;
  const bodyHeight = Math.max(
    5,
    size.height -
      (view === "Library" && !details ? 8 : 6) -
      (showLibrarySync ? 1 : 0),
  );
  const skillColumnWidth = Math.max(
    8,
    (narrow ? size.width : Math.floor(size.width * 0.7)) - 4 - (tiny ? 0 : 22),
  );
  const pageSize = Math.max(1, bodyHeight - 4);
  useEffect(() => {
    setDetailOffset(0);
  }, [selected?.name]);
  useEffect(() => {
    setChangeIndex((index) =>
      Math.min(index, inventory?.operations.length ?? 0),
    );
  }, [inventory]);
  const goToView = (next: string) => {
    setView(next);
    setDetails(false);
    setNotice("");
  };
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
      if (key.escape || key.return || key.downArrow || key.upArrow) {
        setSearching(false);
        setDetails(false);
        if (key.downArrow)
          setIndex((current) =>
            Math.min(Math.max(0, rows.length - 1), current + 1),
          );
        if (key.upArrow) setIndex((current) => Math.max(0, current - 1));
        return;
      }
      const characters = Array.from(query);
      const cursor = Math.min(searchCursor, characters.length);
      if (key.leftArrow) {
        setSearchCursor(Math.max(0, cursor - 1));
        return;
      }
      if (key.rightArrow) {
        setSearchCursor(Math.min(characters.length, cursor + 1));
        return;
      }
      if (key.home || (key.ctrl && input === "a")) {
        setSearchCursor(0);
        return;
      }
      if (key.end || (key.ctrl && input === "e")) {
        setSearchCursor(characters.length);
        return;
      }
      if (key.backspace || key.delete) {
        if (cursor > 0) {
          characters.splice(cursor - 1, 1);
          setQuery(characters.join(""));
          setSearchCursor(cursor - 1);
        }
      } else if (!key.ctrl && !key.meta) {
        const inserted = Array.from(safeText(input));
        characters.splice(cursor, 0, ...inserted);
        setQuery(characters.join(""));
        setSearchCursor(cursor + inserted.length);
      }
      return;
    }
    if (key.escape) {
      if (details) setDetails(false);
      else if (view !== "Library") goToView("Library");
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
      goToView("Library");
      setSearchCursor(Array.from(query).length);
      setSearching(true);
      return;
    }
    if (["1", "2", "3"].includes(input)) {
      goToView(["Library", "Changes", "Settings"][Number(input) - 1]!);
      return;
    }
    if (key.tab) {
      goToView(
        cycle(["Library", "Changes", "Settings"], view, key.shift ? -1 : 1),
      );
      return;
    }
    if (input === "r") {
      void load(true);
      return;
    }
    if (
      input === "s" &&
      inventory &&
      (view === "Library" || view === "Changes")
    ) {
      void preview("sync");
      return;
    }
    if (!inventory) {
      if (key.return || input === "u") setupForm();
      return;
    }
    if (view !== "Library") {
      const selectedIndex = view === "Changes" ? changeIndex : settingsIndex;
      const setSelected =
        view === "Changes" ? setChangeIndex : setSettingsIndex;
      const count =
        view === "Changes"
          ? inventory.operations.length + 1
          : settingsActions.length;
      const last = Math.max(0, count - 1);
      const step = Math.max(1, bodyHeight - 9);
      if (key.downArrow || input === "j" || key.pageDown) {
        setSelected(Math.min(last, selectedIndex + (key.pageDown ? step : 1)));
        return;
      }
      if (key.upArrow || input === "k" || key.pageUp) {
        setSelected(Math.max(0, selectedIndex - (key.pageUp ? step : 1)));
        return;
      }
      if (key.home) {
        setSelected(0);
        return;
      }
      if (key.end) {
        setSelected(last);
        return;
      }
      if (view === "Changes") {
        if (key.return) {
          if (changeIndex === 0) void preview("sync");
          else {
            const operation = inventory.operations[changeIndex - 1];
            if (!operation) return;
            setReviewOffset(0);
            setOutcome([
              "Change details",
              `${operation.kind === "add" ? "Add" : "Remove"} ${operation.skill.name}`,
              `Scope: ${operation.skill.scope}`,
              `Source: ${operation.skill.source ?? "Unknown"}`,
              `Agents: ${operation.skill.agents.join(", ")}`,
              ...(operation.checkoutPath
                ? [`Checkout: ${operation.checkoutPath}`]
                : []),
              ...operation.reasons,
              "Saved plan only. Review sync checks current state before applying.",
            ]);
          }
        }
        return;
      }
    }
    if (view === "Settings") {
      const action = key.return ? settingsActions[settingsIndex]!.key : input;
      const actionIndex = settingsActions.findIndex(
        (item) => item.key === action,
      );
      if (actionIndex >= 0) setSettingsIndex(actionIndex);
      if (action === "m") {
        void preview("migrate");
        return;
      }
      if (action === "u") {
        setupForm();
        return;
      }
      if (action === "p")
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
      if (action === "b")
        showForm({
          title: "Choose this machine's profile",
          hint: `Available: ${inventory.profiles.join(", ")}. Review sync before applying.`,
          fields: [
            {
              label: "Profile",
              value: inventory.machine.profile,
              choices: inventory.profiles,
            },
          ],
          submit: (f) => ["config", "--profile", f[0]!.value],
        });
      if (action === "c")
        showForm({
          title: "Connect shared configuration",
          hint: "Uses your Git credentials. Existing policy is merged; conflicts require resolution.",
          fields: [{ label: "Repository URL", value: "" }],
          submit: (f) => ["connect", f[0]!.value],
        });
      return;
    }
    if (details && ["m", "g", "o", "x"].includes(input)) return;
    if (
      view === "Library" &&
      !details &&
      (key.leftArrow || key.rightArrow || input === "m")
    ) {
      changeMachine(key.leftArrow ? -1 : 1);
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
    if (
      (key.return || input === "i") &&
      view === "Library" &&
      !details &&
      selected
    ) {
      setDetails(true);
      setDetailOffset(0);
      return;
    }
    if (details) {
      const update = setDetailOffset;
      const max = Math.max(
        0,
        (selected ? inspectorLines(selected, size.width).length : 0) -
          (bodyHeight - 1),
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
        : searching
          ? "Enter/Esc results · ↑↓ select"
          : details
            ? selected &&
              inspectorLines(selected, size.width).length > bodyHeight - 1
              ? "Esc results · ↑↓ scroll"
              : "Esc results"
            : view !== "Library"
              ? tiny
                ? "↑↓ select · Enter open · Esc library"
                : `↑↓ select   Enter ${view === "Changes" ? "open" : "choose"}   Tab/Shift-Tab views   Esc library`
              : tiny
                ? "↑↓ select · Enter/i details · / search · ?"
                : `↑↓ select   Enter/i details   / search   ? help   q quit`;
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
      <Box flexDirection="column" paddingX={1}>
        <Line bold>Keyboard guide</Line>
        {[
          "1–3 views · Tab next · Shift-Tab back",
          "/ search · Enter/Esc results",
          "↑↓ or j/k select · Enter/i details",
          "←/→ machine · g scope · o ownership",
          "x clear filters · r refresh",
          "s review sync · y apply in review",
          "a add · d remove · v verify source",
          "Details: Esc results · ↑↓ scroll",
          "?/Esc close help · q quit",
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
  else if (view === "Settings")
    content = (
      <SelectionMenu
        title={`Settings for ${inventory.machine.name}`}
        subtitle={`Profile: ${inventory.machine.profile} · ${inventory.discovery.roots.length} workspace ${inventory.discovery.roots.length === 1 ? "root" : "roots"}`}
        items={settingsActions}
        selected={settingsIndex}
        context={[settingsActions[settingsIndex]!.description]}
        height={bodyHeight}
        width={size.width}
      />
    );
  else if (view === "Changes") {
    const selectedOperation = inventory.operations[changeIndex - 1];
    content = (
      <SelectionMenu
        title={`Changes on ${inventory.machine.name}`}
        subtitle={
          inventory.operations.length
            ? `${inventory.operations.length} saved changes. Review before applying.`
            : "No saved installation changes."
        }
        items={[
          { label: "Review sync" },
          ...inventory.operations.map((operation) => ({
            label: `${operation.kind === "add" ? "Add" : "Remove"} ${operation.skill.name}   ${operation.skill.scope}`,
          })),
        ]}
        selected={changeIndex}
        height={bodyHeight}
        width={size.width}
        context={
          selectedOperation
            ? [
                `Source: ${selectedOperation.skill.source ?? "Unknown"}`,
                selectedOperation.checkoutPath ??
                  "Global installation on this machine.",
                "Enter shows details. Press s to review a fresh sync.",
              ]
            : [
                "Check installations and review a fresh plan.",
                "Confirm the review to apply changes.",
              ]
        }
      />
    );
  } else if (details)
    content = (
      <Inspector
        entry={selected}
        lines={bodyHeight}
        width={size.width}
        offset={detailOffset}
      />
    );
  else
    content = (
      <Box flexDirection="row" flexGrow={1}>
        <Box
          flexDirection="column"
          flexGrow={1}
          width={narrow ? size.width : Math.floor(size.width * 0.7)}
          borderStyle="single"
          borderColor={searching ? color.muted : color.accent}
          paddingX={1}
        >
          <Line tone={searching ? color.muted : color.accent} bold>
            Results{searching ? "" : " · ↑↓ select"}
          </Line>
          <Box>
            <Box width={skillColumnWidth} paddingRight={1}>
              <Text bold>Skill</Text>
            </Box>
            {!tiny && (
              <Box width={12}>
                <Text dimColor>Ownership</Text>
              </Box>
            )}
            {!tiny && (
              <Box width={10}>
                <Text dimColor>Machines</Text>
              </Box>
            )}
          </Box>
          {rows.length === 0 ? (
            <Box flexDirection="column" marginTop={1}>
              <Text>No matching skills.</Text>
              <Text dimColor>Press x to clear filters or r to refresh.</Text>
            </Box>
          ) : (
            rows.slice(offset, offset + pageSize).map((row, i) => (
              <Box key={row.name}>
                <Box width={skillColumnWidth} paddingRight={1}>
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
                {!tiny && (
                  <Box width={10}>
                    <Text color={color.muted}>{row.machines.length}</Text>
                  </Box>
                )}
              </Box>
            ))
          )}
        </Box>
        {!narrow && (
          <Box
            width={size.width - Math.floor(size.width * 0.7)}
            borderStyle="single"
            borderColor={color.muted}
          >
            <Preview
              entry={selected}
              lines={bodyHeight - 2}
              width={size.width - Math.floor(size.width * 0.7) - 2}
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
            ["Library", "Changes", "Settings"].map((name, i) => (
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
      {showLibrarySync && (
        <Box paddingX={1} justifyContent="space-between">
          <Text color={color.accent} bold wrap="truncate-end">
            s Sync {safeText(inventory.machine.name)}
          </Text>
          {!tiny && <Text dimColor>Review before applying</Text>}
        </Box>
      )}
      {view === "Library" && !details && (
        <>
          <Box paddingX={1}>
            <Text
              wrap="truncate-end"
              color={searching ? color.accent : color.muted}
            >
              {searching ? "Editing search: " : "Search: "}
              {searching
                ? `${Array.from(query)
                    .slice(
                      Math.max(0, searchCursor - Math.max(5, size.width - 24)),
                      searchCursor,
                    )
                    .join(
                      "",
                    )}▏${Array.from(query).slice(searchCursor).join("")}`
                : query || "press /"}
            </Text>
          </Box>
          <Box paddingX={1} justifyContent="space-between">
            <Text wrap="truncate-end">
              {!searching
                ? `‹ ${safeText(selectedMachine)} ›`
                : safeText(selectedMachine)}
              {scope === "all" ? "" : ` · ${scope}`}
              {ownership === "all" ? "" : ` · ${ownership}`} · {rows.length}{" "}
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
        </>
      )}
      <Box height={bodyHeight} overflow="hidden" flexDirection="column">
        {content}
      </Box>
      <Box paddingX={1}>
        <Text
          wrap="truncate-end"
          color={
            busy
              ? color.accent
              : error
                ? color.error
                : notice
                  ? color.good
                  : color.muted
          }
        >
          {safeText(
            busy
              ? progress
              : enriching
                ? "Loading skill metadata · browsing stays available"
                : error ||
                  notice ||
                  (view !== "Library"
                    ? " "
                    : inventory && !details
                      ? "r refresh inventory"
                      : inventory?.skillUsage
                        ? `Evidence ${evidenceMachines.filter((machine) => machine.status !== "unscanned").length}/${evidenceMachines.length} machines collected · r refresh local`
                        : inventory?.cached
                          ? "Metadata not collected · r refresh"
                          : "Installation changes require review."),
          )}
        </Text>
      </Box>
      <Box paddingX={1}>
        <Text wrap="truncate-end" dimColor>
          {footer}
        </Text>
      </Box>
      {!tiny &&
        !details &&
        !searching &&
        !form &&
        !review &&
        !outcome &&
        !help &&
        view === "Library" && (
          <Box paddingX={1}>
            <KeyHint k="←/→">machine</KeyHint>
            <KeyHint k="g">scope</KeyHint>
            <KeyHint k="o">ownership</KeyHint>
            <KeyHint k="x">clear filters</KeyHint>
          </Box>
        )}
    </Box>
  );
}
