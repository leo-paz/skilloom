import type { InstallationDiagnosticsReport } from "../src/core/installation-diagnostics.js";
export const diagnosticsFixture = (): InstallationDiagnosticsReport => ({
  schemaVersion: 1,
  machineId: "local",
  machineName: "Workstation",
  platform: "darwin",
  observedAt: "2026-09-10T10:00:00.000Z",
  complete: true,
  entries: [".agents", ".claude"].map((dir) => ({
    id: dir,
    name: "brainstorming",
    path: `/fixture/${dir}/skills/brainstorming`,
    aliases: [],
    scope: "global",
    rootPath: `/fixture/${dir}/skills`,
    status: "target-missing",
    linkText: "../../missing/brainstorming",
    targetPath: "/fixture/missing/brainstorming",
  })),
  coverage: {
    roots: [
      {
        path: "/fixture/.agents/skills",
        scope: "global",
        status: "scanned",
        entryCount: 2,
      },
    ],
    entriesChecked: 2,
    limits: { maxEntries: 5000, maxRoots: 10000, maxDurationMs: 2000 },
    limitations: [
      "Immediate entries only; custom roots may be outside this scan.",
    ],
  },
});
