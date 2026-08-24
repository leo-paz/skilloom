import { describe, expect, it } from "vitest";
import { managedStateKey, planChanges } from "../src/core/plan.js";
import { resolveDesiredState } from "../src/core/resolve.js";
import { parseProjectConfig, parseUserConfig } from "../src/core/schema.js";

const skill = (name: string, source = "acme/skills") => ({
  name,
  source,
  agents: ["codex"],
});

describe("configuration schemas", () => {
  it("parses a minimal user config and applies defaults", () => {
    const parsed = parseUserConfig(
      "version: 1\nprofiles:\n  default:\n    skills: []\nmachines: {}\n",
    );
    expect(parsed.storage.mode).toBe("local");
    expect(parsed.projects).toEqual({});
  });

  it("rejects unknown keys, unsafe sources, and commands", () => {
    expect(() =>
      parseUserConfig(
        "version: 1\nprofiles: {}\nmachines: {}\ncommand: rm -rf /\n",
      ),
    ).toThrow();
    expect(() =>
      parseProjectConfig(
        "version: 1\nskills:\n  - source: 'x; echo nope'\n    name: bad\n",
      ),
    ).toThrow(/source/i);
  });

  it("accepts local source paths with spaces and shell metacharacters", () => {
    expect(
      parseProjectConfig(
        "version: 1\nskills:\n  - source: '/tmp/skill source;still-an-argv'\n    name: safe\n",
      ).skills[0]?.source,
    ).toBe("/tmp/skill source;still-an-argv");
  });

  it("rejects duplicate skills in one profile", () => {
    expect(() =>
      parseUserConfig(`version: 1
profiles:
  default:
    skills:
      - { source: acme/skills, name: format }
      - { source: acme/skills, name: format }
machines: {}
`),
    ).toThrow(/duplicate/i);
  });
});

describe("resolution and planning", () => {
  const config = {
    version: 1 as const,
    storage: { mode: "local" as const },
    profiles: { base: { skills: [skill("global")] } },
    machines: { laptop: { profile: "base" } },
    projectProfiles: { web: { skills: [skill("lint")] } },
    projects: { "/repo": { profile: "web", skills: [skill("personal")] } },
  };

  it("combines global, project profile, manifest, and personal additions", () => {
    const desired = resolveDesiredState(config, "laptop", "/repo", {
      version: 1,
      skills: [skill("committed")],
    });
    expect(desired.map((item) => `${item.scope}:${item.name}`)).toEqual([
      "global:global",
      "project:committed",
      "project:lint",
      "project:personal",
    ]);
  });

  it("fails when the machine references a missing profile", () => {
    expect(() => resolveDesiredState(config, "other", "/repo")).toThrow(
      /machine/i,
    );
  });

  it("creates deterministic operations and preserves unmanaged skills", () => {
    const desired = [
      { ...skill("new"), scope: "project" as const, reasons: ["manifest"] },
    ];
    const operations = planChanges(
      desired,
      [
        {
          name: "old",
          source: "acme/skills",
          agents: ["codex"],
          scope: "project",
        },
        { name: "manual", source: null, agents: ["codex"], scope: "project" },
      ],
      new Set([
        managedStateKey({
          name: "old",
          source: "acme/skills",
          scope: "project",
        }),
      ]),
    );
    expect(operations.map((op) => `${op.kind}:${op.skill.name}`)).toEqual([
      "add:new",
      "remove:old",
    ]);
  });

  it("is idempotent for a converged state", () => {
    const desired = [
      { ...skill("same"), scope: "global" as const, reasons: ["profile"] },
    ];
    expect(
      planChanges(desired, [{ ...skill("same"), scope: "global" }], new Set()),
    ).toEqual([]);
  });

  it("treats an upstream empty agent list as unknown linkage", () => {
    const desired = [
      { ...skill("same"), scope: "project" as const, reasons: ["manifest"] },
    ];
    expect(
      planChanges(
        desired,
        [
          {
            ...skill("same"),
            agents: [],
            scope: "project",
          },
        ],
        new Set(),
      ),
    ).toEqual([]);
  });

  it("does not remove a same-named skill replaced by the user or managed in another project", () => {
    const installed = [
      {
        name: "review",
        source: "personal/skills",
        agents: ["codex"],
        scope: "project" as const,
      },
    ];
    const managed = new Set([
      managedStateKey(
        { name: "review", source: "acme/skills", scope: "project" },
        "/repo-a",
      ),
    ]);
    expect(planChanges([], installed, managed, "/repo-b")).toEqual([]);
    expect(planChanges([], installed, managed, "/repo-a")).toEqual([]);
  });
});
