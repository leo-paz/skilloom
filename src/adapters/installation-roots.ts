import { posix, win32 } from "node:path";

export interface InstallationDiagnosticRoot {
  path: string;
  scope: "global" | "project";
}

// Directory metadata copied from the pinned skills@1.5.25 adapter. These are
// candidates, not proof that an agent is installed or that its loader uses a root.
// Keep this list tied to the dependency version when updating upstream skills.
const globalHomeDirectories = [
  ".aider-desk/skills",
  ".gemini/antigravity/skills",
  ".gemini/antigravity-cli/skills",
  ".astrbot/data/skills",
  ".augment/skills",
  ".bob/skills",
  ".agents/skills",
  ".codeartsdoer/skills",
  ".codebuddy/skills",
  ".codemaker/skills",
  ".codestudio/skills",
  ".commandcode/skills",
  ".continue/skills",
  ".snowflake/cortex/skills",
  ".config/crush/skills",
  ".cursor/skills",
  ".deepagents/agent/skills",
  ".factory/skills",
  ".firebender/skills",
  ".forge/skills",
  ".fx/skills",
  ".gemini/skills",
  ".copilot/skills",
  ".inferencesh/skills",
  ".jazz/skills",
  ".junie/skills",
  ".iflow/skills",
  ".kilo/skills",
  ".config/kimchi/harness/skills",
  ".kiro/skills",
  ".kode/skills",
  ".lingma/skills",
  ".mcpjam/skills",
  ".minimax/skills",
  ".moxby/skills",
  ".mux/skills",
  ".openhands/skills",
  ".ona/skills",
  ".pi/agent/skills",
  ".posit/assistant/skills",
  ".qoder/skills",
  ".qoder-cn/skills",
  ".qwen/skills",
  ".reasonix/skills",
  ".rovodev/skills",
  ".roo/skills",
  ".tabnine/agent/skills",
  ".terramind/skills",
  ".tinycloud/skills",
  ".trae/skills",
  ".trae-cn/skills",
  ".codeium/windsurf/skills",
  ".zcode/skills",
  ".zencoder/skills",
  ".neovate/skills",
  ".pochi/skills",
  ".adal/skills",
];
const projectDirectories = [
  ".agents/skills",
  ".codex/skills",
  ".aider-desk/skills",
  "data/skills",
  ".autohand/skills",
  ".augment/skills",
  ".bob/skills",
  ".claude/skills",
  "skills",
  ".codeartsdoer/skills",
  ".codebuddy/skills",
  ".codemaker/skills",
  ".codestudio/skills",
  ".commandcode/skills",
  ".continue/skills",
  ".cortex/skills",
  ".crush/skills",
  ".devin/skills",
  "agent/skills",
  ".forge/skills",
  ".fx/skills",
  ".goose/skills",
  ".grok/skills",
  ".hermes/skills",
  ".inferencesh/skills",
  ".jazz/skills",
  ".junie/skills",
  ".iflow/skills",
  ".kimchi/skills",
  ".kiro/skills",
  ".kode/skills",
  ".lingma/skills",
  ".mcpjam/skills",
  ".minimax/skills",
  ".vibe/skills",
  ".moxby/skills",
  ".mux/skills",
  ".openhands/skills",
  ".ona/skills",
  ".pi/skills",
  ".posit/assistant/skills",
  ".qoder/skills",
  ".qwen/skills",
  ".reasonix/skills",
  ".rovodev/skills",
  ".roo/skills",
  ".tabnine/agent/skills",
  ".terramind/skills",
  ".tinycloud/skills",
  ".trae/skills",
  ".windsurf/skills",
  ".zcode/skills",
  ".zencoder/skills",
  ".neovate/skills",
  ".pochi/skills",
  ".adal/skills",
];

export function* installationDiagnosticRoots(
  env: NodeJS.ProcessEnv,
  projectRoots: readonly string[] = [],
  platform: NodeJS.Platform = process.platform,
  checkBudget?: () => void,
): Generator<InstallationDiagnosticRoot> {
  const paths = platform === "win32" ? win32 : posix;
  const home = (
    platform === "win32"
      ? env.USERPROFILE || env.HOME
      : env.HOME || env.USERPROFILE
  )?.trim();
  if (!home || !paths.isAbsolute(home))
    throw new Error(
      "Installation diagnostics require an absolute home directory in HOME or USERPROFILE.",
    );
  const seen = new Set<string>();
  function* add(
    path: string,
    scope: "global" | "project",
  ): Generator<InstallationDiagnosticRoot> {
    checkBudget?.();
    // Relative overrides are returned for explicit invalid-root coverage, never
    // resolved against this process cwd or silently inspected.
    const normalized = paths.normalize(path);
    // Do not lowercase Windows paths: case-sensitive directories can be enabled.
    if (!seen.has(normalized)) {
      seen.add(normalized);
      yield { path: normalized, scope };
    }
  }
  // Check shared and legacy roots even if an override points elsewhere. Stale
  // installations there remain observable, without assuming they are active.
  for (const relative of [
    ".agents/skills",
    ".codex/skills",
    ".claude/skills",
    ".pi/agent/skills",
    ".openclaw/skills",
    ".openclaw/workspace/skills",
    ".clawdbot/skills",
    ".moltbot/skills",
    ...globalHomeDirectories,
  ]) {
    yield* add(paths.join(home, relative), "global");
  }
  const config = env.XDG_CONFIG_HOME?.trim() || paths.join(home, ".config");
  for (const relative of [
    "agents/skills",
    "devin/skills",
    "goose/skills",
    "opencode/skills",
  ]) {
    yield* add(paths.join(config, relative), "global");
  }
  for (const [key, fallback] of [
    ["CODEX_HOME", ".codex"],
    ["CLAUDE_CONFIG_DIR", ".claude"],
    ["HERMES_HOME", ".hermes"],
    ["AUTOHAND_HOME", ".autohand"],
    ["GROK_HOME", ".grok"],
    ["VIBE_HOME", ".vibe"],
    ["PI_CODING_AGENT_DIR", ".pi/agent"],
  ] as const) {
    yield* add(
      paths.join(env[key]?.trim() || paths.join(home, fallback), "skills"),
      "global",
    );
  }
  for (const root of projectRoots) {
    for (const relative of projectDirectories)
      yield* add(paths.join(root, relative), "project");
  }
}
