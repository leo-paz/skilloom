import { describe, expect, it } from "vitest";
import { publishedObservation } from "../src/cli/observe.js";
import {
  installationDirectory,
  installationDirectoryLabel,
  installationDirectorySchema,
} from "../src/core/installation-directories.js";
import { inventoryFixture } from "./tui-fixture.js";

describe("portable installation directories", () => {
  it.each([
    [
      "/Users/leo/.agents/skills/review",
      "/Users/leo",
      "~/.agents/skills/review",
    ],
    ["/home/leo/.claude/skills/review", "/home/leo", "~/.claude/skills/review"],
    [
      "C:\\Users\\Leo\\.agents\\skills\\review",
      "c:\\users\\leo",
      "~/.agents/skills/review",
    ],
    [
      "\\\\server\\homes\\leo\\.claude\\skills\\review",
      "\\\\server\\homes\\leo",
      "~/.claude/skills/review",
    ],
  ])(
    "formats an origin-machine home without leaking it: %s",
    (path, home, label) => {
      const directory = installationDirectory(path, undefined, { HOME: home });
      expect(installationDirectoryLabel(directory)).toBe(label);
      expect(JSON.stringify(directory)).not.toContain(home);
    },
  );
  it("prefers project-relative paths and handles Windows checkouts", () => {
    expect(
      installationDirectory(
        "C:\\dev\\repo\\.agents\\skills\\review",
        "C:\\dev\\repo",
        { USERPROFILE: "C:\\Users\\leo" },
      ),
    ).toEqual({ base: "project", path: ".agents/skills/review" });
  });
  it("keeps custom roots portable and does not mistake siblings or other drives for descendants", () => {
    expect(
      installationDirectoryLabel(
        installationDirectory("D:\\tools\\codex\\skills\\review", undefined, {
          USERPROFILE: "C:\\Users\\leo",
          CODEX_HOME: "D:\\tools\\codex",
        }),
      ),
    ).toBe("<CODEX_HOME>/skills/review");
    for (const path of ["/home/leon/private/review", "/secret/review"]) {
      expect(
        installationDirectory(path, undefined, { HOME: "/home/leo" }),
      ).toEqual({ base: "external", path: "" });
    }
  });
  it("publishes portable locations while stripping the local absolute installation path", () => {
    const inventory = inventoryFixture();
    inventory.globalSkills[0]!.path =
      "/Users/private-person/.agents/skills/code-review";
    const published = publishedObservation(inventory);
    expect(JSON.stringify(published)).not.toContain("/Users/private-person");
    expect(published.globalSkills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          installationDirectories:
            inventory.globalSkills[0]!.installationDirectories,
        }),
      ]),
    );
  });
  it("rejects absolute paths, traversal and terminal controls in shared observations", () => {
    for (const path of [
      "/Users/leo",
      "C:/Users/leo",
      "../secret",
      ".agents/../secret",
      "a\u001b[31m",
      "a\\b",
    ]) {
      expect(
        installationDirectorySchema.safeParse({ base: "home", path }).success,
      ).toBe(false);
    }
    expect(
      installationDirectorySchema.safeParse({
        base: "external",
        path: "private",
      }).success,
    ).toBe(false);
  });
});
