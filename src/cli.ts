#!/usr/bin/env node
import { realpath } from "node:fs/promises";
import path from "node:path";
import {
  buildManagedConfig,
  createWorkspaceState,
  deleteWorkspaceState,
  discoverDevcontainerConfig,
  getDefaultRemoteWorkspaceFolder,
  getGeneratedConfigPath,
  getLegacyGeneratedConfigPath,
  getManagedContainerName,
  getKnownHostsPath,
  getManagedLabels,
  getWorkspaceUserDataDir,
  hashWorkspacePath,
  helpText,
  loadWorkspaceState,
  parseArgs,
  removeGeneratedConfig,
  resolvePort,
  saveWorkspaceState,
  type DockerInspect,
  UserError,
  writeManagedConfig,
} from "./core";
import {
  assertPortAvailable,
  copyKnownHosts,
  devcontainerUp,
  ensureSshAuthSockAccessible,
  ensureGeneratedConfigIgnored,
  ensureHostEnvironment,
  ensurePathIgnored,
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
import { RUNNER_HOST_KEYS_DIRNAME } from "./constants";

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
  const environment = await ensureHostEnvironment({ allowMissingSsh });
  const port = resolvePort(command, explicitPort, state);
  const knownHostsPath = await getKnownHostsPath();
  const discovered = await discoverDevcontainerConfig(workspacePath, devcontainerSubpath);
  const generatedConfigPath = getGeneratedConfigPath(discovered.path);
  const legacyGeneratedConfigPath = getLegacyGeneratedConfigPath(discovered.path);
  const workspaceHash = hashWorkspacePath(workspacePath);
  const labels = getManagedLabels(workspaceHash);
  const userDataDir = getWorkspaceUserDataDir(workspacePath);
  const containerName = getManagedContainerName(workspacePath, port);

  const managedConfig = buildManagedConfig(discovered.config, {
    port,
    containerName,
    sshAuthSock: environment.sshAuthSock,
    knownHostsPath,
  });

  if (environment.warning) {
    console.warn(`Warning: ${environment.warning}`);
  }

  await ensureGeneratedConfigIgnored(workspacePath, generatedConfigPath);
  await removeGeneratedConfig(legacyGeneratedConfigPath);
  await writeManagedConfig(generatedConfigPath, managedConfig);

  const existingContainerIds = await listManagedContainers(labels);
  if (command === "up" && existingContainerIds.length > 1) {
    throw new UserError("More than one managed container was found for this workspace. Run `devbox down` first.");
  }

  let existingInspects: DockerInspect[] = [];
  if (existingContainerIds.length > 0) {
    existingInspects = await inspectContainers(existingContainerIds);
  }

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
  const upResult = await devcontainerUp({
    workspacePath,
    generatedConfigPath,
    userDataDir,
    labels,
  });
  const remoteWorkspaceFolder = upResult.remoteWorkspaceFolder ?? getDefaultRemoteWorkspaceFolder(workspacePath);

  console.log("Configuring SSH access inside the devcontainer...");
  await ensurePathIgnored(workspacePath, path.join(workspacePath, RUNNER_HOST_KEYS_DIRNAME));
  if (requiresSshAuthSockPermissionFix(environment.sshAuthSock)) {
    console.log("Making the forwarded SSH agent socket accessible to the container user...");
    await ensureSshAuthSockAccessible(upResult.containerId);
  }
  await copyKnownHosts(upResult.containerId);
  await stopManagedSshd(upResult.containerId);
  await restoreRunnerHostKeys(upResult.containerId, remoteWorkspaceFolder);
  console.log("Installing and starting the SSH server inside the container (first run can take a bit)...");
  await startRunner(upResult.containerId, port, remoteWorkspaceFolder);
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

  console.log(`\nReady. ${upResult.containerId.slice(0, 12)} is available on port ${port}.`);
  if (!knownHostsPath) {
    console.log("Host known_hosts was not found, so only SSH agent sharing was configured.");
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
    `Removed ${containerIds.length} managed container(s). Workspace-mounted SSH credentials and host keys were preserved.`,
  );
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
