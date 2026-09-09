#!/usr/bin/env node
import { mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildManagedConfig,
  createWorkspaceState,
  describeUpPortStrategy,
  formatReadyMessage,
  getDefaultRemoteWorkspaceFolder,
  getManagedContainerName,
  getManagedPortFromContainerName,
  getManagedLabels,
  getWorkspacePorts,
  getWorkspaceSshEnabled,
  prepareKnownHostsMount,
  parseGithubHost,
  parseGithubUser,
  getWorkspaceSshMetadataFile,
  getWorkspaceStateDir,
  getWorkspaceUserDataDir,
  hashWorkspacePath,
  helpText,
  loadWorkspaceState,
  parseArgs,
  resolveWorkspaceConfig,
  removeGeneratedConfig,
  resolvePort,
  resolveUpPortsPreference,
  saveWorkspaceState,
  type DockerInspect,
  type GithubAuthPreference,
  UserError,
  writeManagedConfig,
} from "./core";
import {
  assertConfiguredSshAuthSockAvailable,
  assertPortsAvailable,
  configureGitIdentity,
  configureAuthorizedKeys,
  copyKnownHosts,
  devcontainerUp,
  ensureManagedContainerSshMountCompatibility,
  ensureSshAuthSockAccessible,
  ensureGeneratedConfigIgnored,
  ensureHostEnvironment,
  ensurePathIgnored,
  findAvailablePorts,
  formatCommandError,
  isExecutableAvailable,
  inspectContainers,
  isCommandError,
  labelsForWorkspaceHash,
  listManagedContainers,
  openInteractiveShell,
  persistRunnerHostKeys,
  resolveSshPublicKey,
  resolveShellContainerId,
  requiresSshAuthSockPermissionFix,
  removeContainers,
  restoreRunnerHostKeys,
  runStartupCommand,
  runDevcontainerCommand,
  startRunner,
  stopManagedSshd,
} from "./runtime";
import {
  DEFAULT_UP_AUTO_PORT_START,
  DOCKER_DESKTOP_SSH_AUTH_SOCK_SOURCE,
  MANAGED_LABEL_KEY,
} from "./constants";
import { createRunnerMetadata, serializeRunnerMetadata } from "./runnerState";
import { getDevboxStatus } from "./status";
import { ariseManagedWorkspaces } from "./arise";
import { listTemplateSummaries } from "./templates";
import { runUpdateCommand } from "./update";

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.command === "help") {
    console.log(helpText());
    return;
  }

  if (parsed.command === "arise") {
    await handleArise();
    return;
  }

  if (parsed.command === "templates") {
    console.log(JSON.stringify(listTemplateSummaries(), null, 2));
    return;
  }

  if (parsed.command === "update") {
    const exitCode = await runUpdateCommand({
      checkOnly: parsed.checkOnly ?? false,
      version: parsed.version,
    });
    if (exitCode !== 0) {
      process.exitCode = exitCode;
    }
    return;
  }

  const workspacePath = await realpath(process.cwd());
  const state = await loadWorkspaceState(workspacePath);

  if (parsed.command === "shell") {
    await handleShell(workspacePath, state);
    return;
  }

  if (parsed.command === "exec") {
    await handleExec(workspacePath, state, parsed.execArgs ?? []);
    return;
  }

  if (parsed.command === "status") {
    await handleStatus(workspacePath, state);
    return;
  }

  if (parsed.command === "down") {
    await handleDown(workspacePath, state, parsed.devcontainerSubpath);
    return;
  }

  await handleUpLike(
    parsed.command,
    workspacePath,
    state,
    parsed.port,
    parsed.portCount,
    parsed.sshEnabled,
    parsed.allowMissingSsh,
    parsed.devcontainerSubpath,
    parsed.sshPublicKeyPath,
    parsed.templateName,
    parsed.githubUser,
    parsed.githubHost,
    parsed.startupCommand,
    parsed.clearStartupCommand ?? false,
  );
}

async function handleUpLike(
  command: "up" | "rebuild",
  workspacePath: string,
  state: Awaited<ReturnType<typeof loadWorkspaceState>>,
  explicitPort: number | undefined,
  explicitPortCount: number | undefined,
  explicitSshEnabled: boolean | undefined,
  allowMissingSsh: boolean,
  devcontainerSubpath: string | undefined,
  sshPublicKeyPath?: string,
  templateName?: string,
  explicitGithubUser?: string,
  explicitGithubHost?: string,
  explicitStartupCommand?: string,
  clearStartupCommand = false,
): Promise<void> {
  const githubAuth = resolveGithubAuthPreference({
    explicitUser: explicitGithubUser,
    explicitHost: explicitGithubHost,
    state,
    env: process.env,
  });
  const sshEnabled = explicitSshEnabled ?? getWorkspaceSshEnabled(state);
  const startupCommand = clearStartupCommand
    ? undefined
    : explicitStartupCommand ?? state?.startupCommand;
  const environment = await ensureHostEnvironment({ allowMissingSsh, workspacePath, githubAuth });
  const resolvedSshPublicKey = sshEnabled
    ? await resolveSshPublicKey({ overridePath: sshPublicKeyPath })
    : { publicKey: null, sourcePath: null, source: null };
  const workspaceHash = hashWorkspacePath(workspacePath);
  const labels = getManagedLabels(workspaceHash);
  const existingContainerIds = await listManagedContainers(labels);
  if (command === "up" && existingContainerIds.length > 1) {
    throw new UserError("More than one managed container was found for this workspace. Run `devbox down` first.");
  }

  let existingInspects: DockerInspect[] = [];
  if (existingContainerIds.length > 0) {
    existingInspects = await inspectContainers(existingContainerIds);
  }

  let preferredPorts: number[] | undefined;
  if (command === "up") {
    preferredPorts = resolveUpPortsPreference({
      explicitPort,
      portCount: explicitPortCount,
      state,
      existingPublishedPort: getManagedPortFromContainerName(existingInspects[0]?.Name),
    });
  } else if (explicitPort !== undefined) {
    preferredPorts = [explicitPort];
  } else if (state) {
    preferredPorts = getWorkspacePorts(state);
  } else {
    preferredPorts = [resolvePort(command, explicitPort, state)];
  }
  const requestedPortCount = explicitPortCount ?? preferredPorts?.length ?? 1;
  const ports = await resolveRequestedPorts({
    preferredPorts,
    requestedPortCount,
  });

  console.log(
    `Using ${ports.length === 1 ? "port" : "ports"} ${ports.join(", ")}. ${command === "up" ? describeUpPortStrategy() : ""}`.trim(),
  );
  const resolvedConfig = await resolveWorkspaceConfig({
    workspacePath,
    devcontainerSubpath,
    templateName,
    state,
    preferStateSource: command === "rebuild",
  });
  if (resolvedConfig.templateSelection === "fallback") {
    console.log("No devcontainer definition found; using built-in ubuntu template.");
  }
  const generatedConfigPath = resolvedConfig.generatedConfigPath;
  const userDataDir = getWorkspaceUserDataDir(workspacePath);
  const preparedKnownHosts = await prepareKnownHostsMount({ userDataDir });
  const containerName = getManagedContainerName(workspacePath, ports[0]);

  const managedConfig = buildManagedConfig(resolvedConfig.config, {
    ports,
    containerName,
    sshAuthSock: environment.sshAuthSock,
    knownHostsPath: preparedKnownHosts.knownHostsPath,
    githubTokenAvailable: environment.githubToken !== null,
    forceRootUser: process.platform === "linux" && environment.dockerRootless,
  });

  if (environment.warning) {
    console.warn(`Warning: ${environment.warning}`);
  }
  if (environment.githubTokenWarning) {
    console.warn(`Warning: ${environment.githubTokenWarning}`);
  }
  if (preparedKnownHosts.warning) {
    console.warn(`Warning: ${preparedKnownHosts.warning}`);
  }
  if (resolvedSshPublicKey.warning) {
    console.warn(`Warning: ${resolvedSshPublicKey.warning}`);
  }
  if (process.platform === "linux" && environment.dockerRootless) {
    console.warn(
      "Warning: Docker rootless remaps bind-mounted workspace ownership on Linux, so devbox is forcing the container user to root to keep the workspace writable.",
    );
  }

  if (environment.sshAuthSock === DOCKER_DESKTOP_SSH_AUTH_SOCK_SOURCE) {
    console.log("Using Docker Desktop SSH agent sharing.");
  } else if (environment.sshAuthSock) {
    console.log(`Using host SSH agent socket from ${environment.sshAuthSock}.`);
  }
  if (environment.githubToken) {
    if (environment.githubAuth) {
      console.log(`Using host GitHub authentication from gh account ${environment.githubAuth.user}@${environment.githubAuth.host}.`);
    } else {
      console.log("Using host GitHub authentication from gh.");
    }
  }

  if (resolvedConfig.configSource === "repo" && resolvedConfig.sourceConfigPath) {
    await ensureGeneratedConfigIgnored(workspacePath, generatedConfigPath);
  }
  await ensurePathIgnored(workspacePath, getWorkspaceStateDir(workspacePath));
  if (resolvedConfig.legacyGeneratedConfigPath) {
    await removeGeneratedConfig(resolvedConfig.legacyGeneratedConfigPath);
  }
  await writeManagedConfig(generatedConfigPath, managedConfig);

  if (command === "rebuild") {
    await removeContainers(existingContainerIds);
    existingInspects = [];
  } else if (existingInspects[0]) {
    const publishedPorts = getPublishedHostPorts(existingInspects[0]);
    const publishedPortSet = new Set(publishedPorts);
    const requestedPortSet = new Set(ports);
    const portListChanged =
      publishedPorts.length !== ports.length ||
      ports.some((port) => !publishedPortSet.has(port)) ||
      publishedPorts.some((port) => !requestedPortSet.has(port));
    if (publishedPorts.length > 0 && portListChanged) {
      const rebuildCommand = `devbox rebuild ${ports[0]}${ports.length > 1 ? ` --ports ${ports.length}` : ""}`;
      throw new UserError(
        `This workspace already has a managed container publishing port(s) ${publishedPorts.join(", ")}. Use \`${rebuildCommand}\` to change the port list.`,
      );
    }
  }

  const managedContainerPorts = new Set(
    existingInspects.flatMap((container) =>
      container.State?.Running ? getPublishedHostPorts(container) : [],
    ),
  );
  await assertPortsAvailable(ports, managedContainerPorts);

  const sshMountCompatibility = existingInspects[0]
    ? await ensureManagedContainerSshMountCompatibility(existingInspects[0], environment.sshAuthSock)
    : "not-applicable";
  if (sshMountCompatibility === "created-symlink") {
    console.log("Recreated the missing host SSH agent mount source as a symlink to the current SSH_AUTH_SOCK.");
  } else if (sshMountCompatibility === "updated-symlink") {
    console.log("Updated the stale host SSH agent mount symlink to point at the current SSH_AUTH_SOCK.");
  }

  console.log(`Starting workspace on ${ports.length === 1 ? "port" : "ports"} ${ports.join(", ")}...`);
  const upResult = await runStepWithHeartbeat({
    startMessage: "Preparing devcontainer. First builds with features may take several minutes...",
    heartbeatMessage: "Still preparing devcontainer",
    successMessage: "Devcontainer is ready",
    action: () =>
      devcontainerUp({
        workspacePath,
        generatedConfigPath,
        userDataDir,
        labels,
        processEnv: environment.githubToken ? { GH_TOKEN: environment.githubToken } : undefined,
      }),
  });
  const remoteWorkspaceFolder = upResult.remoteWorkspaceFolder ?? getDefaultRemoteWorkspaceFolder(workspacePath);

  console.log(
    sshEnabled
      ? "Configuring SSH access inside the devcontainer..."
      : "Configuring devcontainer access without installing the bundled SSH server...",
  );
  if (requiresSshAuthSockPermissionFix(environment.sshAuthSock)) {
    console.log("Making the forwarded SSH agent socket accessible to the container user...");
    await ensureSshAuthSockAccessible(upResult.containerId, environment.sshAuthSock);
  }
  if (environment.sshAuthSock) {
    await assertConfiguredSshAuthSockAvailable(upResult.containerId);
  }
  const knownHostsCopyResult = await copyKnownHosts(upResult.containerId, preparedKnownHosts.knownHostsPath);
  if (knownHostsCopyResult === "empty") {
    console.warn("Warning: Prepared known_hosts data was empty inside the devcontainer, so it was not copied.");
  }
  if (environment.gitUserName || environment.gitUserEmail) {
    console.log("Syncing Git author identity from the host into the devcontainer...");
    await configureGitIdentity(upResult.containerId, environment.gitUserName, environment.gitUserEmail);
  }
  if (sshEnabled) {
    await stopManagedSshd(upResult.containerId, ports[0]);
    await restoreRunnerHostKeys(upResult.containerId, remoteWorkspaceFolder);
    const runnerCredentials = await runStepWithHeartbeat({
      startMessage: "Installing and starting the SSH server inside the container (first run can take a bit)...",
      heartbeatMessage: "Still installing and starting the SSH server",
      successMessage: "SSH server is ready",
      action: () => startRunner(upResult.containerId, ports[0], remoteWorkspaceFolder),
    });
    if (resolvedSshPublicKey.publicKey) {
      const sshUser = runnerCredentials.user ?? upResult.remoteUser;
      if (!sshUser) {
        throw new UserError(
          "SSH public key auth was requested, but devbox could not determine which container user should receive authorized_keys.",
        );
      }
      console.log("Installing SSH public key for key-based login...");
      await configureAuthorizedKeys(upResult.containerId, sshUser, resolvedSshPublicKey.publicKey);
    }
    const runnerMetadataPath = getWorkspaceSshMetadataFile(workspacePath);
    await mkdir(path.dirname(runnerMetadataPath), { recursive: true });
    await writeFile(
      runnerMetadataPath,
      serializeRunnerMetadata(
        createRunnerMetadata({
          sshUser: runnerCredentials.user,
          sshPort: runnerCredentials.sshPort ?? ports[0],
          permitRootLogin: runnerCredentials.permitRootLogin,
          publicKeyConfigured: resolvedSshPublicKey.publicKey !== null,
          publicKeySource: resolvedSshPublicKey.sourcePath,
        }),
      ),
      "utf8",
    );
    console.log("Saving SSH server state for future runs...");
    await persistRunnerHostKeys(upResult.containerId, remoteWorkspaceFolder);
  } else {
    if (existingInspects.length > 0) {
      const previousPorts = new Set<number>([
        ...getWorkspacePorts(state),
        ...(getManagedPortFromContainerName(existingInspects[0]?.Name) !== undefined
          ? [getManagedPortFromContainerName(existingInspects[0]?.Name)!]
          : []),
      ]);
      for (const previousPort of previousPorts) {
        await stopManagedSshd(upResult.containerId, previousPort);
      }
    }
    console.log("Bundled SSH server installation skipped; published ports are ready for the devcontainer service.");
  }

  const workspaceState = createWorkspaceState({
    workspacePath,
    ports,
    sshEnabled,
    startupCommand,
    configSource: resolvedConfig.configSource,
    sourceConfigPath: resolvedConfig.sourceConfigPath,
    generatedConfigPath,
    userDataDir,
    labels,
    template: resolvedConfig.template,
    githubAuth: environment.githubAuth,
    containerId: upResult.containerId,
  });
  await saveWorkspaceState(workspaceState);

  if (startupCommand) {
    await runStepWithHeartbeat({
      startMessage: "Running the configured post-start command...",
      heartbeatMessage: "Still running the configured post-start command",
      successMessage: "Configured post-start command completed",
      action: () => runStartupCommand(upResult.containerId, startupCommand),
    });
  }

  console.log(formatReadyMessage(upResult.containerId, ports, remoteWorkspaceFolder));
  if (!preparedKnownHosts.knownHostsPath || knownHostsCopyResult !== "copied") {
    console.log("Host known_hosts was unavailable for injection, so only SSH agent sharing was configured.");
  }
}

async function handleShell(
  workspacePath: string,
  state: Awaited<ReturnType<typeof loadWorkspaceState>>,
): Promise<void> {
  if (!isExecutableAvailable("docker")) {
    throw new UserError("Docker is required but was not found in PATH.");
  }

  if (!isExecutableAvailable("devcontainer")) {
    throw new UserError("Dev Container CLI is required but was not found in PATH.");
  }

  const labels = labelsForWorkspaceHash(hashWorkspacePath(workspacePath));
  const containerIds = await listManagedContainers(labels);
  const containers = await inspectContainers(containerIds);
  const containerId = resolveShellContainerId({
    containers,
    preferredContainerId: state?.lastContainerId,
  });

  await assertConfiguredSshAuthSockAvailable(containerId);
  console.log(`Opening shell inside ${containerId.slice(0, 12)}...`);
  process.exitCode = await openInteractiveShell(containerId);
}

async function handleExec(
  workspacePath: string,
  state: Awaited<ReturnType<typeof loadWorkspaceState>>,
  commandArgs: string[],
): Promise<void> {
  if (!isExecutableAvailable("docker")) {
    throw new UserError("Docker is required but was not found in PATH.");
  }

  if (!isExecutableAvailable("devcontainer")) {
    throw new UserError("Dev Container CLI is required but was not found in PATH.");
  }

  const labels = labelsForWorkspaceHash(hashWorkspacePath(workspacePath));
  const containerIds = await listManagedContainers(labels);
  const containers = await inspectContainers(containerIds);
  const containerId = resolveShellContainerId({
    containers,
    preferredContainerId: state?.lastContainerId,
  });

  process.exitCode = await runDevcontainerCommand(containerId, commandArgs);
}

async function handleDown(
  workspacePath: string,
  state: Awaited<ReturnType<typeof loadWorkspaceState>>,
  devcontainerSubpath: string | undefined,
): Promise<void> {
  if (!isExecutableAvailable("docker")) {
    throw new UserError("Docker is required but was not found in PATH.");
  }

  const labels = labelsForWorkspaceHash(hashWorkspacePath(workspacePath));
  const containerIds = await listManagedContainers(labels);
  await removeContainers(containerIds);

  const generatedConfigPaths = new Set<string>();
  if (state?.generatedConfigPath) {
    generatedConfigPaths.add(state.generatedConfigPath);
  }

  if (state?.configSource === "repo") {
    try {
      const resolvedConfig = await resolveWorkspaceConfig({
        workspacePath,
        devcontainerSubpath,
        state,
      });
      generatedConfigPaths.add(resolvedConfig.generatedConfigPath);
      if (resolvedConfig.legacyGeneratedConfigPath) {
        generatedConfigPaths.add(resolvedConfig.legacyGeneratedConfigPath);
      }
    } catch {
      // Workspace may no longer contain a devcontainer definition; cleanup still continues.
    }
  }

  for (const generatedConfigPath of generatedConfigPaths) {
    await removeGeneratedConfig(generatedConfigPath);
  }

  if (state) {
    await saveWorkspaceState({
      ...state,
      lastContainerId: undefined,
      updatedAt: new Date().toISOString(),
    });
  }

  if (containerIds.length === 0) {
    console.log("No managed container was running for this workspace.");
    return;
  }

  console.log(
    `Removed ${containerIds.length} managed container(s). Workspace-mounted SSH password, metadata, and host keys were preserved.`,
  );
}

async function handleStatus(
  workspacePath: string,
  state: Awaited<ReturnType<typeof loadWorkspaceState>>,
): Promise<void> {
  const status = await getDevboxStatus({ workspacePath, state });
  console.log(JSON.stringify(status, null, 2));
}

async function handleArise(): Promise<void> {
  if (!isExecutableAvailable("docker")) {
    throw new UserError("Docker is required but was not found in PATH.");
  }

  if (!isExecutableAvailable("devcontainer")) {
    throw new UserError("Dev Container CLI is required but was not found in PATH.");
  }

  const summary = await ariseManagedWorkspaces({
    loadManagedContainers: async () => {
      const containerIds = await listManagedContainers({ [MANAGED_LABEL_KEY]: "true" });
      return inspectContainers(containerIds);
    },
    loadWorkspaceState,
    removeContainers,
    restartWorkspace: async (input) => {
      await handleUpLike(
        "up",
        input.workspacePath,
        input.state,
        input.explicitPort,
        undefined,
        undefined,
        false,
        input.devcontainerSubpath,
      );
    },
    log: (message) => console.log(message),
    formatError: formatAriseError,
  });

  if (summary.failedWorkspaces.length > 0) {
    process.exitCode = 1;
  }
}

function resolveGithubAuthPreference(input: {
  explicitUser?: string;
  explicitHost?: string;
  state: Awaited<ReturnType<typeof loadWorkspaceState>>;
  env: Record<string, string | undefined>;
}): GithubAuthPreference | null {
  const envUser = input.env.DEVBOX_GH_USER ? parseGithubUser(input.env.DEVBOX_GH_USER) : undefined;
  const envHost = input.env.DEVBOX_GH_HOST ? parseGithubHost(input.env.DEVBOX_GH_HOST) : undefined;
  const user = input.explicitUser ?? envUser ?? input.state?.githubAuth?.user;

  if (!user) {
    if (input.explicitHost || envHost) {
      throw new UserError("A GitHub user is required when selecting a GitHub host. Pass --gh-user or set DEVBOX_GH_USER.");
    }
    return null;
  }

  return {
    user: parseGithubUser(user),
    host: parseGithubHost(input.explicitHost ?? envHost ?? input.state?.githubAuth?.host ?? "github.com"),
  };
}

function getPublishedHostPorts(container: DockerInspect): number[] {
  const ports = container.NetworkSettings?.Ports ?? {};
  const values = new Set<number>();

  for (const bindings of Object.values(ports)) {
    if (!bindings) {
      continue;
    }

    for (const binding of bindings) {
      if (!binding?.HostPort) {
        continue;
      }

      const parsed = Number(binding.HostPort);
      if (Number.isInteger(parsed)) {
        values.add(parsed);
      }
    }
  }

  return [...values];
}

async function resolveRequestedPorts(input: {
  preferredPorts: number[] | undefined;
  requestedPortCount: number;
}): Promise<number[]> {
  const preferredPorts = input.preferredPorts ?? [];
  if (preferredPorts.length >= input.requestedPortCount) {
    return preferredPorts.slice(0, input.requestedPortCount);
  }

  if (preferredPorts.length > 0) {
    const lastPreferredPort = Math.max(...preferredPorts);
    const additionalPorts = await findAvailablePorts(
      lastPreferredPort + 1,
      input.requestedPortCount - preferredPorts.length,
    );
    return [...preferredPorts, ...additionalPorts];
  }

  return findAvailablePorts(DEFAULT_UP_AUTO_PORT_START, input.requestedPortCount);
}

async function runStepWithHeartbeat<T>(input: {
  startMessage: string;
  heartbeatMessage: string;
  successMessage?: string;
  action: () => Promise<T>;
  intervalMs?: number;
}): Promise<T> {
  const startedAt = Date.now();
  const intervalMs = input.intervalMs ?? 20000;

  console.log(input.startMessage);
  const intervalId = setInterval(() => {
    console.log(`${input.heartbeatMessage} (${formatElapsed(Date.now() - startedAt)} elapsed)...`);
  }, intervalMs);

  try {
    const result = await input.action();
    if (input.successMessage) {
      console.log(`${input.successMessage} (${formatElapsed(Date.now() - startedAt)}).`);
    }
    return result;
  } finally {
    clearInterval(intervalId);
  }
}

function formatElapsed(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes === 0) {
    return `${seconds}s`;
  }

  return `${minutes}m ${seconds}s`;
}

function formatAriseError(error: unknown): string {
  if (error instanceof UserError) {
    return error.message;
  }

  if (isCommandError(error)) {
    return formatCommandError(error);
  }

  if (error instanceof Error && error.message) {
    return error.message;
  }

  return String(error);
}

main().catch((error: unknown) => {
  if (error instanceof UserError) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }

  if (isCommandError(error)) {
    console.error(`Error: ${formatCommandError(error)}`);
    process.exit(error.result.exitCode || 1);
  }

  console.error(error);
  process.exit(1);
});
