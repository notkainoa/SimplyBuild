import path from "node:path";
import {
  UserCancelledError,
  UserFacingError,
  type CliOptions,
  type ProjectCandidate,
  type SchemeCandidate,
  type TargetCandidate,
} from "../types.js";
import { discoverProjects } from "../discovery/projects.js";
import { discoverSchemes } from "../discovery/schemes.js";
import { discoverTargets } from "../discovery/targets.js";
import { decideTargetFromQuery } from "../matching/targetMatcher.js";
import { createStateStore, type StateStore } from "../state/store.js";
import { createPromptApi, type PromptApi } from "../ui/prompts.js";
import { runPhysicalPipeline, runSimulatorPipeline } from "../runner/pipelines.js";
import { ensureXcodebuildmcpReady } from "../setup/xcodebuildmcpPrereq.js";

export interface RunSimplyBuildDependencies {
  cwd?: string;
  prompts?: PromptApi;
  stateStore?: StateStore;
  ensureXcodebuildmcpReady?: (prompts: PromptApi, verbose: boolean) => Promise<void>;
  discoverProjects?: (scanRoot: string) => Promise<ProjectCandidate[]>;
  discoverSchemes?: (container: ProjectCandidate) => Promise<SchemeCandidate[]>;
  discoverTargets?: () => Promise<TargetCandidate[]>;
  runSimulatorPipeline?: (
    ctx: { container: ProjectCandidate; scheme: string; target: TargetCandidate; verbose: boolean },
    prompts: PromptApi,
  ) => Promise<void>;
  runPhysicalPipeline?: (
    ctx: { container: ProjectCandidate; scheme: string; target: TargetCandidate; verbose: boolean },
    prompts: PromptApi,
  ) => Promise<void>;
}

function targetLabel(target: TargetCandidate): string {
  const kindLabel = target.kind === "physical" ? "Device" : "Simulator";
  const osPart = target.os ? ` - ${target.os}` : "";
  const statePart = target.state ? ` (${target.state})` : "";
  return `[${kindLabel}] ${target.name}${osPart}${statePart}`;
}

function sortTargetsForSelection(
  targets: TargetCandidate[],
  rememberedTargetId?: string,
): TargetCandidate[] {
  const copy = [...targets];
  copy.sort((a, b) => {
    const aRemembered = rememberedTargetId && a.id === rememberedTargetId ? 1 : 0;
    const bRemembered = rememberedTargetId && b.id === rememberedTargetId ? 1 : 0;
    if (aRemembered !== bRemembered) {
      return bRemembered - aRemembered;
    }

    if (a.kind !== b.kind) {
      return a.kind === "physical" ? -1 : 1;
    }

    if (a.kind === "simulator" && b.kind === "simulator") {
      const aBooted = a.isBooted ? 1 : 0;
      const bBooted = b.isBooted ? 1 : 0;
      if (aBooted !== bBooted) {
        return bBooted - aBooted;
      }
    }

    return a.name.localeCompare(b.name);
  });

  return copy;
}

function formatCandidateList<T>(
  values: T[],
  labelFor: (item: T) => string,
  maxItems = 8,
): string[] {
  if (values.length === 0) {
    return [];
  }

  const lines = values.slice(0, maxItems).map((item) => `- ${labelFor(item)}`);
  if (values.length > maxItems) {
    lines.push(`- ...and ${values.length - maxItems} more`);
  }
  return lines;
}

function formatDiscoverySuccessLabel(
  count: number,
  singularLabel: string,
  pluralLabel: string,
  emptyLabel: string,
): string {
  if (count === 0) {
    return emptyLabel;
  }

  if (count === 1) {
    return `Found 1 ${singularLabel}`;
  }

  return `Found ${count} ${pluralLabel}`;
}

async function discoverWithStage<T>(
  prompts: PromptApi,
  message: string,
  task: () => Promise<T[]>,
  labels: {
    singular: string;
    plural: string;
    empty: string;
  },
): Promise<T[]> {
  let successLabel = message;

  return prompts.stage(
    message,
    async () => {
      const results = await task();
      successLabel = formatDiscoverySuccessLabel(
        results.length,
        labels.singular,
        labels.plural,
        labels.empty,
      );
      return results;
    },
    {
      get success() {
        return successLabel;
      },
      error: message,
    },
  );
}

function projectKeyFromContainer(container: ProjectCandidate): string {
  return path.resolve(container.path);
}

function toTimestamp(value: string | undefined): number {
  if (!value) {
    return 0;
  }

  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

async function resolveRememberedContainerPath(
  candidates: ProjectCandidate[],
  stateStore: StateStore,
): Promise<string | undefined> {
  const withMemory = await Promise.all(
    candidates.map(async (candidate) => {
      const memory = await stateStore.getProjectMemory(projectKeyFromContainer(candidate));
      return {
        candidate,
        memory,
      };
    }),
  );

  withMemory.sort((a, b) => toTimestamp(b.memory?.updatedAt) - toTimestamp(a.memory?.updatedAt));
  return withMemory.find((entry) => entry.memory)?.candidate.path;
}

async function resolveProjectCandidates(
  startDir: string,
  prompts: PromptApi,
  discoverProjectsFn: (scanRoot: string) => Promise<ProjectCandidate[]>,
): Promise<ProjectCandidate[]> {
  let scanDir = path.resolve(startDir);
  let isParentSearch = false;

  while (true) {
    const message = isParentSearch ? "Loading parent projects" : "Loading projects";
    const emptyLabel = isParentSearch ? "No parent projects found" : "No projects found";
    const candidates = await discoverWithStage(
      prompts,
      message,
      async () => discoverProjectsFn(scanDir),
      {
        singular: "project",
        plural: "projects",
        empty: emptyLabel,
      },
    );
    if (candidates.length > 0) {
      return candidates;
    }

    const parentDir = path.dirname(scanDir);
    if (parentDir === scanDir) {
      throw new UserFacingError("No Xcode project or workspace found.");
    }

    if (!prompts.interactive) {
      throw new UserFacingError(
        "No Xcode project or workspace found in this directory.",
        [
          `Run from a folder containing .xcodeproj/.xcworkspace or use an interactive TTY to search parent directories.`,
        ],
      );
    }

    const shouldSearchParent = await prompts.confirm(
      "No Xcode project found here. Search parent directory?",
      true,
    );

    if (!shouldSearchParent) {
      throw new UserFacingError("No Xcode project selected.");
    }

    scanDir = parentDir;
    isParentSearch = true;
  }
}

async function pickProject(
  candidates: ProjectCandidate[],
  prompts: PromptApi,
  rememberedPath?: string,
): Promise<ProjectCandidate> {
  if (candidates.length === 1) {
    return candidates[0];
  }

  if (!prompts.interactive) {
    throw new UserFacingError(
      "Multiple Xcode containers found but interactive selection is unavailable.",
      formatCandidateList(candidates, (item) => `${item.kind}: ${item.path}`),
    );
  }

  const selectedPath = await prompts.select<string>(
    "Select project/workspace",
    candidates.map((candidate) => ({
      value: candidate.path,
      label: `${candidate.name} (${candidate.kind})`,
      hint: candidate.path,
    })),
    rememberedPath,
  );

  const selected = candidates.find((candidate) => candidate.path === selectedPath);
  if (!selected) {
    throw new UserFacingError("Unable to resolve selected project/workspace.");
  }

  return selected;
}

function matchSchemeName(input: string, schemes: SchemeCandidate[]): string | undefined {
  const exact = schemes.find((item) => item.name === input);
  if (exact) {
    return exact.name;
  }

  const caseInsensitive = schemes.find(
    (item) => item.name.toLowerCase() === input.toLowerCase(),
  );
  return caseInsensitive?.name;
}

async function resolveScheme(
  container: ProjectCandidate,
  explicitScheme: string | undefined,
  rememberedScheme: string | undefined,
  prompts: PromptApi,
  discoverSchemesFn: (container: ProjectCandidate) => Promise<SchemeCandidate[]>,
): Promise<string> {
  const schemes = await discoverWithStage(
    prompts,
    "Loading schemes",
    async () => discoverSchemesFn(container),
    {
      singular: "scheme",
      plural: "schemes",
      empty: "No schemes found",
    },
  );

  if (explicitScheme) {
    if (schemes.length === 0) {
      return explicitScheme;
    }

    const matched = matchSchemeName(explicitScheme, schemes);
    if (!matched) {
      throw new UserFacingError(
        `Scheme '${explicitScheme}' not found in selected ${container.kind}.`,
        formatCandidateList(schemes, (item) => item.name),
      );
    }

    return matched;
  }

  if (schemes.length === 0) {
    if (!prompts.interactive) {
      throw new UserFacingError(
        "No schemes discovered automatically.",
        ["Re-run in interactive mode to enter a scheme manually."],
      );
    }

    return prompts.text("No schemes discovered. Enter scheme name");
  }

  const nonTestSchemes = schemes.filter((scheme) => !scheme.isLikelyTestScheme);
  if (nonTestSchemes.length === 1) {
    return nonTestSchemes[0].name;
  }

  if (!prompts.interactive) {
    throw new UserFacingError(
      "Multiple schemes found but interactive selection is unavailable.",
      formatCandidateList(schemes, (item) => item.name),
    );
  }

  return prompts.select<string>(
    "Select scheme",
    schemes.map((scheme) => ({
      value: scheme.name,
      label: scheme.name,
      hint: scheme.isLikelyTestScheme ? "likely test scheme" : undefined,
    })),
    rememberedScheme,
  );
}

async function selectTargetInteractively(
  prompts: PromptApi,
  allTargets: TargetCandidate[],
  rememberedTargetId?: string,
  message = "Select target device/simulator",
): Promise<TargetCandidate> {
  if (!prompts.interactive) {
    throw new UserFacingError(
      "Target selection requires an interactive terminal.",
      formatCandidateList(allTargets, targetLabel),
    );
  }

  const sorted = sortTargetsForSelection(allTargets, rememberedTargetId);
  const selectedId = await prompts.select<string>(
    message,
    sorted.map((target) => ({
      value: target.id,
      label: targetLabel(target),
    })),
    rememberedTargetId,
  );

  const selected = sorted.find((target) => target.id === selectedId);
  if (!selected) {
    throw new UserFacingError("Unable to resolve selected target.");
  }

  return selected;
}

async function resolveTarget(
  options: CliOptions,
  allTargets: TargetCandidate[],
  rememberedTargetId: string | undefined,
  prompts: PromptApi,
): Promise<{ target: TargetCandidate; source: "interactive" | "query" | "explicit" }> {
  if (allTargets.length === 0) {
    throw new UserFacingError("No available devices or simulators were found.");
  }

  if (options.device) {
    const exactMatches = allTargets.filter(
      (target) => target.name.toLowerCase() === options.device?.toLowerCase(),
    );

    if (exactMatches.length === 1) {
      return { target: exactMatches[0], source: "explicit" };
    }

    if (exactMatches.length > 1) {
      const selected = await selectTargetInteractively(
        prompts,
        exactMatches,
        rememberedTargetId,
        "Multiple exact device matches found. Select target",
      );
      return { target: selected, source: "explicit" };
    }

    throw new UserFacingError(
      `No exact device/simulator match found for '${options.device}'.`,
      formatCandidateList(allTargets, targetLabel),
    );
  }

  if (options.query) {
    const decision = decideTargetFromQuery(options.query, allTargets);
    if (!decision.requiresInteractive && decision.selected) {
      return {
        target: decision.selected,
        source: "query",
      };
    }

    if (!prompts.interactive) {
      throw new UserFacingError(
        `Target query '${options.query}' requires interactive disambiguation.`,
        formatCandidateList(decision.ranked.map((item) => item.target), targetLabel),
      );
    }

    const selected = await selectTargetInteractively(
      prompts,
      allTargets,
      rememberedTargetId,
      `Select target for '${options.query}'`,
    );
    return { target: selected, source: "interactive" };
  }

  const selected = await selectTargetInteractively(prompts, allTargets, rememberedTargetId);
  return { target: selected, source: "interactive" };
}

export async function runSimplyBuild(
  options: CliOptions,
  deps: RunSimplyBuildDependencies = {},
): Promise<void> {
  const cwd = path.resolve(deps.cwd ?? process.cwd());
  const prompts = deps.prompts ?? createPromptApi();
  const stateStore = deps.stateStore ?? createStateStore();
  const ensureXcodebuildmcpReadyFn =
    deps.ensureXcodebuildmcpReady ?? ensureXcodebuildmcpReady;
  const discoverProjectsFn = deps.discoverProjects ?? discoverProjects;
  const discoverSchemesFn = deps.discoverSchemes ?? discoverSchemes;
  const discoverTargetsFn = deps.discoverTargets ?? discoverTargets;
  const runSimulator = deps.runSimulatorPipeline ?? runSimulatorPipeline;
  const runPhysical = deps.runPhysicalPipeline ?? runPhysicalPipeline;

  await ensureXcodebuildmcpReadyFn(prompts, options.verbose);

  if (options.listProjects) {
    const projects = await discoverWithStage(
      prompts,
      "Loading projects",
      async () => discoverProjectsFn(cwd),
      {
        singular: "project",
        plural: "projects",
        empty: "No projects found",
      },
    );
    if (projects.length === 0) {
      console.log("No Xcode projects/workspaces found.");
      return;
    }

    for (const project of projects) {
      console.log(`${project.kind}: ${project.path}`);
    }
    return;
  }

  if (options.listDevices) {
    const targets = await discoverWithStage(
      prompts,
      "Loading devices and simulators",
      async () => discoverTargetsFn(),
      {
        singular: "device or simulator",
        plural: "devices and simulators",
        empty: "No devices or simulators found",
      },
    );
    if (targets.length === 0) {
      console.log("No available devices/simulators found.");
      return;
    }

    for (const target of sortTargetsForSelection(targets)) {
      console.log(`${targetLabel(target)} :: ${target.id}`);
    }
    return;
  }

  if (!options.query && !options.device && !prompts.interactive) {
    throw new UserFacingError(
      "Interactive target selection requires a TTY.",
      ["Use `simplybuild --device \"Exact Name\"` or `simplybuild \"query\"` in non-interactive environments."],
    );
  }

  prompts.intro("simplybuild");

  try {
    const candidates = await resolveProjectCandidates(cwd, prompts, discoverProjectsFn);
    const rememberedContainerPath = await resolveRememberedContainerPath(
      candidates,
      stateStore,
    );
    const selectedContainer = await pickProject(
      candidates,
      prompts,
      rememberedContainerPath,
    );

    const projectKey = projectKeyFromContainer(selectedContainer);
    const projectMemory = await stateStore.getProjectMemory(projectKey);

    const scheme = await resolveScheme(
      selectedContainer,
      options.scheme,
      projectMemory?.lastScheme,
      prompts,
      discoverSchemesFn,
    );

    const allTargets = await discoverWithStage(
      prompts,
      "Loading devices and simulators",
      async () => discoverTargetsFn(),
      {
        singular: "device or simulator",
        plural: "devices and simulators",
        empty: "No devices or simulators found",
      },
    );
    const { target } = await resolveTarget(
      options,
      allTargets,
      projectMemory?.lastTarget?.id,
      prompts,
    );

    if (target.kind === "physical") {
      const isApproved = await stateStore.isPhysicalDeviceApproved(projectKey, target.id);
      if (!isApproved) {
        if (!prompts.interactive) {
          throw new UserFacingError(
            `First physical deployment to ${target.name} requires confirmation in an interactive terminal.`,
          );
        }

        const approved = await prompts.confirm(
          `First deploy to ${target.name} for this project. Continue?`,
          true,
        );

        if (!approved) {
          throw new UserCancelledError("Physical deployment not approved.");
        }

        await stateStore.markPhysicalDeviceApproved(projectKey, target.id);
      }
    }

    const context = {
      container: selectedContainer,
      scheme,
      target,
      verbose: options.verbose,
    };

    if (target.kind === "simulator") {
      await runSimulator(context, prompts);
    } else {
      await runPhysical(context, prompts);
    }

    await stateStore.setProjectContext(projectKey, {
      containerPath: selectedContainer.path,
      containerKind: selectedContainer.kind,
      scheme,
      target: {
        kind: target.kind,
        id: target.id,
        name: target.name,
      },
    });

    prompts.outro(`Build and launch complete: ${scheme} -> ${target.name}`);
  } catch (error) {
    if (error instanceof UserCancelledError) {
      throw error;
    }

    throw error;
  }
}
