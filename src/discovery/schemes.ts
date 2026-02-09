import type { ProjectCandidate, SchemeCandidate } from "../types.js";
import { runCommand } from "../runner/commandRunner.js";

function parseJsonObject(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }

  try {
    return JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function parseSchemesFromText(raw: string): string[] {
  const match = raw.match(/Schemes:([\s\S]*?)(\n\n|$)/);
  if (!match) {
    return [];
  }

  return match[1]
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function isLikelyTestScheme(name: string): boolean {
  return /(^|[-_\s])(tests?|uitests?|snapshot)([-_\s]|$)/i.test(name);
}

export async function discoverSchemes(container: ProjectCandidate): Promise<SchemeCandidate[]> {
  const args = ["-list", "-json"];
  if (container.kind === "workspace") {
    args.push("-workspace", container.path);
  } else {
    args.push("-project", container.path);
  }

  const jsonResult = await runCommand("xcodebuild", args);
  let schemes: string[] = [];

  if (jsonResult.ok) {
    const parsed = parseJsonObject(jsonResult.stdout || jsonResult.stderr);
    if (parsed) {
      const rootObj =
        (parsed.workspace as Record<string, unknown> | undefined) ??
        (parsed.project as Record<string, unknown> | undefined);
      const schemeValues = rootObj?.schemes;
      if (Array.isArray(schemeValues)) {
        schemes = schemeValues.filter((s): s is string => typeof s === "string");
      }
    }
  }

  if (schemes.length === 0) {
    const fallbackArgs = ["-list"];
    if (container.kind === "workspace") {
      fallbackArgs.push("-workspace", container.path);
    } else {
      fallbackArgs.push("-project", container.path);
    }

    const textResult = await runCommand("xcodebuild", fallbackArgs);
    schemes = parseSchemesFromText(`${textResult.stdout}\n${textResult.stderr}`);
  }

  return schemes
    .map((name) => ({
      name,
      isLikelyTestScheme: isLikelyTestScheme(name),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
