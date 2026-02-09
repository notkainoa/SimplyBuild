import type { CommandResult } from "../types.js";
import { runCommand } from "./commandRunner.js";

export interface XcodebuildMcpResponse {
  text: string;
  isError: boolean;
  json: Record<string, unknown> | null;
}

export interface ToolCommandResult extends CommandResult {
  response: XcodebuildMcpResponse;
}

function mergeTextContent(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }

  const textBlocks = content
    .filter((entry): entry is { type?: string; text?: string } => {
      return Boolean(entry && typeof entry === "object");
    })
    .filter((entry) => entry.type === "text" && typeof entry.text === "string")
    .map((entry) => entry.text ?? "");

  return textBlocks.join("\n\n").trim();
}

export function parseXcodebuildMcpOutput(stdout: string): XcodebuildMcpResponse {
  try {
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    const text = mergeTextContent(parsed.content);
    const isError = parsed.isError === true;
    return {
      text,
      isError,
      json: parsed,
    };
  } catch {
    return {
      text: stdout.trim(),
      isError: false,
      json: null,
    };
  }
}

function withStandardToolOptions(args: string[]): string[] {
  const hasOutput = args.includes("--output");
  const hasStyle = args.includes("--style");
  const merged = [...args];
  if (!hasOutput) {
    merged.push("--output", "json");
  }
  if (!hasStyle) {
    merged.push("--style", "minimal");
  }
  return merged;
}

export async function runXcodebuildmcpTool(
  args: string[],
  options: { cwd?: string; verbose?: boolean } = {},
): Promise<ToolCommandResult> {
  const result = await runCommand("xcodebuildmcp", withStandardToolOptions(args), options);
  const response = parseXcodebuildMcpOutput(result.stdout);

  return {
    ...result,
    response,
  };
}
