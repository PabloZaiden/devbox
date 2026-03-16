import { readFile as readFileFromFs } from "node:fs/promises";
import path from "node:path";
import { parse as parseJsonc } from "jsonc-parser/lib/esm/main.js";
import type { ParseError } from "jsonc-parser";
import {
  type DockerInspect,
  type WorkspaceState,
  getDefaultRemoteWorkspaceFolder,
  getManagedLabels,
  getManagedPortFromContainerName,
  getWorkspaceStateFile,
  hashWorkspacePath,
  loadWorkspaceState,
} from "./core";
import { DEVBOX_SSH_METADATA_FILENAME, RUNNER_CRED_FILENAME } from "./constants";
import { parseRunnerCredentials, parseRunnerMetadata, type RunnerCredentials, type RunnerMetadata } from "./runnerState";
import { formatCommandError, inspectContainers, isCommandError, isExecutableAvailable, listManagedContainers } from "./runtime";

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
  hasSshMetadataFile: boolean;
  sshMetadataPath: string;
  sourceConfigPath: string | null;
  generatedConfigPath: string | null;
  userDataDir: string | null;
  updatedAt: string | null;
  warnings: string[];
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
  isDockerAvailable?: () => boolean;
}

interface OptionalParsedFile<T> {
  exists: boolean;
  value: T | null;
}

export async function getDevboxStatus(
  input: {
    workspacePath: string;
    state?: WorkspaceState | null;
    warnings?: string[];
  },
  deps: StatusDependencies = {},
): Promise<DevboxStatus> {
  const loadState = deps.loadWorkspaceState ?? loadWorkspaceState;
  const readFile = deps.readFile ?? defaultReadFile;
  const listContainers = deps.listManagedContainers ?? listManagedContainers;
  const inspect = deps.inspectContainers ?? inspectContainers;
  const isDockerAvailable = deps.isDockerAvailable ?? (() => isExecutableAvailable("docker"));

  const state = input.state === undefined ? await loadState(input.workspacePath) : input.state;
  const workspaceHash = state?.workspaceHash ?? hashWorkspacePath(input.workspacePath);
  const labels = state?.labels ?? getManagedLabels(workspaceHash);
  const warnings = [...(input.warnings ?? [])];
  const containers = await loadManagedContainers({
    inspect,
    isDockerAvailable,
    labels,
    listContainers,
    warnings,
  });
  const primaryContainer = selectPrimaryContainer(containers, state?.lastContainerId);

  if (containers.length > 1) {
    warnings.push(`Found ${containers.length} managed containers for this workspace; reporting the preferred container.`);
  }

  const credentialPath = path.join(input.workspacePath, RUNNER_CRED_FILENAME);
  const credentialFile = await readRunnerCredentialsFile(credentialPath, readFile);
  const sshMetadataPath = path.join(input.workspacePath, DEVBOX_SSH_METADATA_FILENAME);
  const sshMetadataFile = await readRunnerMetadataFile(sshMetadataPath, readFile, warnings);
  const configHints = await readConfigHints({
    readFile,
    sourceConfigPath: state?.sourceConfigPath ?? null,
    warnings,
    workspacePath: input.workspacePath,
  });
  const publishedPorts = getPublishedPorts(primaryContainer);
  const configuredSshPort =
    state?.port
    ?? sshMetadataFile.value?.sshPort
    ?? credentialFile.value?.sshPort
    ?? getManagedPortFromContainerName(primaryContainer?.Name)
    ?? null;
  const effectivePort = configuredSshPort === null
    ? firstPublishedHostPort(publishedPorts)
    : getPublishedHostPortForPort(publishedPorts, configuredSshPort) ?? configuredSshPort;
  const sshUser = sshMetadataFile.value?.sshUser ?? credentialFile.value?.user ?? null;
  const permitRootLogin = sshMetadataFile.value?.permitRootLogin ?? credentialFile.value?.permitRootLogin ?? null;
  const password = credentialFile.value?.password ?? null;
  appendMissingDataWarnings({
    warnings,
    credentialFile,
    credentialPath,
    password,
    sshMetadataFile,
    sshMetadataPath,
    sshUser,
    sshPort: configuredSshPort,
    permitRootLogin,
    remoteUser: configHints.remoteUser,
  });

  return {
    running: Boolean(primaryContainer?.State?.Running),
    port: effectivePort,
    password,
    workdir: configHints.workdir ?? getDefaultRemoteWorkspaceFolder(input.workspacePath),
    workdirSource: configHints.workdirSource,
    workspacePath: input.workspacePath,
    workspaceHash,
    containerId: primaryContainer?.Id ?? null,
    containerName: normalizeContainerName(primaryContainer?.Name),
    containerState: primaryContainer?.State?.Status ?? null,
    containerCount: containers.length,
    lastContainerId: state?.lastContainerId ?? null,
    sshUser,
    sshPort: configuredSshPort,
    permitRootLogin,
    remoteUser: configHints.remoteUser,
    labels,
    publishedPorts,
    hasStateFile: state !== null,
    statePath: getWorkspaceStateFile(input.workspacePath),
    hasCredentialFile: credentialFile.exists,
    credentialPath,
    hasSshMetadataFile: sshMetadataFile.exists,
    sshMetadataPath,
    sourceConfigPath: state?.sourceConfigPath ?? configHints.sourceConfigPath,
    generatedConfigPath: state?.generatedConfigPath ?? null,
    userDataDir: state?.userDataDir ?? null,
    updatedAt: state?.updatedAt ?? null,
    warnings,
  };
}

async function readRunnerCredentialsFile(
  credentialPath: string,
  readFile: (filePath: string) => Promise<string>,
): Promise<OptionalParsedFile<RunnerCredentials>> {
  const content = await readOptionalTextFile(credentialPath, readFile);
  if (content === null) {
    return { exists: false, value: null };
  }

  return {
    exists: true,
    value: parseRunnerCredentials(content),
  };
}

async function readRunnerMetadataFile(
  sshMetadataPath: string,
  readFile: (filePath: string) => Promise<string>,
  warnings: string[],
): Promise<OptionalParsedFile<RunnerMetadata>> {
  const content = await readOptionalTextFile(sshMetadataPath, readFile);
  if (content === null) {
    return { exists: false, value: null };
  }

  try {
    return {
      exists: true,
      value: parseRunnerMetadata(content),
    };
  } catch (error) {
    warnings.push(
      `Could not parse devbox SSH metadata file: ${sshMetadataPath}. ` +
      `Error: ${formatErrorMessage(error)}; ` +
      "`sshUser`, `sshPort`, and `permitRootLogin` may be unavailable.",
    );
    return {
      exists: true,
      value: null,
    };
  }
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
      continue;
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      input.warnings.push(`Devcontainer config for status hints was not a JSON object: ${candidate}.`);
      continue;
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

function appendMissingDataWarnings(input: {
  warnings: string[];
  credentialFile: OptionalParsedFile<RunnerCredentials>;
  credentialPath: string;
  password: string | null;
  sshMetadataFile: OptionalParsedFile<RunnerMetadata>;
  sshMetadataPath: string;
  sshUser: string | null;
  sshPort: number | null;
  permitRootLogin: boolean | null;
  remoteUser: string | null;
}): void {
  if (!input.credentialFile.exists) {
    input.warnings.push(`Runner password file was not found: ${input.credentialPath}. \`password\` is unavailable.`);
  } else if (input.password === null) {
    input.warnings.push(
      `Runner password file was present but did not contain a usable password: ${input.credentialPath}. \`password\` is unavailable.`,
    );
  }

  if (!input.sshMetadataFile.exists) {
    const unavailableFields = [
      input.sshUser === null ? "sshUser" : null,
      input.sshPort === null ? "sshPort" : null,
      input.permitRootLogin === null ? "permitRootLogin" : null,
    ].filter((field): field is string => field !== null);
    if (unavailableFields.length > 0) {
      input.warnings.push(
        `Devbox SSH metadata file was not found: ${input.sshMetadataPath}. ` +
        `${formatUnavailableFields(unavailableFields)} Start the workspace again with this devbox version to persist them.`,
      );
    }
  } else if (input.sshMetadataFile.value !== null) {
    const unavailableFields = [
      input.sshMetadataFile.value.sshUser === null && input.sshUser === null ? "sshUser" : null,
      input.sshMetadataFile.value.sshPort === null && input.sshPort === null ? "sshPort" : null,
      input.sshMetadataFile.value.permitRootLogin === null && input.permitRootLogin === null ? "permitRootLogin" : null,
    ].filter((field): field is string => field !== null);
    if (unavailableFields.length > 0) {
      input.warnings.push(
        `Devbox SSH metadata file is missing ${formatFieldList(unavailableFields)}: ${input.sshMetadataPath}.`,
      );
    }
  }

  if (input.remoteUser === null) {
    input.warnings.push(
      "`remoteUser` is unavailable because the devcontainer config does not set `remoteUser` or `containerUser`.",
    );
  }
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

async function loadManagedContainers(input: {
  isDockerAvailable: () => boolean;
  labels: Record<string, string>;
  listContainers: (labels: Record<string, string>) => Promise<string[]>;
  inspect: (containerIds: string[]) => Promise<DockerInspect[]>;
  warnings: string[];
}): Promise<DockerInspect[]> {
  if (!input.isDockerAvailable()) {
    input.warnings.push("Docker was not found in PATH; reporting saved workspace state and persisted SSH files only.");
    return [];
  }

  try {
    const containerIds = await input.listContainers(input.labels);
    return await input.inspect(containerIds);
  } catch (error) {
    if (isCommandError(error)) {
      input.warnings.push(
        `Docker status lookup failed; reporting saved workspace state and persisted SSH files only. ${formatCommandError(error)}`,
      );
      return [];
    }
    throw error;
  }
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

function getPublishedHostPortForPort(
  publishedPorts: Record<string, DevboxStatusPortBinding[]>,
  port: number,
): number | null {
  const bindings = publishedPorts[`${port}/tcp`] ?? [];
  for (const binding of bindings) {
    if (binding.hostPort !== null) {
      return binding.hostPort;
    }
  }

  return null;
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

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return "Unknown parse error.";
}

function formatUnavailableFields(fields: string[]): string {
  return `${formatFieldList(fields)} ${fields.length === 1 ? "is" : "are"} unavailable.`;
}

function formatFieldList(fields: string[]): string {
  if (fields.length === 1) {
    return `\`${fields[0]}\``;
  }
  if (fields.length === 2) {
    return `\`${fields[0]}\` and \`${fields[1]}\``;
  }
  return `${fields.slice(0, -1).map((field) => `\`${field}\``).join(", ")}, and \`${fields[fields.length - 1]}\``;
}
