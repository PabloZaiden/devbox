#!/usr/bin/env node
import { realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildManagedConfig,
  createWorkspaceState,
  deleteWorkspaceState,
  describeUpPortStrategy,
  discoverDevcontainerConfig,
  formatReadyMessage,
  getDefaultRemoteWorkspaceFolder,
  getGeneratedConfigPath,
  getLegacyGeneratedConfigPath,
  getManagedContainerName,
  getManagedPortFromContainerName,
  getManagedLabels,
  prepareKnownHostsMount,
  getWorkspaceUserDataDir,
  hashWorkspacePath,
  helpText,
  loadWorkspaceState,
  parseArgs,
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
  copyKnownHosts,
  devcontainerUp,
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
  RUNNER_HOST_KEYS_DIRNAME,
} from "./constants";
import { createRunnerMetadata, serializeRunnerMetadata } from "./runnerState";
import { getDevboxStatus } from "./status";

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.command === "help") {
    console.log(helpText());
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

  await handleUpLike(parsed.command, workspacePath, state, parsed.port, parsed.allowMissingSsh, parsed.devcontainerSubpath);
}

async function handleUpLike(
  command: "up" | "rebuild",
  workspacePath: string,
  state: Awaited<ReturnType<typeof loadWorkspaceState>>,
  explicitPort: number | undefined,
  allowMissingSsh: boolean,
  devcontainerSubpath: string | undefined,
): Promise<void> {
  const environment = await ensureHostEnvironment({ allowMissingSsh, workspacePath });
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
  const discovered = await discoverDevcontainerConfig(workspacePath, devcontainerSubpath);
  const generatedConfigPath = getGeneratedConfigPath(discovered.path);
  const legacyGeneratedConfigPath = getLegacyGeneratedConfigPath(discovered.path);
  const userDataDir = getWorkspaceUserDataDir(workspacePath);
  const preparedKnownHosts = await prepareKnownHostsMount({ userDataDir });
  const containerName = getManagedContainerName(workspacePath, port);

  const managedConfig = buildManagedConfig(discovered.config, {
    port,
    containerName,
    sshAuthSock: environment.sshAuthSock,
    knownHostsPath: preparedKnownHosts.knownHostsPath,
    githubTokenAvailable: environment.githubToken !== null,
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

  if (environment.sshAuthSock === DOCKER_DESKTOP_SSH_AUTH_SOCK_SOURCE) {
    console.log("Using Docker Desktop SSH agent sharing.");
  } else if (environment.sshAuthSock) {
    console.log(`Using host SSH agent socket from ${environment.sshAuthSock}.`);
  }
  if (environment.githubToken) {
    console.log("Using host GitHub authentication from gh.");
  }

  await ensureGeneratedConfigIgnored(workspacePath, generatedConfigPath);
  await removeGeneratedConfig(legacyGeneratedConfigPath);
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
  await stopManagedSshd(upResult.containerId);
  await restoreRunnerHostKeys(upResult.containerId, remoteWorkspaceFolder);
  const runnerCredentials = await runStepWithHeartbeat({
    startMessage: "Installing and starting the SSH server inside the container (first run can take a bit)...",
    heartbeatMessage: "Still installing and starting the SSH server",
    successMessage: "SSH server is ready",
    action: () => startRunner(upResult.containerId, port, remoteWorkspaceFolder),
  });
  await writeFile(
    runnerMetadataPath,
    serializeRunnerMetadata(
      createRunnerMetadata({
        sshUser: runnerCredentials.user,
        sshPort: runnerCredentials.sshPort ?? port,
        permitRootLogin: runnerCredentials.permitRootLogin,
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
      sourceConfigPath: discovered.path,
      generatedConfigPath,
      userDataDir,
      labels,
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

  try {
    const discovered = await discoverDevcontainerConfig(workspacePath, devcontainerSubpath);
    generatedConfigPaths.add(getGeneratedConfigPath(discovered.path));
    generatedConfigPaths.add(getLegacyGeneratedConfigPath(discovered.path));
  } catch {
    // Workspace may no longer contain a devcontainer definition; cleanup still continues.
  }

  for (const generatedConfigPath of generatedConfigPaths) {
    await removeGeneratedConfig(generatedConfigPath);
  }

  await deleteWorkspaceState(workspacePath);

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
