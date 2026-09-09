import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

// Real installed Pi lifecycle, deterministic local model responses. No model API
// calls, credentials, user configuration, or user sessions are used by this test.
// Requires `npm run build` and Pi on PATH (or PI_ACCEPTANCE_BIN).
const root = await realpath(
  await mkdtemp(join(tmpdir(), "skilloom-pi-acceptance-")),
);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const worker = join(repo, "dist/usage-worker.mjs");
const agentDir = join(root, ".pi/agent");
const config = join(root, ".config/skilloom");
const skill = join(root, ".agents/skills/accepted/SKILL.md");
const missing = join(root, ".agents/skills/missing/SKILL.md");
const ordinary = join(root, "ordinary.txt");
const env = {
  HOME: root,
  PATH: process.env.PATH,
  PI_CODING_AGENT_DIR: agentDir,
  CODEX_HOME: join(root, ".codex"),
  CLAUDE_CONFIG_DIR: join(root, ".claude"),
  XDG_CONFIG_HOME: join(root, ".config"),
  PI_OFFLINE: "1",
  NO_COLOR: "1",
};
const execute = (command, args) =>
  new Promise((done, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 30000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) done(stdout);
      else
        reject(
          new Error(`Fixture command failed (${code}): ${stderr}\n${stdout}`),
        );
    });
  });
let requests = 0;
let successfulToolResults = 0;
const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const input = JSON.parse(Buffer.concat(chunks).toString());
  requests++;
  const results = input.messages.filter((message) => message.role === "tool");
  successfulToolResults = results.length;
  const first = results.length === 0;
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const chunk = (delta, finish_reason = null) =>
    res.write(
      `data: ${JSON.stringify({
        id: `fixture-${requests}`,
        object: "chat.completion.chunk",
        created: 0,
        model: "fixture",
        choices: [{ index: 0, delta, finish_reason }],
      })}\n\n`,
    );
  if (first) {
    chunk({
      role: "assistant",
      tool_calls: [skill, missing, ordinary].map((path, index) => ({
        index,
        id: `fixture-read-${index}`,
        type: "function",
        function: { name: "read", arguments: JSON.stringify({ path }) },
      })),
    });
    chunk({}, "tool_calls");
  } else {
    chunk({ role: "assistant", content: "Fixture complete." });
    chunk({}, "stop");
  }
  res.end("data: [DONE]\n\n");
});

try {
  for (const directory of [agentDir, config, dirname(skill)])
    await mkdir(directory, { recursive: true });
  await writeFile(
    skill,
    "---\nname: accepted\ndescription: Acceptance fixture\n---\nprivate-skill-marker\n",
  );
  await writeFile(ordinary, "ordinary-file-marker");
  await writeFile(
    join(config, "inventory.json"),
    JSON.stringify({
      version: 1,
      observedAt: new Date().toISOString(),
      machine: { id: "fixture", name: "Fixture", profile: "fixture" },
      discovery: {
        status: "found",
        roots: [],
        projectsFound: 0,
        checkoutsFound: 0,
      },
      profiles: ["fixture"],
      machines: [
        { id: "fixture", name: "Fixture", profile: "fixture", local: true },
      ],
      globalSkills: [
        {
          name: "accepted",
          path: skill,
          agents: ["pi"],
          scope: "global",
          installed: true,
          desired: false,
          managed: false,
          ownership: "personal",
          reasons: [],
          source: null,
        },
      ],
      projects: [],
      operations: [],
    }),
  );
  await execute(process.execPath, [worker, "usage", "install"]);
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        fixture: {
          baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
          api: "openai-completions",
          apiKey: "fixture-only",
          models: [
            {
              id: "fixture",
              reasoning: false,
              input: ["text"],
              contextWindow: 32000,
              maxTokens: 1000,
            },
          ],
        },
      },
    }),
  );
  const pi = process.env.PI_ACCEPTANCE_BIN || "pi";
  const version = (await execute(pi, ["--version"])).trim();
  const output = await execute(pi, [
    "--offline",
    "--provider",
    "fixture",
    "--model",
    "fixture",
    "--thinking",
    "off",
    "--no-extensions",
    "-e",
    join(agentDir, "extensions/skilloom-usage.js"),
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--tools",
    "read",
    "--mode",
    "json",
    "--print",
    "Run the deterministic fixture.",
  ]);
  const lifecycle = output
    .split("\n")
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    })
    .filter((event) => event.type === "tool_execution_end");
  assert.equal(requests, 2, "Pi must complete a tool turn and a final turn");
  assert.equal(
    successfulToolResults,
    3,
    "Pi must submit all three actual tool results",
  );
  assert.equal(lifecycle.length, 3);
  assert.equal(lifecycle.filter((event) => event.isError === true).length, 1);
  const journalDir = join(config, "usage");
  let journal = "";
  for (let attempts = 0; attempts < 40; attempts++) {
    const files = (await readdir(journalDir)).filter(
      (name) => name.startsWith("events-") && name.endsWith(".jsonl"),
    );
    journal = (
      await Promise.all(
        files.map((name) => readFile(join(journalDir, name), "utf8")),
      )
    ).join("");
    if (journal.trim()) break;
    await delay(100);
  }
  const events = journal
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.equal(
    events.length,
    1,
    "Only the successful installed skill read enters the journal",
  );
  assert.equal(events[0].name, "accepted");
  assert.equal(events[0].harness, "pi");
  assert.equal(events[0].evidence, "read");
  assert.match(events[0].pathId, /^[a-f0-9]{64}$/);
  assert(
    !journal.includes(root) &&
      !journal.includes("private-skill-marker") &&
      !journal.includes("ordinary-file-marker"),
  );
  console.log(
    JSON.stringify({
      ok: true,
      piVersion: version,
      model: "local deterministic SSE fixture",
      toolExecutions: lifecycle.length,
      failedReads: 1,
      journalEvents: events.length,
      boundary:
        "Actual Pi CLI read tool and generated extension; no real model or manual skill expansion",
    }),
  );
} finally {
  await new Promise((done) => server.close(done));
  await rm(root, { recursive: true, force: true });
}
