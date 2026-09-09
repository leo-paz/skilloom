import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createSkillMetadataReader,
  skillMetadataSchema,
} from "../src/core/skill-metadata.js";

async function fixture(
  agent = "claude-code",
  frontmatter = "description: Use for review",
) {
  const home = await mkdtemp(join(tmpdir(), "skilloom-metadata-"));
  const root = join(
    home,
    agent === "claude-code" ? ".claude" : ".agents",
    "skills",
    "review",
  );
  await mkdir(root, { recursive: true });
  const file = join(root, "SKILL.md");
  await writeFile(
    file,
    `---\nname: review\n${frontmatter}\n---\nAlways invoke automatically.\n`,
  );
  const env = { HOME: home, CODEX_HOME: join(home, ".codex") };
  const skill = { name: "review", scope: "global" as const, agents: [agent] };
  return { home, root, file, env, skill, read: createSkillMetadataReader(env) };
}
describe("bounded harness-specific declaration metadata", () => {
  it.each([
    ["", "both"],
    ["disable-model-invocation: true", "manual"],
    ["user-invocable: false", "automatic"],
    ["disable-model-invocation: true\nuser-invocable: false", "disabled"],
  ])("interprets Claude declaration %s", async (flags, invocation) => {
    const f = await fixture("claude-code", flags);
    expect((await f.read(f.skill, f.home)).invocation).toBe(invocation);
  });
  it("uses Codex policy rather than Claude-specific flags", async () => {
    const f = await fixture("codex", "disable-model-invocation: true");
    expect((await f.read(f.skill, f.home)).invocation).toBe("both");
    await mkdir(join(f.root, "agents"));
    await writeFile(
      join(f.root, "agents", "openai.yaml"),
      "policy:\n  allow_implicit_invocation: false\n",
    );
    expect(
      (await createSkillMetadataReader(f.env)(f.skill, f.home)).invocation,
    ).toBe("manual");
  });
  it("reports mixed known harness declarations and publishes no local path or prose", async () => {
    const f = await fixture(
      "claude-code",
      "disable-model-invocation: true\ndescription: PRIVATE_LOCAL_DESCRIPTION",
    );
    const codex = join(f.home, ".agents", "skills", "review");
    await mkdir(codex, { recursive: true });
    await symlink(f.file, join(codex, "SKILL.md"));
    const result = await f.read(
      { ...f.skill, agents: ["claude-code", "codex"] },
      f.home,
    );
    expect(result.invocation).toBe("mixed");
    expect(result.variants).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain(f.home);
    expect(JSON.stringify(result)).not.toContain("PRIVATE_LOCAL_DESCRIPTION");
  });
  it("returns unknown for missing, invalid or unsupported declarations", async () => {
    const f = await fixture("claude-code", "disable-model-invocation: 'true'");
    expect((await f.read(f.skill, f.home)).invocation).toBe("unknown");
    expect(
      (await f.read({ ...f.skill, name: "missing" }, f.home)).invocation,
    ).toBe("unknown");
    expect(
      (await f.read({ ...f.skill, agents: ["unverified-harness"] }, f.home))
        .invocation,
    ).toBe("unknown");
  });
  it("bounds malformed files and does not treat instruction prose as declarations", async () => {
    const f = await fixture();
    await writeFile(f.file, "---\n" + "x".repeat(70_000));
    expect((await f.read(f.skill, f.home)).invocation).toBe("unknown");
    await writeFile(
      f.file,
      "description: prose only\ndisable-model-invocation: true\n",
    );
    expect(
      (await createSkillMetadataReader(f.env)(f.skill, f.home)).invocation,
    ).toBe("unknown");
  });
  it("rejects a truncated multibyte Codex sidecar rather than assuming its omitted policy defaults", async () => {
    const f = await fixture("codex");
    await mkdir(join(f.root, "agents"));
    await writeFile(
      join(f.root, "agents", "openai.yaml"),
      "interface: {display_name: Review}\n# " +
        "é".repeat(40_000) +
        "\npolicy: {allow_implicit_invocation: false}\n",
    );
    expect((await f.read(f.skill, f.home)).invocation).toBe("unknown");
  });
  it("caches one scan and refreshes declarations with a new reader", async () => {
    const f = await fixture();
    expect((await f.read(f.skill, f.home)).invocation).toBe("both");
    await writeFile(
      f.file,
      "---\nname: review\ndisable-model-invocation: true\n---\n",
    );
    expect((await f.read(f.skill, f.home)).invocation).toBe("both");
    expect(
      (await createSkillMetadataReader(f.env)(f.skill, f.home)).invocation,
    ).toBe("manual");
  });
  it("detects conflicting same-harness fallback variants", async () => {
    const f = await fixture("codex");
    const legacy = join(f.home, ".codex", "skills", "review");
    await mkdir(join(legacy, "agents"), { recursive: true });
    await writeFile(join(legacy, "SKILL.md"), "---\nname: review\n---\n");
    await writeFile(
      join(legacy, "agents", "openai.yaml"),
      "policy: {allow_implicit_invocation: false}\n",
    );
    expect((await f.read(f.skill, f.home)).invocation).toBe("mixed");
  });
  it("honors Pi disable-model-invocation without inventing user-invocable support", async () => {
    const f = await fixture(
      "pi",
      "description: Pi review\nuser-invocable: false",
    );
    expect((await f.read(f.skill, f.home)).invocation).toBe("both");
    await writeFile(
      f.file,
      "---\nname: review\ndescription: Pi review\ndisable-model-invocation: true\n---\n",
    );
    expect(
      (await createSkillMetadataReader(f.env)(f.skill, f.home)).invocation,
    ).toBe("manual");
  });
  it("parses published metadata without accepting embedded local evidence fields", async () => {
    const f = await fixture();
    const result = await f.read(f.skill, f.home);
    expect(
      skillMetadataSchema.parse({
        ...result,
        path: f.file,
        description: "private",
      }),
    ).toEqual(result);
    expect(
      skillMetadataSchema.safeParse({ ...result, invocation: "maybe" }).success,
    ).toBe(false);
  });
  it("summarizes discovered supported declarations without assuming other harness support", async () => {
    const f = await fixture();
    const result = await f.read(
      { ...f.skill, agents: ["claude-code", "codex", "unverified-harness"] },
      f.home,
    );
    expect(result.invocation).toBe("both");
    expect(
      result.variants.find((variant) => variant.agent === "unverified-harness")
        ?.invocation,
    ).toBe("unknown");
    expect(
      result.variants.find((variant) => variant.agent === "codex")?.status,
    ).toBe("missing");
  });
  it("uses actual detected agents rather than expanded installation coverage", async () => {
    const f = await fixture();
    const result = await f.read(
      {
        ...f.skill,
        agents: ["claude-code", "unverified-harness"],
        detectedAgents: ["claude-code"],
      },
      f.home,
    );
    expect(result.invocation).toBe("both");
  });
});
