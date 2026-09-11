import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

vi.mock("ink", async (original) => ({
  ...(await original<typeof import("ink")>()),
  render: () => {
    throw new Error("render failed");
  },
}));

import { runProcess } from "../src/adapters/skills.js";
import { runDashboard } from "../src/tui/dashboard.js";

it("restores the terminal when rendering throws synchronously", async () => {
  const home = await mkdtemp(join(tmpdir(), "skilloom-render-failure-"));
  const writes: string[] = [];
  const write = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
  try {
    await expect(
      runDashboard(
        {
          cwd: home,
          env: { HOME: home },
          isTTY: true,
          stdout: () => {},
          stderr: () => {},
          run: runProcess,
          confirm: async () => false,
        },
        async () => 0,
      ),
    ).rejects.toThrow("render failed");
  } finally {
    write.mockRestore();
  }
  expect(writes).toContain("\u001b[?1049h\u001b[?25l");
  expect(writes).toContain("\u001b[?25h\u001b[?1049l");
});
