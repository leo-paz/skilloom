import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GitAdapter } from "../../src/adapters/git.js";
import type { ProcessResult } from "../../src/adapters/skills.js";
import { runCli } from "../../src/cli/app.js";
import { loadUserConfig } from "../../src/core/config.js";
import { planChanges } from "../../src/core/plan.js";
import { resolveDesiredState } from "../../src/core/resolve.js";

describe("managed Git configuration", () => {
  it("synchronizes two machines and refuses dirty changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "skilloom-git-"));
    const remote = join(root, "remote.git");
    const one = join(root, "one");
    const two = join(root, "two");
    const git = new GitAdapter();
    await expect(
      git.clone(
        "https://secret-token@github.com/acme/config.git",
        join(root, "unsafe"),
      ),
    ).rejects.toThrow(/token|credential/i);
    const sharedConfig = `version: 1
storage: { mode: managed, repository: ${remote} }
profiles:
  laptop:
    skills: [{ source: acme/skills, name: laptop-skill, agents: [codex] }]
  desktop:
    skills: [{ source: acme/skills, name: desktop-skill, agents: [codex] }]
machines:
  machine-a: { profile: laptop }
  machine-b: { profile: desktop }
`;
    await git.initBare(remote);
    await git.clone(remote, one);
    await writeFile(join(one, "config.yaml"), sharedConfig);
    await git.commitAndPush(one, "Initialize Skilloom configuration");
    await git.clone(remote, two);
    expect(await readFile(join(two, "config.yaml"), "utf8")).toContain(
      "version: 1",
    );

    const machineA = resolveDesiredState(
      await loadUserConfig(join(one, "config.yaml")),
      "machine-a",
    );
    const machineB = resolveDesiredState(
      await loadUserConfig(join(two, "config.yaml")),
      "machine-b",
    );
    expect(
      planChanges(machineA, [], new Set()).map((op) => op.skill.name),
    ).toEqual(["laptop-skill"]);
    expect(
      planChanges(machineB, [], new Set()).map((op) => op.skill.name),
    ).toEqual(["desktop-skill"]);

    await writeFile(join(two, "config.yaml"), "version: 1\n# dirty\n");
    await expect(git.pull(two)).rejects.toThrow(/uncommitted/i);

    await writeFile(join(two, "config.yaml"), sharedConfig);
    await writeFile(
      join(one, "config.yaml"),
      `${sharedConfig}# machine a change\n`,
    );
    await git.commitAndPush(one, "Change machine A configuration");
    await writeFile(
      join(two, "config.yaml"),
      `${sharedConfig}# machine b change\n`,
    );
    await expect(
      git.commitAndPush(two, "Change machine B configuration"),
    ).rejects.toThrow(/push/i);
    await expect(git.pull(two)).rejects.toThrow(/fast-forward|divergent/i);
  });

  it("connects the CLI to an existing managed repository", async () => {
    const root = await mkdtemp(join(tmpdir(), "skilloom-managed-init-"));
    const remote = join(root, "remote.git");
    const seed = join(root, "seed");
    const home = join(root, "home");
    const verify = join(root, "verify");
    const git = new GitAdapter();
    await git.initBare(remote);
    await git.clone(remote, seed);
    await writeFile(
      join(seed, "config.yaml"),
      `version: 1\nstorage: { mode: managed, repository: ${remote} }\nprofiles:\n  work: { skills: [] }\nmachines: {}\n`,
    );
    await git.commitAndPush(seed, "Seed shared configuration");

    const output: string[] = [];
    const code = await runCli(
      [
        "init",
        "--storage",
        "managed",
        "--repository",
        remote,
        "--profile",
        "work",
        "--json",
      ],
      {
        cwd: home,
        env: { HOME: home, XDG_CONFIG_HOME: join(home, ".config") },
        isTTY: false,
        stdout: (line) => output.push(line),
        stderr: (line) => output.push(line),
        run: async (): Promise<ProcessResult> => ({
          code: 0,
          stdout: "",
          stderr: "",
        }),
        confirm: async () => true,
      },
    );
    expect(code).toBe(0);
    expect(JSON.parse(output.at(-1) ?? "{}")).toMatchObject({
      ok: true,
      connected: true,
    });
    await git.clone(remote, verify);
    const connected = await loadUserConfig(join(verify, "config.yaml"));
    expect(Object.values(connected.machines)).toContainEqual({
      profile: "work",
    });
  });
});
