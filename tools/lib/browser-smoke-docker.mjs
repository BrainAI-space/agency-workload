const dockerControlPattern = /^(?:DOCKER|COMPOSE)_/i;

function inheritedValue(environment, key) {
  const value = environment[key];
  return typeof value === "string" && value ? value : undefined;
}

export function assertDockerEndpointOverridesSafe(environment) {
  for (const key of ["DOCKER_HOST", "DOCKER_CONTEXT"]) {
    if (inheritedValue(environment, key)) {
      throw new Error(`Browser smoke refuses the ${key} Docker endpoint override`);
    }
  }
}

export function dockerContextInspectInvocation() {
  return {
    command: "docker",
    args: ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"],
  };
}

export function dockerResourceListInvocation(resource, composeProject) {
  if (!/^[a-z0-9][a-z0-9_-]{0,127}$/.test(composeProject)) {
    throw new Error("Docker Compose project label is invalid");
  }
  const filter = `label=com.docker.compose.project=${composeProject}`;
  if (resource === "container") {
    return {
      command: "docker",
      args: ["ps", "--all", "--filter", filter, "--format", "{{.ID}}"],
    };
  }
  if (resource === "network") {
    return {
      command: "docker",
      args: ["network", "ls", "--filter", filter, "--format", "{{.ID}}"],
    };
  }
  if (resource === "volume") {
    return {
      command: "docker",
      args: ["volume", "ls", "--filter", filter, "--format", "{{.Name}}"],
    };
  }
  throw new Error("Docker resource type is not allowlisted");
}

export function assertLocalDockerEndpoint(endpoint, platform) {
  if (typeof endpoint !== "string" || endpoint !== endpoint.trim() || /[\s\0]/.test(endpoint)) {
    throw new Error("Docker context endpoint is malformed");
  }
  if (platform === "win32") {
    if (!/^npipe:\/\/\/\/\.\/pipe\/[A-Za-z0-9._-]+$/.test(endpoint)) {
      throw new Error("Docker context endpoint is not a local Windows named pipe");
    }
    return;
  }
  let parsed;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error("Docker context endpoint is malformed");
  }
  if (
    parsed.protocol !== "unix:" ||
    parsed.hostname ||
    !parsed.pathname.startsWith("/") ||
    parsed.pathname.includes("..") ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("Docker context endpoint is not a local POSIX socket");
  }
}

export function assertNoDockerControls(environment) {
  const forbidden = Object.keys(environment).filter((key) => dockerControlPattern.test(key));
  if (forbidden.length > 0)
    throw new Error("Non-Docker child environment contains Docker controls");
}
