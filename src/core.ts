import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { access, chmod, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse as parseJsonc } from "jsonc-parser/lib/esm/main.js";
import type { ParseError } from "jsonc-parser";
import pkg from "../package.json";
import {
  CLI_NAME,
  DEFAULT_UP_AUTO_PORT_START,
  DOCKER_DESKTOP_SSH_AUTH_SOCK_SOURCE,
  KNOWN_HOSTS_SNAPSHOT_FILENAME,
  LEGACY_GENERATED_CONFIG_BASENAME,
  MANAGED_LABEL_KEY,
  SSH_AUTH_SOCK_TARGET,
  STATE_VERSION,
  WORKSPACE_LABEL_KEY,
} from "./constants";
import { getTemplateDefinition } from "./templates";

export type CommandName = "up" | "down" | "rebuild" | "shell" | "status" | "arise" | "templates" | "help";

export interface ParsedArgs {
  command: CommandName;
  port?: number;
  allowMissingSsh: boolean;
  devcontainerSubpath?: string;
  sshPublicKeyPath?: string;
  templateName?: string;
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
  forceRootUser?: boolean;
}

export interface PreparedKnownHosts {
  knownHostsPath: string | null;
  warning?: string;
}

export interface WorkspaceState {
  version: number;
  workspacePath: string;
  workspaceHash: string;
  port: number;
  configSource: "repo" | "template";
  sourceConfigPath: string | null;
  generatedConfigPath: string;
  labels: Record<string, string>;
  userDataDir: string;
  template: WorkspaceTemplateState | null;
  lastContainerId?: string;
  updatedAt: string;
}

export interface WorkspaceTemplateState {
  name: string;
  description: string;
  source: "built-in";
  base: string;
  image: string | null;
  pinnedReference: string;
  runtimeVersion: string;
  languages: string[];
  runnerCompatible: boolean;
  config: DevcontainerConfig;
}

export interface ResolvedWorkspaceConfig {
  config: DevcontainerConfig;
  configSource: "repo" | "template";
  sourceConfigPath: string | null;
  generatedConfigPath: string;
  legacyGeneratedConfigPath: string | null;
  template: WorkspaceTemplateState | null;
}

export interface UpResult {
  outcome: string;
  containerId: string;
  remoteUser?: string;
  remoteWorkspaceFolder?: string;
}

export interface DockerInspect {
  Id: string;
  Created?: string;
  Name?: string;
  Config?: {
    Labels?: Record<string, string>;
  };
  Mounts?: Array<{
    Type?: string;
    Source?: string;
    Destination?: string;
  }>;
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
  return `${CLI_NAME} v${pkg.version} - manage a devcontainer plus ssh-server-runner\n\nUsage:\n  ${CLI_NAME}\n  ${CLI_NAME} up [port] [--allow-missing-ssh] [--devcontainer-subpath <subpath>] [--ssh-public-key <path>] [--template <name>]\n  ${CLI_NAME} rebuild [port] [--allow-missing-ssh] [--devcontainer-subpath <subpath>] [--ssh-public-key <path>]\n  ${CLI_NAME} shell\n  ${CLI_NAME} status\n  ${CLI_NAME} templates\n  ${CLI_NAME} arise\n  ${CLI_NAME} down [--devcontainer-subpath <subpath>]\n  ${CLI_NAME} help\n  ${CLI_NAME} --help\n\nCommands:\n  up         Start or reuse the managed devcontainer.\n  rebuild    Recreate the managed devcontainer.\n  shell      Open an interactive shell in the running managed container.\n  status     Print JSON describing the managed devbox for this workspace.\n  templates  Print JSON describing the built-in templates.\n  arise      Restart stopped managed workspaces discovered from existing containers.\n  down       Stop and remove the managed container for this workspace.\n  help       Show this help.\n\nOptions:\n  -p, --port <port>               Publish the same port on host and container.\n  --allow-missing-ssh             Continue without SSH agent sharing when unavailable.\n  --devcontainer-subpath <subpath> Use .devcontainer/<subpath>/devcontainer.json.\n  --ssh-public-key <path>         Use a specific SSH public key file instead of ~/.ssh/id_rsa.pub.\n  --template <name>               Use a built-in template instead of a repo devcontainer.\n  -h, --help                      Show this help.`;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const args = [...argv];

  if (args.length === 0) {
    return { command: "help", allowMissingSsh: false };
  }

  let command: CommandName;
  const first = args[0];

  if (
    first === "up" ||
    first === "down" ||
    first === "rebuild" ||
    first === "shell" ||
    first === "status" ||
    first === "arise" ||
    first === "templates"
  ) {
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
  let sshPublicKeyPath: string | undefined;
  let templateName: string | undefined;
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

    if (arg === "--ssh-public-key") {
      const value = args[index + 1];
      if (!value) {
        throw new UserError("Expected a value after --ssh-public-key.");
      }
      sshPublicKeyPath = parseCliPathOption(value, "--ssh-public-key");
      index += 1;
      continue;
    }

    if (arg === "--template") {
      const value = args[index + 1];
      if (!value) {
        throw new UserError("Expected a value after --template.");
      }
      templateName = parseTemplateName(value);
      index += 1;
      continue;
    }

    if (arg.startsWith("--template=")) {
      templateName = parseTemplateName(arg.slice("--template=".length));
      continue;
    }

    if (arg.startsWith("--ssh-public-key=")) {
      sshPublicKeyPath = parseCliPathOption(arg.slice("--ssh-public-key=".length), "--ssh-public-key");
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
    if (command === "status") {
      throw new UserError("The status command does not accept a port.");
    }
    if (command === "arise") {
      throw new UserError("The arise command does not accept a port.");
    }
    port = parsePort(positionals[0]);
  }

  if (command === "down" && port !== undefined) {
    throw new UserError("The down command does not accept a port.");
  }

  if (command === "shell" && port !== undefined) {
    throw new UserError("The shell command does not accept a port.");
  }

  if (command === "status" && port !== undefined) {
    throw new UserError("The status command does not accept a port.");
  }

  if (command === "arise" && port !== undefined) {
    throw new UserError("The arise command does not accept a port.");
  }

  if (command === "templates" && port !== undefined) {
    throw new UserError("The templates command does not accept a port.");
  }

  if (command === "shell" && devcontainerSubpath !== undefined) {
    throw new UserError("The shell command does not accept --devcontainer-subpath.");
  }

  if (command === "status" && devcontainerSubpath !== undefined) {
    throw new UserError("The status command does not accept --devcontainer-subpath.");
  }

  if (command === "arise" && devcontainerSubpath !== undefined) {
    throw new UserError("The arise command does not accept --devcontainer-subpath.");
  }

  if (command === "templates" && devcontainerSubpath !== undefined) {
    throw new UserError("The templates command does not accept --devcontainer-subpath.");
  }

  if (command === "down" && sshPublicKeyPath !== undefined) {
    throw new UserError("The down command does not accept --ssh-public-key.");
  }

  if (command === "shell" && sshPublicKeyPath !== undefined) {
    throw new UserError("The shell command does not accept --ssh-public-key.");
  }

  if (command === "status" && sshPublicKeyPath !== undefined) {
    throw new UserError("The status command does not accept --ssh-public-key.");
  }

  if (command === "arise" && sshPublicKeyPath !== undefined) {
    throw new UserError("The arise command does not accept --ssh-public-key.");
  }

  if (command === "templates" && sshPublicKeyPath !== undefined) {
    throw new UserError("The templates command does not accept --ssh-public-key.");
  }

  if (command === "status" && allowMissingSsh) {
    throw new UserError("The status command does not accept --allow-missing-ssh.");
  }

  if (command === "arise" && allowMissingSsh) {
    throw new UserError("The arise command does not accept --allow-missing-ssh.");
  }

  if (command === "templates" && allowMissingSsh) {
    throw new UserError("The templates command does not accept --allow-missing-ssh.");
  }

  if (templateName !== undefined && devcontainerSubpath !== undefined) {
    throw new UserError("--template cannot be combined with --devcontainer-subpath.");
  }

  if (command === "down" && templateName !== undefined) {
    throw new UserError("The down command does not accept --template.");
  }

  if (command === "rebuild" && templateName !== undefined) {
    throw new UserError("The rebuild command does not accept --template. Start fresh with `devbox up --template <name>`.");
  }

  if (command === "shell" && templateName !== undefined) {
    throw new UserError("The shell command does not accept --template.");
  }

  if (command === "status" && templateName !== undefined) {
    throw new UserError("The status command does not accept --template.");
  }

  if (command === "arise" && templateName !== undefined) {
    throw new UserError("The arise command does not accept --template.");
  }

  if (command === "templates" && templateName !== undefined) {
    throw new UserError("The templates command does not accept --template.");
  }

  if (devcontainerSubpath || sshPublicKeyPath || templateName) {
    return {
      command,
      port,
      allowMissingSsh,
      ...(devcontainerSubpath ? { devcontainerSubpath } : {}),
      ...(sshPublicKeyPath ? { sshPublicKeyPath } : {}),
      ...(templateName ? { templateName } : {}),
    };
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

export function getTemplateGeneratedConfigPath(workspacePath: string): string {
  return path.join(getWorkspaceStateDir(workspacePath), "template.devcontainer.json");
}

export function getDefaultRemoteWorkspaceFolder(workspacePath: string): string {
  return path.posix.join("/workspaces", path.basename(workspacePath));
}

export function formatReadyMessage(containerId: string, port: number, remoteWorkspaceFolder: string): string {
  return `\nReady. ${containerId.slice(0, 12)} is available on port ${port}.\nProject root inside the container: ${remoteWorkspaceFolder}`;
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
    (parsed.configSource !== "repo" && parsed.configSource !== "template") ||
    typeof parsed.generatedConfigPath !== "string" ||
    (parsed.sourceConfigPath !== null && typeof parsed.sourceConfigPath !== "string") ||
    typeof parsed.userDataDir !== "string" ||
    !parsed.labels ||
    typeof parsed.labels !== "object"
  ) {
    throw new UserError(`State file is invalid: ${statePath}`);
  }

  if (parsed.template !== null && parsed.template !== undefined) {
    assertValidTemplateState(parsed.template);
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
  if (command === "down" || command === "shell" || command === "arise" || command === "help") {
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
    throw new UserError("dockerComposeFile-based devcontainers are not supported.");
  }

  const hasImage = typeof config.image === "string" && config.image.trim().length > 0;
  const hasDockerFile = typeof config.dockerFile === "string" && config.dockerFile.trim().length > 0;
  const build = asRecord(config.build);
  const hasBuildDockerfile = typeof build?.dockerfile === "string" && build.dockerfile.trim().length > 0;

  if (!hasImage && !hasDockerFile && !hasBuildDockerfile) {
    throw new UserError("Only image- or Dockerfile-based devcontainers are supported.");
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
  managedConfig.mounts = dedupe(mounts);

  const containerEnv = getStringRecord(managedConfig.containerEnv, "containerEnv");
  if (containerSshAuthSock) {
    containerEnv.SSH_AUTH_SOCK = containerSshAuthSock;
  }
  if (options.githubTokenAvailable) {
    containerEnv.GH_TOKEN = "${localEnv:GH_TOKEN}";
  }
  managedConfig.containerEnv = containerEnv;

  if (options.forceRootUser) {
    managedConfig.remoteUser = "root";
    managedConfig.containerUser = "root";
  }

  return managedConfig;
}

export function createWorkspaceState(input: {
  workspacePath: string;
  port: number;
  configSource: "repo" | "template";
  sourceConfigPath: string | null;
  generatedConfigPath: string;
  userDataDir: string;
  labels: Record<string, string>;
  template: WorkspaceTemplateState | null;
  containerId?: string;
}): WorkspaceState {
  return {
    version: STATE_VERSION,
    workspacePath: input.workspacePath,
    workspaceHash: hashWorkspacePath(input.workspacePath),
    port: input.port,
    configSource: input.configSource,
    sourceConfigPath: input.sourceConfigPath,
    generatedConfigPath: input.generatedConfigPath,
    labels: input.labels,
    userDataDir: input.userDataDir,
    template: input.template ? cloneTemplateState(input.template) : null,
    lastContainerId: input.containerId,
    updatedAt: new Date().toISOString(),
  };
}

export async function resolveWorkspaceConfig(input: {
  workspacePath: string;
  devcontainerSubpath?: string;
  templateName?: string;
  state: WorkspaceState | null;
  preferStateSource?: boolean;
}): Promise<ResolvedWorkspaceConfig> {
  if (input.templateName) {
    const template = resolveBuiltInTemplate(input.templateName);
    return {
      config: structuredClone(template.config),
      configSource: "template",
      sourceConfigPath: null,
      generatedConfigPath: getTemplateGeneratedConfigPath(input.workspacePath),
      legacyGeneratedConfigPath: null,
      template,
    };
  }

  if (input.devcontainerSubpath) {
    const discovered = await discoverDevcontainerConfig(input.workspacePath, input.devcontainerSubpath);
    return {
      config: discovered.config,
      configSource: "repo",
      sourceConfigPath: discovered.path,
      generatedConfigPath: getGeneratedConfigPath(discovered.path),
      legacyGeneratedConfigPath: getLegacyGeneratedConfigPath(discovered.path),
      template: null,
    };
  }

  if (input.preferStateSource && input.state?.configSource === "template" && input.state.template) {
    return {
      config: structuredClone(input.state.template.config),
      configSource: "template",
      sourceConfigPath: null,
      generatedConfigPath: input.state.generatedConfigPath || getTemplateGeneratedConfigPath(input.workspacePath),
      legacyGeneratedConfigPath: null,
      template: cloneTemplateState(input.state.template),
    };
  }

  const discovered = await discoverDevcontainerConfigIfPresent(input.workspacePath);
  if (discovered) {
    return {
      config: discovered.config,
      configSource: "repo",
      sourceConfigPath: discovered.path,
      generatedConfigPath: getGeneratedConfigPath(discovered.path),
      legacyGeneratedConfigPath: getLegacyGeneratedConfigPath(discovered.path),
      template: null,
    };
  }

  if (input.state?.configSource === "template" && input.state.template) {
    return {
      config: structuredClone(input.state.template.config),
      configSource: "template",
      sourceConfigPath: null,
      generatedConfigPath: input.state.generatedConfigPath || getTemplateGeneratedConfigPath(input.workspacePath),
      legacyGeneratedConfigPath: null,
      template: cloneTemplateState(input.state.template),
    };
  }

  throw new UserError(
    `No devcontainer definition was found in ${input.workspacePath}. ` +
    `Use \`${CLI_NAME} templates\` to list built-in templates, then run \`${CLI_NAME} up --template <name>\`.`,
  );
}

export async function prepareKnownHostsMount(input: {
  userDataDir: string;
  homeDir?: string;
}): Promise<PreparedKnownHosts> {
  const candidate = path.join(input.homeDir ?? os.homedir(), ".ssh", "known_hosts");

  try {
    await access(candidate);
  } catch (error) {
    return {
      knownHostsPath: null,
      warning: buildKnownHostsAccessWarning(candidate, error),
    };
  }

  try {
    const details = await lstat(candidate);
    if (details.isSymbolicLink()) {
      return {
        knownHostsPath: null,
        warning: `Host known_hosts is a symbolic link and was skipped: ${candidate}.`,
      };
    }
    if (!details.isFile()) {
      return {
        knownHostsPath: null,
        warning: `Host known_hosts is not a regular file and was skipped: ${candidate}.`,
      };
    }

    const content = await readFile(candidate, "utf8");
    if (content.trim().length === 0) {
      return {
        knownHostsPath: null,
        warning: `Host known_hosts is empty and was skipped: ${candidate}.`,
      };
    }

    await mkdir(input.userDataDir, { recursive: true });
    const snapshotPath = path.join(input.userDataDir, KNOWN_HOSTS_SNAPSHOT_FILENAME);
    await writeFile(snapshotPath, content, "utf8");
    await chmod(snapshotPath, 0o600);
    return { knownHostsPath: snapshotPath };
  } catch (error) {
    return {
      knownHostsPath: null,
      warning: `Host known_hosts could not be staged and was skipped: ${candidate} (${formatErrorMessage(error)}).`,
    };
  }
}

function buildKnownHostsAccessWarning(candidate: string, error: unknown): string {
  const code = getErrorCode(error);
  if (code === "ENOENT") {
    return `Host known_hosts was not found and was skipped: ${candidate}.`;
  }
  return `Host known_hosts could not be read and was skipped: ${candidate} (${formatErrorMessage(error)}).`;
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

function parseCliPathOption(raw: string, optionName: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new UserError(`${optionName} cannot be empty.`);
  }

  return trimmed;
}

function parseTemplateName(raw: string): string {
  const trimmed = raw.trim();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(trimmed)) {
    throw new UserError(`Invalid template name: ${raw}`);
  }
  return trimmed;
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

async function discoverDevcontainerConfigIfPresent(workspacePath: string): Promise<DiscoveredConfig | null> {
  try {
    return await discoverDevcontainerConfig(workspacePath);
  } catch (error) {
    if (
      error instanceof UserError &&
      error.message.startsWith("No devcontainer definition was found in ")
    ) {
      return null;
    }

    throw error;
  }
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

function resolveBuiltInTemplate(name: string): WorkspaceTemplateState {
  const definition = getTemplateDefinition(name);
  if (!definition) {
    throw new UserError(`Unknown template: ${name}. Run \`${CLI_NAME} templates\` to list available templates.`);
  }

  if (!definition.runnerCompatible) {
    throw new UserError(`Template ${name} is not compatible with ssh-server-runner.`);
  }

  validateSupportedDevcontainerConfig(definition.config);

  return {
    name: definition.name,
    description: definition.description,
    source: definition.source,
    base: definition.base,
    image: definition.image,
    pinnedReference: definition.pinnedReference,
    runtimeVersion: definition.runtimeVersion,
    languages: [...definition.languages],
    runnerCompatible: definition.runnerCompatible,
    config: structuredClone(definition.config),
  };
}

function assertValidTemplateState(value: unknown): asserts value is WorkspaceTemplateState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new UserError("State file template entry is invalid.");
  }

  const record = value as Record<string, unknown>;
  if (
    typeof record.name !== "string" ||
    typeof record.description !== "string" ||
    record.source !== "built-in" ||
    typeof record.base !== "string" ||
    (record.image !== null && typeof record.image !== "string") ||
    typeof record.pinnedReference !== "string" ||
    typeof record.runtimeVersion !== "string" ||
    !Array.isArray(record.languages) ||
    record.languages.some((entry) => typeof entry !== "string") ||
    typeof record.runnerCompatible !== "boolean" ||
    !record.config ||
    typeof record.config !== "object" ||
    Array.isArray(record.config)
  ) {
    throw new UserError("State file template entry is invalid.");
  }
}

function cloneTemplateState(template: WorkspaceTemplateState): WorkspaceTemplateState {
  return {
    ...template,
    languages: [...template.languages],
    config: structuredClone(template.config),
  };
}
