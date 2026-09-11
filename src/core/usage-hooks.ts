import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

export interface UsageHookEvent {
  harness: "claude" | "pi";
  sessionId: string;
  callId: string;
  at: string;
  timestampSource: "observed";
  evidence: "read" | "invoke";
  path?: string;
  name?: string;
}
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown) => (typeof value === "string" ? value : "");
const identifier = (value: unknown) => {
  const string = text(value);
  return string.length > 0 &&
    string.length <= 256 &&
    !/[\x00-\x1f]/.test(string)
    ? string
    : "";
};

/** Accept successful lifecycle events only; the journal must validate installation identity. */
export async function collectUsageHook(options: {
  harness: "claude" | "pi";
  payload: unknown;
  env: NodeJS.ProcessEnv;
  record: (event: UsageHookEvent) => Promise<void>;
  now?: () => Date;
}): Promise<boolean> {
  try {
    const payload = object(options.payload);
    const claude = options.harness === "claude";
    if (
      claude
        ? payload.hook_event_name !== "PostToolUse"
        : payload.type !== "tool_result" || payload.isError !== false
    )
      return false;
    const input = object(claude ? payload.tool_input : payload.input);
    const sessionId = identifier(
      claude ? payload.session_id : payload.sessionId,
    );
    const callId = identifier(
      claude ? payload.tool_use_id : payload.toolCallId,
    );
    if (!sessionId || !callId) return false;
    const tool = claude ? payload.tool_name : payload.toolName;
    const event: UsageHookEvent = {
      harness: options.harness,
      sessionId,
      callId,
      at: (options.now?.() ?? new Date()).toISOString(),
      timestampSource: "observed",
      evidence: "read",
    };
    if (claude && tool === "Skill") {
      const name = identifier(input.skill);
      if (!name || !/^[\p{L}\p{N}_:.\-/]+$/u.test(name)) return false;
      event.name = name;
      event.evidence = "invoke";
    } else if (tool === (claude ? "Read" : "read")) {
      let path = text(claude ? input.file_path : input.path);
      if (!path || path.length > 4096 || /[\x00-\x1f]/.test(path)) return false;
      if (path.startsWith("~/")) {
        const home = options.env.HOME || options.env.USERPROFILE;
        if (!home || !isAbsolute(home)) return false;
        path = join(home, path.slice(2));
      }
      if (!isAbsolute(path)) {
        const cwd = text(payload.cwd);
        if (!isAbsolute(cwd)) return false;
        path = resolve(cwd, path);
      }
      if (basename(path) !== "SKILL.md") return false;
      event.path = path;
    } else return false;
    await options.record(event);
    return true;
  } catch {
    // Observability must never fail an agent tool call.
    return false;
  }
}

const marker = "skilloom-usage-collector-v1";
const extensionHeader = `// ${marker}\n`;
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const environmentKeys = [
  "HOME",
  "USERPROFILE",
  "XDG_CONFIG_HOME",
  "SKILLOOM_CONFIG",
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
  "PI_CODING_AGENT_DIR",
];
function binding(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    environmentKeys.flatMap((key) => (env[key] ? [[key, env[key]!]] : [])),
  );
}
function claudeCommand(command: string[], env: NodeJS.ProcessEnv): string {
  return `${["env", ...Object.entries(binding(env)).map(([key, value]) => `${key}=${value}`), ...command, "usage", "hook", "claude"].map(shellQuote).join(" ")} >/dev/null 2>&1 || true # ${marker}`;
}
function piExtension(command: string[], env: NodeJS.ProcessEnv): string {
  return `${extensionHeader}import { spawn } from "node:child_process";
// Only successful read lifecycle events are recorded. Manual expansion has no reliable event yet.
export default function skilloomUsage(pi) {
  pi.on("tool_result", (event, ctx) => {
    try {
      if (event.toolName !== "read" || event.isError !== false || typeof event.input?.path !== "string" || !event.input.path.endsWith("SKILL.md")) return;
      const payload = JSON.stringify({type: "tool_result", toolName: "read", toolCallId: event.toolCallId, input: {path: event.input.path}, isError: false, sessionId: ctx.sessionManager.getSessionId(), cwd: ctx.cwd});
      if (Buffer.byteLength(payload) > 16384) return;
      const argv = ${JSON.stringify([...command, "usage", "hook", "pi"])};
      const child = spawn(argv[0], argv.slice(1), {env: {...process.env, ...${JSON.stringify(binding(env))}}, stdio: ["pipe", "ignore", "ignore"], windowsHide: true});
      const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
      timer.unref();
      child.on("error", () => clearTimeout(timer));
      child.on("exit", () => clearTimeout(timer));
      child.stdin.on("error", () => {});
      child.stdin.end(payload);
      child.unref();
    } catch { /* Collection never blocks or changes tool results. */ }
  });
}
`;
}

async function readRegular(path: string): Promise<string | undefined> {
  try {
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > 1024 * 1024)
        throw new Error(
          `Refusing non-regular or oversized configuration: ${path}`,
        );
      const buffer = Buffer.alloc(1024 * 1024 + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 1024 * 1024)
        throw new Error(`Configuration exceeds limit: ${path}`);
      return buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export interface UsageHookConfiguration {
  harness: "claude" | "pi";
  path: string;
  installed: boolean;
  changed: boolean;
  backup?: string;
}

/** Explicit opt-in. Status is read-only; changes back up original files and preserve unrelated hooks. */
export async function configureUsageHooks(options: {
  env: NodeJS.ProcessEnv;
  command: string[];
  action: "install" | "uninstall" | "status";
  harnesses?: Array<"claude" | "pi">;
}): Promise<UsageHookConfiguration[]> {
  const home = options.env.HOME || options.env.USERPROFILE;
  if (!home || !isAbsolute(home))
    throw new Error("Usage hooks require an absolute home directory");
  if (
    options.action === "install" &&
    (!options.command.length ||
      options.command.some((part) => !part || /[\x00\r\n]/.test(part)))
  )
    throw new Error("A valid collector command is required");
  const results: UsageHookConfiguration[] = [];
  for (const harness of [
    ...new Set<"claude" | "pi">(options.harnesses ?? ["claude", "pi"]),
  ]) {
    const path =
      harness === "claude"
        ? join(
            options.env.CLAUDE_CONFIG_DIR || join(home, ".claude"),
            "settings.json",
          )
        : join(
            options.env.PI_CODING_AGENT_DIR || join(home, ".pi/agent"),
            "extensions",
            "skilloom-usage.js",
          );
    if (!isAbsolute(path))
      throw new Error(
        `Usage hook configuration path must be absolute: ${path}`,
      );
    const mutate = async () => {
      const before = await readRegular(path);
      let after = before;
      let installed = false;
      if (harness === "claude") {
        const parsed: unknown = before === undefined ? {} : JSON.parse(before);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
          throw new Error(`Invalid Claude settings object: ${path}`);
        const original = JSON.stringify(parsed);
        const config = parsed as Record<string, unknown>;
        if (
          config.hooks !== undefined &&
          (!config.hooks ||
            typeof config.hooks !== "object" ||
            Array.isArray(config.hooks))
        )
          throw new Error(`Invalid Claude hooks object: ${path}`);
        const hooks = object(config.hooks);
        if (
          hooks.PostToolUse !== undefined &&
          !Array.isArray(hooks.PostToolUse)
        )
          throw new Error(`Invalid Claude PostToolUse hooks: ${path}`);
        const post = (hooks.PostToolUse ?? []) as unknown[];
        const owned = (value: unknown) =>
          object(value).type === "command" &&
          text(object(value).command).endsWith(`# ${marker}`);
        installed = post.some(
          (group) =>
            Array.isArray(object(group).hooks) &&
            (object(group).hooks as unknown[]).some(owned),
        );
        if (options.action !== "status") {
          const filtered = post.flatMap((group) => {
            const value = object(group);
            if (!Array.isArray(value.hooks) || !value.hooks.some(owned))
              return [group];
            const remaining = value.hooks.filter((item) => !owned(item));
            return remaining.length ? [{ ...value, hooks: remaining }] : [];
          });
          if (options.action === "install")
            filtered.push({
              matcher: "Read|Skill",
              hooks: [
                {
                  type: "command",
                  command: claudeCommand(options.command, options.env),
                  timeout: 3,
                  async: true,
                },
              ],
            });
          if (options.action === "install" || installed) {
            if (filtered.length) hooks.PostToolUse = filtered;
            else delete hooks.PostToolUse;
            if (Object.keys(hooks).length) config.hooks = hooks;
            else delete config.hooks;
            // Preserve original bytes when already configured, including formatting.
            if (JSON.stringify(config) !== original)
              after = `${JSON.stringify(config, null, 2)}\n`;
          }
        }
      } else {
        installed = before?.startsWith(extensionHeader) ?? false;
        if (options.action === "install") {
          if (before !== undefined && !installed)
            throw new Error(
              `Refusing to replace an unrelated Pi extension: ${path}`,
            );
          after = piExtension(options.command, options.env);
        } else if (options.action === "uninstall" && installed)
          after = undefined;
      }
      const result: UsageHookConfiguration = {
        harness,
        path,
        installed,
        changed: false,
      };
      if (options.action !== "status" && before !== after) {
        if ((await readRegular(path)) !== before)
          throw new Error(`Configuration changed during installation: ${path}`);
        if (before !== undefined) {
          result.backup = `${path}.skilloom-backup-${randomUUID()}`;
          await writeFile(result.backup, before, { flag: "wx", mode: 0o600 });
        }
        if (after === undefined) await unlink(path);
        else {
          const temp = `${path}.${randomUUID()}.tmp`;
          try {
            await writeFile(temp, after, { flag: "wx", mode: 0o600 });
            await rename(temp, path);
          } finally {
            await unlink(temp).catch(() => {});
          }
        }
        result.changed = true;
        result.installed = options.action === "install";
      }
      return result;
    };
    if (options.action === "status") results.push(await mutate());
    else {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const lock = `${path}.skilloom-lock`;
      const handle = await open(lock, "wx", 0o600);
      try {
        results.push(await mutate());
      } finally {
        await handle.close();
        await unlink(lock);
      }
    }
  }
  return results;
}
