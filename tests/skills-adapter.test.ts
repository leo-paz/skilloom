import { describe, expect, it } from "vitest";
import {
  commandForOperation,
  parseSkillsList,
  redactProcessOutput,
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
        path: "/tmp/review",
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
    expect(
      commandForOperation({
        kind: "add",
        skill: {
          name: "review",
          source: "/tmp/source with spaces;untouched",
          agents: ["codex"],
          scope: "project",
        },
        reasons: ["manifest"],
      })[2],
    ).toBe("/tmp/source with spaces;untouched");
  });

  it("redacts credential values from child process output", () => {
    expect(
      redactProcessOutput("failed with secret-value", {
        SERVICE_TOKEN: "secret-value",
      }),
    ).toBe("failed with [REDACTED]");
  });
});
