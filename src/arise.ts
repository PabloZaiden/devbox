import { access, lstat } from "node:fs/promises";
import path from "node:path";
import {
  getManagedPortFromContainerName,
  getWorkspaceStateFile,
  type WorkspaceState,
  type DockerInspect,
} from "./core";
import { DEVBOX_SSH_METADATA_FILENAME, RUNNER_CRED_FILENAME, RUNNER_HOST_KEYS_DIRNAME } from "./constants";

export interface RecoveredWorkspaceMount {
  destination: string;
  source: string;
}

export interface StoppedContainerSkip {
  containerId: string;
  containerName: string | null;
  reason: string;
}

export interface StoppedWorkspaceCandidate {
  workspacePath: string;
  workspaceMountDestination: string;
  primaryContainerId: string;
  primaryContainerName: string | null;
  primaryContainerState: string | null;
  primaryCreatedAt: string | null;
  port: number | undefined;
  containerIds: string[];
  duplicateContainerIds: string[];
}

export interface DiscoverStoppedManagedWorkspacesResult {
  workspaces: StoppedWorkspaceCandidate[];
  skippedContainers: StoppedContainerSkip[];
}

export interface WorkspaceRestartReadiness {
  eligible: boolean;
  workspacePath: string;
  reasons: string[];
  foundArtifacts: string[];
  statePath: string;
  credentialPath: string;
  sshMetadataPath: string;
  hostKeysPath: string;
  hasStateFile: boolean;
  hasCredentialFile: boolean;
  hasSshMetadataFile: boolean;
  hasHostKeysDir: boolean;
}

interface WorkspaceValidationDependencies {
  access?: typeof access;
  lstat?: typeof lstat;
}

export interface AriseRestartInput {
  workspacePath: string;
  state: WorkspaceState | null;
  explicitPort: number | undefined;
  devcontainerSubpath: string | undefined;
  candidate: StoppedWorkspaceCandidate;
}

export interface AriseSkippedWorkspace {
  workspacePath: string;
  reasons: string[];
}

export interface AriseFailedWorkspace {
  workspacePath: string;
  reason: string;
}

export interface AriseSummary {
  discoveredWorkspaceCount: number;
  restartedWorkspaces: string[];
  skippedContainers: StoppedContainerSkip[];
  skippedWorkspaces: AriseSkippedWorkspace[];
  failedWorkspaces: AriseFailedWorkspace[];
}

interface AriseDependencies {
  loadManagedContainers: () => Promise<DockerInspect[]>;
  loadWorkspaceState: (workspacePath: string) => Promise<WorkspaceState | null>;
  inspectWorkspaceRestartReadiness?: (
    workspacePath: string,
  ) => Promise<WorkspaceRestartReadiness>;
  removeContainers: (containerIds: string[]) => Promise<void>;
  restartWorkspace: (input: AriseRestartInput) => Promise<void>;
  log?: (message: string) => void;
  formatError?: (error: unknown) => string;
}

export function discoverStoppedManagedWorkspaces(containers: DockerInspect[]): DiscoverStoppedManagedWorkspacesResult {
  const skippedContainers: StoppedContainerSkip[] = [];
  const grouped = new Map<string, Array<{ container: DockerInspect; mount: RecoveredWorkspaceMount }>>();

  for (const container of containers) {
    if (container.State?.Running) {
      continue;
    }

    const recovered = recoverWorkspaceMount(container);
    if ("reason" in recovered) {
      skippedContainers.push({
        containerId: container.Id,
        containerName: normalizeContainerName(container.Name),
        reason: recovered.reason,
      });
      continue;
    }

    const entry = grouped.get(recovered.source) ?? [];
    entry.push({ container, mount: recovered });
    grouped.set(recovered.source, entry);
  }

  const workspaces = [...grouped.entries()]
    .map(([workspacePath, entries]) => {
      const sortedEntries = [...entries].sort(compareWorkspaceEntries);
      const primary = sortedEntries[0];
      return {
        workspacePath,
        workspaceMountDestination: primary.mount.destination,
        primaryContainerId: primary.container.Id,
        primaryContainerName: normalizeContainerName(primary.container.Name),
        primaryContainerState: primary.container.State?.Status ?? null,
        primaryCreatedAt: primary.container.Created ?? null,
        port: getManagedPortFromContainerName(primary.container.Name),
        containerIds: sortedEntries.map((entry) => entry.container.Id),
        duplicateContainerIds: sortedEntries.slice(1).map((entry) => entry.container.Id),
      };
    })
    .sort((left, right) => left.workspacePath.localeCompare(right.workspacePath));

  return {
    workspaces,
    skippedContainers,
  };
}

export function recoverWorkspaceMount(
  container: DockerInspect,
): RecoveredWorkspaceMount | { reason: string } {
  const bindMounts = (container.Mounts ?? [])
    .filter(
      (mount): mount is Required<Pick<NonNullable<DockerInspect["Mounts"]>[number], "Type" | "Source" | "Destination">> =>
        mount?.Type === "bind" &&
        typeof mount.Source === "string" &&
        typeof mount.Destination === "string" &&
        path.isAbsolute(mount.Source) &&
        path.posix.isAbsolute(mount.Destination),
    )
    .map((mount) => ({
      source: path.resolve(mount.Source),
      destination: normalizeDestinationPath(mount.Destination),
    }));

  if (bindMounts.length === 0) {
    return { reason: "Container has no absolute bind mounts." };
  }

  const workspaceMounts = bindMounts.filter((mount) => isLikelyWorkspaceDestination(mount.destination));
  if (workspaceMounts.length === 0) {
    return { reason: "Container has no bind mount targeting a workspace under /workspaces." };
  }

  const rankedMounts = [...workspaceMounts].sort(compareMounts);
  if (rankedMounts.length > 1 && mountRank(rankedMounts[0]) === mountRank(rankedMounts[1])) {
    return { reason: "Container has multiple equally likely workspace bind mounts under /workspaces." };
  }

  return rankedMounts[0];
}

export async function inspectWorkspaceRestartReadiness(
  workspacePath: string,
  deps: WorkspaceValidationDependencies = {},
): Promise<WorkspaceRestartReadiness> {
  const accessFile = deps.access ?? access;
  const statPath = deps.lstat ?? lstat;
  const reasons: string[] = [];
  const foundArtifacts: string[] = [];

  const workspaceStat = await safeLstat(workspacePath, statPath);
  if (workspaceStat === null) {
    reasons.push("Workspace directory no longer exists.");
  } else if (!workspaceStat.isDirectory()) {
    reasons.push("Recovered workspace path is not a directory.");
  }

  const statePath = getWorkspaceStateFile(workspacePath);
  const credentialPath = path.join(workspacePath, RUNNER_CRED_FILENAME);
  const sshMetadataPath = path.join(workspacePath, DEVBOX_SSH_METADATA_FILENAME);
  const hostKeysPath = path.join(workspacePath, RUNNER_HOST_KEYS_DIRNAME);

  const hasStateFile = await pathExists(statePath, accessFile);
  const hasCredentialFile = await pathExists(credentialPath, accessFile);
  const hasSshMetadataFile = await pathExists(sshMetadataPath, accessFile);
  const hostKeysStat = await safeLstat(hostKeysPath, statPath);
  const hasHostKeysDir = hostKeysStat?.isDirectory() ?? false;

  if (hasStateFile) {
    foundArtifacts.push("saved state");
  }
  if (hasCredentialFile) {
    foundArtifacts.push(RUNNER_CRED_FILENAME);
  }
  if (hasSshMetadataFile) {
    foundArtifacts.push(DEVBOX_SSH_METADATA_FILENAME);
  }
  if (hasHostKeysDir) {
    foundArtifacts.push(`${RUNNER_HOST_KEYS_DIRNAME}/`);
  }

  if (reasons.length === 0 && foundArtifacts.length === 0) {
    reasons.push(
      `No devbox restart leftovers were found in ${workspacePath}. Expected at least one of: saved state, ` +
      `${RUNNER_CRED_FILENAME}, ${DEVBOX_SSH_METADATA_FILENAME}, or ${RUNNER_HOST_KEYS_DIRNAME}/.`,
    );
  }

  return {
    eligible: reasons.length === 0,
    workspacePath,
    reasons,
    foundArtifacts,
    statePath,
    credentialPath,
    sshMetadataPath,
    hostKeysPath,
    hasStateFile,
    hasCredentialFile,
    hasSshMetadataFile,
    hasHostKeysDir,
  };
}

export async function ariseManagedWorkspaces(deps: AriseDependencies): Promise<AriseSummary> {
  const log = deps.log ?? (() => {});
  const formatError = deps.formatError ?? defaultFormatError;
  const readinessCheck = deps.inspectWorkspaceRestartReadiness ?? inspectWorkspaceRestartReadiness;

  log("Scanning for stopped managed devbox containers...");
  const containers = await deps.loadManagedContainers();
  const discovery = discoverStoppedManagedWorkspaces(containers);

  for (const skippedContainer of discovery.skippedContainers) {
    log(
      `Skipping container ${formatContainerDisplay(skippedContainer.containerId, skippedContainer.containerName)}: ${skippedContainer.reason}`,
    );
  }

  if (discovery.workspaces.length === 0) {
    log("No stopped managed devbox workspaces were found.");
    return {
      discoveredWorkspaceCount: 0,
      restartedWorkspaces: [],
      skippedContainers: discovery.skippedContainers,
      skippedWorkspaces: [],
      failedWorkspaces: [],
    };
  }

  log(`Found ${discovery.workspaces.length} stopped managed workspace(s) to evaluate.`);

  const restartedWorkspaces: string[] = [];
  const skippedWorkspaces: AriseSkippedWorkspace[] = [];
  const failedWorkspaces: AriseFailedWorkspace[] = [];

  for (const candidate of discovery.workspaces) {
    try {
      log(
        `Recovered ${candidate.workspacePath} from ${formatContainerDisplay(candidate.primaryContainerId, candidate.primaryContainerName)}.`,
      );

      const readiness = await readinessCheck(candidate.workspacePath);
      if (!readiness.eligible) {
        skippedWorkspaces.push({
          workspacePath: candidate.workspacePath,
          reasons: readiness.reasons,
        });
        log(`Skipping ${candidate.workspacePath}: ${readiness.reasons.join(" ")}`);
        continue;
      }

      log(
        `Found restart leftovers for ${candidate.workspacePath}: ${readiness.foundArtifacts.join(", ")}.`,
      );

      const state = await deps.loadWorkspaceState(candidate.workspacePath);
      if (candidate.duplicateContainerIds.length > 0) {
        log(
          `Removing ${candidate.duplicateContainerIds.length} older stopped container(s) for ${candidate.workspacePath} before restart.`,
        );
        await deps.removeContainers(candidate.duplicateContainerIds);
      }

      log(`Running \`devbox up\` again for ${candidate.workspacePath}...`);
      await deps.restartWorkspace({
        workspacePath: candidate.workspacePath,
        state,
        explicitPort: state ? undefined : candidate.port,
        devcontainerSubpath: getStoredDevcontainerSubpath(candidate.workspacePath, state?.sourceConfigPath),
        candidate,
      });
      restartedWorkspaces.push(candidate.workspacePath);
    } catch (error) {
      const reason = formatError(error);
      failedWorkspaces.push({
        workspacePath: candidate.workspacePath,
        reason,
      });
      log(`Failed to restart ${candidate.workspacePath}: ${reason}`);
      log("Continuing with remaining stopped workspaces...");
    }
  }

  log(
    `Arise summary: restarted ${restartedWorkspaces.length}, skipped ${skippedWorkspaces.length} workspace(s), ` +
      `ignored ${discovery.skippedContainers.length} container(s), failed ${failedWorkspaces.length}.`,
  );

  return {
    discoveredWorkspaceCount: discovery.workspaces.length,
    restartedWorkspaces,
    skippedContainers: discovery.skippedContainers,
    skippedWorkspaces,
    failedWorkspaces,
  };
}

export function getStoredDevcontainerSubpath(
  workspacePath: string,
  sourceConfigPath: string | null | undefined,
): string | undefined {
  if (!sourceConfigPath) {
    return undefined;
  }

  const normalizedWorkspacePath = path.resolve(workspacePath);
  const normalizedSourceConfigPath = path.resolve(sourceConfigPath);
  const defaultConfigPath = path.join(normalizedWorkspacePath, ".devcontainer", "devcontainer.json");
  const rootConfigPath = path.join(normalizedWorkspacePath, ".devcontainer.json");
  if (normalizedSourceConfigPath === defaultConfigPath || normalizedSourceConfigPath === rootConfigPath) {
    return undefined;
  }

  const devcontainerRoot = path.join(normalizedWorkspacePath, ".devcontainer");
  const relativeConfigPath = path.relative(devcontainerRoot, normalizedSourceConfigPath);
  if (
    relativeConfigPath.startsWith("..") ||
    path.isAbsolute(relativeConfigPath) ||
    path.basename(normalizedSourceConfigPath) !== "devcontainer.json"
  ) {
    return undefined;
  }

  const relativeDirectory = path.dirname(relativeConfigPath);
  return relativeDirectory === "." ? undefined : relativeDirectory;
}

function normalizeContainerName(name: string | undefined): string | null {
  if (!name) {
    return null;
  }
  return name.replace(/^\//, "");
}

function normalizeDestinationPath(destination: string): string {
  const normalized = path.posix.normalize(destination);
  return normalized === "." ? "/" : normalized;
}

function isLikelyWorkspaceDestination(destination: string): boolean {
  return destination.startsWith("/workspaces/") && destination.length > "/workspaces/".length;
}

function compareMounts(left: RecoveredWorkspaceMount, right: RecoveredWorkspaceMount): number {
  return mountRank(left) - mountRank(right) || left.destination.localeCompare(right.destination);
}

function mountRank(mount: RecoveredWorkspaceMount): number {
  return destinationDepth(mount.destination) * 1000 + mount.destination.length;
}

function destinationDepth(destination: string): number {
  return destination.split("/").filter(Boolean).length;
}

function compareWorkspaceEntries(
  left: { container: DockerInspect },
  right: { container: DockerInspect },
): number {
  const createdComparison = (right.container.Created ?? "").localeCompare(left.container.Created ?? "");
  if (createdComparison !== 0) {
    return createdComparison;
  }

  return right.container.Id.localeCompare(left.container.Id);
}

async function pathExists(filePath: string, accessFile: typeof access): Promise<boolean> {
  try {
    await accessFile(filePath);
    return true;
  } catch {
    return false;
  }
}

async function safeLstat(filePath: string, statPath: typeof lstat): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await statPath(filePath);
  } catch {
    return null;
  }
}

function formatContainerDisplay(containerId: string, containerName: string | null): string {
  const shortId = containerId.slice(0, 12);
  return containerName ? `${containerName} (${shortId})` : shortId;
}

function defaultFormatError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error);
}
