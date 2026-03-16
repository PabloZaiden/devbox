import { readFile as readFileFromFs } from "node:fs/promises";
import path from "node:path";
import { parse as parseJsonc } from "jsonc-parser/lib/esm/main.js";
import type { ParseError } from "jsonc-parser";
import {
  type DockerInspect,
  type WorkspaceState,
  getDefaultRemoteWorkspaceFolder,
  getManagedLabels,
  getWorkspaceStateFile,
  hashWorkspacePath,
  loadWorkspaceState,
} from "./core";
import { RUNNER_CRED_FILENAME } from "./constants";
import { inspectContainers, listManagedContainers } from "./runtime";

export interface DevboxStatusPortBinding {
  hostIp: string | null;
  hostPort: number | null;
}

export interface DevboxStatus {
  running: boolean;
  port: number | null;
  password: string | null;
  workdir: string;
  workdirSource: "config" | "default";
  workspacePath: string;
  workspaceHash: string;
  containerId: string | null;
  containerName: string | null;
  containerState: string | null;
  containerCount: number;
  lastContainerId: string | null;
  sshUser: string | null;
  sshPort: number | null;
  permitRootLogin: boolean | null;
  remoteUser: string | null;
  labels: Record<string, string>;
  publishedPorts: Record<string, DevboxStatusPortBinding[]>;
  hasStateFile: boolean;
  statePath: string;
  hasCredentialFile: boolean;
  credentialPath: string;
  sourceConfigPath: string | null;
  generatedConfigPath: string | null;
  userDataDir: string | null;
  updatedAt: string | null;
  warnings: string[];
}

export interface RunnerCredentials {
  user: string | null;
  password: string | null;
  sshPort: number | null;
  permitRootLogin: boolean | null;
}

interface ConfigHints {
  remoteUser: string | null;
  sourceConfigPath: string | null;
  workdir: string | null;
  workdirSource: "config" | "default";
}

interface StatusDependencies {
  inspectContainers?: (containerIds: string[]) => Promise<DockerInspect[]>;
  listManagedContainers?: (labels: Record<string, string>) => Promise<string[]>;
  loadWorkspaceState?: (workspacePath: string) => Promise<WorkspaceState | null>;
  readFile?: (filePath: string) => Promise<string>;
}

export async function getDevboxStatus(
  input: {
    workspacePath: string;
    state?: WorkspaceState | null;
  },
  deps: StatusDependencies = {},
): Promise<DevboxStatus> {
  const loadState = deps.loadWorkspaceState ?? loadWorkspaceState;
  const readFile = deps.readFile ?? defaultReadFile;
  const listContainers = deps.listManagedContainers ?? listManagedContainers;
  const inspect = deps.inspectContainers ?? inspectContainers;

  const state = input.state === undefined ? await loadState(input.workspacePath) : input.state;
  const workspaceHash = state?.workspaceHash ?? hashWorkspacePath(input.workspacePath);
  const labels = state?.labels ?? getManagedLabels(workspaceHash);
  const containerIds = await listContainers(labels);
  const containers = await inspect(containerIds);
  const warnings: string[] = [];
  const primaryContainer = selectPrimaryContainer(containers, state?.lastContainerId);

  if (containers.length > 1) {
    warnings.push(`Found ${containers.length} managed containers for this workspace; reporting the preferred container.`);
  }

  const credentialPath = path.join(input.workspacePath, RUNNER_CRED_FILENAME);
  const credentials = await readRunnerCredentialsFile(credentialPath, readFile);
  const configHints = await readConfigHints({
    readFile,
    sourceConfigPath: state?.sourceConfigPath ?? null,
    warnings,
    workspacePath: input.workspacePath,
  });
  const publishedPorts = getPublishedPorts(primaryContainer);
  const effectivePort = firstPublishedHostPort(publishedPorts) ?? state?.port ?? credentials?.sshPort ?? null;

  return {
    running: Boolean(primaryContainer?.State?.Running),
    port: effectivePort,
    password: credentials?.password ?? null,
    workdir: configHints.workdir ?? getDefaultRemoteWorkspaceFolder(input.workspacePath),
    workdirSource: configHints.workdirSource,
    workspacePath: input.workspacePath,
    workspaceHash,
    containerId: primaryContainer?.Id ?? state?.lastContainerId ?? null,
    containerName: normalizeContainerName(primaryContainer?.Name),
    containerState: primaryContainer?.State?.Status ?? null,
    containerCount: containers.length,
    lastContainerId: state?.lastContainerId ?? null,
    sshUser: credentials?.user ?? null,
    sshPort: credentials?.sshPort ?? null,
    permitRootLogin: credentials?.permitRootLogin ?? null,
    remoteUser: configHints.remoteUser,
    labels,
    publishedPorts,
    hasStateFile: state !== null,
    statePath: getWorkspaceStateFile(input.workspacePath),
    hasCredentialFile: credentials !== null,
    credentialPath,
    sourceConfigPath: state?.sourceConfigPath ?? configHints.sourceConfigPath,
    generatedConfigPath: state?.generatedConfigPath ?? null,
    userDataDir: state?.userDataDir ?? null,
    updatedAt: state?.updatedAt ?? null,
    warnings,
  };
}

export function parseRunnerCredentials(content: string): RunnerCredentials {
  const lines = content.split(/\r?\n/);
  const map = new Map<string, string>();

  for (const line of lines) {
    const match = line.match(/^(SSH user|SSH pass|SSH port|PermitRootLogin):\s*(.*)$/);
    if (!match) {
      continue;
    }
    map.set(match[1], match[2]);
  }

  const portValue = map.get("SSH port");
  const parsedPort = portValue && /^\d+$/.test(portValue) ? Number(portValue) : null;
  const permitRootLogin = parsePermitRootLogin(map.get("PermitRootLogin") ?? null);

  return {
    user: map.get("SSH user") ?? null,
    password: map.get("SSH pass") ?? null,
    sshPort: Number.isInteger(parsedPort) ? parsedPort : null,
    permitRootLogin,
  };
}

function parsePermitRootLogin(value: string | null): boolean | null {
  if (!value) {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "yes") {
    return true;
  }
  if (normalized === "no") {
    return false;
  }
  return null;
}

async function readRunnerCredentialsFile(
  credentialPath: string,
  readFile: (filePath: string) => Promise<string>,
): Promise<RunnerCredentials | null> {
  const content = await readOptionalTextFile(credentialPath, readFile);
  if (content === null) {
    return null;
  }

  return parseRunnerCredentials(content);
}

async function readConfigHints(input: {
  workspacePath: string;
  sourceConfigPath: string | null;
  readFile: (filePath: string) => Promise<string>;
  warnings: string[];
}): Promise<ConfigHints> {
  const defaultWorkdir = getDefaultRemoteWorkspaceFolder(input.workspacePath);
  const candidates = [
    input.sourceConfigPath,
    path.join(input.workspacePath, ".devcontainer", "devcontainer.json"),
    path.join(input.workspacePath, ".devcontainer.json"),
  ].filter((candidate, index, values): candidate is string => Boolean(candidate) && values.indexOf(candidate) === index);

  for (const candidate of candidates) {
    const content = await readOptionalTextFile(candidate, input.readFile);
    if (content === null) {
      continue;
    }

    const errors: ParseError[] = [];
    const parsed = parseJsonc(content, errors, {
      allowTrailingComma: true,
      disallowComments: false,
    });

    if (errors.length > 0) {
      input.warnings.push(`Could not parse devcontainer config for status hints: ${candidate}.`);
      break;
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      input.warnings.push(`Devcontainer config for status hints was not a JSON object: ${candidate}.`);
      break;
    }

    const config = parsed as Record<string, unknown>;
    const configuredWorkdir = typeof config.workspaceFolder === "string" && config.workspaceFolder.trim().length > 0
      ? config.workspaceFolder
      : null;
    const remoteUser = typeof config.remoteUser === "string" && config.remoteUser.trim().length > 0
      ? config.remoteUser
      : typeof config.containerUser === "string" && config.containerUser.trim().length > 0
        ? config.containerUser
        : null;

    return {
      remoteUser,
      sourceConfigPath: candidate,
      workdir: configuredWorkdir ?? defaultWorkdir,
      workdirSource: configuredWorkdir ? "config" : "default",
    };
  }

  return {
    remoteUser: null,
    sourceConfigPath: input.sourceConfigPath,
    workdir: defaultWorkdir,
    workdirSource: "default",
  };
}

async function readOptionalTextFile(
  filePath: string,
  readFile: (filePath: string) => Promise<string>,
): Promise<string | null> {
  try {
    return await readFile(filePath);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function defaultReadFile(filePath: string): Promise<string> {
  return readFileFromFs(filePath, "utf8");
}

function selectPrimaryContainer(
  containers: DockerInspect[],
  preferredContainerId: string | undefined,
): DockerInspect | null {
  if (preferredContainerId) {
    const preferred = containers.find((container) => container.Id === preferredContainerId);
    if (preferred) {
      return preferred;
    }
  }

  return containers.find((container) => container.State?.Running) ?? containers[0] ?? null;
}

function normalizeContainerName(name: string | undefined): string | null {
  if (!name) {
    return null;
  }
  return name.replace(/^\//, "");
}

function getPublishedPorts(container: DockerInspect | null): Record<string, DevboxStatusPortBinding[]> {
  if (!container) {
    return {};
  }

  const ports = container.NetworkSettings?.Ports ?? {};
  const publishedPorts: Record<string, DevboxStatusPortBinding[]> = {};

  for (const [containerPort, bindings] of Object.entries(ports)) {
    publishedPorts[containerPort] = (bindings ?? []).map((binding) => ({
      hostIp: binding?.HostIp ?? null,
      hostPort: binding?.HostPort && /^\d+$/.test(binding.HostPort) ? Number(binding.HostPort) : null,
    }));
  }

  return publishedPorts;
}

function firstPublishedHostPort(publishedPorts: Record<string, DevboxStatusPortBinding[]>): number | null {
  for (const bindings of Object.values(publishedPorts)) {
    for (const binding of bindings) {
      if (binding.hostPort !== null) {
        return binding.hostPort;
      }
    }
  }

  return null;
}
