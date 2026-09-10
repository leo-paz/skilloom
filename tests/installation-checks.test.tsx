import { render } from "ink-testing-library";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InstallationDiagnosticsReport } from "../src/core/installation-diagnostics.js";
import { InstallationChecks } from "../src/tui/installation-checks.js";

import { diagnosticsFixture } from "./installation-checks-fixture.js";

const mounted: Array<ReturnType<typeof render>> = [];
afterEach(() => {
  for (const app of mounted.splice(0)) app.unmount();
});
const tick = () => new Promise((resolve) => setTimeout(resolve, 60));

describe("installation checks", () => {
  it("groups proven missing leaves but keeps unverified target expressions separate", async () => {
    const report = diagnosticsFixture();
    report.entries[0]!.targetPath =
      "/fixture/.agents/skills/../../missing/brainstorming";
    report.entries[1]!.targetPath =
      "/fixture/.claude/skills/../../missing/brainstorming";
    for (const entry of report.entries)
      entry.missingTargetPath = "/fixture/missing/brainstorming";
    const app = render(
      <InstallationChecks
        scan={async () => structuredClone(report)}
        onClose={() => {}}
        width={100}
        height={26}
        machineName="Workstation"
      />,
    );
    mounted.push(app);
    await tick();
    expect(app.lastFrame()).toContain("2 entries");
    app.stdin.write("\r");
    await tick();
    expect(app.lastFrame()).toContain("Missing target");
    expect(app.lastFrame()).toContain("/fixture/missing/brainstorming");
    expect(app.lastFrame()).not.toContain("../../missing");
    app.stdin.write("\u001b");
    await tick();
    for (const entry of report.entries) delete entry.missingTargetPath;
    app.stdin.write("r");
    await tick();
    expect(app.lastFrame()).not.toMatch(/Target missing\s+2 entries/);
    expect(app.lastFrame()?.match(/1 entry/g)).toHaveLength(2);
  });
  it("identifies a broken instruction link without calling its installation directory missing", async () => {
    const report = diagnosticsFixture();
    report.entries = [
      {
        ...report.entries[0]!,
        status: "skill-file-invalid",
        skillFile: {
          path: "/fixture/.agents/skills/brainstorming/SKILL.md",
          linkText: "missing-instructions.md",
          targetPath:
            "/fixture/.agents/skills/brainstorming/missing-instructions.md",
        },
      },
    ];
    const app = render(
      <InstallationChecks
        scan={async () => report}
        onClose={() => {}}
        width={120}
        height={32}
        machineName="Workstation"
      />,
    );
    mounted.push(app);
    await tick();
    app.stdin.write("\r");
    await tick();
    expect(app.lastFrame()).toContain("Invalid SKILL.md entry");
    expect(app.lastFrame()).toContain(
      "SKILL.md entry: /fixture/.agents/skills/brainstorming/SKILL.md",
    );
    expect(app.lastFrame()).toContain("missing-instructions.md");
    expect(app.lastFrame()).not.toContain("Target missing");
  });
  it("groups a shared missing target, opens exact entries, and keeps Escape predictable", async () => {
    const scan = vi.fn(async () => diagnosticsFixture());
    const close = vi.fn();
    const app = render(
      <InstallationChecks
        scan={scan}
        onClose={close}
        width={110}
        height={26}
        machineName="Workstation"
      />,
    );
    mounted.push(app);
    await tick();
    expect(app.lastFrame()).toContain("Target missing");
    expect(app.lastFrame()).toContain("2 entries");
    expect(app.lastFrame()).toContain("Workstation");
    app.stdin.write("\r");
    await tick();
    expect(app.lastFrame()).toContain("/fixture/.agents/skills/brainstorming");
    expect(app.lastFrame()).toContain("/fixture/.claude/skills/brainstorming");
    expect(app.lastFrame()).not.toContain("Apply");
    app.stdin.write("\u001b");
    await tick();
    expect(close).not.toHaveBeenCalled();
    expect(app.lastFrame()).toContain("Target missing");
    app.stdin.write("r");
    await tick();
    expect(scan).toHaveBeenCalledTimes(2);
    app.stdin.write("\u001b");
    await tick();
    expect(close).toHaveBeenCalledOnce();
  });
  it("reports incomplete coverage without claiming there are no problems", async () => {
    const report = diagnosticsFixture();
    report.entries = [];
    report.complete = false;
    report.coverage.stoppedBecause = "entry-limit";
    const app = render(
      <InstallationChecks
        scan={async () => report}
        onClose={() => {}}
        width={60}
        height={20}
        machineName="Workstation"
      />,
    );
    mounted.push(app);
    await tick();
    expect(app.lastFrame()).toContain("Entry limit reached");
    expect(app.lastFrame()).toContain("No findings in checked entries");
    app.stdin.write("c");
    await tick();
    expect(app.lastFrame()).toContain("Entry limit reached");
  });
  it("keeps exit available while a scan is pending and sanitizes terminal text", async () => {
    let finish!: (value: InstallationDiagnosticsReport) => void;
    const close = vi.fn();
    const app = render(
      <InstallationChecks
        scan={() =>
          new Promise((resolve) => {
            finish = resolve;
          })
        }
        onClose={close}
        width={70}
        height={20}
        machineName="Workstation"
      />,
    );
    mounted.push(app);
    await tick();
    app.stdin.write("\u001b");
    await tick();
    expect(close).toHaveBeenCalledOnce();
    const report = diagnosticsFixture();
    report.entries[0]!.name = "bad\u001b[2Jname";
    finish(report);
    await tick();
    expect(app.lastFrame()).not.toContain("\u001b[2J");
  });
});
