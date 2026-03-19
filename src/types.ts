export type ContainerKind = "workspace" | "project";
export type TargetKind = "physical" | "simulator";

export interface ProjectCandidate {
  kind: ContainerKind;
  path: string;
  name: string;
}

export interface SchemeCandidate {
  name: string;
  isLikelyTestScheme: boolean;
}

export interface TargetCandidate {
  kind: TargetKind;
  id: string;
  aliases?: string[];
  name: string;
  os: string;
  state: string;
  connectionState?: "connected" | "paired_disconnected" | "unpaired" | "unknown";
  isBooted?: boolean;
}

export interface ResolvedContext {
  container: ProjectCandidate;
  scheme: string;
  target: TargetCandidate;
  source: "interactive" | "query" | "explicit";
}

export interface CliOptions {
  query?: string;
  device?: string;
  scheme?: string;
  listDevices: boolean;
  listProjects: boolean;
  verbose: boolean;
  help: boolean;
}

export interface CommandResult {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
}

export interface CommandRunOptions {
  cwd?: string;
  verbose?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface ProjectMemory {
  lastSelectedContainerPath?: string;
  containerKind?: ContainerKind;
  lastScheme?: string;
  lastTarget?: {
    kind: TargetKind;
    id: string;
    name: string;
  };
  approvedPhysicalDeviceIds: string[];
  updatedAt: string;
}

export interface StateFile {
  version: 1;
  projects: Record<string, ProjectMemory>;
}

export class UserFacingError extends Error {
  public readonly details?: string[];

  constructor(message: string, details?: string[]) {
    super(message);
    this.name = "UserFacingError";
    this.details = details;
  }
}

export class UserCancelledError extends Error {
  constructor(message = "Operation cancelled") {
    super(message);
    this.name = "UserCancelledError";
  }
}

export const MATCHING_THRESHOLDS = {
  closeMatch: 0.72,
  ambiguityDelta: 0.08,
  physicalPreferenceWindow: 0.03,
} as const;
