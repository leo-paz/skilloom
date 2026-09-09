import { render } from "ink-testing-library";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type DashboardBackend, SkilloomApp } from "../src/tui/app.js";
import { buildLibrary, filterLibrary } from "../src/tui/catalog.js";
import { inventoryFixture } from "./tui-fixture.js";

const mounted: Array<ReturnType<typeof render>> = [];
afterEach(() => {
  for (const app of mounted.splice(0)) app.unmount();
});
const tick = () => new Promise((resolve) => setTimeout(resolve, 60));
const backend = (): DashboardBackend => ({
  load: vi.fn(async () => inventoryFixture()),
  execute: vi.fn(async () => ({
    code: 0,
    value: { ok: true, operations: [], issues: [] },
  })),
});
const mount = (width = 120, api = backend()) => {
  const app = render(
    <SkilloomApp
      initialInventory={inventoryFixture()}
      backend={api}
      width={width}
      height={32}
    />,
  );
  mounted.push(app);
  return app;
};

describe("full-screen skill library", () => {
  it("hydrates an older snapshot without blocking selection or rescanning inventory", async () => {
    const old = inventoryFixture();
    delete old.skillUsage;
    delete old.globalSkills[0]!.metadata;
    let finish!: (inventory: typeof old) => void;
    const api = {
      ...backend(),
      enrich: vi.fn(
        () =>
          new Promise<typeof old>((resolve) => {
            finish = resolve;
          }),
      ),
    };
    const app = render(
      <SkilloomApp
        initialInventory={old}
        backend={api}
        width={100}
        height={32}
      />,
    );
    mounted.push(app);
    await tick();
    expect(app.lastFrame()).toContain("Loading skill metadata");
    app.stdin.write("\u001b[B");
    await tick();
    expect(app.lastFrame()).toContain("› design-system");
    const enriched = inventoryFixture();
    enriched.projects[0]!.checkouts[0]!.skills![0]!.metadata = {
      source: "skill-declaration",
      invocation: "unknown",
      variants: [],
    };
    finish(enriched);
    await tick();
    expect(app.lastFrame()).toContain("› design-system");
    expect(app.lastFrame()).toContain("Both");
    expect(app.lastFrame()).not.toContain("Loading skill metadata");
    expect(api.load).not.toHaveBeenCalled();
    expect(api.execute).not.toHaveBeenCalled();
    expect(api.enrich).toHaveBeenCalledTimes(1);
  });
  it.each([40, 100, 140])(
    "shows declared invocation and observed usage columns at %i columns",
    async (width) => {
      const api = backend();
      const app = mount(width, api);
      await tick();
      expect(app.lastFrame()).toContain("Invoke");
      expect(app.lastFrame()).toContain("Used by");
      expect(app.lastFrame()).toContain("Both");
      expect(app.lastFrame()).toContain(width < 65 ? "OAI" : "OpenAI");
      expect(api.execute).not.toHaveBeenCalled();
      app.stdin.write("\r");
      await tick();
      expect(app.lastFrame()).toContain("2 skill reads");
      expect(app.lastFrame()).toContain("Usage scan is partial");
    },
  );
  it("keeps declared availability distinct from usage and filters usage by machine", () => {
    const inventory = inventoryFixture();
    const rows = buildLibrary(inventory);
    expect(rows.find((row) => row.name === "code-review")?.usedBy).toEqual([
      "codex",
    ]);
    expect(rows.find((row) => row.name === "design-system")?.usedBy).toEqual(
      [],
    );
    expect(rows.find((row) => row.name === "remote-research")?.usedBy).toEqual(
      [],
    );
    const localCopy = { ...inventory.globalSkills[0]! };
    inventory.remoteObservations![0]!.globalSkills = [localCopy];
    const remoteRows = filterLibrary(buildLibrary(inventory), {
      machine: "remote",
      query: "code-review",
      scope: "all",
      ownership: "all",
    });
    expect(remoteRows[0]?.usedBy).toEqual([]);
  });
  it("indexes every machine and searches source, project, and agent metadata", () => {
    const rows = buildLibrary(inventoryFixture());
    expect(rows.map((x) => x.name)).toEqual([
      "code-review",
      "design-system",
      "remote-research",
    ]);
    expect(
      filterLibrary(rows, {
        query: "research",
        machine: "all",
        scope: "all",
        ownership: "all",
      }).map((x) => x.name),
    ).toEqual(["remote-research"]);
    expect(
      rows.find((x) => x.name === "remote-research")?.occurrences[0]
        ?.checkoutPath,
    ).toBeUndefined();
  });
  it("searches without leaving the library and shows remote observation context", async () => {
    const app = mount();
    await tick();
    expect(app.lastFrame()).toContain("Skilloom");
    expect(app.lastFrame()).toContain("Library");
    app.stdin.write("/");
    await tick();
    app.stdin.write("remote-research");
    await tick();
    app.stdin.write("\r");
    await tick();
    expect(app.lastFrame()).toContain("remote-research");
    expect(app.lastFrame()).toContain("Studio");
    expect(app.lastFrame()).toContain("Saved observations");
    expect(app.lastFrame()).not.toContain("/workspace/catalog");
  });
  it("provides a usable compact list and an inspect/back flow", async () => {
    const app = mount(48);
    await tick();
    expect(app.lastFrame()).toContain("code-review");
    app.stdin.write("\r");
    await tick();
    expect(app.lastFrame()).toContain("acme/review");
    app.stdin.write("\u001b");
    await tick();
    expect(app.lastFrame()).toContain("Library");
  });
  it("requires a reviewed preview and explicit confirmation before syncing", async () => {
    const api = backend();
    api.execute = vi.fn(async (args) =>
      args.includes("--dry-run")
        ? {
            code: 0,
            value: {
              ok: true,
              operations: [
                {
                  kind: "add",
                  name: "new-skill",
                  cwd: "/workspace/catalog",
                  scope: "project",
                  agents: ["codex"],
                },
              ],
              issues: [],
            },
          }
        : {
            code: 0,
            value: { ok: true, converged: true, completed: [], pending: [] },
          },
    );
    const app = mount(120, api);
    await tick();
    app.stdin.write("s");
    await tick();
    expect(api.execute).toHaveBeenCalledWith(
      ["sync", "--dry-run"],
      expect.any(Function),
    );
    expect(app.lastFrame()).toContain("new-skill");
    expect(app.lastFrame()).toContain("Apply");
    app.stdin.write("\u001b");
    await tick();
    expect(api.execute).toHaveBeenCalledTimes(1);
    app.stdin.write("s");
    await tick();
    app.stdin.write("y");
    await tick();
    expect(api.execute).toHaveBeenLastCalledWith(
      ["sync", "--yes"],
      expect.any(Function),
    );
  });
  it("keeps the previous inventory visible when a refresh fails", async () => {
    const api = backend();
    api.load = vi.fn(async () => {
      throw Error("Repository unavailable");
    });
    const app = mount(120, api);
    await tick();
    app.stdin.write("r");
    await tick();
    expect(app.lastFrame()).toContain("Repository unavailable");
    expect(app.lastFrame()).toContain("code-review");
  });
  it("shows source replacements and keeps partial publication results readable", async () => {
    const api = backend();
    api.execute = vi.fn(async (args) =>
      args.includes("--dry-run")
        ? {
            code: 0,
            value: {
              fingerprint: "reviewed",
              issues: [],
              operations: [
                {
                  kind: "remove",
                  name: "code-review",
                  source: "old/repo",
                  scope: "global",
                },
                {
                  kind: "add",
                  name: "code-review",
                  source: "new/repo",
                  scope: "global",
                },
              ],
            },
          }
        : {
            code: 4,
            value: {
              converged: true,
              partialSuccess: true,
              phases: {
                apply: { status: "succeeded" },
                verify: { status: "succeeded" },
                publish: { status: "failed" },
              },
              error: {
                message:
                  "Remote push rejected. Retry sync after resolving the remote.",
              },
            },
          },
    );
    const app = mount(80, api);
    await tick();
    app.stdin.write("s");
    await tick();
    expect(app.lastFrame()).toContain("old/repo");
    expect(app.lastFrame()).toContain("new/repo");
    app.stdin.write("y");
    await tick();
    expect(api.execute).toHaveBeenLastCalledWith(
      ["sync", "--yes", "--expect", "reviewed"],
      expect.any(Function),
    );
    expect(app.lastFrame()).toContain("apply: succeeded");
    expect(app.lastFrame()).toContain("publish: failed");
    expect(app.lastFrame()).toContain("Local requirements verified.");
    expect(app.lastFrame()).toContain("Remote push rejected");
  });
  it("reuses the current profile when editing workspace setup", async () => {
    const api = backend();
    const app = mount(120, api);
    await tick();
    app.stdin.write("3");
    await tick();
    app.stdin.write("u");
    await tick();
    app.stdin.write("\r");
    await tick();
    app.stdin.write("\r");
    await tick();
    app.stdin.write("\r");
    await tick();
    expect(api.execute).toHaveBeenCalledWith(
      [
        "setup",
        "~/dev",
        "--machine-name",
        "Workstation",
        "--profile",
        "personal",
      ],
      expect.any(Function),
    );
  });
  it("scrolls to every installation and can scroll back from the end", async () => {
    const inventory = inventoryFixture();
    inventory.remoteObservations![0]!.globalSkills = Array.from(
      { length: 8 },
      (_, i) => ({
        ...inventory.globalSkills[0]!,
        source: `remote/source-${i}`,
      }),
    );
    const app = render(
      <SkilloomApp
        initialInventory={inventory}
        backend={backend()}
        width={48}
        height={24}
      />,
    );
    mounted.push(app);
    await tick();
    app.stdin.write("\r");
    await tick();
    app.stdin.write("\u001b[F");
    await tick();
    expect(app.lastFrame()).toContain("remote/source-7");
    app.stdin.write("\u001b[H");
    await tick();
    expect(app.lastFrame()).toContain("acme/review");
  });
  it("requires choosing the unknown installation before verifying its source", async () => {
    const inventory = inventoryFixture();
    inventory.globalSkills[0]!.source = null;
    inventory.projects[0]!.checkouts.push({
      path: "/workspace/second",
      skills: [{ ...inventory.globalSkills[0]!, scope: "project" }],
    });
    const api = backend();
    const app = render(
      <SkilloomApp
        initialInventory={inventory}
        backend={api}
        width={100}
        height={32}
      />,
    );
    mounted.push(app);
    await tick();
    app.stdin.write("v");
    await tick();
    expect(app.lastFrame()).toContain("Global on this machine");
    app.stdin.write("\u001b[C");
    await tick();
    expect(app.lastFrame()).toContain("/workspace/second");
    app.stdin.write("\r");
    await tick();
    app.stdin.write("acme/proof");
    await tick();
    app.stdin.write("\r");
    await tick();
    expect(api.execute).toHaveBeenCalledWith(
      [
        "source",
        "verify",
        "code-review",
        "--source",
        "acme/proof",
        "--scope",
        "project",
        "--checkout",
        "/workspace/second",
        "--yes",
      ],
      expect.any(Function),
    );
  });
  it("clamps a paged selection when refreshed inventory becomes shorter", async () => {
    const inventory = inventoryFixture();
    inventory.globalSkills = Array.from({ length: 60 }, (_, i) => ({
      ...inventory.globalSkills[0]!,
      name: `skill-${String(i).padStart(2, "0")}`,
    }));
    const api = backend();
    const app = render(
      <SkilloomApp
        initialInventory={inventory}
        backend={api}
        width={80}
        height={24}
      />,
    );
    mounted.push(app);
    await tick();
    app.stdin.write("\u001b[F");
    await tick();
    expect(app.lastFrame()).toContain("skill-59");
    app.stdin.write("r");
    await tick();
    expect(app.lastFrame()).toContain("code-review");
  });
  it("keeps the active field and save controls visible on a compact screen", async () => {
    const app = mount(40);
    await tick();
    app.stdin.write("a");
    await tick();
    expect(app.lastFrame()).toContain("Field 1 of 4");
    for (let i = 0; i < 3; i++) {
      app.stdin.write("\t");
      await tick();
    }
    expect(app.lastFrame()).toContain("Field 4 of 4");
    expect(app.lastFrame()).toContain("Global · personal");
    expect(app.lastFrame()).toContain("Esc cancel");
  });
  it("returns search to visibly active results and preserves filters across Escape", async () => {
    const app = mount();
    await tick();
    app.stdin.write("/");
    await tick();
    app.stdin.write("review");
    await tick();
    expect(app.lastFrame()).toContain("Editing search");
    app.stdin.write("\u001b");
    await tick();
    expect(app.lastFrame()).toContain("Results");
    expect(app.lastFrame()).not.toContain("Editing search");
    app.stdin.write("\u001b");
    await tick();
    expect(app.lastFrame()).toContain("1 skills");
    expect(app.lastFrame()).not.toContain("design-system");
    app.stdin.write("\r");
    await tick();
    expect(app.lastFrame()).toContain("Skill details");
    expect(app.lastFrame()).not.toContain("Ownership");
    app.stdin.write("\u001b");
    await tick();
    expect(app.lastFrame()).toContain("Results");
    expect(app.lastFrame()).toContain("1 skills");
  });
  it("opens the same complete details with i or Enter and exits before search", async () => {
    const app = mount();
    await tick();
    app.stdin.write("\r");
    await tick();
    expect(app.lastFrame()).toContain("Skill details");
    expect(app.lastFrame()).toContain("Last observed");
    app.stdin.write("\u001b");
    await tick();
    app.stdin.write("i");
    await tick();
    expect(app.lastFrame()).toContain("Last observed");
    app.stdin.write("/");
    await tick();
    app.stdin.write("design");
    await tick();
    app.stdin.write("\u001b[B");
    await tick();
    expect(app.lastFrame()).toContain("Results");
    expect(app.lastFrame()).not.toContain("Skill details");
    expect(app.lastFrame()).not.toContain("Editing search");
  });
  it("groups identical checkout facts and shows their paths without another mode", async () => {
    const inventory = inventoryFixture();
    inventory.projects[0]!.checkouts.push({
      path: "/workspace/other",
      skills: structuredClone(inventory.projects[0]!.checkouts[0]!.skills!),
    });
    const app = render(
      <SkilloomApp
        initialInventory={inventory}
        backend={backend()}
        width={120}
        height={36}
      />,
    );
    mounted.push(app);
    await tick();
    app.stdin.write("/");
    await tick();
    app.stdin.write("design");
    await tick();
    app.stdin.write("\r");
    await tick();
    app.stdin.write("\r");
    await tick();
    expect(app.lastFrame()).toContain("catalog (2 locations)");

    expect(app.lastFrame()).toContain("/workspace/catalog");
    expect(app.lastFrame()).toContain("/workspace/other");
  });
  it("cycles machines both ways, retaining a selected skill or falling back to the first", async () => {
    const app = mount();
    await tick();
    app.stdin.write("\u001b[B");
    await tick();
    expect(app.lastFrame()).toContain("› design-system");
    app.stdin.write("\u001b[C");
    await tick();
    expect(app.lastFrame()).toContain("‹ Workstation ›");
    expect(app.lastFrame()).toContain("› design-system");
    app.stdin.write("\u001b[C");
    await tick();
    expect(app.lastFrame()).toContain("‹ Studio ›");
    expect(app.lastFrame()).toContain("› remote-research");
    app.stdin.write("\u001b[C");
    await tick();
    expect(app.lastFrame()).toContain("‹ All machines ›");
    expect(app.lastFrame()).toContain("› remote-research");
    app.stdin.write("\u001b[D");
    await tick();
    expect(app.lastFrame()).toContain("‹ Studio ›");
    app.stdin.write("\r");
    await tick();
    app.stdin.write("\u001b[D");
    await tick();
    expect(app.lastFrame()).toContain("Studio");
    expect(app.lastFrame()).toContain("Skill details");
  });
  it("uses horizontal arrows for cursor editing during search without switching machines", async () => {
    const app = mount();
    await tick();
    app.stdin.write("/");
    await tick();
    app.stdin.write("co-review");
    await tick();
    for (let i = 0; i < 7; i++) {
      app.stdin.write("\u001b[D");
      await tick();
    }
    app.stdin.write("de");
    await tick();
    expect(app.lastFrame()).toContain("code▏-review");
    expect(app.lastFrame()).toContain("All machines");
    app.stdin.write("\u001b[C");
    await tick();
    app.stdin.write("\u007f");
    await tick();
    expect(app.lastFrame()).toContain("code▏review");
    app.stdin.write("\u001b");
    await tick();
    expect(app.lastFrame()).toContain("Search: codereview");
  });
  it.each([40, 100])(
    "starts a local sync directly from Library at %i columns and preserves remote browsing on cancel",
    async (width) => {
      const api = backend();
      const app = mount(width, api);
      await tick();
      expect(app.lastFrame()).toContain("s Sync Workstation");
      expect(app.lastFrame()).not.toContain("2 Machines");
      app.stdin.write("\u001b[D");
      await tick();
      expect(app.lastFrame()).toContain("Studio");
      expect(app.lastFrame()).toContain("s Sync Workstation");
      app.stdin.write("s");
      await tick();
      expect(api.execute).toHaveBeenCalledWith(
        ["sync", "--dry-run"],
        expect.any(Function),
      );
      expect(app.lastFrame()).toContain("Review local sync");
      app.stdin.write("\u001b");
      await tick();
      expect(app.lastFrame()).toContain("Results");
      expect(app.lastFrame()).toContain("remote-research");
      expect(app.lastFrame()).toContain("Studio");
      expect(api.execute).toHaveBeenCalledTimes(1);
    },
  );
  it("opens settings with arrows and Enter, cancels back to selection, and reverses tabs", async () => {
    const api = backend();
    const app = mount(40, api);
    await tick();
    app.stdin.write("3");
    await tick();
    expect(app.lastFrame()).toContain("› Workspace setup");
    app.stdin.write("\u001b[B");
    await tick();
    expect(app.lastFrame()).toContain("› Create a profile");
    app.stdin.write("\r");
    await tick();
    expect(app.lastFrame()).toContain("New profile");
    app.stdin.write("\u001b");
    await tick();
    expect(app.lastFrame()).toContain("› Create a profile");
    expect(api.execute).not.toHaveBeenCalled();
    app.stdin.write("\u001b[Z");
    await tick();
    expect(app.lastFrame()).toContain("Review sync");
    app.stdin.write("\u001b[Z");
    await tick();
    expect(app.lastFrame()).toContain("Results");
  });
  it("opens saved change details without applying, and Enter on Review sync obtains a fresh preview", async () => {
    const inventory = inventoryFixture();
    inventory.operations = [
      {
        kind: "add",
        skill: {
          name: "new-skill",
          source: "acme/new",
          scope: "global",
          agents: ["codex"],
        },
        reasons: ["profile"],
      },
    ];
    const api = backend();
    const app = render(
      <SkilloomApp
        initialInventory={inventory}
        backend={api}
        width={100}
        height={32}
      />,
    );
    mounted.push(app);
    await tick();
    app.stdin.write("2");
    await tick();
    expect(app.lastFrame()).toContain("› Review sync");
    app.stdin.write("\u001b[B");
    await tick();
    app.stdin.write("\r");
    await tick();
    expect(app.lastFrame()).toContain("Change details");
    expect(app.lastFrame()).toContain("acme/new");
    expect(api.execute).not.toHaveBeenCalled();
    app.stdin.write("\u001b");
    await tick();
    expect(app.lastFrame()).toContain("› Add new-skill");
    app.stdin.write("\u001b[A");
    await tick();
    app.stdin.write("\r");
    await tick();
    expect(api.execute).toHaveBeenCalledWith(
      ["sync", "--dry-run"],
      expect.any(Function),
    );
    app.stdin.write("\u001b");
    await tick();
    expect(app.lastFrame()).toContain("› Review sync");
    app.stdin.write("a");
    app.stdin.write("d");
    app.stdin.write("v");
    await tick();
    expect(api.execute).toHaveBeenCalledTimes(1);
    expect(app.lastFrame()).toContain("› Review sync");
  });
});
