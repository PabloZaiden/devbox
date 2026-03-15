import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse as parseJsonc } from "jsonc-parser/lib/esm/main.js";
import type { ParseError } from "jsonc-parser";
import {
  CLI_NAME,
  DEFAULT_UP_AUTO_PORT_START,
  DOCKER_DESKTOP_SSH_AUTH_SOCK_SOURCE,
  KNOWN_HOSTS_TARGET,
  LEGACY_GENERATED_CONFIG_BASENAME,
  MANAGED_LABEL_KEY,
  SSH_AUTH_SOCK_TARGET,
  STATE_VERSION,
  WORKSPACE_LABEL_KEY,
} from "./constants";

export type CommandName = "up" | "down" | "rebuild" | "shell" | "help";

export interface ParsedArgs {
  command: CommandName;
  port?: number;
  allowMissingSsh: boolean;
  devcontainerSubpath?: string;
}

export type DevcontainerConfig = Record<string, unknown>;

export interface DiscoveredConfig {
  path: string;
  config: DevcontainerConfig;
}

export interface ManagedConfigOptions {
  port: number;
  containerName: string;
  sshAuthSock: string | null;
  knownHostsPath: string | null;
  githubTokenAvailable?: boolean;
}

export interface WorkspaceState {
  version: number;
  workspacePath: string;
  workspaceHash: string;
  port: number;
  sourceConfigPath: string;
  generatedConfigPath: string;
  labels: Record<string, string>;
  userDataDir: string;
  lastContainerId?: string;
  updatedAt: string;
}

export interface UpResult {
  outcome: string;
  containerId: string;
  remoteUser?: string;
  remoteWorkspaceFolder?: string;
}

export interface DockerInspect {
  Id: string;
  Name?: string;
  Config?: {
    Labels?: Record<string, string>;
  };
  State?: {
    Running?: boolean;
    Status?: string;
  };
  NetworkSettings?: {
    Ports?: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null>;
  };
}

export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserError";
  }
}

export function helpText(): string {
  return `${CLI_NAME} - manage a devcontainer plus ssh-server-runner\n\nUsage:\n  ${CLI_NAME}\n  ${CLI_NAME} up [port] [--allow-missing-ssh] [--devcontainer-subpath <subpath>]\n  ${CLI_NAME} rebuild [port] [--allow-missing-ssh] [--devcontainer-subpath <subpath>]\n  ${CLI_NAME} shell\n  ${CLI_NAME} down [--devcontainer-subpath <subpath>]\n  ${CLI_NAME} help\n  ${CLI_NAME} --help\n\nCommands:\n  up       Start or reuse the managed devcontainer.\n  rebuild  Recreate the managed devcontainer.\n  shell    Open an interactive shell in the running managed container.\n  down     Stop and remove the managed container for this workspace.\n  help     Show this help.\n\nOptions:\n  -p, --port <port>             Publish the same port on host and container.\n  --allow-missing-ssh           Continue without SSH agent sharing when unavailable.\n  --devcontainer-subpath <path> Use .devcontainer/<path>/devcontainer.json.\n  -h, --help                    Show this help.\n\nNotes:\n  - Running ${CLI_NAME} with no arguments shows this help.\n  - The same port is published on host and container.\n  - \`${CLI_NAME} up\` uses the explicit port when provided, otherwise reuses the last stored port for the workspace, otherwise auto-assigns the first free port starting at ${DEFAULT_UP_AUTO_PORT_START}.\n  - \`${CLI_NAME} rebuild\` reuses the last stored port for the workspace when no port is provided.\n  - ${CLI_NAME} shell opens an interactive shell in the running managed container for this workspace.\n  - Only image/Dockerfile-based devcontainers are supported in v1.`;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const args = [...argv];

  if (args.length === 0) {
    return { command: "help", allowMissingSsh: false };
  }

  let command: CommandName;
  const first = args[0];

  if (first === "up" || first === "down" || first === "rebuild" || first === "shell") {
    command = first;
    args.shift();
  } else if (first === "help") {
    return { command: "help", allowMissingSsh: false };
  } else if (first === "--help" || first === "-h") {
    return { command: "help", allowMissingSsh: false };
  } else {
    throw new UserError(`A command is required. Run \`${CLI_NAME} --help\` for usage.`);
  }

  let port: number | undefined;
  let allowMissingSsh = false;
  let devcontainerSubpath: string | undefined;
  const positionals: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--help" || arg === "-h") {
      return { command: "help", allowMissingSsh: false };
    }

    if (arg === "--allow-missing-ssh") {
      allowMissingSsh = true;
      continue;
    }

    if (arg === "--devcontainer-subpath") {
      const value = args[index + 1];
      if (!value) {
        throw new UserError("Expected a value after --devcontainer-subpath.");
      }
      devcontainerSubpath = parseDevcontainerSubpath(value);
      index += 1;
      continue;
    }

    if (arg.startsWith("--devcontainer-subpath=")) {
      devcontainerSubpath = parseDevcontainerSubpath(arg.slice("--devcontainer-subpath=".length));
      continue;
    }

    if (arg === "--port" || arg === "-p") {
      const value = args[index + 1];
      if (!value) {
        throw new UserError("Expected a value after --port.");
      }
      port = parsePort(value);
      index += 1;
      continue;
    }

    if (arg.startsWith("--port=")) {
      port = parsePort(arg.slice("--port=".length));
      continue;
    }

    if (arg.startsWith("-")) {
      throw new UserError(`Unknown option: ${arg}`);
    }

    positionals.push(arg);
  }

  if (positionals.length > 1) {
    throw new UserError(`Unexpected extra argument: ${positionals[1]}`);
  }

  if (positionals[0]) {
    if (command === "down") {
      throw new UserError("The down command does not accept a port.");
    }
    if (command === "shell") {
      throw new UserError("The shell command does not accept a port.");
    }
    port = parsePort(positionals[0]);
  }

  if (command === "down" && port !== undefined) {
    throw new UserError("The down command does not accept a port.");
  }

  if (command === "shell" && port !== undefined) {
    throw new UserError("The shell command does not accept a port.");
  }

  if (command === "shell" && devcontainerSubpath !== undefined) {
    throw new UserError("The shell command does not accept --devcontainer-subpath.");
  }

  if (devcontainerSubpath) {
    return { command, port, allowMissingSsh, devcontainerSubpath };
  }

  return { command, port, allowMissingSsh };
}

export function parsePort(raw: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new UserError(`Invalid port: ${raw}`);
  }

  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new UserError(`Port must be between 1 and 65535. Received: ${raw}`);
  }

  return port;
}

export function hashWorkspacePath(workspacePath: string): string {
  return createHash("sha256").update(workspacePath).digest("hex").slice(0, 16);
}

export function getManagedLabels(workspaceHash: string): Record<string, string> {
  return {
    [MANAGED_LABEL_KEY]: "true",
    [WORKSPACE_LABEL_KEY]: workspaceHash,
  };
}

export function getStateRoot(): string {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", CLI_NAME);
  }

  const xdgStateHome = process.env.XDG_STATE_HOME;
  if (xdgStateHome) {
    return path.join(xdgStateHome, CLI_NAME);
  }

  return path.join(os.homedir(), ".local", "state", CLI_NAME);
}

export function getWorkspaceStateDir(workspacePath: string): string {
  return path.join(getStateRoot(), "workspaces", hashWorkspacePath(workspacePath));
}

export function getWorkspaceStateFile(workspacePath: string): string {
  return path.join(getWorkspaceStateDir(workspacePath), "state.json");
}

export function getWorkspaceUserDataDir(workspacePath: string): string {
  return path.join(getWorkspaceStateDir(workspacePath), "user-data");
}

export function getDefaultRemoteWorkspaceFolder(workspacePath: string): string {
  return path.posix.join("/workspaces", path.basename(workspacePath));
}

export function getManagedContainerName(workspacePath: string, port: number): string {
  const projectName = path.basename(workspacePath);
  const normalized = projectName
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .replace(/-+/g, "-");
  const safeProjectName = normalized.length > 0 ? normalized : hashWorkspacePath(workspacePath);

  return `devbox-${safeProjectName.slice(0, 48)}-${port}`;
}

export function getManagedPortFromContainerName(containerName: string | undefined): number | undefined {
  if (!containerName) {
    return undefined;
  }

  const normalizedName = containerName.replace(/^\//, "");
  if (!normalizedName.startsWith("devbox-")) {
    return undefined;
  }

  const match = normalizedName.match(/-(\d+)$/);
  if (!match) {
    return undefined;
  }

  const port = Number(match[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return undefined;
  }

  return port;
}

export async function loadWorkspaceState(workspacePath: string): Promise<WorkspaceState | null> {
  const statePath = getWorkspaceStateFile(workspacePath);
  if (!existsSync(statePath)) {
    return null;
  }

  const raw = await readFile(statePath, "utf8");
  const parsed = JSON.parse(raw) as Partial<WorkspaceState>;

  if (
    parsed.version !== STATE_VERSION ||
    typeof parsed.workspacePath !== "string" ||
    typeof parsed.workspaceHash !== "string" ||
    typeof parsed.port !== "number" ||
    typeof parsed.generatedConfigPath !== "string" ||
    typeof parsed.sourceConfigPath !== "string" ||
    typeof parsed.userDataDir !== "string" ||
    !parsed.labels ||
    typeof parsed.labels !== "object"
  ) {
    throw new UserError(`State file is invalid: ${statePath}`);
  }

  return parsed as WorkspaceState;
}

export async function saveWorkspaceState(state: WorkspaceState): Promise<void> {
  const stateDir = getWorkspaceStateDir(state.workspacePath);
  await mkdir(stateDir, { recursive: true });
  await writeFile(getWorkspaceStateFile(state.workspacePath), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export async function deleteWorkspaceState(workspacePath: string): Promise<void> {
  await rm(getWorkspaceStateDir(workspacePath), { recursive: true, force: true });
}

export function resolvePort(command: CommandName, explicitPort: number | undefined, state: WorkspaceState | null): number {
  if (command === "down" || command === "shell" || command === "help") {
    throw new UserError(`resolvePort cannot be used for ${command}.`);
  }

  if (explicitPort !== undefined) {
    return explicitPort;
  }

  if (state) {
    return state.port;
  }

  throw new UserError(
    `No port was provided and no previous port is stored for this workspace. Run \`${CLI_NAME} up <port>\` first.`,
  );
}

export function resolveUpPortPreference(input: {
  explicitPort: number | undefined;
  state: WorkspaceState | null;
  existingPublishedPort?: number;
}): number | undefined {
  if (input.explicitPort !== undefined) {
    return input.explicitPort;
  }

  if (input.state) {
    return input.state.port;
  }

  return input.existingPublishedPort;
}

export function describeUpPortStrategy(): string {
  return `Reuse the previous workspace port when available, otherwise auto-assign the first free port starting at ${DEFAULT_UP_AUTO_PORT_START}.`;
}

export async function discoverDevcontainerConfig(
  workspacePath: string,
  devcontainerSubpath?: string,
): Promise<DiscoveredConfig> {
  const candidates = getDevcontainerCandidates(workspacePath, devcontainerSubpath);

  for (const candidate of candidates) {
    if (!existsSync(candidate)) {
      continue;
    }

    const content = await readFile(candidate, "utf8");
    const errors: ParseError[] = [];
    const parsed = parseJsonc(content, errors, {
      allowTrailingComma: true,
      disallowComments: false,
    });

    if (errors.length > 0) {
      const details = errors.map((error) => `${error.error}@${error.offset}`).join(", ");
      throw new UserError(`Could not parse ${candidate} as JSONC (${details}).`);
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new UserError(`${candidate} must contain a JSON object.`);
    }

    const config = parsed as DevcontainerConfig;
    validateSupportedDevcontainerConfig(config);

    return { path: candidate, config };
  }

  const expectedLocations = devcontainerSubpath
    ? `.devcontainer/${formatDevcontainerSubpath(devcontainerSubpath)}/devcontainer.json`
    : ".devcontainer/devcontainer.json or .devcontainer.json";

  throw new UserError(
    `No devcontainer definition was found in ${workspacePath}. Expected ${expectedLocations}.`,
  );
}

export function validateSupportedDevcontainerConfig(config: DevcontainerConfig): void {
  if (config.dockerComposeFile !== undefined) {
    throw new UserError("dockerComposeFile-based devcontainers are not supported in v1.");
  }

  const hasImage = typeof config.image === "string" && config.image.trim().length > 0;
  const hasDockerFile = typeof config.dockerFile === "string" && config.dockerFile.trim().length > 0;
  const build = asRecord(config.build);
  const hasBuildDockerfile = typeof build?.dockerfile === "string" && build.dockerfile.trim().length > 0;

  if (!hasImage && !hasDockerFile && !hasBuildDockerfile) {
    throw new UserError("Only image- or Dockerfile-based devcontainers are supported in v1.");
  }
}

export function getGeneratedConfigPath(sourceConfigPath: string): string {
  const sourceBasename = path.basename(sourceConfigPath);

  if (sourceBasename === "devcontainer.json") {
    return path.join(path.dirname(sourceConfigPath), ".devcontainer.json");
  }

  if (sourceBasename === ".devcontainer.json") {
    return path.join(path.dirname(sourceConfigPath), "devcontainer.json");
  }

  throw new UserError(
    `Unsupported devcontainer config filename: ${sourceConfigPath}. Expected devcontainer.json or .devcontainer.json.`,
  );
}

export function getLegacyGeneratedConfigPath(sourceConfigPath: string): string {
  return path.join(path.dirname(sourceConfigPath), LEGACY_GENERATED_CONFIG_BASENAME);
}

export async function writeManagedConfig(generatedConfigPath: string, config: DevcontainerConfig): Promise<void> {
  await mkdir(path.dirname(generatedConfigPath), { recursive: true });
  await writeFile(generatedConfigPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export async function removeGeneratedConfig(generatedConfigPath: string): Promise<void> {
  await rm(generatedConfigPath, { force: true });
}

export function buildManagedConfig(baseConfig: DevcontainerConfig, options: ManagedConfigOptions): DevcontainerConfig {
  const managedConfig = structuredClone(baseConfig);
  const runArgs = withManagedContainerName(getStringArray(managedConfig.runArgs, "runArgs"), options.containerName);
  if (!hasPublishedPort(runArgs, options.port)) {
    runArgs.push("-p", `${options.port}:${options.port}`);
  }
  managedConfig.runArgs = runArgs;

  const containerSshAuthSock = getContainerSshAuthSockPath(options.sshAuthSock);
  const mounts = getStringArray(managedConfig.mounts, "mounts");
  if (options.sshAuthSock && containerSshAuthSock) {
    mounts.push(`type=bind,source=${options.sshAuthSock},target=${containerSshAuthSock}`);
  }
  if (options.knownHostsPath) {
    mounts.push(`type=bind,source=${options.knownHostsPath},target=${KNOWN_HOSTS_TARGET},readonly`);
  }
  managedConfig.mounts = dedupe(mounts);

  const containerEnv = getStringRecord(managedConfig.containerEnv, "containerEnv");
  if (containerSshAuthSock) {
    containerEnv.SSH_AUTH_SOCK = containerSshAuthSock;
  }
  if (options.githubTokenAvailable) {
    containerEnv.GH_TOKEN = "${localEnv:GH_TOKEN}";
  }
  managedConfig.containerEnv = containerEnv;

  return managedConfig;
}

export function createWorkspaceState(input: {
  workspacePath: string;
  port: number;
  sourceConfigPath: string;
  generatedConfigPath: string;
  userDataDir: string;
  labels: Record<string, string>;
  containerId?: string;
}): WorkspaceState {
  return {
    version: STATE_VERSION,
    workspacePath: input.workspacePath,
    workspaceHash: hashWorkspacePath(input.workspacePath),
    port: input.port,
    sourceConfigPath: input.sourceConfigPath,
    generatedConfigPath: input.generatedConfigPath,
    labels: input.labels,
    userDataDir: input.userDataDir,
    lastContainerId: input.containerId,
    updatedAt: new Date().toISOString(),
  };
}

export async function getKnownHostsPath(): Promise<string | null> {
  const candidate = path.join(os.homedir(), ".ssh", "known_hosts");
  try {
    await access(candidate);
    return candidate;
  } catch {
    return null;
  }
}

export function quoteShell(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

export function getContainerSshAuthSockPath(sshAuthSock: string | null): string | null {
  if (!sshAuthSock) {
    return null;
  }

  return sshAuthSock === DOCKER_DESKTOP_SSH_AUTH_SOCK_SOURCE ? DOCKER_DESKTOP_SSH_AUTH_SOCK_SOURCE : SSH_AUTH_SOCK_TARGET;
}

function parseDevcontainerSubpath(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new UserError("Devcontainer subpath cannot be empty.");
  }

  if (path.isAbsolute(trimmed) || trimmed.startsWith("\\")) {
    throw new UserError(`Devcontainer subpath must stay inside .devcontainer. Received: ${raw}`);
  }

  const segments = trimmed.split(/[\\/]+/u).filter((segment) => segment.length > 0);
  if (segments.length === 0 || segments.some((segment) => segment === "." || segment === "..")) {
    throw new UserError(`Devcontainer subpath must stay inside .devcontainer. Received: ${raw}`);
  }

  return path.join(...segments);
}

function getDevcontainerCandidates(workspacePath: string, devcontainerSubpath?: string): string[] {
  if (devcontainerSubpath) {
    return [path.join(workspacePath, ".devcontainer", devcontainerSubpath, "devcontainer.json")];
  }

  return [
    path.join(workspacePath, ".devcontainer", "devcontainer.json"),
    path.join(workspacePath, ".devcontainer.json"),
  ];
}

function formatDevcontainerSubpath(subpath: string): string {
  return subpath.split(path.sep).join("/");
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function withManagedContainerName(runArgs: string[], containerName: string): string[] {
  const next: string[] = [];

  for (let index = 0; index < runArgs.length; index += 1) {
    const current = runArgs[index];

    if (current === "--name") {
      index += 1;
      continue;
    }

    if (current.startsWith("--name=")) {
      continue;
    }

    next.push(current);
  }

  next.push("--name", containerName);
  return next;
}

function hasPublishedPort(runArgs: string[], port: number): boolean {
  const expected = `${port}:${port}`;

  for (let index = 0; index < runArgs.length; index += 1) {
    const current = runArgs[index];
    const next = runArgs[index + 1];

    if ((current === "-p" || current === "--publish") && next === expected) {
      return true;
    }

    if (current.startsWith("-p") && current.slice(2) === expected) {
      return true;
    }

    if (current.startsWith("--publish=") && current.slice("--publish=".length) === expected) {
      return true;
    }
  }

  return false;
}

function getStringArray(value: unknown, fieldName: string): string[] {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new UserError(`${fieldName} must be an array of strings.`);
  }

  return [...value];
}

function getStringRecord(value: unknown, fieldName: string): Record<string, string> {
  if (value === undefined) {
    return {};
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new UserError(`${fieldName} must be an object with string values.`);
  }

  const entries = Object.entries(value);
  if (entries.some(([, entryValue]) => typeof entryValue !== "string")) {
    throw new UserError(`${fieldName} must be an object with string values.`);
  }

  return Object.fromEntries(entries) as Record<string, string>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}
