import { execFileSync } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { applyProvenance, verifyProvenance } from "../src/core/provenance.js";
import type { InstalledSkill } from "../src/core/types.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "skilloom-provenance-"));
  const source = join(root, "source");
  const skillTree = join(source, "skills/review");
  const installed = join(root, "home/.agents/skills/review");
  await mkdir(skillTree, { recursive: true });
  await writeFile(
    join(skillTree, "SKILL.md"),
    "---\nname: review\n---\nReview carefully.\n",
  );
  await writeFile(join(skillTree, "example.txt"), "example\n");
  execFileSync("git", ["init", source]);
  execFileSync("git", ["add", "."], { cwd: source });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.com",
      "commit",
      "-m",
      "fixture",
    ],
    { cwd: source },
  );
  await mkdir(installed, { recursive: true });
  await cp(skillTree, installed, { recursive: true });
  const env = {
    HOME: join(root, "home"),
    XDG_CONFIG_HOME: join(root, "home/.config"),
  };
  const skill: InstalledSkill = {
    name: "review",
    scope: "global",
    source: null,
    path: installed,
    agents: ["codex"],
  };
  return { root, source, installed, env, skill };
}

it("proves matching installed contents without modifying installation and invalidates changed contents", async () => {
  const f = await fixture();
  const result = await verifyProvenance(f.skill, f.source, f.root, f.env, {
    persist: true,
  });
  expect(result).toMatchObject({
    verified: true,
    persisted: true,
    source: f.source,
  });
  expect(result.commit).toMatch(/^[a-f0-9]{40}$/);
  expect((await applyProvenance([f.skill], f.root, f.env))[0]?.source).toBe(
    f.source,
  );
  expect(await readFile(join(f.installed, "example.txt"), "utf8")).toBe(
    "example\n",
  );
  await writeFile(join(f.installed, "example.txt"), "changed\n");
  expect(
    (await applyProvenance([f.skill], f.root, f.env))[0]?.source,
  ).toBeNull();
  await expect(
    verifyProvenance(f.skill, f.source, f.root, f.env, { persist: true }),
  ).rejects.toThrow(/match/);
});

it("dry run does not save proof and conflicting source claims are rejected", async () => {
  const f = await fixture();
  await verifyProvenance(f.skill, f.source, f.root, f.env, { persist: false });
  expect(
    (await applyProvenance([f.skill], f.root, f.env))[0]?.source,
  ).toBeNull();
  await expect(
    verifyProvenance(
      { ...f.skill, source: "other/repo" },
      f.source,
      f.root,
      f.env,
      { persist: true },
    ),
  ).rejects.toThrow(/source/i);
  await expect(
    verifyProvenance(f.skill, "ext::sh -c unsafe", f.root, f.env, {
      persist: true,
    }),
  ).rejects.toThrow(/source/i);
});

it("rejects internal installed symlinks instead of reading files outside the skill", async () => {
  const f = await fixture();
  await symlink(join(f.root, "source"), join(f.installed, "escape"));
  await expect(
    verifyProvenance(f.skill, f.source, f.root, f.env, { persist: true }),
  ).rejects.toThrow(/symbolic link/);
});

it("invalidates proof when a linked installation changes its resolved location", async () => {
  const f = await fixture();
  const link = join(f.root, "linked-review");
  await symlink(f.installed, link);
  const skill = { ...f.skill, path: link };
  await verifyProvenance(skill, f.source, f.root, f.env, { persist: true });
  expect((await applyProvenance([skill], f.root, f.env))[0]?.source).toBe(
    f.source,
  );
  const alternate = join(f.root, "alternate");
  await cp(f.installed, alternate, { recursive: true });
  const { unlink } = await import("node:fs/promises");
  await unlink(link);
  await symlink(alternate, link);
  expect((await applyProvenance([skill], f.root, f.env))[0]?.source).toBeNull();
});

it("rejects symlinks in the source skill and conflicting saved source attribution", async () => {
  const f = await fixture();
  await verifyProvenance(f.skill, f.source, f.root, f.env, { persist: true });
  const otherSource = join(f.root, "other-source");
  execFileSync("git", ["clone", f.source, otherSource]);
  await expect(
    verifyProvenance(f.skill, otherSource, f.root, f.env, { persist: true }),
  ).rejects.toThrow(/conflicts/);
  await symlink("example.txt", join(otherSource, "skills/review/unsafe"));
  execFileSync("git", ["add", "."], { cwd: otherSource });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.com",
      "commit",
      "-m",
      "unsafe fixture",
    ],
    { cwd: otherSource },
  );
  await expect(
    verifyProvenance(f.skill, otherSource, f.root, f.env, { persist: false }),
  ).rejects.toThrow(/symbolic link/);
});

it("source verify uses installed paths and only lists skills through the upstream runtime", async () => {
  const f = await fixture();
  const { verifySource } = await import("../src/cli/source.js");
  const output: string[] = [];
  const commands: string[][] = [];
  const runtime = {
    cwd: f.root,
    env: f.env,
    isTTY: false,
    stdout: (line: string) => output.push(line),
    stderr: (line: string) => output.push(line),
    confirm: async () => false,
    run: async (_executable: string, args: string[]) => {
      commands.push(args);
      return { code: 0, stdout: JSON.stringify([f.skill]), stderr: "" };
    },
  };
  expect(
    await verifySource(
      ["review", "--source", f.source, "--dry-run"],
      runtime,
      true,
    ),
  ).toBe(0);
  expect(JSON.parse(output.at(-1)!)).toMatchObject({
    command: "source verify",
    verified: true,
    persisted: false,
  });
  expect(
    await verifySource(
      ["review", "--source", f.source, "--yes"],
      runtime,
      true,
    ),
  ).toBe(0);
  expect(JSON.parse(output.at(-1)!)).toMatchObject({
    verified: true,
    persisted: true,
  });
  expect(
    commands.every((args) => args.includes("list") && !args.includes("add")),
  ).toBe(true);
});

it("canonicalizes a relative local source before saving attribution", async () => {
  const f = await fixture();
  const proof = await verifyProvenance(f.skill, "./source", f.root, f.env, {
    persist: true,
  });
  expect(proof.source).toBe(f.source);
  expect((await applyProvenance([f.skill], f.root, f.env))[0]?.source).toBe(
    f.source,
  );
});
