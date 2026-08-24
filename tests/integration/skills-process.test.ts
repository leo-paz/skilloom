import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SkillsAdapter } from "../../src/adapters/skills.js";

describe("skills process integration", () => {
  it("uses argv and captures partial failures through a fake npx", async () => {
    const root = await mkdtemp(join(tmpdir(), "skilloom-fake-npx-"));
    const executable = join(root, "npx");
    const log = join(root, "argv.log");
    await writeFile(
      executable,
      `#!/bin/sh
printf '%s\\n' "$@" >> "$SKILLOOM_TEST_LOG"
if [ "$2" = "list" ]; then
  printf '[{"name":"one","scope":"project","agents":["Codex"],"source":"acme/skills"}]'
  exit 0
fi
if [ "$2" = "remove" ]; then
  printf 'deliberate failure' >&2
  exit 7
fi
exit 0
`,
    );
    await chmod(executable, 0o755);
    const adapter = new SkillsAdapter(undefined, executable);
    const env = { ...process.env, SKILLOOM_TEST_LOG: log };
    expect(await adapter.list("project", root, env)).toHaveLength(1);
    const result = await adapter.execute(
      {
        kind: "remove",
        skill: {
          name: "one",
          source: "acme/skills",
          agents: ["codex"],
          scope: "project",
        },
        reasons: ["test"],
      },
      root,
      env,
    );
    expect(result.code).toBe(7);
    expect(result.stderr).toContain("deliberate failure");
    expect(await readFile(log, "utf8")).toContain("remove\none\n");
  });
});
