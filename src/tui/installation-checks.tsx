import { Box, Text, useInput } from "ink";
import React, { useEffect, useMemo, useRef, useState } from "react";
import wrapAnsi from "wrap-ansi";
import type { InstallationDiagnosticsReport } from "../core/installation-diagnostics.js";
import { observedLabel, safeText } from "./catalog.js";

const colors = {
  accent: "#77A7DF",
  warning: "#DDB66E",
  muted: "#8392A5",
  selection: "#25384F",
  selected: "#E8F1FC",
};
type Entry = InstallationDiagnosticsReport["entries"][number];
interface Finding {
  key: string;
  name: string;
  status: Entry["status"];
  entries: Entry[];
}
interface Row {
  text: string;
  tone?: string;
  bold?: boolean;
  path?: boolean;
}
const labels: Record<string, string> = {
  "target-missing": "Target missing",
  unreadable: "Cannot inspect",
  "symlink-loop": "Link loop",
  "not-directory": "Not a directory",
  "skill-file-invalid": "Invalid SKILL.md entry",
  "changed-during-scan": "Changed during scan",
};
const stopLabels: Record<string, string> = {
  "entry-limit": "Entry limit reached",
  "root-limit": "Directory limit reached",
  "time-limit": "Time limit reached",
  aborted: "Scan cancelled",
};
export function installationFindingLabel(status: string): string {
  return labels[status] ?? status.replaceAll("-", " ");
}
function groupFindings(entries: Entry[]): Finding[] {
  const groups = new Map<string, Finding>();
  for (const entry of entries) {
    // Merge different expressions only when the scanner resolved the existing
    // parent and observed the same missing leaf. Raw expressions stay available.
    const key =
      entry.status === "target-missing" && entry.targetPath
        ? `${entry.status}:${entry.missingTargetPath ? `verified:${entry.missingTargetPath}` : `expression:${entry.targetPath}`}`
        : entry.id;
    const found = groups.get(key);
    if (found) {
      found.entries.push(entry);
      if (found.name !== entry.name) found.name = "Shared target";
    } else
      groups.set(key, {
        key,
        name: entry.name,
        status: entry.status,
        entries: [entry],
      });
  }
  return [...groups.values()];
}
function findingRows(finding: Finding): Row[] {
  const first = finding.entries[0]!;
  const target = first.missingTargetPath ?? first.targetPath;
  const sameScope = finding.entries.every(
    (entry) => entry.scope === first.scope,
  );
  const sameLinkText = finding.entries.every(
    (entry) => entry.linkText === first.linkText,
  );
  const explanation =
    finding.status === "target-missing"
      ? "Target absent when checked. It may be temporarily unavailable."
      : finding.status === "symlink-loop"
        ? "Following this link did not reach a target. Inspect the link chain."
        : "This entry could not be fully inspected. See its status and paths below.";
  return [
    { text: finding.name, bold: true },
    { text: installationFindingLabel(finding.status), tone: colors.warning },
    { text: "" },
    { text: explanation },
    ...(target
      ? [
          { text: "" },
          {
            text: first.missingTargetPath ? "Missing target" : "Link target",
            tone: colors.muted,
          },
          { text: target, path: true },
        ]
      : []),
    ...(!first.missingTargetPath &&
    sameLinkText &&
    first.linkText &&
    first.linkText !== first.targetPath
      ? [{ text: `Link text: ${first.linkText}`, tone: colors.muted }]
      : []),
    { text: "" },
    {
      text: `${finding.entries.length} ${finding.entries.length === 1 ? "directory entry" : "directory entries"}${sameScope ? ` (${first.scope})` : ""}`,
      bold: true,
    },
    ...finding.entries.flatMap((entry): Row[] => [
      { text: entry.path, tone: colors.accent, path: true },
      ...(entry.skillFile
        ? [
            {
              text: `SKILL.md entry: ${entry.skillFile.path}`,
              tone: colors.warning,
            },
            ...(entry.skillFile.linkText
              ? [
                  {
                    text: `Link text: ${entry.skillFile.linkText}`,
                    tone: colors.muted,
                  },
                ]
              : []),
            ...(entry.skillFile.targetPath
              ? [
                  {
                    text: `Link target: ${entry.skillFile.targetPath}`,
                    tone: colors.muted,
                  },
                ]
              : []),
          ]
        : []),
      ...(!sameScope
        ? [
            {
              text: entry.scope === "project" ? "Project" : "Global",
              tone: colors.muted,
            },
          ]
        : []),
      ...(!entry.missingTargetPath &&
      !sameLinkText &&
      entry.linkText !== undefined
        ? [{ text: `Link text: ${entry.linkText}`, tone: colors.muted }]
        : []),
      ...(entry.errorCode && entry.errorCode !== "ENOENT"
        ? [{ text: `Inspection: ${entry.errorCode}`, tone: colors.warning }]
        : []),
      ...entry.aliases
        .filter((alias) => alias !== entry.path)
        .map((alias) => ({
          text: `Also reached through ${alias}`,
          tone: colors.muted,
        })),
      { text: "" },
    ]),
    { text: "Leave unchanged", bold: true },
    {
      text: "This check does not change links, target contents, or requirements.",
    },
    ...(first.targetPath
      ? [
          {
            text: "Restoring the target could activate these entries and other undiscovered references.",
          },
        ]
      : []),
  ];
}
function coverageRows(report: InstallationDiagnosticsReport): Row[] {
  const roots = report.coverage.roots.filter(
    (root) => root.status !== "absent",
  );
  const problems = roots.filter(
    (root) => !["scanned", "alias"].includes(root.status),
  );
  const checked = roots.filter((root) =>
    ["scanned", "alias"].includes(root.status),
  );
  return [
    { text: "Scan coverage", bold: true },
    {
      text: `${report.coverage.entriesChecked} entries inspected on ${report.platform}`,
    },
    ...(report.coverage.stoppedBecause
      ? [
          {
            text:
              stopLabels[report.coverage.stoppedBecause] ??
              report.coverage.stoppedBecause,
            tone: colors.warning,
          },
        ]
      : []),
    {
      text: `${report.coverage.roots.length - roots.length} candidate directories were absent.`,
      tone: colors.muted,
    },
    {
      text: "Checks immediate entries. Nested skills, custom configuration and plugin caches are outside this scan.",
      tone: colors.muted,
    },
    { text: "" },
    ...[...problems, ...checked].flatMap((root): Row[] => [
      { text: root.path, tone: colors.accent, path: true },
      {
        text: `${root.status}${root.errorCode ? `: ${root.errorCode}` : ""}${root.status === "scanned" ? `, ${root.entryCount} entries` : ""}`,
        tone:
          root.status === "scanned" ||
          root.status === "absent" ||
          root.status === "alias"
            ? colors.muted
            : colors.warning,
      },
      ...(root.aliasOf
        ? [{ text: `Same directory as ${root.aliasOf}`, tone: colors.muted }]
        : []),
      { text: "" },
    ]),
    { text: "Scope and limitations", bold: true },
    ...report.coverage.limitations.map((text) => ({
      text,
      tone: colors.muted,
    })),
  ];
}
function scanSummary(report: InstallationDiagnosticsReport): string {
  const count = `${report.coverage.entriesChecked} entries checked`;
  if (report.coverage.stoppedBecause)
    return `${stopLabels[report.coverage.stoppedBecause]} · ${count}`;
  const unavailableRoots = report.coverage.roots.filter(
    (root) => !["scanned", "absent", "alias"].includes(root.status),
  );
  if (unavailableRoots.length)
    return `${unavailableRoots.length} directories could not be checked · ${count}`;
  if (!report.complete)
    return `Inspection incomplete · ${count} · c explains gaps`;
  return `${report.entries.length} findings · ${count} · c coverage`;
}
function wrapRow(row: Row, width: number): Row[] {
  const text = safeText(row.text);
  if (!row.path)
    return wrapAnsi(text, width, { hard: true, trim: false })
      .split("\n")
      .map((text) => ({ ...row, text }));
  const result: Row[] = [];
  let line = "";
  for (const segment of text.split(/(?<=[/\\])/)) {
    if (
      line &&
      wrapAnsi(line + segment, width, { hard: true, trim: false }).includes(
        "\n",
      )
    ) {
      result.push({ ...row, text: line });
      line = "";
    }
    const parts = wrapAnsi(line + segment, width, {
      hard: true,
      trim: false,
    }).split("\n");
    result.push(...parts.slice(0, -1).map((text) => ({ ...row, text })));
    line = parts.at(-1) ?? "";
  }
  if (line || !result.length) result.push({ ...row, text: line });
  return result;
}

export function InstallationChecks({
  scan,
  onClose,
  onReport,
  width,
  height,
  machineName,
}: {
  scan: () => Promise<InstallationDiagnosticsReport>;
  onClose: () => void;
  onReport?: (report: InstallationDiagnosticsReport) => void;
  width: number;
  height: number;
  machineName: string;
}) {
  const [report, setReport] = useState<InstallationDiagnosticsReport>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [index, setIndex] = useState(0);
  const [page, setPage] = useState<"list" | "finding" | "coverage">("list");
  const [offset, setOffset] = useState(0);
  const active = useRef(true);
  const scanning = useRef(false);
  const refresh = async () => {
    if (scanning.current) return;
    scanning.current = true;
    setLoading(true);
    setError("");
    try {
      const result = await scan();
      if (!active.current) return;
      setReport(result);
      onReport?.(result);
      setIndex(0);
      setOffset(0);
      setPage("list");
    } catch (cause) {
      if (active.current)
        setError(safeText(cause instanceof Error ? cause.message : cause));
    } finally {
      scanning.current = false;
      if (active.current) setLoading(false);
    }
  };
  useEffect(() => {
    active.current = true;
    void refresh();
    return () => {
      active.current = false;
    };
  }, []);
  const findings = useMemo(
    () => groupFindings(report?.entries ?? []),
    [report],
  );
  const selected = findings[index];
  const rows = useMemo(() => {
    const source =
      page === "coverage" && report
        ? coverageRows(report)
        : page === "finding" && selected
          ? findingRows(selected)
          : [];
    return source.flatMap((row) => wrapRow(row, Math.max(8, width - 4)));
  }, [page, report, selected, width]);
  const visible = Math.max(1, height - 7);
  const maxOffset = Math.max(0, rows.length - visible);
  useInput((input, key) => {
    if (key.escape || input === "l") {
      if (page === "list") onClose();
      else {
        setPage("list");
        setOffset(0);
      }
      return;
    }
    if (input === "r") {
      void refresh();
      return;
    }
    if (loading) return;
    if (input === "c" && report) {
      setPage("coverage");
      setOffset(0);
      return;
    }
    if (page === "list") {
      if ((key.return || input === "i") && selected) {
        setPage("finding");
        setOffset(0);
      }
      if (key.downArrow || input === "j" || key.pageDown)
        setIndex((i) =>
          Math.max(
            0,
            Math.min(findings.length - 1, i + (key.pageDown ? visible : 1)),
          ),
        );
      if (key.upArrow || input === "k" || key.pageUp)
        setIndex((i) => Math.max(0, i - (key.pageUp ? visible : 1)));
      if (key.home) setIndex(0);
      if (key.end) setIndex(Math.max(0, findings.length - 1));
    } else {
      if (key.downArrow || input === "j" || key.pageDown)
        setOffset((i) => Math.min(maxOffset, i + (key.pageDown ? visible : 1)));
      if (key.upArrow || input === "k" || key.pageUp)
        setOffset((i) => Math.max(0, i - (key.pageUp ? visible : 1)));
      if (key.home) setOffset(0);
      if (key.end) setOffset(maxOffset);
    }
  });
  const start = Math.floor(Math.max(0, index) / visible) * visible;
  const narrow = width < 70;
  const nameWidth = Math.max(10, width - (narrow ? 23 : 37));
  return (
    <Box flexDirection="column" paddingX={1} height={height}>
      <Text bold>Installation checks</Text>
      <Text color={colors.accent} wrap="truncate-end">
        {safeText(report?.machineName ?? machineName)} · this machine only
      </Text>
      <Text color={colors.muted} wrap="truncate-end">
        {report
          ? `Checked ${observedLabel(report.observedAt)}`
          : "Checking local directories"}
      </Text>
      <Text
        color={report?.complete === false ? colors.warning : colors.muted}
        wrap="truncate-end"
      >
        {loading
          ? "Checking entries… Esc returns to Library"
          : error
            ? `Check failed: ${error}`
            : report
              ? scanSummary(report)
              : "No scan available"}
      </Text>
      <Text> </Text>
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {page === "list" ? (
          findings.length ? (
            findings.slice(start, start + visible).map((finding, i) => (
              <Box
                key={finding.key}
                backgroundColor={
                  start + i === index ? colors.selection : undefined
                }
              >
                <Box width={nameWidth}>
                  <Text
                    wrap="truncate-end"
                    bold={start + i === index}
                    {...(start + i === index ? { color: colors.selected } : {})}
                  >
                    {start + i === index ? "› " : "  "}
                    {safeText(finding.name)}
                  </Text>
                </Box>
                <Box width={20}>
                  <Text
                    wrap="truncate-end"
                    color={
                      start + i === index ? colors.selected : colors.warning
                    }
                  >
                    {installationFindingLabel(finding.status)}
                  </Text>
                </Box>
                {!narrow && (
                  <Text
                    color={start + i === index ? colors.selected : colors.muted}
                  >
                    {finding.entries.length}{" "}
                    {finding.entries.length === 1 ? "entry" : "entries"}
                  </Text>
                )}
              </Box>
            ))
          ) : !loading && !error ? (
            <Text>
              {report?.complete
                ? "No findings in the checked directories."
                : "No findings in checked entries. Check coverage."}
            </Text>
          ) : null
        ) : (
          rows
            .slice(
              Math.min(offset, maxOffset),
              Math.min(offset, maxOffset) + visible,
            )
            .map((row, i) => (
              <Text
                key={i}
                {...(row.tone ? { color: row.tone } : {})}
                bold={row.bold ?? false}
              >
                {row.text || " "}
              </Text>
            ))
        )}
      </Box>
      <Text color={colors.muted} wrap="truncate-end">
        {page === "list"
          ? narrow
            ? "↑↓ select · Enter inspect · r rescan · Esc back"
            : "↑↓ select   Enter inspect   c coverage   r rescan   Esc Library"
          : "↑↓ scroll   c coverage   Esc findings"}
      </Text>
    </Box>
  );
}
