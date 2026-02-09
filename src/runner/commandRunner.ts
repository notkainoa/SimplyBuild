import { spawn } from "node:child_process";
import type { CommandResult, CommandRunOptions } from "../types.js";

export async function runCommand(
  command: string,
  args: string[],
  options: CommandRunOptions = {},
): Promise<CommandResult> {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: options.verbose ? "inherit" : "pipe",
  });

  if (options.verbose) {
    return new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => {
        resolve({
          ok: code === 0,
          code: code ?? 1,
          stdout: "",
          stderr: "",
        });
      });
    });
  }

  let stdout = "";
  let stderr = "";

  child.stdout?.on("data", (chunk) => {
    stdout += String(chunk);
  });

  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });

  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        ok: code === 0,
        code: code ?? 1,
        stdout,
        stderr,
      });
    });
  });
}
