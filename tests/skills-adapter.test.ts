import { describe, expect, it } from "vitest";
import {
  commandForOperation,
  parseSkillsList,
} from "../src/adapters/skills.js";

describe("skills adapter", () => {
  it("parses current upstream JSON", () => {
    expect(
      parseSkillsList(
        '[{"name":"review","path":"/tmp/review","scope":"project","agents":["Codex"],"source":"acme/skills","sourceUrl":null,"sourceType":"github"}]',
      ),
    ).toEqual([
      {
        name: "review",
        source: "acme/skills",
        scope: "project",
        agents: ["codex"],
      },
    ]);
  });

  it("rejects malformed upstream JSON", () => {
    expect(() => parseSkillsList('{"name":"wrong"}')).toThrow(/output/i);
  });

  it("constructs argv without shell interpolation", () => {
    expect(
      commandForOperation({
        kind: "add",
        skill: {
          name: "review",
          source: "acme/skills",
          agents: ["codex"],
          scope: "global",
        },
        reasons: ["profile"],
      }),
    ).toEqual([
      "skills",
      "add",
      "acme/skills",
      "--skill",
      "review",
      "--agent",
      "codex",
      "--global",
      "--yes",
    ]);
    expect(
      commandForOperation({
        kind: "remove",
        skill: {
          name: "review",
          source: "acme/skills",
          agents: ["codex"],
          scope: "project",
        },
        reasons: ["no longer desired"],
      }),
    ).toEqual(["skills", "remove", "review", "--agent", "codex", "--yes"]);
  });
});
