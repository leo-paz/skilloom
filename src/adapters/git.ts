import { spawn } from "node:child_process";

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class GitExecutionError extends Error {
  override readonly name = "GitExecutionError";
}

function runGit(args: string[], cwd?: string): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

async function requireGit(args: string[], cwd?: string): Promise<GitResult> {
  let result: GitResult;
  try {
    result = await runGit(args, cwd);
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

  async pull(path: string): Promise<void> {
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
    await requireGit(["pull", "--ff-only"], path);
  }

  async commitAndPush(path: string, message: string): Promise<void> {
    await requireGit(["add", "--", "config.yaml"], path);
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
