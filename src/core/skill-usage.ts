import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  mkdir,
  open,
  opendir,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";

export type SkillHarness = "codex" | "claude" | "pi";
export interface SkillUsage {
  name: string;
  harness: SkillHarness;
  evidence: "invoke" | "read";
  count: number;
  lastUsedAt: string;
}
export interface SkillUsageScan {
  usage: SkillUsage[];
  coverage: {
    status: "complete" | "incomplete";
    filesDiscovered: number;
    filesScanned: number;
    bytesRead: number;
    limitsHit: string[];
    observedAt: string;
  };
}
export const skillUsageScanSchema = z.object({
  usage: z.array(
    z.object({
      name: z.string(),
      harness: z.enum(["codex", "claude", "pi"]),
      evidence: z.enum(["invoke", "read"]),
      count: z.number().int().nonnegative(),
      lastUsedAt: z.string(),
    }),
  ),
  coverage: z.object({
    status: z.enum(["complete", "incomplete"]),
    filesDiscovered: z.number().int().nonnegative(),
    filesScanned: z.number().int().nonnegative(),
    bytesRead: z.number().int().nonnegative(),
    limitsHit: z.array(z.string()),
    observedAt: z.string(),
  }),
});
interface Pending {
  id: string;
  names: string[];
  evidence: "invoke" | "read";
  at: string;
}
interface Cursor {
  identity: string;
  offset: number;
  mtimeMs: number;
  cwd: string;
  pending: Pending[];
  omittedHistory: boolean;
}
interface Event {
  id: string;
  name: string;
  harness: SkillHarness;
  evidence: "invoke" | "read";
  at: string;
}
interface Cache {
  version: 1;
  files: Record<string, Cursor>;
  events: Event[];
  omittedEvents: boolean;
  knownFingerprint?: string;
  lastCoverage?: SkillUsageScan["coverage"];
}
interface Candidate {
  path: string;
  harness: SkillHarness;
  modified: number;
  size: number;
  identity: string;
}
const LIMITS = {
  milliseconds: 1500,
  directories: 256,
  entries: 6000,
  candidates: 192,
  files: 48,
  bytes: 8 * 1024 * 1024,
  perFile: 512 * 1024,
  events: 10000,
};
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const array = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];
const text = (value: unknown): string =>
  typeof value === "string" ? value : "";
function decode(value: unknown): Record<string, unknown> {
  try {
    return object(typeof value === "string" ? JSON.parse(value) : value);
  } catch {
    return {};
  }
}
function successfulOutput(value: unknown): boolean {
  const decoded = decode(value);
  if (decoded.exit_code === 0) return true;
  // Codex exec wraps process results in MCP text blocks; their output is never stored.
  return array(value).some((item) => decode(object(item).text).exit_code === 0);
}

/** Structured invocation/read evidence only. Reading a skill does not prove its advice was followed. */
export async function scanSkillUsage(options: {
  env: NodeJS.ProcessEnv;
  cachePath: string;
  knownSkills: Array<{ name: string; paths?: string[] | undefined }>;
  signal?: AbortSignal | undefined;
}): Promise<SkillUsageScan> {
  const started = Date.now();
  const limits = new Set<string>();
  const coverage: SkillUsageScan["coverage"] = {
    status: "complete",
    filesDiscovered: 0,
    filesScanned: 0,
    bytesRead: 0,
    limitsHit: [],
    observedAt: new Date().toISOString(),
  };
  const stopped = () => {
    if (options.signal?.aborted) {
      limits.add("aborted");
      return true;
    }
    if (Date.now() - started >= LIMITS.milliseconds) {
      limits.add("time");
      return true;
    }
    return false;
  };
  const names = new Set(options.knownSkills.map((skill) => skill.name));
  const pathNames = new Map<string, string>();
  for (const skill of options.knownSkills)
    for (const path of skill.paths ?? [])
      pathNames.set(
        resolve(path.endsWith("SKILL.md") ? path : join(path, "SKILL.md")),
        skill.name,
      );
  const matchName = (name: string): string[] => (names.has(name) ? [name] : []);
  const matchPath = (value: unknown, cwd: string): string[] => {
    const path = text(value);
    if (!path || basename(path) !== "SKILL.md" || (!isAbsolute(path) && !cwd))
      return [];
    const normalized = resolve(cwd || "/", path);
    const known = pathNames.get(normalized);
    if (known) return [known];
    return matchName(basename(dirname(normalized)));
  };
  // Deliberately excludes shell expressions, pipelines, globs and command substitutions.
  const commandReads = (cmd: string, cwd: string): string[] => {
    if (!/^\s*cat\s+/.test(cmd) || /[\n\r;|&$`<>*?]/.test(cmd)) return [];
    const tokens =
      cmd.trim().match(/'(?:[^']*)'|"(?:[^"\\]*)"|[^\s'"]+/g) ?? [];
    if (tokens.shift() !== "cat" || !tokens.length) return [];
    if (tokens.some((token) => token.startsWith("-"))) return [];
    return [
      ...new Set(
        tokens.flatMap((token) =>
          matchPath(token.replace(/^['"]|['"]$/g, ""), cwd),
        ),
      ),
    ];
  };
  const knownFingerprint = digest(
    JSON.stringify(
      options.knownSkills
        .map((skill) => ({
          name: skill.name,
          paths: [...(skill.paths ?? [])].sort(),
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    ),
  );
  let cache: Cache = {
    version: 1,
    files: {},
    events: [],
    omittedEvents: false,
  };
  try {
    const handle = await open(
      options.cachePath,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );
    let stored: Record<string, unknown>;
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > 4 * 1024 * 1024)
        throw new Error("invalid cache file");
      const buffer = Buffer.alloc(4 * 1024 * 1024 + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 4 * 1024 * 1024) throw new Error("oversized cache");
      stored = decode(buffer.subarray(0, bytesRead).toString("utf8"));
    } finally {
      await handle.close();
    }
    if (stored.version !== 1) throw new Error("cache version");
    cache.omittedEvents = stored.omittedEvents === true;
    cache.knownFingerprint = text(stored.knownFingerprint);
    const previousCoverage = skillUsageScanSchema.shape.coverage.safeParse(
      stored.lastCoverage,
    );
    if (previousCoverage.success) cache.lastCoverage = previousCoverage.data;
    for (const [key, value] of Object.entries(object(stored.files)).slice(
      0,
      LIMITS.candidates,
    )) {
      const cursor = object(value);
      if (
        !/^[a-f0-9]{64}$/.test(key) ||
        typeof cursor.identity !== "string" ||
        !Number.isSafeInteger(cursor.offset) ||
        Number(cursor.offset) < 0
      )
        continue;
      cache.files[key] = {
        identity: cursor.identity,
        offset: Number(cursor.offset),
        mtimeMs: Number(cursor.mtimeMs) || 0,
        cwd: isAbsolute(text(cursor.cwd)) ? text(cursor.cwd) : "",
        omittedHistory: cursor.omittedHistory === true,
        pending: array(cursor.pending)
          .slice(-128)
          .flatMap((value) => {
            const pending = object(value);
            const skillNames = array(pending.names).flatMap((name) =>
              matchName(text(name)),
            );
            return text(pending.id).length <= 256 &&
              skillNames.length &&
              ["invoke", "read"].includes(text(pending.evidence)) &&
              Number.isFinite(Date.parse(text(pending.at)))
              ? [
                  {
                    id: text(pending.id),
                    names: skillNames,
                    evidence: pending.evidence as Pending["evidence"],
                    at: text(pending.at),
                  },
                ]
              : [];
          }),
      };
    }
    cache.events = array(stored.events)
      .slice(-LIMITS.events)
      .flatMap((value) => {
        const event = object(value);
        return /^[a-f0-9]{64}$/.test(text(event.id)) &&
          names.has(text(event.name)) &&
          ["codex", "claude", "pi"].includes(text(event.harness)) &&
          ["invoke", "read"].includes(text(event.evidence)) &&
          Number.isFinite(Date.parse(text(event.at)))
          ? [
              {
                id: text(event.id),
                name: text(event.name),
                harness: event.harness as SkillHarness,
                evidence: event.evidence as Event["evidence"],
                at: text(event.at),
              },
            ]
          : [];
      });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      limits.add("cache_unavailable");
  }
  if (cache.knownFingerprint !== knownFingerprint) cache.files = {};
  cache.knownFingerprint = knownFingerprint;
  const events = new Map(cache.events.map((event) => [event.id, event]));
  const home = options.env.HOME || options.env.USERPROFILE;
  const roots: Array<{ path: string; harness: SkillHarness }> = home
    ? [
        {
          path: join(
            options.env.CODEX_HOME || join(home, ".codex"),
            "sessions",
          ),
          harness: "codex",
        },
        {
          path: join(
            options.env.CLAUDE_CONFIG_DIR || join(home, ".claude"),
            "projects",
          ),
          harness: "claude",
        },
        {
          path: join(
            options.env.PI_CODING_AGENT_DIR || join(home, ".pi/agent"),
            "sessions",
          ),
          harness: "pi",
        },
      ]
    : [];
  if (!home) limits.add("home_unavailable");
  const candidates: Candidate[] = [];
  const budgets = {
    codex: { directories: 0, entries: 0, candidates: 0 },
    claude: { directories: 0, entries: 0, candidates: 0 },
    pi: { directories: 0, entries: 0, candidates: 0 },
  };
  const discover = async (
    path: string,
    harness: SkillHarness,
    depth: number,
  ): Promise<void> => {
    if (stopped()) return;
    const budget = budgets[harness];
    if (
      depth > 6 ||
      budget.directories++ >= Math.floor(LIMITS.directories / 3)
    ) {
      limits.add("directories");
      return;
    }
    const children: Array<{
      path: string;
      directory: boolean;
      modified: number;
      size: number;
      identity: string;
    }> = [];
    try {
      const dir = await opendir(path);
      for await (const entry of dir) {
        if (stopped()) break;
        if (++budget.entries > LIMITS.entries / 3) {
          limits.add("entries");
          break;
        }
        if (
          entry.isSymbolicLink() ||
          (!entry.isDirectory() &&
            (!entry.isFile() || !entry.name.endsWith(".jsonl")))
        )
          continue;
        const child = join(path, entry.name);
        try {
          const info = await stat(child);
          children.push({
            path: child,
            directory: entry.isDirectory(),
            modified: info.mtimeMs,
            size: info.size,
            identity: `${info.dev}:${info.ino}`,
          });
        } catch {
          limits.add("unreadable");
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        limits.add("unreadable");
      return;
    }
    for (const child of children.sort((a, b) => b.modified - a.modified)) {
      if (stopped()) break;
      if (child.directory) {
        if (budget.entries <= LIMITS.entries / 3)
          await discover(child.path, harness, depth + 1);
      } else if (budget.candidates < LIMITS.candidates / 3) {
        candidates.push({ ...child, harness });
        budget.candidates += 1;
      } else limits.add("files");
    }
  };
  await Promise.all(roots.map((root) => discover(root.path, root.harness, 0)));
  coverage.filesDiscovered = candidates.length;
  const complete = (
    cursor: Cursor,
    harness: SkillHarness,
    id: string,
    ok: boolean,
  ) => {
    const index = cursor.pending.findIndex((item) => item.id === id);
    if (index < 0) return;
    const pending = cursor.pending.splice(index, 1)[0]!;
    if (!ok) return;
    for (const name of pending.names) {
      const key = digest(`${harness}:${id}:${name}:${pending.evidence}`);
      events.set(key, {
        id: key,
        name,
        harness,
        evidence: pending.evidence,
        at: pending.at,
      });
    }
  };
  const processRecord = (
    record: Record<string, unknown>,
    cursor: Cursor,
    harness: SkillHarness,
  ) => {
    const payload = object(record.payload),
      message = object(record.message);
    const contextPath =
      text(record.cwd) ||
      (["session_meta", "turn_context"].includes(text(record.type))
        ? text(payload.cwd)
        : "");
    if (isAbsolute(contextPath)) cursor.cwd = contextPath;
    const at =
      text(record.timestamp) ||
      (typeof message.timestamp === "number"
        ? new Date(message.timestamp).toISOString()
        : text(message.timestamp));
    const add = (id: unknown, name: unknown, value: unknown) => {
      const args = object(value);
      let matched: string[] = [],
        evidence: Pending["evidence"] = "read";
      if (harness === "claude" && name === "Skill") {
        matched = matchName(text(args.skill));
        evidence = "invoke";
      } else if (["read", "Read", "read_file"].includes(text(name)))
        matched = matchPath(args.path ?? args.file_path, cursor.cwd);
      else if (["exec_command", "Bash", "bash"].includes(text(name)))
        matched = commandReads(text(args.cmd ?? args.command), cursor.cwd);
      else if (
        harness === "codex" &&
        name === "exec" &&
        typeof value === "string"
      ) {
        // Accept a single awaited call wrapper, never general JavaScript or quoted examples.
        const wrapper = value.match(
          /^\s*(?:text\()?\s*await tools\.exec_command\((\{[\s\S]*\})\)\)?;?\s*$/,
        );
        if (wrapper) {
          const literal = wrapper[1]!.replace(
            /([{,]\s*)([A-Za-z_][A-Za-z_0-9]*)\s*:/g,
            '$1"$2":',
          );
          const command = decode(literal);
          matched = commandReads(
            text(command.cmd),
            text(command.workdir) || cursor.cwd,
          );
        }
      }
      if (
        matched.length &&
        text(id) &&
        text(id).length <= 256 &&
        at.length <= 40 &&
        Number.isFinite(Date.parse(at))
      ) {
        cursor.pending = cursor.pending.filter((item) => item.id !== id);
        cursor.pending.push({ id: text(id), names: matched, evidence, at });
        if (cursor.pending.length > 128) {
          cursor.pending.shift();
          limits.add("pending_calls");
        }
      }
    };
    if (harness === "codex" && record.type === "response_item") {
      if (["function_call", "custom_tool_call"].includes(text(payload.type)))
        add(
          payload.call_id,
          payload.name,
          payload.type === "function_call"
            ? decode(payload.arguments)
            : payload.input,
        );
      if (
        ["function_call_output", "custom_tool_call_output"].includes(
          text(payload.type),
        )
      )
        complete(
          cursor,
          harness,
          text(payload.call_id),
          successfulOutput(payload.output),
        );
    } else {
      for (const value of array(message.content)) {
        const item = object(value);
        if (
          ["tool_use", "toolCall"].includes(text(item.type)) &&
          (message.role === "assistant" || record.type === "assistant")
        )
          add(item.id, item.name, item.input ?? item.arguments);
        if (item.type === "tool_result")
          complete(
            cursor,
            harness,
            text(item.tool_use_id),
            item.is_error !== true,
          );
      }
      if (message.role === "toolResult")
        complete(
          cursor,
          harness,
          text(message.toolCallId),
          message.isError === false,
        );
    }
  };
  const ordered = candidates.sort((a, b) => b.modified - a.modified);
  if (ordered.length > LIMITS.files) limits.add("files");
  const fairFiles: Candidate[] = [];
  const byHarness = roots.map((root) =>
    ordered.filter((file) => file.harness === root.harness),
  );
  for (
    let index = 0;
    index < LIMITS.files && fairFiles.length < LIMITS.files;
    index += 1
  )
    for (const files of byHarness) {
      if (files[index] && fairFiles.length < LIMITS.files)
        fairFiles.push(files[index]!);
    }
  for (const file of fairFiles) {
    if (stopped()) break;
    if (coverage.bytesRead >= LIMITS.bytes) {
      limits.add("bytes");
      break;
    }
    const key = digest(file.path);
    let cursor = cache.files[key];
    if (
      !cursor ||
      cursor.identity !== file.identity ||
      file.size < cursor.offset ||
      (file.size === cursor.offset && file.modified !== cursor.mtimeMs)
    )
      cursor = {
        identity: file.identity,
        offset: 0,
        mtimeMs: 0,
        cwd: "",
        pending: [],
        omittedHistory: false,
      };
    if (cursor.offset === file.size && cursor.mtimeMs === file.modified) {
      cache.files[key] = cursor;
      continue;
    }
    let offset = cursor.offset;
    let discard = false;
    if (file.size - offset > LIMITS.perFile) {
      offset = file.size - LIMITS.perFile;
      discard = true;
      cursor.omittedHistory = true;
      cursor.pending = [];
    }
    try {
      const handle = await open(
        file.path,
        constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
      );
      try {
        if (!(await handle.stat()).isFile()) {
          limits.add("non_regular_file");
          continue;
        }
        const buffer = Buffer.alloc(
          Math.min(
            file.size - offset,
            LIMITS.perFile,
            LIMITS.bytes - coverage.bytesRead,
          ),
        );
        const { bytesRead } = await handle.read(
          buffer,
          0,
          buffer.length,
          offset,
        );
        coverage.bytesRead += bytesRead;
        coverage.filesScanned += 1;
        let start = 0;
        while (start < bytesRead && !stopped()) {
          const end = buffer.indexOf(10, start);
          if (end < 0 || end >= bytesRead) break;
          if (discard) discard = false;
          else {
            try {
              processRecord(
                object(
                  JSON.parse(buffer.subarray(start, end).toString("utf8")),
                ),
                cursor,
                file.harness,
              );
            } catch {
              limits.add("malformed_records");
            }
          }
          start = end + 1;
        }
        cursor.offset = offset + start;
        if (!start && bytesRead === LIMITS.perFile) {
          cursor.offset = offset + bytesRead;
          cursor.omittedHistory = true;
          limits.add("oversized_record");
        }
        cursor.mtimeMs = file.modified;
        cache.files[key] = cursor;
      } finally {
        await handle.close();
      }
    } catch {
      limits.add("unreadable");
    }
  }
  const retained = [...events.values()].sort((a, b) =>
    a.at.localeCompare(b.at),
  );
  if (retained.length > LIMITS.events) cache.omittedEvents = true;
  cache.events = retained.slice(-LIMITS.events);
  const currentKeys = new Set(ordered.map((file) => digest(file.path)));
  cache.files = Object.fromEntries(
    Object.entries(cache.files)
      .filter(([key]) => currentKeys.has(key))
      .slice(-LIMITS.candidates),
  );
  if (
    cache.omittedEvents ||
    Object.values(cache.files).some((cursor) => cursor.omittedHistory)
  )
    limits.add("history_window");
  const usage = new Map<string, SkillUsage>();
  for (const event of cache.events) {
    const key = `${event.name}:${event.harness}:${event.evidence}`;
    const current = usage.get(key);
    if (current) {
      current.count += 1;
      if (Date.parse(event.at) > Date.parse(current.lastUsedAt))
        current.lastUsedAt = event.at;
    } else
      usage.set(key, {
        name: event.name,
        harness: event.harness,
        evidence: event.evidence,
        count: 1,
        lastUsedAt: event.at,
      });
  }
  coverage.limitsHit = [...limits].sort();
  coverage.status = limits.size ? "incomplete" : "complete";
  if (
    !coverage.bytesRead &&
    cache.lastCoverage?.filesDiscovered === coverage.filesDiscovered &&
    JSON.stringify(cache.lastCoverage.limitsHit) ===
      JSON.stringify(coverage.limitsHit)
  )
    Object.assign(coverage, cache.lastCoverage);
  cache.lastCoverage = coverage;
  if (!options.signal?.aborted) {
    try {
      await mkdir(dirname(options.cachePath), { recursive: true });
      const pending = `${options.cachePath}.${randomUUID()}.tmp`;
      await writeFile(pending, JSON.stringify(cache), { mode: 0o600 });
      await rename(pending, options.cachePath);
    } catch {
      limits.add("cache_write_failed");
    }
  }
  coverage.limitsHit = [...limits].sort();
  coverage.status = limits.size ? "incomplete" : "complete";
  return {
    usage: [...usage.values()].sort(
      (a, b) =>
        a.name.localeCompare(b.name) ||
        a.harness.localeCompare(b.harness) ||
        a.evidence.localeCompare(b.evidence),
    ),
    coverage,
  };
}
