import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GitAdapter } from "../../src/adapters/git.js";
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
});
