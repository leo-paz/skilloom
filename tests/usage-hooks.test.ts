import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectUsageHook,
  configureUsageHooks,
  type UsageHookEvent,
} from "../src/core/usage-hooks.js";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(
    homes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
  );
});
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "skilloom-hook-"));
  homes.push(home);
  const env = {
    HOME: home,
    CLAUDE_CONFIG_DIR: join(home, "custom claude"),
    PI_CODING_AGENT_DIR: join(home, "custom pi"),
    XDG_CONFIG_HOME: join(home, "config"),
  };
  const command = [process.execPath, join(home, "collector 'test'.mjs")];
  return {
    home,
    env,
    command,
    claude: join(env.CLAUDE_CONFIG_DIR, "settings.json"),
    pi: join(env.PI_CODING_AGENT_DIR, "extensions", "skilloom-usage.js"),
  };
}
describe("usage lifecycle collectors", () => {
  it("records only successful structured skill reads and distinct name-only invocations without bodies", async () => {
    const f = await fixture();
    const events: UsageHookEvent[] = [];
    const record = async (event: UsageHookEvent) => {
      events.push(event);
    };
    const now = () => new Date("2026-09-09T12:00:00Z");
    const base = { env: f.env, record, now };
    const claude = {
      hook_event_name: "PostToolUse",
      session_id: "session",
      tool_use_id: "call",
      tool_name: "Read",
      cwd: f.home,
      tool_input: { file_path: "skills/review/SKILL.md" },
      tool_response: { content: "PRIVATE BODY" },
      transcript_path: "/private/transcript",
    };
    expect(
      await collectUsageHook({ ...base, harness: "claude", payload: claude }),
    ).toBe(true);
    expect(events[0]).toEqual({
      harness: "claude",
      sessionId: "session",
      callId: "call",
      at: now().toISOString(),
      timestampSource: "observed",
      evidence: "read",
      path: join(f.home, "skills/review/SKILL.md"),
    });
    expect(
      await collectUsageHook({
        ...base,
        harness: "claude",
        payload: {
          ...claude,
          tool_name: "Skill",
          tool_input: { skill: "plugin:review" },
        },
      }),
    ).toBe(true);
    expect(events[1]).toMatchObject({
      evidence: "invoke",
      name: "plugin:review",
    });
    expect(events[1]).not.toHaveProperty("path");
    expect(
      await collectUsageHook({
        ...base,
        harness: "pi",
        payload: {
          type: "tool_result",
          isError: false,
          toolName: "read",
          toolCallId: "pi-call",
          sessionId: "pi-session",
          cwd: f.home,
          input: { path: "~/skills/review/SKILL.md" },
          content: "PRIVATE",
        },
      }),
    ).toBe(true);
    expect(JSON.stringify(events)).not.toContain("PRIVATE");
    expect(JSON.stringify(events)).not.toContain("transcript");
    for (const payload of [
      { ...claude, hook_event_name: "PostToolUseFailure" },
      {
        ...claude,
        tool_name: "Bash",
        tool_input: { command: "cat skills/review/SKILL.md" },
      },
      { ...claude, session_id: "" },
      { ...claude, cwd: "relative" },
      { ...claude, tool_input: { file_path: "README.md" } },
    ]) {
      expect(
        await collectUsageHook({ ...base, harness: "claude", payload }),
      ).toBe(false);
    }
    for (const isError of [true, undefined])
      expect(
        await collectUsageHook({
          ...base,
          harness: "pi",
          payload: {
            type: "tool_result",
            toolName: "read",
            sessionId: "session",
            toolCallId: "call",
            input: { path: "/skills/SKILL.md" },
            isError,
          },
        }),
      ).toBe(false);
    expect(
      await collectUsageHook({
        ...base,
        harness: "claude",
        payload: claude,
        record: async () => {
          throw new Error("disk unavailable");
        },
      }),
    ).toBe(false);
    expect(events).toHaveLength(3);
  });
});
describe("opt-in usage hook configuration", () => {
  it("preserves existing hooks/settings, backs up bytes, installs idempotently and removes only its hooks", async () => {
    const f = await fixture();
    const original = JSON.stringify(
      {
        permissions: { allow: ["Read"] },
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [{ type: "command", command: "existing-pre" }],
            },
          ],
          PostToolUse: [
            {
              matcher: "Read",
              hooks: [{ type: "command", command: "existing-post" }],
            },
          ],
        },
      },
      null,
      4,
    );
    await mkdir(dirname(f.claude), { recursive: true });
    await writeFile(f.claude, original);
    const options = { env: f.env, command: f.command };
    expect(
      (await configureUsageHooks({ ...options, action: "status" })).every(
        (item) => !item.installed,
      ),
    ).toBe(true);
    const installed = await configureUsageHooks({
      ...options,
      action: "install",
    });
    expect(installed.every((item) => item.changed && item.installed)).toBe(
      true,
    );
    expect(await readFile(installed[0]!.backup!, "utf8")).toBe(original);
    const config = JSON.parse(await readFile(f.claude, "utf8"));
    expect(config.permissions).toEqual({ allow: ["Read"] });
    expect(config.hooks.PostToolUse[0].hooks[0].command).toBe("existing-post");
    expect(config.hooks.PostToolUse[1].hooks[0]).toMatchObject({
      type: "command",
      async: true,
      timeout: 3,
    });
    expect(config.hooks.PostToolUse[1].hooks[0].command).toContain(
      "usage' 'hook' 'claude",
    );
    expect(config.hooks.PostToolUse[1].hooks[0].command).toContain(
      "XDG_CONFIG_HOME=",
    );
    expect(
      (await configureUsageHooks({ ...options, action: "install" })).every(
        (item) => item.installed && !item.changed,
      ),
    ).toBe(true);
    expect(
      (await configureUsageHooks({ ...options, action: "uninstall" })).every(
        (item) => !item.installed && item.changed,
      ),
    ).toBe(true);
    expect(JSON.parse(await readFile(f.claude, "utf8"))).toEqual(
      JSON.parse(original),
    );
    expect(
      (await configureUsageHooks({ ...options, action: "uninstall" })).every(
        (item) => !item.changed,
      ),
    ).toBe(true);
  });
  it("status creates no directories and refuses malformed settings, symlinks, collisions and locks", async () => {
    const f = await fixture();
    const options = { env: f.env, command: f.command };
    await configureUsageHooks({ ...options, action: "status" });
    expect(await readdir(f.home)).toEqual([]);
    await mkdir(dirname(f.claude), { recursive: true });
    await writeFile(f.claude, "{broken");
    await expect(
      configureUsageHooks({
        ...options,
        action: "install",
        harnesses: ["claude"],
      }),
    ).rejects.toThrow();
    expect(await readFile(f.claude, "utf8")).toBe("{broken");
    await rm(f.claude);
    const target = join(f.home, "original.json");
    await writeFile(target, "{}");
    await symlink(target, f.claude);
    await expect(
      configureUsageHooks({
        ...options,
        action: "install",
        harnesses: ["claude"],
      }),
    ).rejects.toThrow();
    await mkdir(dirname(f.pi), { recursive: true });
    await writeFile(f.pi, "// Unrelated user extension");
    await expect(
      configureUsageHooks({ ...options, action: "install", harnesses: ["pi"] }),
    ).rejects.toThrow("unrelated");
    await writeFile(`${f.pi}.skilloom-lock`, "busy");
    await expect(
      configureUsageHooks({
        ...options,
        action: "uninstall",
        harnesses: ["pi"],
      }),
    ).rejects.toThrow();
    expect(await readFile(f.pi, "utf8")).toContain("Unrelated");
  });
  it("runs the Claude hook with literal paths and environment bindings and fails open if the collector disappears", async () => {
    const f = await fixture();
    const output = join(f.home, "claude-received.json");
    await writeFile(
      f.command[1]!,
      `import {writeFileSync} from 'node:fs'; let s=''; for await (const chunk of process.stdin) s+=chunk; writeFileSync(${JSON.stringify(output)},JSON.stringify({args:process.argv.slice(2),payload:JSON.parse(s),config:process.env.XDG_CONFIG_HOME}));`,
    );
    await configureUsageHooks({
      env: f.env,
      command: f.command,
      action: "install",
      harnesses: ["claude"],
    });
    const config = JSON.parse(await readFile(f.claude, "utf8"));
    const command = config.hooks.PostToolUse[0].hooks[0].command;
    const run = () =>
      new Promise<void>((resolve, reject) => {
        const child = execFile("/bin/sh", ["-c", command], (error) =>
          error ? reject(error) : resolve(),
        );
        child.stdin!.end(
          JSON.stringify({
            hook_event_name: "PostToolUse",
            tool_name: "Skill",
            tool_input: { skill: "review" },
          }),
        );
      });
    await run();
    const received = JSON.parse(await readFile(output, "utf8"));
    expect(received.args).toEqual(["usage", "hook", "claude"]);
    expect(received.config).toBe(f.env.XDG_CONFIG_HOME);
    expect(received.payload.tool_input.skill).toBe("review");
    await rm(f.command[1]!);
    await expect(run()).resolves.toBeUndefined();
  });
  it("loads the generated Pi extension without Skilloom dependencies and sends only derived input through argv", async () => {
    const f = await fixture();
    const output = join(f.home, "received.json");
    await writeFile(
      f.command[1]!,
      `import {writeFileSync} from 'node:fs'; let s=''; for await (const chunk of process.stdin) s+=chunk; writeFileSync(${JSON.stringify(output)},JSON.stringify({args:process.argv.slice(2),payload:JSON.parse(s),config:process.env.XDG_CONFIG_HOME}));`,
    );
    await configureUsageHooks({
      env: f.env,
      command: f.command,
      action: "install",
      harnesses: ["pi"],
    });
    const runner = join(f.home, "run.mjs");
    await writeFile(
      runner,
      `import extension from ${JSON.stringify(f.pi)}; import {existsSync} from 'node:fs'; let handler; extension({on(type,fn){if(type!=='tool_result')throw new Error(type); handler=fn;}}); const ctx={cwd:${JSON.stringify(f.home)}, sessionManager:{getSessionId:()=>"real-session"}}; handler({toolName:'read',isError:false,toolCallId:'read-1',input:{path:'skill/SKILL.md',secret:'private'},content:'PRIVATE BODY'},ctx); for(let i=0;i<100 && !existsSync(${JSON.stringify(output)});i++) await new Promise(r=>setTimeout(r,20));`,
    );
    await promisify(execFile)(process.execPath, [runner]);
    const received = JSON.parse(await readFile(output, "utf8"));
    expect(received.args).toEqual(["usage", "hook", "pi"]);
    expect(received.config).toBe(f.env.XDG_CONFIG_HOME);
    expect(received.payload).toEqual({
      type: "tool_result",
      toolName: "read",
      toolCallId: "read-1",
      input: { path: "skill/SKILL.md" },
      isError: false,
      sessionId: "real-session",
      cwd: f.home,
    });
  });
});
