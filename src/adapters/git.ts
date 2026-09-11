import { spawn } from "node:child_process";
import { abortProcessGroup } from "./process.js";

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class GitExecutionError extends Error {
  override readonly name = "GitExecutionError";
}

function runGit(
  args: string[],
  cwd?: string,
  signal?: AbortSignal,
): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      signal,
      detached: Boolean(signal) && process.platform !== "win32",
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stopped = abortProcessGroup(child, signal);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    let failure: Error | undefined;
    child.once("error", (error) => {
      failure = error;
    });
    child.once("close", (code) => {
      void stopped().then(() => {
        if (failure) reject(failure);
        else resolve({ code: code ?? 1, stdout, stderr });
      });
    });
  });
}

async function requireGit(
  args: string[],
  cwd?: string,
  signal?: AbortSignal,
): Promise<GitResult> {
  let result: GitResult;
  try {
    result = await runGit(args, cwd, signal);
  } catch (error) {
    throw new GitExecutionError(
      `git ${args[0] ?? "command"} failed to start: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (result.code !== 0) {
    throw new GitExecutionError(
      `git ${args[0] ?? "command"} failed with exit ${result.code}: ${result.stderr.trim()}`,
    );
  }
  return result;
}

export class GitAdapter {
  async initBare(path: string): Promise<void> {
    await requireGit(["init", "--bare", path]);
  }

  async clone(repository: string, destination: string): Promise<void> {
    if (/^https?:\/\//i.test(repository)) {
      let parsed: URL;
      try {
        parsed = new URL(repository);
      } catch {
        throw new Error("repository URL is invalid");
      }
      if (
        parsed.username ||
        parsed.password ||
        [...parsed.searchParams.keys()].some((key) =>
          /(token|secret|password|key)/i.test(key),
        )
      ) {
        throw new Error(
          "repository URL must not contain credentials or access tokens",
        );
      }
    }
    await requireGit(["clone", repository, destination]);
  }

  async status(path: string): Promise<string> {
    return (await requireGit(["status", "--porcelain"], path)).stdout;
  }

  async pull(path: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if ((await this.status(path)).trim()) {
      throw new Error(
        "managed configuration has uncommitted changes; resolve them before pulling",
      );
    }
    const branch = (
      await requireGit(["branch", "--show-current"], path)
    ).stdout.trim();
    if (!branch)
      throw new Error("managed configuration checkout has no branch");
    await requireGit(["pull", "--ff-only"], path, signal);
  }

  /** Only this newly-created observation commit may be replayed after a race. */
  async commitObservationAndPush(
    path: string,
    message: string,
    file: string,
  ): Promise<void> {
    if (!/^observations\/[a-zA-Z0-9_-]+\.json$/.test(file))
      throw new GitExecutionError(
        "observation publication requires one machine observation file",
      );
    const dirty = (
      await requireGit(
        ["status", "--porcelain", "-z", "--untracked-files=all"],
        path,
      )
    ).stdout;
    if (
      dirty
        .split("\0")
        .filter(Boolean)
        .some((entry) => entry.slice(3) !== file)
    )
      throw new GitExecutionError(
        "managed configuration has unrelated uncommitted changes; preserve and resolve them before publishing",
      );
    await requireGit(["add", "--", file], path);
    const changes = (
      await requireGit(["diff", "--cached", "--name-only"], path)
    ).stdout.trim();
    if (!changes) return;
    await requireGit(
      [
        "-c",
        "user.name=Skilloom",
        "-c",
        "user.email=skilloom@localhost",
        "commit",
        "-m",
        message,
        "--",
        file,
      ],
      path,
    );
    let ownCommit = (
      await requireGit(["rev-parse", "HEAD"], path)
    ).stdout.trim();
    for (let attempt = 0; attempt < 3; attempt++) {
      const push = await runGit(["push", "-u", "origin", "HEAD"], path);
      if (push.code === 0) return;
      const recovery =
        "Observation is committed locally. Inspect git status and the branch divergence in the managed checkout, resolve it, then git push; installation does not need to be repeated.";
      if (
        attempt === 2 ||
        !/non-fast-forward|fetch first|rejected/.test(push.stderr)
      )
        throw new GitExecutionError(
          `Observation publication failed: ${push.stderr.trim()} ${recovery}`,
        );
      await requireGit(["fetch", "origin"], path);
      const upstream = (
        await requireGit(["rev-parse", "--abbrev-ref", "@{upstream}"], path)
      ).stdout.trim();
      const local = (
        await requireGit(["rev-list", `${upstream}..HEAD`], path)
      ).stdout.trim();
      if (!local) return; // A previous push reached the remote despite a transport error.
      if (local !== ownCommit || (await this.status(path)).trim())
        throw new GitExecutionError(
          `Publication cannot retry with other local commits or changes. ${recovery}`,
        );
      const rebase = await runGit(
        [
          "-c",
          "user.name=Skilloom",
          "-c",
          "user.email=skilloom@localhost",
          "rebase",
          upstream,
        ],
        path,
      );
      if (rebase.code !== 0) {
        await requireGit(["rebase", "--abort"], path);
        throw new GitExecutionError(
          `Observation conflicts with remote changes; automatic retry stopped. ${recovery}`,
        );
      }
      ownCommit = (await requireGit(["rev-parse", "HEAD"], path)).stdout.trim();
    }
  }

  async commitAndPush(
    path: string,
    message: string,
    files: string[] = ["config.yaml"],
  ): Promise<void> {
    await requireGit(["add", "--", ...files], path);
    if (!(await this.status(path)).trim()) return;
    await requireGit(
      [
        "-c",
        "user.name=Skilloom",
        "-c",
        "user.email=skilloom@localhost",
        "commit",
        "-m",
        message,
      ],
      path,
    );
    await requireGit(["push", "-u", "origin", "HEAD"], path);
  }
}
