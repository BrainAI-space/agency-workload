export const requiredSchedulePaths = Object.freeze([
  "/api/v1/planning/settings",
  "/api/v1/people",
  "/api/v1/projects",
  "/api/v1/allocations",
  "/api/v1/schedule",
]);

export function createNetworkState() {
  return {
    completions: new Map(),
    evidence: [],
    responseFailures: 0,
    transportFailures: 0,
  };
}

export function appendBoundedNetworkEvidence(evidence, item, maximum = 100) {
  if (!Number.isSafeInteger(maximum) || maximum < 1) {
    throw new Error("Browser smoke evidence bound is invalid");
  }
  evidence.push(item);
  if (evidence.length > maximum) evidence.splice(0, evidence.length - maximum);
}

export function recordApiResponse(state, item, maximum = 100) {
  appendBoundedNetworkEvidence(state.evidence, item, maximum);
  if (item.status < 200 || item.status >= 300) {
    state.responseFailures = Math.min(999, state.responseFailures + 1);
    return;
  }
  if (item.method !== "GET" || item.status !== 200) return;
  state.completions.set(item.path, Math.min(999, (state.completions.get(item.path) ?? 0) + 1));
}

export function recordApiTransportFailure(state) {
  state.transportFailures = Math.min(999, state.transportFailures + 1);
}

export function assertNetworkHealthy(state) {
  if (state.responseFailures > 0) {
    throw new Error("Browser smoke observed an API response failure");
  }
  if (state.transportFailures > 0) {
    throw new Error("Browser smoke observed an API transport failure");
  }
}

export function completionSnapshot(state, paths) {
  return new Map(paths.map((path) => [path, state.completions.get(path) ?? 0]));
}

export function assertDestinationRequestsCompleted(state, paths, baseline) {
  for (const path of paths) {
    if ((state.completions.get(path) ?? 0) <= (baseline.get(path) ?? 0)) {
      throw new Error("Browser smoke destination GET did not complete with status 200");
    }
  }
}
