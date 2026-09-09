import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  discoverBackfill,
  newBackfillState,
} from "../src/core/usage-backfill.js";

it("restarts an interrupted directory after churn without duplicating pending paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "usage-discovery-"));
  try {
    for (const name of ["a", "b", "c", "d"])
      await writeFile(join(root, `${name}.jsonl`), "{}\n");
    const before = await lstat(root);
    const state = newBackfillState([{ path: root, harness: "claude" }]);
    state.queue[0] = {
      ...state.queue[0]!,
      skip: 3,
      identity: `${before.dev}:${before.ino}`,
      modified: before.mtimeMs,
    };
    const pending = join(root, "c.jsonl"),
      info = await lstat(pending);
    state.pending.push({
      path: pending,
      harness: "claude",
      identity: `${info.dev}:${info.ino}`,
      size: info.size,
      modified: info.mtimeMs,
    });
    state.filesDiscovered = 1;
    await rm(join(root, "a.jsonl"));
    await writeFile(join(root, "new.jsonl"), "{}\n");
    await utimes(root, new Date(), new Date(before.mtimeMs + 2000));
    await discoverBackfill(state, () => false);
    expect(state.queue).toEqual([]);
    expect(state.skipped).toContain("directory_changed");
    expect(state.pending.map((file) => file.path).sort()).toEqual(
      (await readdir(root)).map((name) => join(root, name)).sort(),
    );
    expect(state.filesDiscovered).toBe(4);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("resumes a large interrupted directory after churn without omitting entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "usage-discovery-mid-"));
  try {
    for (let i = 0; i < 55; i++)
      await writeFile(join(root, `${i}.jsonl`), "{}\n");
    const state = newBackfillState([{ path: root, harness: "pi" }]);
    await discoverBackfill(state, () => false);
    expect(state.pending).toHaveLength(48);
    expect(state.queue[0]?.skip).toBe(48);
    const seen = new Set(state.pending.map((file) => file.path));
    const before = await lstat(root);
    await writeFile(join(root, "new.jsonl"), "{}\n");
    await utimes(root, new Date(), new Date(before.mtimeMs + 2000));
    for (let pass = 0; pass < 4 && state.queue.length; pass++) {
      state.pending = [];
      await discoverBackfill(state, () => false);
      for (const file of state.pending) seen.add(file.path);
    }
    expect(state.queue).toEqual([]);
    expect(seen.size).toBe(56);
    expect(state.skipped).toContain("directory_changed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("shares the first batch across harnesses and borrows capacity only after smaller roots finish", async () => {
  const root = await mkdtemp(join(tmpdir(), "usage-discovery-fair-"));
  try {
    const roots = (["codex", "claude", "pi"] as const).map((harness) => ({
      path: join(root, harness),
      harness,
    }));
    for (const { path, harness } of roots) {
      await mkdir(path);
      const count = harness === "codex" ? 90 : 2;
      for (let i = 0; i < count; i++)
        await writeFile(join(path, `${i}.jsonl`), "{}\n");
    }
    const state = newBackfillState(roots);
    await discoverBackfill(state, () => false);
    expect(
      state.pending.filter((file) => file.harness === "claude"),
    ).toHaveLength(2);
    expect(state.pending.filter((file) => file.harness === "pi")).toHaveLength(
      2,
    );
    expect(
      state.pending.filter((file) => file.harness === "codex"),
    ).toHaveLength(44);
    expect(state.queue.map((item) => item.harness)).toEqual(["codex"]);

    // All three large roots must instead retain an equal share without looping.
    for (const { path, harness } of roots.filter(
      (item) => item.harness !== "codex",
    )) {
      for (let i = 2; i < 60; i++)
        await writeFile(join(path, `${i}.jsonl`), "{}\n");
    }
    const balanced = newBackfillState(roots);
    await discoverBackfill(balanced, () => false);
    for (const harness of ["codex", "claude", "pi"])
      expect(
        balanced.pending.filter((file) => file.harness === harness),
      ).toHaveLength(16);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
