#!/usr/bin/env node
import { realpath, writeFile } from "node:fs/promises";
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
  prepareKnownHostsMount,
  getWorkspaceUserDataDir,
  hashWorkspacePath,
  helpText,
  loadWorkspaceState,
  parseArgs,
  resolveWorkspaceConfig,
  removeGeneratedConfig,
  resolvePort,
  resolveUpPortPreference,
  saveWorkspaceState,
  type DockerInspect,
  UserError,
  writeManagedConfig,
} from "./core";
import {
  assertConfiguredSshAuthSockAvailable,
  assertPortAvailable,
  configureGitIdentity,
  configureAuthorizedKeys,
  copyKnownHosts,
  devcontainerUp,
  ensureManagedContainerSshMountCompatibility,
  ensureSshAuthSockAccessible,
  ensureGeneratedConfigIgnored,
  ensureHostEnvironment,
  ensurePathIgnored,
  findFirstAvailablePort,
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
  startRunner,
  stopManagedSshd,
} from "./runtime";
import {
  DEFAULT_UP_AUTO_PORT_START,
  DEVBOX_SSH_METADATA_FILENAME,
  DOCKER_DESKTOP_SSH_AUTH_SOCK_SOURCE,
  MANAGED_LABEL_KEY,
  RUNNER_CRED_FILENAME,
  RUNNER_HOST_KEYS_DIRNAME,
} from "./constants";
import { createRunnerMetadata, serializeRunnerMetadata } from "./runnerState";
import { getDevboxStatus } from "./status";
import { ariseManagedWorkspaces } from "./arise";
import { listTemplateSummaries } from "./templates";

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

  const workspacePath = await realpath(process.cwd());
  const state = await loadWorkspaceState(workspacePath);

  if (parsed.command === "shell") {
    await handleShell(workspacePath, state);
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
    parsed.allowMissingSsh,
    parsed.devcontainerSubpath,
    parsed.sshPublicKeyPath,
    parsed.templateName,
  );
}

async function handleUpLike(
  command: "up" | "rebuild",
  workspacePath: string,
  state: Awaited<ReturnType<typeof loadWorkspaceState>>,
  explicitPort: number | undefined,
  allowMissingSsh: boolean,
  devcontainerSubpath: string | undefined,
  sshPublicKeyPath?: string,
  templateName?: string,
): Promise<void> {
  const environment = await ensureHostEnvironment({ allowMissingSsh, workspacePath });
  const resolvedSshPublicKey = await resolveSshPublicKey({ overridePath: sshPublicKeyPath });
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

  const port =
    command === "up"
      ? (resolveUpPortPreference({
          explicitPort,
          state,
          existingPublishedPort: getManagedPortFromContainerName(existingInspects[0]?.Name),
        }) ?? (await findFirstAvailablePort(DEFAULT_UP_AUTO_PORT_START)))
      : resolvePort(command, explicitPort, state);

  console.log(`Using port ${port}. ${command === "up" ? describeUpPortStrategy() : ""}`.trim());
  const resolvedConfig = await resolveWorkspaceConfig({
    workspacePath,
    devcontainerSubpath,
    templateName,
    state,
  });
  const generatedConfigPath = resolvedConfig.generatedConfigPath;
  const userDataDir = getWorkspaceUserDataDir(workspacePath);
  const preparedKnownHosts = await prepareKnownHostsMount({ userDataDir });
  const containerName = getManagedContainerName(workspacePath, port);

  const managedConfig = buildManagedConfig(resolvedConfig.config, {
    port,
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
    console.log("Using host GitHub authentication from gh.");
  }

  if (resolvedConfig.configSource === "repo" && resolvedConfig.sourceConfigPath) {
    await ensureGeneratedConfigIgnored(workspacePath, generatedConfigPath);
  }
  if (resolvedConfig.legacyGeneratedConfigPath) {
    await removeGeneratedConfig(resolvedConfig.legacyGeneratedConfigPath);
  }
  await writeManagedConfig(generatedConfigPath, managedConfig);

  if (command === "rebuild") {
    await removeContainers(existingContainerIds);
    existingInspects = [];
  } else if (existingInspects[0]) {
    const publishedPorts = getPublishedHostPorts(existingInspects[0]);
    if (publishedPorts.length > 0 && !publishedPorts.includes(port)) {
      throw new UserError(
        `This workspace already has a managed container publishing port(s) ${publishedPorts.join(", ")}. Use \`devbox rebuild ${port}\` to change the port.`,
      );
    }
  }

  const allowCurrentPort = existingInspects.some(
    (container) => container.State?.Running && getPublishedHostPorts(container).includes(port),
  );
  await assertPortAvailable(port, allowCurrentPort);

  const sshMountCompatibility = existingInspects[0]
    ? await ensureManagedContainerSshMountCompatibility(existingInspects[0], environment.sshAuthSock)
    : "not-applicable";
  if (sshMountCompatibility === "created-symlink") {
    console.log("Recreated the missing host SSH agent mount source as a symlink to the current SSH_AUTH_SOCK.");
  } else if (sshMountCompatibility === "updated-symlink") {
    console.log("Updated the stale host SSH agent mount symlink to point at the current SSH_AUTH_SOCK.");
  }

  console.log(`Starting workspace on port ${port}...`);
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

  console.log("Configuring SSH access inside the devcontainer...");
  await ensurePathIgnored(workspacePath, path.join(workspacePath, RUNNER_HOST_KEYS_DIRNAME));
  const runnerMetadataPath = path.join(workspacePath, DEVBOX_SSH_METADATA_FILENAME);
  await ensurePathIgnored(workspacePath, runnerMetadataPath);
  await ensurePathIgnored(workspacePath, path.join(workspacePath, RUNNER_CRED_FILENAME));
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
  await stopManagedSshd(upResult.containerId, port);
  await restoreRunnerHostKeys(upResult.containerId, remoteWorkspaceFolder);
  const runnerCredentials = await runStepWithHeartbeat({
    startMessage: "Installing and starting the SSH server inside the container (first run can take a bit)...",
    heartbeatMessage: "Still installing and starting the SSH server",
    successMessage: "SSH server is ready",
    action: () => startRunner(upResult.containerId, port, remoteWorkspaceFolder),
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
  await writeFile(
    runnerMetadataPath,
    serializeRunnerMetadata(
      createRunnerMetadata({
        sshUser: runnerCredentials.user,
        sshPort: runnerCredentials.sshPort ?? port,
        permitRootLogin: runnerCredentials.permitRootLogin,
        publicKeyConfigured: resolvedSshPublicKey.publicKey !== null,
        publicKeySource: resolvedSshPublicKey.sourcePath,
      }),
    ),
    "utf8",
  );
  console.log("Saving SSH server state for future runs...");
  await persistRunnerHostKeys(upResult.containerId, remoteWorkspaceFolder);

  await saveWorkspaceState(
    createWorkspaceState({
      workspacePath,
      port,
      configSource: resolvedConfig.configSource,
      sourceConfigPath: resolvedConfig.sourceConfigPath,
      generatedConfigPath,
      userDataDir,
      labels,
      template: resolvedConfig.template,
      containerId: upResult.containerId,
    }),
  );

  console.log(formatReadyMessage(upResult.containerId, port, remoteWorkspaceFolder));
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
      await handleUpLike("up", input.workspacePath, input.state, input.explicitPort, false, input.devcontainerSubpath);
    },
    log: (message) => console.log(message),
    formatError: formatAriseError,
  });

  if (summary.failedWorkspaces.length > 0) {
    process.exitCode = 1;
  }
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
