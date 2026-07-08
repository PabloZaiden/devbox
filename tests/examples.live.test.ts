import { existsSync } from "node:fs";
import { chmod, cp, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  DOCKER_DESKTOP_SSH_AUTH_SOCK_SOURCE,
  MANAGED_LABEL_KEY,
  SSH_AUTH_SOCK_TARGET,
  WORKSPACE_LABEL_KEY,
} from "../src/constants";
import {
  getDefaultRemoteWorkspaceFolder,
  getManagedContainerName,
  getWorkspaceRunnerCredentialFile,
  getWorkspaceRunnerHostKeysDir,
  getWorkspaceSshMetadataFile,
  hashWorkspacePath,
  quoteShell,
  type DockerInspect,
} from "../src/core";

setDefaultTimeout(15 * 60_000);

const repoRoot = process.cwd();
const cliPath = path.join(repoRoot, "src", "cli.ts");
const tempPaths: string[] = [];
const cleanupTasks: Array<() => Promise<void>> = [];
const skipLiveIntegration = process.env.DEVBOX_SKIP_LIVE_EXAMPLE_TESTS === "1";
const canRunLiveIntegration = !skipLiveIntegration && canRunLivePrerequisites();
const canRunAriseLiveIntegration = !skipLiveIntegration && canRunAriseLivePrerequisites();
const liveTest = canRunLiveIntegration ? test.serial : test.skip;
const liveAriseTest = canRunAriseLiveIntegration ? test.serial : test.skip;

interface CommandResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

interface LiveFixtureOptions {
  forceNoDockerDesktopHostService?: boolean;
  ghToken?: string;
  gitIdentity?: {
    name: string;
    email: string;
  };
  knownHosts?: string;
  requireSshAuthSock?: boolean;
  useFallbackDevcontainer?: boolean;
}

interface RunnerArtifacts {
  knownHosts: string;
}

interface LiveFixture {
  env: Record<string, string>;
  expectedContainerSshAuthSockPath: string | null;
  knownHostsContent: string | null;
  port: number;
  remoteWorkspaceFolder: string;
  runnerArtifacts: RunnerArtifacts;
  runnerCredPath: string;
  runnerMetadataPath: string;
  sampleFilePath: string;
  sshAuthSockPath: string | null;
  statePath: string;
  workspacePath: string;
}

afterEach(async () => {
  for (const cleanup of cleanupTasks.splice(0).reverse()) {
    try {
      await cleanup();
    } catch {
      // Best-effort cleanup so one failed teardown does not hide the test result.
    }
  }

  await Promise.all(
    tempPaths.splice(0).map(async (tempPath) => {
      await rm(tempPath, { recursive: true, force: true });
    }),
  );
});

describe("example workspaces (real devcontainers)", () => {
  liveTest(
    "template workspace falls back to the ubuntu template without a repo devcontainer",
    async () => {
      const fixture = await setupLiveFixture("template-workspace");
      const up = runCli(fixture, ["up", "--allow-missing-ssh"]);

      expect(up.exitCode).toBe(0);
      expect(up.stdout).toContain("No devcontainer definition found; using built-in ubuntu template.");
      expect(up.stdout).toContain("Devcontainer is ready");
      expect(up.stdout).toContain("SSH server:");
      expect(up.stdout).toContain("Ready.");

      const state = await readJson(fixture.statePath);
      const selectedPort = Number(state.port);
      const containerId = String(state.lastContainerId);
      expect(up.stdout).toContain(`Using port ${selectedPort}.`);
      expect(state.configSource).toBe("template");
      expect(state.sourceConfigPath).toBeNull();
      expect(state.template.name).toBe("ubuntu");

      const inspect = inspectContainer(fixture, containerId);
      expect(inspect.Name).toBe(`/${getManagedContainerName(fixture.workspacePath, selectedPort)}`);
      expect(inspect.Config?.Labels).toEqual(expect.objectContaining(state.labels));
      expect(getPublishedHostPort(inspect, selectedPort)).toBe(String(selectedPort));

      const sampleFileContent = await readFile(fixture.sampleFilePath, "utf8");
      const sample = execInContainer(
        fixture,
        containerId,
        `cat ${quoteShell(path.posix.join(fixture.remoteWorkspaceFolder, "sample-file.txt"))}`,
      );
      expect(sample.stdout).toBe(sampleFileContent);

      const down = runCli(fixture, ["down"]);
      expect(down.exitCode).toBe(0);
      expect(down.stdout).toContain("Removed 1 managed container(s).");
      expect(await listManagedContainerIds(fixture)).toEqual([]);
    },
    { timeout: 8 * 60_000 },
  );

  liveTest(
    "smoke workspace exercises the real docker-in-docker devcontainer path",
    async () => {
      const fixture = await setupLiveFixture("smoke-workspace");
      const up = runCli(fixture, ["up", String(fixture.port), "--allow-missing-ssh"]);

      expect(up.exitCode).toBe(0);
      expect(up.stdout).toContain(`Using port ${fixture.port}.`);
      expect(up.stdout).toContain("Devcontainer is ready");
      expect(up.stdout).toContain("SSH server:");
      expect(up.stdout).toContain("Ready.");
      expect(up.stderr).toContain("Continuing without SSH agent sharing.");

      const state = await readJson(fixture.statePath);
      const containerId = String(state.lastContainerId);
      expect(state.port).toBe(fixture.port);

      const inspect = inspectContainer(fixture, containerId);
      expect(inspect.Name).toBe(`/${getManagedContainerName(fixture.workspacePath, fixture.port)}`);
      expect(inspect.Config?.Labels).toEqual(expect.objectContaining(state.labels));
      expect(getPublishedHostPort(inspect, fixture.port)).toBe(String(fixture.port));

      const sampleFileContent = await readFile(fixture.sampleFilePath, "utf8");
      const sample = execInContainer(
        fixture,
        containerId,
        `cat ${quoteShell(path.posix.join(fixture.remoteWorkspaceFolder, "sample-file.txt"))}`,
      );
      expect(sample.stdout).toBe(sampleFileContent);

      const featureChecks = execInContainer(
        fixture,
        containerId,
        "docker --version >/dev/null",
      );
      expect(featureChecks.exitCode).toBe(0);

      expect(existsSync(getWorkspaceRunnerHostKeysDir(fixture.workspacePath))).toBe(true);

      const runnerCredContent = await readFile(fixture.runnerCredPath, "utf8");
      expect(runnerCredContent.trim().length).toBeGreaterThan(0);
      const runnerMetadata = await readJson(fixture.runnerMetadataPath);
      expectRunnerMetadata(runnerMetadata, fixture.port);

      const down = runCli(fixture, ["down"]);
      expect(down.exitCode).toBe(0);
      expect(down.stdout).toContain("Removed 1 managed container(s).");
      expect(await listManagedContainerIds(fixture)).toEqual([]);
      expect(existsSync(fixture.runnerCredPath)).toBe(true);
      expect(existsSync(fixture.runnerMetadataPath)).toBe(true);
      expect(existsSync(getWorkspaceRunnerHostKeysDir(fixture.workspacePath))).toBe(true);
      expect(existsSync(fixture.statePath)).toBe(true);
    },
    { timeout: 8 * 60_000 },
  );

  liveTest(
    "complex workspace exercises real features and host integration",
    async () => {
      const fixture = await setupLiveFixture("complex-workspace", {
        forceNoDockerDesktopHostService: false,
        ghToken: "ghs_live_example_token",
        gitIdentity: {
          name: "Example Author",
          email: "example@author.test",
        },
        knownHosts: "github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKnownHostsEntry\n",
        requireSshAuthSock: true,
      });
      const up = runCli(fixture, ["up", String(fixture.port)]);

      expect(up.exitCode).toBe(0);
      expect(up.stdout).toContain(`Using port ${fixture.port}.`);
      expect(
        up.stdout.includes("Using host SSH agent socket from ") ||
          up.stdout.includes("Using Docker Desktop SSH agent sharing."),
      ).toBe(true);
      expect(up.stdout).toContain("Using host GitHub authentication from gh.");
      expect(up.stdout).toContain("Syncing Git author identity from the host into the devcontainer...");
      expect(up.stdout).toContain("SSH server:");
      expect(up.stdout).toContain("Ready.");

      const state = await readJson(fixture.statePath);
      const firstContainerId = String(state.lastContainerId);
      expect(state.port).toBe(fixture.port);

      const inspect = inspectContainer(fixture, firstContainerId);
      expect(inspect.Name).toBe(`/${getManagedContainerName(fixture.workspacePath, fixture.port)}`);
      expect(inspect.Config?.Labels).toEqual(expect.objectContaining(state.labels));
      expect(getPublishedHostPort(inspect, fixture.port)).toBe(String(fixture.port));

      const sampleFileContent = await readFile(fixture.sampleFilePath, "utf8");
      const sample = execInContainer(
        fixture,
        firstContainerId,
        `cat ${quoteShell(path.posix.join(fixture.remoteWorkspaceFolder, "sample-file.txt"))}`,
      );
      expect(sample.stdout).toBe(sampleFileContent);

      const featureChecks = execInContainer(
        fixture,
        firstContainerId,
        "node --version >/dev/null && terraform version >/dev/null && az version >/dev/null && docker --version >/dev/null",
      );
      expect(featureChecks.exitCode).toBe(0);

      expect(existsSync(getWorkspaceRunnerHostKeysDir(fixture.workspacePath))).toBe(true);

      const ghTokenInContainer = execInContainer(fixture, firstContainerId, 'printf "%s" "${GH_TOKEN:-}"');
      expect(ghTokenInContainer.stdout).toBe("ghs_live_example_token");

      const gitUserNameInContainer = execInContainer(fixture, firstContainerId, "git config --global --get user.name");
      expect(gitUserNameInContainer.stdout.trim()).toBe("Example Author");

      const gitUserEmailInContainer = execInContainer(fixture, firstContainerId, "git config --global --get user.email");
      expect(gitUserEmailInContainer.stdout.trim()).toBe("example@author.test");

      const knownHostsInContainer = execInContainer(fixture, firstContainerId, "cat ~/.ssh/known_hosts");
      const knownHostsContent = fixture.knownHostsContent;
      if (knownHostsContent === null) {
        throw new Error("Expected known_hosts content.");
      }
      expect(knownHostsInContainer.stdout).toBe(knownHostsContent);

      const sshAuthSockInContainer = execInContainer(
        fixture,
        firstContainerId,
        'printf "%s" "${SSH_AUTH_SOCK:-}" && test -S "${SSH_AUTH_SOCK:-/missing}"',
      );
      expect(sshAuthSockInContainer.exitCode).toBe(0);
      const expectedContainerSshAuthSockPath = fixture.expectedContainerSshAuthSockPath;
      if (expectedContainerSshAuthSockPath === null) {
        throw new Error("Expected a container SSH auth sock path.");
      }
      expect(sshAuthSockInContainer.stdout).toBe(expectedContainerSshAuthSockPath);

      const hostKeyInContainer = execInContainerAsRoot(fixture, firstContainerId, "find /etc/ssh -maxdepth 1 -type f -name 'ssh_host_*_key' | head -n 1");
      expect(hostKeyInContainer.stdout.trim().length).toBeGreaterThan(0);

      const runnerCredContent = await readFile(fixture.runnerCredPath, "utf8");
      expect(runnerCredContent.trim().length).toBeGreaterThan(0);
      const runnerMetadata = await readJson(fixture.runnerMetadataPath);
      expectRunnerMetadata(runnerMetadata, fixture.port);

      const rebuild = runCli(fixture, ["rebuild"]);
      expect(rebuild.exitCode).toBe(0);
      expect(rebuild.stdout).toContain(`Using port ${fixture.port}.`);
      expect(rebuild.stdout).toContain("Ready.");

      const rebuiltState = await readJson(fixture.statePath);
      const rebuiltContainerId = String(rebuiltState.lastContainerId);
      expect(rebuiltState.port).toBe(fixture.port);
      expect(rebuiltContainerId).not.toBe(firstContainerId);
      const restoredHostKey = execInContainerAsRoot(fixture, rebuiltContainerId, "find /etc/ssh -maxdepth 1 -type f -name 'ssh_host_*_key' | head -n 1");
      expect(restoredHostKey.stdout.trim().length).toBeGreaterThan(0);

      const down = runCli(fixture, ["down"]);
      expect(down.exitCode).toBe(0);
      expect(down.stdout).toContain("Removed 1 managed container(s).");
      expect(await listManagedContainerIds(fixture)).toEqual([]);
      expect(existsSync(fixture.runnerMetadataPath)).toBe(true);
      expect(existsSync(getWorkspaceRunnerHostKeysDir(fixture.workspacePath))).toBe(true);
      expect(existsSync(fixture.statePath)).toBe(true);
    },
    { timeout: 12 * 60_000 },
  );

  liveAriseTest(
    "arise restarts a stopped managed workspace using real docker containers",
    async () => {
      const fixture = await setupLiveFixture("smoke-workspace", {
        requireSshAuthSock: true,
        useFallbackDevcontainer: true,
      });
      const up = runCli(fixture, ["up", String(fixture.port)]);
      expect(up.exitCode).toBe(0);

      const initialState = await readJson(fixture.statePath);
      const initialContainerId = String(initialState.lastContainerId);
      expect(inspectContainer(fixture, initialContainerId).State?.Running).toBe(true);

      runCommand(["docker", "stop", initialContainerId], {
        cwd: fixture.workspacePath,
        env: fixture.env,
      });

      const stoppedInspect = inspectContainer(fixture, initialContainerId);
      expect(stoppedInspect.State?.Running).toBe(false);
      expect(existsSync(fixture.runnerMetadataPath)).toBe(true);
      expect(existsSync(getWorkspaceRunnerHostKeysDir(fixture.workspacePath))).toBe(true);

      const arise = runCommand([process.execPath, "run", cliPath, "arise"], {
        cwd: repoRoot,
        env: fixture.env,
      });

      expect(arise.exitCode).toBe(0);
      expect(arise.stdout).toContain("Scanning for stopped managed devbox containers...");
      expect(arise.stdout).toContain(`Recovered ${fixture.workspacePath}`);
      expect(arise.stdout).toContain(`Running \`devbox up\` again for ${fixture.workspacePath}...`);
      expect(arise.stdout).toMatch(/Arise summary: restarted \d+, skipped \d+ workspace\(s\), ignored \d+ container\(s\), failed 0\./);

      const restartedState = await readJson(fixture.statePath);
      const restartedContainerId = String(restartedState.lastContainerId);
      const restartedInspect = inspectContainer(fixture, restartedContainerId);
      expect(restartedInspect.State?.Running).toBe(true);
      expect(getPublishedHostPort(restartedInspect, fixture.port)).toBe(String(fixture.port));
      expect(
        restartedInspect.Mounts?.some(
          (mount) =>
            mount.Type === "bind" &&
            mount.Source === fixture.workspacePath &&
            mount.Destination === fixture.remoteWorkspaceFolder,
        ),
      ).toBe(true);
      expect(existsSync(getWorkspaceRunnerHostKeysDir(fixture.workspacePath))).toBe(true);

      const sample = execInContainer(
        fixture,
        restartedContainerId,
        `cat ${quoteShell(path.posix.join(fixture.remoteWorkspaceFolder, "sample-file.txt"))}`,
      );
      expect(sample.exitCode).toBe(0);
      expect(sample.stdout).toBe(await readFile(fixture.sampleFilePath, "utf8"));

      const down = runCli(fixture, ["down"]);
      expect(down.exitCode).toBe(0);
    },
    { timeout: 8 * 60_000 },
  );
});

async function setupLiveFixture(exampleName: string, options: LiveFixtureOptions = {}): Promise<LiveFixture> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "devbox-live-example-"));
  tempPaths.push(tempDir);
  const tempRoot = await realpath(tempDir);

  const workspaceCopyPath = path.join(tempRoot, exampleName);
  await cp(path.join(repoRoot, "examples", exampleName), workspaceCopyPath, { recursive: true });
  await resetWorkspaceArtifacts(workspaceCopyPath);

  runCommand(["git", "init", workspaceCopyPath]);
  if (options.gitIdentity) {
    runCommand(["git", "-C", workspaceCopyPath, "config", "user.name", options.gitIdentity.name]);
  runCommand(["git", "-C", workspaceCopyPath, "config", "user.email", options.gitIdentity.email]);
  }

  const workspacePath = await realpath(workspaceCopyPath);
  const homeDir = path.join(tempRoot, "home");
  await mkdir(homeDir, { recursive: true });

  if (options.knownHosts !== undefined) {
    const sshDir = path.join(homeDir, ".ssh");
    await mkdir(sshDir, { recursive: true });
    await writeFile(path.join(sshDir, "known_hosts"), options.knownHosts, "utf8");
  }

  const forceNoDockerDesktopHostService = options.forceNoDockerDesktopHostService ?? !options.requireSshAuthSock;
  const wrappersDir = path.join(tempRoot, "bin");
  const fallbackDevcontainerImage = options.useFallbackDevcontainer ? resolveFallbackDevcontainerImage(exampleName) : null;
  await createHostToolWrappers(wrappersDir, {
    fallbackDevcontainerImage,
    forceNoDockerDesktopHostService,
  });

  const useDockerDesktopHostService = options.requireSshAuthSock && !forceNoDockerDesktopHostService && isDockerDesktopHost();

  let sshAuthSockServer: Server | null = null;
  let sshAuthSockPath: string | null = null;
  if (options.requireSshAuthSock && !useDockerDesktopHostService) {
    sshAuthSockPath = path.join(tempRoot, "ssh-auth.sock");
    sshAuthSockServer = await startUnixSocketServer(sshAuthSockPath);
  }

  const remoteWorkspaceFolder = getDefaultRemoteWorkspaceFolder(workspacePath);

  const env = baseEnv();
  env.DEVBOX_TEST_GH_TOKEN = options.ghToken ?? "";
  env.HOME = homeDir;
  env.PATH = `${wrappersDir}${path.delimiter}${env.PATH}`;
  env.SSH_AUTH_SOCK = sshAuthSockPath ?? "";
  const dockerConfig = resolveHostDockerConfig();
  if (dockerConfig) {
    env.DOCKER_CONFIG = dockerConfig;
  }

  const fixture: LiveFixture = {
    env,
    expectedContainerSshAuthSockPath: options.requireSshAuthSock
      ? (useDockerDesktopHostService ? DOCKER_DESKTOP_SSH_AUTH_SOCK_SOURCE : SSH_AUTH_SOCK_TARGET)
      : null,
    knownHostsContent: options.knownHosts ?? null,
    port: await findAvailablePort(),
    remoteWorkspaceFolder,
    runnerArtifacts: {
      knownHosts: path.join(workspacePath, ".devbox-test-known-hosts"),
    },
    runnerCredPath: getWorkspaceRunnerCredentialFile(workspacePath),
    runnerMetadataPath: getWorkspaceSshMetadataFile(workspacePath),
    sampleFilePath: path.join(workspacePath, "sample-file.txt"),
    sshAuthSockPath,
    statePath: getStatePath(workspacePath),
    workspacePath,
  };

  cleanupTasks.push(async () => {
    await forceDown(fixture);
    if (sshAuthSockServer) {
      await closeServer(sshAuthSockServer);
    }
  });

  return fixture;
}

function runCli(fixture: LiveFixture, args: string[], allowFailure = false): CommandResult {
  return runCommand([process.execPath, "run", cliPath, ...args], {
    allowFailure,
    cwd: fixture.workspacePath,
    env: fixture.env,
  });
}

function execInContainer(fixture: LiveFixture, containerId: string, script: string): CommandResult {
  return runCommand(["devcontainer", "exec", "--container-id", containerId, "sh", "-lc", script], {
    cwd: fixture.workspacePath,
    env: fixture.env,
  });
}

function execInContainerAsRoot(fixture: LiveFixture, containerId: string, script: string): CommandResult {
  return runCommand(["docker", "exec", "--user", "root", containerId, "sh", "-lc", script], {
    cwd: fixture.workspacePath,
    env: fixture.env,
  });
}

function inspectContainer(fixture: LiveFixture, containerId: string): DockerInspect {
  const result = runCommand(["docker", "inspect", containerId], {
    cwd: fixture.workspacePath,
    env: fixture.env,
  });
  return (JSON.parse(result.stdout) as DockerInspect[])[0];
}

async function forceDown(fixture: LiveFixture): Promise<void> {
  runCli(fixture, ["down"], true);

  const containerIds = await listManagedContainerIds(fixture);
  if (containerIds.length > 0) {
    runCommand(["docker", "rm", "--force", ...containerIds], {
      allowFailure: true,
      cwd: fixture.workspacePath,
      env: fixture.env,
    });
  }
}

async function listManagedContainerIds(fixture: LiveFixture): Promise<string[]> {
  const result = runCommand(
    [
      "docker",
      "ps",
      "-aq",
      "--filter",
      `label=${MANAGED_LABEL_KEY}=true`,
      "--filter",
      `label=${WORKSPACE_LABEL_KEY}=${hashWorkspacePath(fixture.workspacePath)}`,
    ],
    {
      allowFailure: true,
      cwd: fixture.workspacePath,
      env: fixture.env,
    },
  );

  return result.stdout
    .split(/\s+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function getPublishedHostPort(container: DockerInspect, port: number): string | undefined {
  return container.NetworkSettings?.Ports?.[`${port}/tcp`]?.[0]?.HostPort;
}

function runCommand(
  command: string[],
  options?: {
    allowFailure?: boolean;
    cwd?: string;
    env?: Record<string, string>;
  },
): CommandResult {
  const result = Bun.spawnSync(command, {
    cwd: options?.cwd,
    env: options?.env,
    stderr: "pipe",
    stdout: "pipe",
  });
  const output: CommandResult = {
    exitCode: result.exitCode ?? 1,
    stderr: Buffer.from(result.stderr).toString("utf8"),
    stdout: Buffer.from(result.stdout).toString("utf8"),
  };

  if (output.exitCode !== 0 && !options?.allowFailure) {
    throw new Error(
      `Command failed: ${command.join(" ")}\nstdout:\n${output.stdout || "<empty>"}\nstderr:\n${output.stderr || "<empty>"}`,
    );
  }

  return output;
}

function canRunLivePrerequisites(): boolean {
  return canRunCommand(["docker", "info"]) && canRunCommand(["docker", "ps", "-q"]) && canRunCommand(["devcontainer", "--version"]);
}

function canRunAriseLivePrerequisites(): boolean {
  return canRunCommand(["docker", "info"]) &&
    canRunCommand(["docker", "ps", "-q"]) &&
    (canRunCommand(["devcontainer", "--version"]) || resolveFallbackDevcontainerImage("smoke-workspace") !== null);
}

function isDockerDesktopHost(): boolean {
  try {
    const result = Bun.spawnSync(["docker", "info", "--format", "{{.OperatingSystem}}"], {
      stderr: "pipe",
      stdout: "pipe",
    });
    if ((result.exitCode ?? 1) !== 0) {
      return false;
    }

    return Buffer.from(result.stdout).toString("utf8").toLowerCase().includes("docker desktop");
  } catch {
    return false;
  }
}

function canRunCommand(command: string[]): boolean {
  try {
    const result = Bun.spawnSync(command, {
      stderr: "pipe",
      stdout: "pipe",
    });
    return (result.exitCode ?? 1) === 0;
  } catch {
    return false;
  }
}

function resolveFallbackDevcontainerImage(exampleName: string): string | null {
  const result = Bun.spawnSync(["docker", "image", "ls", "--format", "{{.Repository}}:{{.Tag}}"], {
    stderr: "pipe",
    stdout: "pipe",
  });
  if ((result.exitCode ?? 1) !== 0) {
    return null;
  }

  const images = Buffer.from(result.stdout)
    .toString("utf8")
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);

  const preferredPatterns =
    exampleName === "complex-workspace"
      ? [/^vsc-complex-workspace-.*-features:latest$/, /^vsc-complex-workspace-.*-features-uid:latest$/]
      : [
          /^vsc-workspace-.*-features:latest$/,
          /^vsc-workspace-.*-features-uid:latest$/,
          /^vsc-complex-workspace-.*-features:latest$/,
          /^vsc-complex-workspace-.*-features-uid:latest$/,
        ];

  for (const pattern of preferredPatterns) {
    const match = images.find((image) => pattern.test(image));
    if (match) {
      return match;
    }
  }

  return images.find((image) => /^vsc-.*-features(?:-uid)?:latest$/.test(image)) ?? null;
}

async function resetWorkspaceArtifacts(workspacePath: string): Promise<void> {
  await rm(getWorkspaceRunnerCredentialFile(workspacePath), { force: true });
  await rm(getWorkspaceRunnerHostKeysDir(workspacePath), { force: true, recursive: true });
  await rm(path.join(workspacePath, ".devcontainer", ".devcontainer.json"), { force: true });
}

async function createHostToolWrappers(
  wrappersDir: string,
  options: { fallbackDevcontainerImage: string | null; forceNoDockerDesktopHostService: boolean },
): Promise<void> {
  await mkdir(wrappersDir, { recursive: true });

  if (options.forceNoDockerDesktopHostService) {
    const realDockerPath = findExecutable("docker");
    if (!realDockerPath) {
      throw new Error("docker was not found in PATH.");
    }

    const dockerWrapperPath = path.join(wrappersDir, "docker");
    await writeFile(
      dockerWrapperPath,
      `#!/bin/sh
if [ "$1" = "info" ] && [ "$2" = "--format" ] && [ "$3" = "{{.OperatingSystem}}" ]; then
  printf '%s\\n' 'Docker Engine'
  exit 0
fi
exec ${quoteShell(realDockerPath)} "$@"
`,
      "utf8",
    );
    await chmod(dockerWrapperPath, 0o755);
  }

  if (options.fallbackDevcontainerImage) {
    const realDockerPath = findExecutable("docker");
    if (!realDockerPath) {
      throw new Error("docker was not found in PATH.");
    }

    const devcontainerWrapperPath = path.join(wrappersDir, "devcontainer");
    await writeFile(
      devcontainerWrapperPath,
      buildFallbackDevcontainerWrapper(realDockerPath, options.fallbackDevcontainerImage),
      "utf8",
    );
    await chmod(devcontainerWrapperPath, 0o755);
  }

  const ghWrapperPath = path.join(wrappersDir, "gh");
  await writeFile(
    ghWrapperPath,
    `#!/bin/sh
if [ "$1" = "auth" ] && [ "$2" = "token" ]; then
  if [ -n "\${DEVBOX_TEST_GH_TOKEN:-}" ]; then
    printf '%s\\n' "$DEVBOX_TEST_GH_TOKEN"
    exit 0
  fi

  printf '%s\\n' 'Run gh auth login to authenticate.' >&2
  exit 1
fi

printf '%s\\n' 'Unsupported gh command for live example tests.' >&2
exit 1
`,
    "utf8",
  );
  await chmod(ghWrapperPath, 0o755);
}

function buildFallbackDevcontainerWrapper(realDockerPath: string, image: string): string {
  return `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const docker = ${JSON.stringify(realDockerPath)};
const fallbackImage = ${JSON.stringify(image)};
const args = process.argv.slice(2);

function fail(message) {
  process.stderr.write(message + "\\n");
  process.exit(1);
}

function run(commandArgs, options = {}) {
  const result = spawnSync(commandArgs[0], commandArgs.slice(1), {
    cwd: options.cwd,
    encoding: "utf8",
    env: process.env,
    stdio: options.capture === false ? "inherit" : ["ignore", "pipe", "pipe"],
  });
  if ((result.status ?? 1) !== 0) {
    if (result.stdout) {
      process.stdout.write(result.stdout);
    }
    if (result.stderr) {
      process.stderr.write(result.stderr);
    }
    process.exit(result.status ?? 1);
  }
  return result;
}

function parseFlagValues(name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name) {
      values.push(args[index + 1]);
      index += 1;
    }
  }
  return values;
}

function parseMount(spec) {
  return Object.fromEntries(
    spec.split(",").map((entry) => {
      const separator = entry.indexOf("=");
      return separator === -1 ? [entry, ""] : [entry.slice(0, separator), entry.slice(separator + 1)];
    }),
  );
}

function getContainerName(runArgs) {
  for (let index = 0; index < runArgs.length; index += 1) {
    if (runArgs[index] === "--name" && runArgs[index + 1]) {
      return runArgs[index + 1];
    }
  }
  return null;
}

function expandEnv(value) {
  if (typeof value !== "string") {
    return "";
  }
  const match = value.match(/^\\$\\{localEnv:([^}]+)\\}$/);
  return match ? process.env[match[1]] ?? "" : value;
}

if (args.length === 1 && args[0] === "--version") {
  process.stdout.write("devcontainer test wrapper\\n");
  process.exit(0);
}

if (args[0] === "exec") {
  let containerId = null;
  let index = 1;
  while (index < args.length) {
    const current = args[index];
    if (current === "--container-id") {
      containerId = args[index + 1];
      index += 2;
      continue;
    }
    if (current === "--terminal-columns" || current === "--terminal-rows") {
      index += 2;
      continue;
    }
    break;
  }

  if (!containerId) {
    fail("Missing --container-id");
  }

  const result = spawnSync(docker, ["exec", containerId, ...args.slice(index)], {
    encoding: "utf8",
    env: process.env,
    stdio: "inherit",
  });
  process.exit(result.status ?? 1);
}

if (args[0] !== "up") {
  fail("Unsupported devcontainer test wrapper command: " + args.join(" "));
}

const workspaceFolder = parseFlagValues("--workspace-folder")[0];
const configPath = parseFlagValues("--config")[0];
const labels = parseFlagValues("--id-label");

if (!workspaceFolder || !configPath) {
  fail("Missing required up arguments.");
}

const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const runArgs = Array.isArray(config.runArgs) ? config.runArgs.map(String) : [];
const mounts = Array.isArray(config.mounts) ? config.mounts.map(String) : [];
const containerEnv = config.containerEnv && typeof config.containerEnv === "object" ? config.containerEnv : {};
const containerName = getContainerName(runArgs);
if (!containerName) {
  fail("Managed config did not include a container name.");
}

const remoteWorkspaceFolder = path.posix.join("/workspaces", path.basename(workspaceFolder));
const existing = run([docker, "ps", "-aq", "--filter", "name=^/" + containerName + "$"]);
let containerId = existing.stdout.trim().split(/\\s+/).filter(Boolean)[0];

if (containerId) {
  const running = run([docker, "inspect", "-f", "{{.State.Running}}", containerId]).stdout.trim();
  if (running !== "true") {
    run([docker, "start", containerId], { capture: false });
  }
} else {
  const dockerArgs = [docker, "run", "-d", "--init", "--name", containerName, "-w", remoteWorkspaceFolder];
  for (const label of labels) {
    dockerArgs.push("--label", label);
  }
  dockerArgs.push("--mount", "type=bind,source=" + workspaceFolder + ",target=" + remoteWorkspaceFolder);

  for (const mount of mounts) {
    const parsed = parseMount(mount);
    if (parsed.type === "bind" && parsed.source && parsed.target) {
      dockerArgs.push("--mount", "type=bind,source=" + parsed.source + ",target=" + parsed.target);
    }
  }

  for (let index = 0; index < runArgs.length; index += 1) {
    const current = runArgs[index];
    if (current === "--name") {
      index += 1;
      continue;
    }
    dockerArgs.push(current);
  }

  for (const [key, value] of Object.entries(containerEnv)) {
    dockerArgs.push("--env", key + "=" + expandEnv(String(value)));
  }

  dockerArgs.push(fallbackImage, "sh", "-lc", "trap 'exit 0' TERM INT; while :; do sleep 5; done");
  const created = run(dockerArgs);
  containerId = created.stdout.trim().split(/\\s+/).filter(Boolean)[0];
}

process.stdout.write(JSON.stringify({ type: "start", text: "Starting container" }) + "\\n");
process.stdout.write(JSON.stringify({ containerId, outcome: "success", remoteWorkspaceFolder }) + "\\n");
`;
}

async function startUnixSocketServer(socketPath: string): Promise<Server> {
  const server = createServer((socket) => {
    socket.end();
  });

  return await new Promise<Server>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

async function findAvailablePort(): Promise<number> {
  const server = createServer();
  return await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Could not determine an ephemeral port."));
        return;
      }

      const selectedPort = address.port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(selectedPort);
      });
    });
  });
}

function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }

  return env;
}

function getStatePath(workspacePath: string): string {
  return path.join(workspacePath, ".devbox", "state.json");
}

function findExecutable(command: string): string | null {
  const pathValue = process.env.PATH ?? "";
  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) {
      continue;
    }

    const candidate = path.join(directory, command);
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function resolveHostDockerConfig(): string | null {
  if (process.env.DOCKER_CONFIG && existsSync(process.env.DOCKER_CONFIG)) {
    return process.env.DOCKER_CONFIG;
  }

  const home = process.env.HOME;
  if (!home) {
    return null;
  }

  const dockerConfig = path.join(home, ".docker");
  return existsSync(dockerConfig) ? dockerConfig : null;
}

async function readJson(filePath: string): Promise<any> {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function expectRunnerMetadata(metadata: any, port: number): void {
  expect(typeof metadata.sshUser).toBe("string");
  expect(metadata.sshUser.length).toBeGreaterThan(0);
  expect(metadata.sshPort).toBe(port);
  expect(metadata.permitRootLogin).toBe(metadata.sshUser === "root");
}
