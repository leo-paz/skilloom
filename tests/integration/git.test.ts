import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GitAdapter } from "../../src/adapters/git.js";

describe("managed Git configuration", () => {
  it("synchronizes two machines and refuses dirty changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "skilloom-git-"));
    const remote = join(root, "remote.git");
    const one = join(root, "one");
    const two = join(root, "two");
    const git = new GitAdapter();
    await git.initBare(remote);
    await git.clone(remote, one);
    await writeFile(join(one, "config.yaml"), "version: 1\n");
    await git.commitAndPush(one, "Initialize Skilloom configuration");
    await git.clone(remote, two);
    expect(await readFile(join(two, "config.yaml"), "utf8")).toContain(
      "version: 1",
    );
    await writeFile(join(two, "config.yaml"), "version: 1\n# dirty\n");
    await expect(git.pull(two)).rejects.toThrow(/uncommitted/i);
  });
});
