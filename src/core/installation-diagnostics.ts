import { createHash } from "node:crypto";
import { lstat, opendir, readlink, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { installationDiagnosticRoots } from "../adapters/installation-roots.js";

export type InstallationFindingStatus =
  | "target-missing"
  | "unreadable"
  | "symlink-loop"
  | "not-directory"
  | "skill-file-invalid"
  | "changed-during-scan";
export interface InstallationDiagnosticEntry {
  /** Stable observation identity, not a fingerprint or permission to mutate. */
  id: string;
  name: string;
  path: string;
  aliases: string[];
  scope: "global" | "project";
  rootPath: string;
  status: InstallationFindingStatus;
  linkText?: string;
  /** Absolute link expression; preserves dot segments, not a resolved missing leaf. */
  targetPath?: string;
  /** A missing leaf under an existing resolved parent, for observation grouping only. */
  missingTargetPath?: string;
  errorCode?: string;
  /** The offending instruction-file entry, distinct from its installation directory. */
  skillFile?: { path: string; linkText?: string; targetPath?: string };
}
export interface InstallationDiagnosticRootCoverage {
  path: string;
  scope: "global" | "project";
  status:
    | "scanned"
    | "absent"
    | "target-missing"
    | "unreadable"
    | "symlink-loop"
    | "not-directory"
    | "partial"
    | "not-scanned"
    | "alias";
  entryCount: number;
  canonicalPath?: string;
  aliasOf?: string;
  errorCode?: string;
}
type StopReason = "entry-limit" | "root-limit" | "time-limit" | "aborted";
export interface InstallationDiagnosticsReport {
  schemaVersion: 1;
  machineId: string | null;
  machineName: string;
  platform: NodeJS.Platform;
  observedAt: string;
  complete: boolean;
  entries: InstallationDiagnosticEntry[];
  coverage: {
    roots: InstallationDiagnosticRootCoverage[];
    entriesChecked: number;
    limits: { maxEntries: number; maxRoots: number; maxDurationMs: number };
    stoppedBecause?: StopReason;
    limitations: string[];
  };
}
export interface InstallationDiagnosticsOptions {
  machineId: string | null;
  machineName: string;
  env: NodeJS.ProcessEnv;
  /** Explicit local checkout paths; no repository discovery or recursion. */
  projectRoots?: string[];
  maxEntries?: number;
  maxRoots?: number;
  maxDurationMs?: number;
  signal?: AbortSignal | undefined;
}
class ScanStopped extends Error {
  constructor(readonly reason: StopReason) {
    super(reason);
  }
}
function errorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error
    ? String(error.code)
    : "UNKNOWN";
}
function findingStatus(error: unknown): InstallationFindingStatus {
  const code = errorCode(error);
  if (code === "ENOENT") return "target-missing";
  if (code === "ELOOP") return "symlink-loop";
  if (code === "ENOTDIR") return "not-directory";
  return "unreadable";
}
function linkTargetExpression(parent: string, linkText: string): string {
  // normalize/resolve would collapse `pivot/..` before traversing pivot's
  // symlink, changing the filesystem meaning of the stored link target.
  return isAbsolute(linkText)
    ? linkText
    : `${parent}${parent.endsWith(sep) ? "" : sep}${linkText}`;
}
function limit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 1)
    throw new Error("Diagnostic scan limits must be positive finite numbers.");
  return Math.floor(value);
}

/** Read-only local observations. Absolute paths stay local; do not publish this report. */
export async function scanInstallationDiagnostics(
  options: InstallationDiagnosticsOptions,
): Promise<InstallationDiagnosticsReport> {
  const started = performance.now();
  const limits = {
    maxEntries: limit(options.maxEntries, 5_000),
    maxRoots: limit(options.maxRoots, 10_000),
    maxDurationMs: limit(options.maxDurationMs, 2_000),
  };
  const report: InstallationDiagnosticsReport = {
    schemaVersion: 1,
    machineId: options.machineId,
    machineName: options.machineName,
    platform: process.platform,
    observedAt: new Date().toISOString(),
    complete: true,
    entries: [],
    coverage: {
      roots: [],
      entriesChecked: 0,
      limits,
      limitations: [
        "Immediate children of known installation roots only; nested namespaces, hidden metadata directories, custom harness configuration and inactive plugin caches are not inspected.",
        "Candidate roots do not establish active harness loading, ownership, source, version or whether an installation is wanted.",
        "Checks inspect filesystem metadata, not skill contents, readability of contents, internal references or agent execution.",
        "Observations can change after scanning. Entry IDs are not mutation capabilities; no installation was changed.",
        "Filesystem calls are bounded by a scan deadline; a pending operating-system read may finish after the report returns.",
      ],
    },
  };
  if (process.platform === "win32")
    report.coverage.limitations.push(
      "Windows results are basic filesystem observations, not validated junction or reparse-point mutation support.",
    );
  const rootsByCanonicalPath = new Map<
    string,
    InstallationDiagnosticRootCoverage
  >();
  const entriesByRoot = new Map<string, InstallationDiagnosticEntry[]>();
  function check() {
    if (options.signal?.aborted) throw new ScanStopped("aborted");
    if (performance.now() - started >= limits.maxDurationMs)
      throw new ScanStopped("time-limit");
  }
  async function read<T>(
    operation: Promise<T>,
    cleanup?: (value: T) => void,
  ): Promise<T> {
    // Attach handlers before checking so even a raced rejection is consumed.
    let stopped = false;
    const pending = operation.then((value) => {
      if (stopped) cleanup?.(value);
      return value;
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      check();
      return await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new ScanStopped("time-limit")),
            Math.max(1, limits.maxDurationMs - (performance.now() - started)),
          );
          abort = () => reject(new ScanStopped("aborted"));
          options.signal?.addEventListener("abort", abort, { once: true });
          if (options.signal?.aborted) abort();
        }),
      ]);
    } catch (error) {
      stopped = true;
      // The operation may outlive its deadline. Consume any eventual rejection.
      void pending.catch(() => {});
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      if (abort) options.signal?.removeEventListener("abort", abort);
    }
  }
  async function missingLeaf(
    targetExpression: string,
  ): Promise<string | undefined> {
    // A trailing separator makes lstat follow a final symlink. Its ENOENT
    // would not prove that the directory entry itself is missing.
    if (
      targetExpression.endsWith(sep) ||
      (process.platform === "win32" && targetExpression.endsWith("/"))
    )
      return undefined;
    const leaf = basename(targetExpression);
    if (!leaf || leaf === "." || leaf === "..") return undefined;
    try {
      await read(lstat(targetExpression));
      // Existing leaf links can themselves point elsewhere; do not infer their
      // missing destination from the expression of a different link.
      return undefined;
    } catch (error) {
      if (error instanceof ScanStopped) throw error;
      if (errorCode(error) !== "ENOENT") return undefined;
    }
    try {
      // dirname preserves dot segments. realpath traverses intermediate links
      // before resolving '..', unlike lexical path normalization.
      const parent = await read(realpath(dirname(targetExpression)));
      return join(parent, leaf);
    } catch (error) {
      if (error instanceof ScanStopped) throw error;
      return undefined;
    }
  }
  async function inspectSkillFile(
    entry: InstallationDiagnosticEntry,
  ): Promise<boolean> {
    const filePath = join(entry.path, "SKILL.md");
    let before;
    try {
      before = await read(lstat(filePath));
    } catch (error) {
      if (error instanceof ScanStopped) throw error;
      // A truly absent instruction entry can be an intentional namespace.
      if (errorCode(error) === "ENOENT") return false;
      entry.status = findingStatus(error);
      entry.errorCode = errorCode(error);
      entry.skillFile = { path: filePath };
      return true;
    }
    if (before.isFile()) return false;
    entry.skillFile = { path: filePath };
    entry.status = "skill-file-invalid";
    if (!before.isSymbolicLink()) return true;
    try {
      entry.skillFile.linkText = await read(readlink(filePath));
      entry.skillFile.targetPath = linkTargetExpression(
        await read(realpath(entry.path)),
        entry.skillFile.linkText,
      );
      try {
        if ((await read(stat(filePath))).isFile()) return false;
      } catch (error) {
        if (error instanceof ScanStopped) throw error;
        const code = errorCode(error);
        entry.errorCode = code;
        if (!["ENOENT", "ELOOP", "ENOTDIR"].includes(code))
          entry.status = "unreadable";
      }
      const after = await read(lstat(filePath));
      if (
        !after.isSymbolicLink() ||
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.ctimeMs !== after.ctimeMs ||
        (await read(readlink(filePath))) !== entry.skillFile.linkText
      )
        entry.status = "changed-during-scan";
    } catch (error) {
      if (error instanceof ScanStopped) throw error;
      entry.errorCode = errorCode(error);
      entry.status =
        entry.errorCode === "ENOENT" ? "changed-during-scan" : "unreadable";
    }
    return true;
  }
  async function inspect(
    path: string,
    root: InstallationDiagnosticRootCoverage,
    canonicalRoot: string,
  ): Promise<InstallationDiagnosticEntry | undefined> {
    const name = basename(path);
    const entry: InstallationDiagnosticEntry = {
      id: createHash("sha256")
        .update(
          JSON.stringify([
            options.machineId,
            options.machineId === null ? options.machineName : null,
            join(canonicalRoot, name),
          ]),
        )
        .digest("hex"),
      name,
      path,
      aliases: [path],
      scope: root.scope,
      rootPath: root.path,
      status: "unreadable",
    };
    try {
      const before = await read(lstat(path));
      if (before.isSymbolicLink()) {
        entry.linkText = await read(readlink(path));
        entry.targetPath = linkTargetExpression(canonicalRoot, entry.linkText);
        try {
          if (!(await read(stat(path))).isDirectory())
            entry.status = "not-directory";
          else if (!(await inspectSkillFile(entry))) return undefined;
        } catch (error) {
          if (error instanceof ScanStopped) throw error;
          entry.status = findingStatus(error);
          entry.errorCode = errorCode(error);
        }
        if (entry.status === "target-missing") {
          const missing = await missingLeaf(entry.targetPath);
          if (missing) entry.missingTargetPath = missing;
        }
        // Diagnose a link only if that same link still occupies the entry.
        const after = await read(lstat(path));
        if (
          !after.isSymbolicLink() ||
          before.dev !== after.dev ||
          before.ino !== after.ino ||
          before.ctimeMs !== after.ctimeMs ||
          (await read(readlink(path))) !== entry.linkText
        )
          entry.status = "changed-during-scan";
        return entry;
      }
      if (before.isDirectory())
        return (await inspectSkillFile(entry)) ? entry : undefined;
      // Regular metadata files are not installation directories. Special
      // filesystem entries are unsupported observations, never removal advice.
      if (before.isFile()) return undefined;
      entry.status = "not-directory";
      return entry;
    } catch (error) {
      if (error instanceof ScanStopped) throw error;
      entry.status =
        errorCode(error) === "ENOENT"
          ? "changed-during-scan"
          : findingStatus(error);
      entry.errorCode = errorCode(error);
      return entry;
    }
  }
  try {
    for (const candidate of installationDiagnosticRoots(
      options.env,
      options.projectRoots,
      process.platform,
      check,
    )) {
      check();
      if (report.coverage.roots.length >= limits.maxRoots)
        throw new ScanStopped("root-limit");
      const root: InstallationDiagnosticRootCoverage = {
        ...candidate,
        status: "not-scanned",
        entryCount: 0,
      };
      report.coverage.roots.push(root);
      if (!isAbsolute(root.path)) {
        root.status = "unreadable";
        root.errorCode = "INVALID_ROOT";
        report.complete = false;
        continue;
      }
      let rootExists = false;
      try {
        const info = await read(lstat(root.path));
        rootExists = true;
        if (!info.isDirectory() && !info.isSymbolicLink()) {
          root.status = "not-directory";
          report.complete = false;
          continue;
        }
        const canonical = await read(realpath(root.path));
        root.canonicalPath = canonical;
        const existing = rootsByCanonicalPath.get(canonical);
        if (existing) {
          root.status = "alias";
          root.aliasOf = existing.path;
          root.entryCount = existing.entryCount;
          for (const entry of entriesByRoot.get(canonical) ?? [])
            entry.aliases.push(join(root.path, entry.name));
          continue;
        }
        rootsByCanonicalPath.set(canonical, root);
        const rootEntries: InstallationDiagnosticEntry[] = [];
        entriesByRoot.set(canonical, rootEntries);
        const directory = await read(opendir(root.path), (value) => {
          void Promise.resolve()
            .then(() => value.close())
            .catch(() => {});
        });
        root.status = "partial";
        try {
          while (true) {
            check();
            const child = await read(directory.read(), () => {
              void Promise.resolve()
                .then(() => directory.close())
                .catch(() => {});
            });
            if (!child) break;
            if (report.coverage.entriesChecked >= limits.maxEntries)
              throw new ScanStopped("entry-limit");
            report.coverage.entriesChecked++;
            root.entryCount++;
            if (child.name.startsWith(".")) continue;
            const entry = await inspect(
              join(root.path, child.name),
              root,
              canonical,
            );
            if (entry) {
              rootEntries.push(entry);
              report.entries.push(entry);
              if (
                entry.status === "unreadable" ||
                entry.status === "changed-during-scan"
              )
                report.complete = false;
            }
          }
          root.status = "scanned";
        } finally {
          void Promise.resolve()
            .then(() => directory.close())
            .catch(() => {});
        }
      } catch (error) {
        if (error instanceof ScanStopped) throw error;
        const code = errorCode(error);
        root.status =
          code === "ENOENT"
            ? rootExists
              ? "target-missing"
              : "absent"
            : (findingStatus(error) as
                | "unreadable"
                | "symlink-loop"
                | "not-directory");
        root.errorCode = code;
        if (root.status !== "absent") report.complete = false;
      }
    }
  } catch (error) {
    if (!(error instanceof ScanStopped)) throw error;
    report.complete = false;
    report.coverage.stoppedBecause = error.reason;
  }
  for (const entry of report.entries) entry.aliases.sort();
  report.entries.sort((a, b) => a.path.localeCompare(b.path));
  return report;
}
