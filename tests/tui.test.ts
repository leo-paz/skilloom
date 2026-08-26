import { describe, expect, it } from "vitest";
import type { MachineInventory } from "../src/core/types.js";
import { renderDashboard } from "../src/tui/dashboard.js";

describe("terminal dashboard", () => {
  it("leads with machine, project, skill, and drift state", () => {
    const inventory: MachineInventory = {
      version: 1,
      observedAt: "2026-08-26T12:00:00.000Z",
      machine: { id: "mini", name: "Leo's Mac mini", profile: "default" },
      discovery: {
        status: "found",
        roots: [{ path: "/Users/paz/dev", depth: 3, status: "scanned" }],
        projectsFound: 1,
        checkoutsFound: 1,
      },
      profiles: ["default"],
      machines: [
        { id: "mini", name: "Leo's Mac mini", profile: "default" },
        { id: "book", name: "Leo's MacBook", profile: "default" },
      ],
      globalSkills: [
        {
          name: "code-review",
          source: "mattpocock/skills",
          agents: ["codex"],
          scope: "global",
          installed: true,
          desired: true,
          managed: true,
          reasons: ["machine profile default"],
        },
      ],
      projects: [
        {
          id: "github.com/leo-paz/skilloom",
          name: "skilloom",
          remote: "git@github.com:leo-paz/skilloom.git",
          checkouts: [{ path: "/Users/paz/dev/skilloom" }],
          skills: [],
          operations: [],
        },
      ],
      operations: [
        {
          kind: "add",
          skill: {
            name: "tdd",
            source: "mattpocock/skills",
            agents: ["codex"],
            scope: "project",
          },
          reasons: ["personal project additions"],
        },
      ],
    };

    expect(renderDashboard(inventory)).toBe(`Leo's Mac mini · profile default
Global · ● code-review
Drift · 1 pending change

Machines
● Leo's Mac mini · default · this machine
○ Leo's MacBook · default · not observed

Projects
skilloom · no skills · synced`);
  });
});
