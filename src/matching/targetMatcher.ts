import { MATCHING_THRESHOLDS, type TargetCandidate } from "../types.js";

export interface RankedTarget {
  target: TargetCandidate;
  score: number;
}

export interface QueryMatchDecision {
  selected?: TargetCandidate;
  ranked: RankedTarget[];
  requiresInteractive: boolean;
  reason:
    | "no-targets"
    | "below-threshold"
    | "ambiguous"
    | "selected"
    | "selected-physical-preference";
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function normalizeMatchString(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ");
  return compactWhitespace(normalized);
}

function tokenize(value: string): string[] {
  const normalized = normalizeMatchString(value);
  if (!normalized) {
    return [];
  }
  return normalized.split(" ").filter(Boolean);
}

function tokenOverlapScore(query: string, candidate: string): number {
  const queryTokens = new Set(tokenize(query));
  const candidateTokens = new Set(tokenize(candidate));
  if (queryTokens.size === 0 || candidateTokens.size === 0) {
    return 0;
  }

  let matches = 0;
  for (const token of queryTokens) {
    if (candidateTokens.has(token)) {
      matches += 1;
    }
  }

  const union = new Set([...queryTokens, ...candidateTokens]).size;
  return union === 0 ? 0 : matches / union;
}

export function scoreTarget(query: string, target: TargetCandidate): number {
  const q = normalizeMatchString(query);
  const candidate = normalizeMatchString(target.name);

  if (!q || !candidate) {
    return 0;
  }

  const exact = q === candidate ? 1 : 0;
  const prefix = candidate.startsWith(q) || q.startsWith(candidate) ? 0.9 : 0;
  const substring = candidate.includes(q) || q.includes(candidate) ? 0.82 : 0;
  const tokenOverlap = tokenOverlapScore(q, candidate);

  return Math.max(exact, prefix, substring, tokenOverlap);
}

function sortRanked(a: RankedTarget, b: RankedTarget): number {
  if (a.score !== b.score) {
    return b.score - a.score;
  }
  if (a.target.kind !== b.target.kind) {
    return a.target.kind === "physical" ? -1 : 1;
  }
  return a.target.name.localeCompare(b.target.name);
}

export function rankTargets(query: string, targets: TargetCandidate[]): RankedTarget[] {
  return targets
    .map((target) => ({ target, score: scoreTarget(query, target) }))
    .sort(sortRanked);
}

export function decideTargetFromQuery(query: string, targets: TargetCandidate[]): QueryMatchDecision {
  const ranked = rankTargets(query, targets);
  if (ranked.length === 0) {
    return {
      ranked,
      requiresInteractive: true,
      reason: "no-targets",
    };
  }

  const top = ranked[0];
  const second = ranked[1];

  if (top.score < MATCHING_THRESHOLDS.closeMatch) {
    return {
      ranked,
      requiresInteractive: true,
      reason: "below-threshold",
    };
  }

  const bestPhysical = ranked.find((entry) => entry.target.kind === "physical");
  const bestSimulator = ranked.find((entry) => entry.target.kind === "simulator");

  if (bestPhysical && bestSimulator) {
    const delta = Math.abs(bestPhysical.score - bestSimulator.score);
    if (delta <= MATCHING_THRESHOLDS.physicalPreferenceWindow) {
      return {
        ranked,
        selected: bestPhysical.target,
        requiresInteractive: false,
        reason: "selected-physical-preference",
      };
    }
  }

  if (second && top.score - second.score < MATCHING_THRESHOLDS.ambiguityDelta) {
    return {
      ranked,
      requiresInteractive: true,
      reason: "ambiguous",
    };
  }

  return {
    ranked,
    selected: top.target,
    requiresInteractive: false,
    reason: "selected",
  };
}
