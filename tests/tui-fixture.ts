import type { MachineInventory } from "../src/core/types.js";
export const inventoryFixture = (): MachineInventory => ({
  version: 1,
  observedAt: "2026-09-08T12:00:00.000Z",
  machine: { id: "local", name: "Workstation", profile: "personal" },
  discovery: {
    status: "found",
    roots: [{ path: "/workspace", depth: 3, status: "scanned" }],
    projectsFound: 1,
    checkoutsFound: 1,
  },
  profiles: ["personal", "studio"],
  machines: [
    { id: "local", name: "Workstation", profile: "personal", local: true },
    {
      id: "remote",
      name: "Studio",
      profile: "studio",
      observedAt: "2026-09-07T12:00:00.000Z",
    },
  ],
  globalSkills: [
    {
      name: "code-review",
      usagePathIds: ["a".repeat(64)],
      installationDirectories: [
        { base: "home", path: ".agents/skills/code-review" },
        { base: "home", path: ".claude/skills/code-review" },
      ],
      metadata: {
        readerVersion: 2,
        source: "skill-declaration",
        invocation: "both",
        variants: [{ agent: "codex", invocation: "both", status: "read" }],
      },
      source: "acme/review",
      agents: ["codex"],
      scope: "global",
      installed: true,
      desired: true,
      managed: true,
      ownership: "personal",
      reasons: ["machine profile personal"],
    },
  ],
  projects: [
    {
      id: "github.com/acme/catalog",
      name: "catalog",
      remote: "https://github.com/acme/catalog",
      checkouts: [
        {
          path: "/workspace/catalog",
          skills: [
            {
              name: "design-system",
              installationDirectories: [
                { base: "project", path: ".claude/skills/design-system" },
              ],
              source: null,
              agents: ["claude-code"],
              scope: "project",
              installed: true,
              desired: false,
              managed: false,
              ownership: "repository",
              reasons: [],
            },
          ],
        },
      ],
      skills: [],
      operations: [],
    },
  ],
  operations: [],
  skillUsage: {
    version: 2,
    sessions: [
      {
        name: "code-review",
        harness: "codex",
        sessionId: "b".repeat(64),
        pathId: "a".repeat(64),
        firstUsedAt: "2026-09-08T10:00:00.000Z",
        lastUsedAt: "2026-09-08T11:00:00.000Z",
        eventCount: 2,
      },
    ],
    history: [
      {
        id: "d".repeat(64),
        name: "code-review",
        harness: "codex",
        evidence: "read",
        pathId: "a".repeat(64),
        at: "2026-09-08T11:00:00.000Z",
      },
    ],
    usage: [
      {
        name: "code-review",
        pathId: "a".repeat(64),
        harness: "codex",
        evidence: "read",
        count: 2,
        lastUsedAt: "2026-09-08T11:00:00.000Z",
      },
    ],
    coverage: {
      status: "incomplete",
      filesDiscovered: 1,
      filesScanned: 1,
      bytesRead: 100,
      limitsHit: ["files"],
      observedAt: "2026-09-08T12:00:00.000Z",
    },
  },
  remoteObservations: [
    {
      machine: { id: "remote", name: "Studio" },
      observedAt: "2026-09-07T12:00:00.000Z",
      projects: [
        {
          id: "github.com/acme/catalog",
          name: "catalog",
          skills: [
            {
              name: "remote-research",
              source: "acme/research",
              agents: ["codex"],
              scope: "project",
              installed: true,
              desired: false,
              managed: false,
              ownership: "personal",
              reasons: [],
            },
          ],
        },
      ],
    },
  ],
});
