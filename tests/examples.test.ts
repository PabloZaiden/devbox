import { chmod, cp, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { KNOWN_HOSTS_SNAPSHOT_FILENAME, SSH_AUTH_SOCK_TARGET } from "../src/constants";
import { hashWorkspacePath } from "../src/core";
import { buildInteractiveShellScript } from "../src/runtime";

const repoRoot = process.cwd();
const cliPath = path.join(repoRoot, "src", "cli.ts");
const tempPaths: string[] = [];

interface ExampleFixtureOptions {
  ghToken?: string;
  gitIdentity?: {
    name: string;
    email: string;
  };
  knownHosts?: string;
  sshAuthSock?: boolean;
}

interface ExampleFixture {
  commandLogPath: string;
  env: Record<string, string>;
  generatedConfigPath: string;
  homeDir: string;
  sourceConfigPath: string;
  sshAuthSockPath: string | null;
  statePath: string;
  userDataDir: string;
  workspacePath: string;
}

interface CliResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

interface LoggedCommand {
  args: string[];
  containerId?: string;
  script?: string;
  tool: string;
}

const FAKE_HOST_TOOL = String.raw`#!/usr/bin/env bun
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const tool = process.env.DEVBOX_FAKE_TOOL;
const root = process.env.DEVBOX_FAKE_HOST_DIR;

if (!tool) {
  console.error("DEVBOX_FAKE_TOOL is required");
  process.exit(1);
}

if (!root) {
  console.error("DEVBOX_FAKE_HOST_DIR is required");
  process.exit(1);
}

mkdirSync(root, { recursive: true });

const args = process.argv.slice(2);
const statePath = path.join(root, "state.json");
const logPath = path.join(root, "commands.jsonl");

function loadState() {
  if (!existsSync(statePath)) {
    return { nextId: 1, containers: {} };
  }

  return JSON.parse(readFileSync(statePath, "utf8"));
}

function saveState(state) {
  writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf8");
}

function log(extra = {}) {
  appendFileSync(logPath, JSON.stringify({ tool, args, ...extra }) + "\n", "utf8");
}

function parseLabels(inputArgs) {
  const labels = {};
  for (let index = 0; index < inputArgs.length; index += 1) {
    if (inputArgs[index] !== "--id-label") {
      continue;
    }

    const entry = inputArgs[index + 1] ?? "";
    const separatorIndex = entry.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    labels[entry.slice(0, separatorIndex)] = entry.slice(separatorIndex + 1);
    index += 1;
  }

  return labels;
}

function getFlagValue(inputArgs, name) {
  const index = inputArgs.indexOf(name);
  if (index === -1) {
    return undefined;
  }

  return inputArgs[index + 1];
}

function getContainerName(runArgs, fallbackName) {
  const index = runArgs.indexOf("--name");
  if (index === -1) {
    return fallbackName;
  }

  return String(runArgs[index + 1] ?? fallbackName);
}

function getPublishedPort(runArgs) {
  const index = runArgs.indexOf("-p");
  if (index === -1) {
    return undefined;
  }

  const mapping = String(runArgs[index + 1] ?? "");
  const hostPort = Number(mapping.split(":")[0]);
  return Number.isInteger(hostPort) ? hostPort : undefined;
}

function buildInspectPayload(container) {
  const ports = {};
  if (container.port !== undefined) {
    ports[String(container.port) + "/tcp"] = [{ HostIp: "0.0.0.0", HostPort: String(container.port) }];
  }

  return {
    Id: container.id,
    Name: "/" + container.name,
    Config: {
      Labels: container.labels,
    },
    State: {
      Running: container.running,
      Status: container.running ? "running" : "exited",
    },
    NetworkSettings: {
      Ports: ports,
    },
  };
}

function handleLsof() {
  log();
  process.exit(1);
}

function handleGh() {
  log();
  if (args[0] === "auth" && args[1] === "token") {
    if (process.env.DEVBOX_FAKE_GH_MODE === "token") {
      console.log(process.env.DEVBOX_FAKE_GH_TOKEN || "ghs_example_token");
      return;
    }

    console.error("Run gh auth login to authenticate.");
    process.exit(1);
  }

  console.error("Unsupported fake gh command: " + args.join(" "));
  process.exit(1);
}

function handleDocker() {
  const state = loadState();
  log();

  if (args[0] === "info") {
    console.log("Docker Engine");
    return;
  }

  if (args[0] === "ps") {
    const filters = [];
    for (let index = 1; index < args.length; index += 1) {
      if (args[index] !== "--filter") {
        continue;
      }

      filters.push(String(args[index + 1] ?? ""));
      index += 1;
    }

    const containers = Object.values(state.containers).filter((container) =>
      filters.every((filter) => {
        const match = filter.match(/^label=([^=]+)=(.*)$/);
        if (!match) {
          return true;
        }

        return container.labels?.[match[1]] === match[2];
      }),
    );

    console.log(containers.map((container) => container.id).join("\n"));
    return;
  }

  if (args[0] === "inspect") {
    const payload = args.slice(1).map((containerId) => buildInspectPayload(state.containers[containerId])).filter(Boolean);
    console.log(JSON.stringify(payload));
    return;
  }

  if (args[0] === "rm") {
    const containerIds = args.filter((arg) => !arg.startsWith("-")).slice(1);
    for (const containerId of containerIds) {
      delete state.containers[containerId];
    }

    saveState(state);
    console.log(containerIds.join("\n"));
    return;
  }

  if (args[0] === "cp") {
    return;
  }

  if (args[0] === "exec") {
    let user;
    let index = 1;

    while (index < args.length && args[index].startsWith("-")) {
      if (args[index] === "--user") {
        user = args[index + 1];
        index += 2;
        continue;
      }

      index += 1;
    }

    const containerId = args[index];
    const script = args[args.length - 1] ?? "";
    log({ containerId, script, user });
    return;
  }

  console.error("Unsupported fake docker command: " + args.join(" "));
  process.exit(1);
}

function handleDevcontainer() {
  const state = loadState();

  if (args[0] === "up") {
    const workspacePath = getFlagValue(args, "--workspace-folder");
    const configPath = getFlagValue(args, "--config");
    const userDataDir = getFlagValue(args, "--user-data-folder");

    if (!workspacePath || !configPath || !userDataDir) {
      console.error("Missing required fake devcontainer up arguments.");
      process.exit(1);
    }

    const config = JSON.parse(readFileSync(configPath, "utf8"));
    const runArgs = Array.isArray(config.runArgs) ? config.runArgs.map(String) : [];
    const containerId = "fake-container-" + state.nextId;
    const containerName = getContainerName(runArgs, "devbox-fake-" + state.nextId);
    const port = getPublishedPort(runArgs);
    const labels = parseLabels(args);
    const remoteWorkspaceFolder =
      typeof config.workspaceFolder === "string" && config.workspaceFolder.length > 0
        ? config.workspaceFolder
        : path.posix.join("/workspaces", path.basename(workspacePath));

    state.nextId += 1;
    state.containers[containerId] = {
      id: containerId,
      labels,
      name: containerName,
      port,
      remoteWorkspaceFolder,
      running: true,
      workspacePath,
    };
    mkdirSync(userDataDir, { recursive: true });
    saveState(state);
    log({ configPath, containerId, labels, workspacePath });

    console.log(JSON.stringify({ type: "start", text: "Resolving Remote" }));
    console.log(JSON.stringify({ type: "raw", text: "Container started" }));
    console.log(JSON.stringify({ type: "text", level: 1, text: 'LifecycleCommandExecutionMap: {"postCreateCommand":"mock"}' }));
    console.log(JSON.stringify({ outcome: "success", containerId, remoteWorkspaceFolder }));
    return;
  }

  if (args[0] === "exec") {
    const containerId = getFlagValue(args, "--container-id");
    const script = args[args.length - 1] ?? "";
    log({ containerId, script });

    if (script.includes("/run/devbox-known_hosts")) {
      console.log(process.env.DEVBOX_FAKE_KNOWN_HOSTS_MODE || "missing");
      return;
    }

    if (script.includes("SSH_PORT=") && script.includes("CRED_FILE=")) {
      const match = script.match(/SSH_PORT='([^']+)'/);
      const port = match ? match[1] : "22";
      const credFileMatch = script.match(/CRED_FILE='([^']+)'/);
      const credentialFile = credFileMatch ? credFileMatch[1] : null;
      const container = containerId ? state.containers[containerId] : null;
      if (credentialFile && container?.workspacePath && container?.remoteWorkspaceFolder) {
        const relativeCredentialPath = path.posix.relative(container.remoteWorkspaceFolder, credentialFile);
        const hostCredentialPath = path.join(container.workspacePath, relativeCredentialPath);
        mkdirSync(path.dirname(hostCredentialPath), { recursive: true });
        writeFileSync(
          hostCredentialPath,
          "password\n",
          "utf8",
        );
      }
      console.log("SSH user: root");
      console.log("SSH pass: password");
      console.log("SSH port: " + port);
      console.log("PermitRootLogin: yes");
      return;
    }

    return;
  }

  console.error("Unsupported fake devcontainer command: " + args.join(" "));
  process.exit(1);
}

switch (tool) {
  case "docker":
    handleDocker();
    break;
  case "devcontainer":
    handleDevcontainer();
    break;
  case "gh":
    handleGh();
    break;
  case "lsof":
    handleLsof();
    break;
  default:
    console.error("Unsupported fake tool: " + tool);
    process.exit(1);
}
`;

afterEach(async () => {
  await Promise.all(
    tempPaths.splice(0).map(async (tempPath) => {
      await rm(tempPath, { recursive: true, force: true });
    }),
  );
});

describe("example workspaces (simulated host tools)", () => {
  test("smoke workspace exercises up, shell, and down through the CLI", async () => {
    const fixture = await setupExampleFixture("smoke-workspace");
    const sourceBefore = await readFile(fixture.sourceConfigPath, "utf8");

    const up = runCli(fixture, ["up", "--allow-missing-ssh"]);
    expect(up.exitCode).toBe(0);
    expect(up.stdout).toContain("Using port 5001.");
    expect(up.stdout).toContain("Devcontainer is ready");
    expect(up.stdout).toContain("SSH server:");
    expect(up.stdout).toContain("Ready.");
    expect(up.stderr).toContain("Continuing without SSH agent sharing.");
    expect(existsSync(fixture.generatedConfigPath)).toBe(true);
    expect(await readFile(fixture.sourceConfigPath, "utf8")).toBe(sourceBefore);

    const generatedConfig = await readJson(fixture.generatedConfigPath);
    expect(generatedConfig.image).toBe("mcr.microsoft.com/devcontainers/base:ubuntu");
    expect(generatedConfig.runArgs).toEqual(["--name", "devbox-smoke-workspace-5001", "-p", "5001:5001"]);
    expect(generatedConfig.mounts).toEqual([]);
    expect(generatedConfig.containerEnv).toEqual({});

    const state = await readJson(fixture.statePath);
    expect(state.port).toBe(5001);
    expect(state.sourceConfigPath).toBe(fixture.sourceConfigPath);
    expect(state.generatedConfigPath).toBe(fixture.generatedConfigPath);

    const excludeContent = await readFile(path.join(fixture.workspacePath, ".git", "info", "exclude"), "utf8");
    expect(excludeContent).toContain("/.devcontainer/.devcontainer.json");
    expect(excludeContent).toContain("/.devbox-ssh.json");

    const shell = runCli(fixture, ["shell"]);
    expect(shell.exitCode).toBe(0);
    expect(shell.stdout).toContain("Opening shell inside ");

    const statusWhileRunning = runCli(fixture, ["status"]);
    expect(statusWhileRunning.exitCode).toBe(0);
    const runningStatus = JSON.parse(statusWhileRunning.stdout);
    expect(runningStatus.running).toBe(true);
    expect(runningStatus.port).toBe(5001);
    expect(runningStatus.password).toBe("password");
    expect(runningStatus.workdir).toBe("/workspaces/smoke-workspace");
    expect(runningStatus.containerCount).toBe(1);
    expect(runningStatus.hasStateFile).toBe(true);
    expect(runningStatus.hasCredentialFile).toBe(true);
    expect(runningStatus.hasSshMetadataFile).toBe(true);

    const commandsAfterShell = await readCommandLog(fixture.commandLogPath);
    expect(
      commandsAfterShell.some(
        (entry) => entry.tool === "devcontainer" && entry.args[0] === "exec" && entry.script === buildInteractiveShellScript(),
      ),
    ).toBe(true);

    const down = runCli(fixture, ["down"]);
    expect(down.exitCode).toBe(0);
    expect(down.stdout).toContain("Removed 1 managed container(s).");
    expect(existsSync(fixture.generatedConfigPath)).toBe(false);
    expect(existsSync(fixture.statePath)).toBe(false);

    const statusAfterDown = runCli(fixture, ["status"]);
    expect(statusAfterDown.exitCode).toBe(0);
    const stoppedStatus = JSON.parse(statusAfterDown.stdout);
    expect(stoppedStatus.running).toBe(false);
    expect(stoppedStatus.port).toBe(5001);
    expect(stoppedStatus.password).toBe("password");
    expect(stoppedStatus.hasStateFile).toBe(false);
    expect(stoppedStatus.hasCredentialFile).toBe(true);
    expect(stoppedStatus.hasSshMetadataFile).toBe(true);
  });

  test("complex workspace preserves features and supports rebuild via the CLI", async () => {
    const fixture = await setupExampleFixture("complex-workspace", {
      ghToken: "ghs_example_token",
      gitIdentity: {
        name: "Example Author",
        email: "example@author.test",
      },
      knownHosts: "github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeExampleKnownHost\n",
      sshAuthSock: true,
    });
    const sourceBefore = await readFile(fixture.sourceConfigPath, "utf8");

    const up = runCli(fixture, ["up"]);
    expect(up.exitCode).toBe(0);
    expect(up.stdout).toContain("Using port 5001.");
    expect(up.stdout).toContain("Using host SSH agent socket from ");
    expect(up.stdout).toContain("Using host GitHub authentication from gh.");
    expect(up.stdout).toContain("Syncing Git author identity from the host into the devcontainer...");
    expect(up.stdout).toContain("Ready.");
    expect(up.stderr).toBe("");

    const knownHostsSnapshotPath = path.join(fixture.userDataDir, KNOWN_HOSTS_SNAPSHOT_FILENAME);
    expect(existsSync(knownHostsSnapshotPath)).toBe(true);
    expect(await readFile(fixture.sourceConfigPath, "utf8")).toBe(sourceBefore);

    const generatedConfig = await readJson(fixture.generatedConfigPath);
    expect(generatedConfig.features).toEqual({
      "ghcr.io/devcontainers/features/azure-cli:1": {},
      "ghcr.io/devcontainers/features/docker-in-docker:2": {},
      "ghcr.io/devcontainers/features/node:1": {},
      "ghcr.io/devcontainers/features/terraform:1": {},
    });
    expect(generatedConfig.runArgs).toEqual(["--name", "devbox-complex-workspace-5001", "-p", "5001:5001"]);
    expect(generatedConfig.mounts).toEqual([`type=bind,source=${fixture.sshAuthSockPath},target=${SSH_AUTH_SOCK_TARGET}`]);
    expect(generatedConfig.containerEnv).toEqual({
      GH_TOKEN: "${localEnv:GH_TOKEN}",
      SSH_AUTH_SOCK: SSH_AUTH_SOCK_TARGET,
    });

    const initialState = await readJson(fixture.statePath);
    const commandsAfterUp = await readCommandLog(fixture.commandLogPath);
    expect(
      commandsAfterUp.some(
        (entry) =>
          entry.tool === "devcontainer" &&
          entry.args[0] === "exec" &&
          typeof entry.script === "string" &&
          entry.script.includes("git config --global user.name 'Example Author'"),
      ),
    ).toBe(true);

    const rebuild = runCli(fixture, ["rebuild"]);
    expect(rebuild.exitCode).toBe(0);
    expect(rebuild.stdout).toContain("Using port 5001.");
    expect(rebuild.stdout).toContain("Ready.");

    const rebuiltState = await readJson(fixture.statePath);
    expect(rebuiltState.port).toBe(5001);
    expect(rebuiltState.lastContainerId).not.toBe(initialState.lastContainerId);

    const down = runCli(fixture, ["down"]);
    expect(down.exitCode).toBe(0);
    expect(down.stdout).toContain("Removed 1 managed container(s).");
    expect(existsSync(fixture.generatedConfigPath)).toBe(false);
    expect(existsSync(fixture.statePath)).toBe(false);

    const commandsAfterDown = await readCommandLog(fixture.commandLogPath);
    expect(commandsAfterDown.filter((entry) => entry.tool === "docker" && entry.args[0] === "rm").length).toBeGreaterThanOrEqual(2);
  });
});

async function setupExampleFixture(exampleName: string, options: ExampleFixtureOptions = {}): Promise<ExampleFixture> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "devbox-example-test-"));
  tempPaths.push(tempDir);

  const workspaceCopyPath = path.join(tempDir, exampleName);
  await cp(path.join(repoRoot, "examples", exampleName), workspaceCopyPath, { recursive: true });
  await runHostCommand(["git", "init", workspaceCopyPath]);

  if (options.gitIdentity) {
    await runHostCommand(["git", "-C", workspaceCopyPath, "config", "user.name", options.gitIdentity.name]);
    await runHostCommand(["git", "-C", workspaceCopyPath, "config", "user.email", options.gitIdentity.email]);
  }

  const workspacePath = await realpath(workspaceCopyPath);
  const fakeHostDir = path.join(tempDir, "fake-host");
  const commandLogPath = await createFakeHostToolchain(fakeHostDir);
  const homeDir = path.join(tempDir, "home");
  await mkdir(homeDir, { recursive: true });

  if (options.knownHosts !== undefined) {
    const sshDir = path.join(homeDir, ".ssh");
    await mkdir(sshDir, { recursive: true });
    await writeFile(path.join(sshDir, "known_hosts"), options.knownHosts, "utf8");
  }

  let sshAuthSockPath: string | null = null;
  if (options.sshAuthSock) {
    sshAuthSockPath = path.join(tempDir, "agent.sock");
    await writeFile(sshAuthSockPath, "fake-agent\n", "utf8");
  }

  const xdgStateHome = path.join(tempDir, "state");
  const env = baseEnv();
  env.DEVBOX_FAKE_GH_MODE = options.ghToken ? "token" : "unauthenticated";
  env.DEVBOX_FAKE_GH_TOKEN = options.ghToken ?? "";
  env.DEVBOX_FAKE_HOST_DIR = fakeHostDir;
  env.DEVBOX_FAKE_KNOWN_HOSTS_MODE = options.knownHosts ? "copied" : "missing";
  env.HOME = homeDir;
  env.PATH = `${path.join(fakeHostDir, "bin")}${path.delimiter}${env.PATH}`;
  env.SSH_AUTH_SOCK = sshAuthSockPath ?? "";
  env.XDG_STATE_HOME = xdgStateHome;

  const stateDir = getStateDir(homeDir, workspacePath, xdgStateHome);
  return {
    commandLogPath,
    env,
    generatedConfigPath: path.join(workspacePath, ".devcontainer", ".devcontainer.json"),
    homeDir,
    sourceConfigPath: path.join(workspacePath, ".devcontainer", "devcontainer.json"),
    sshAuthSockPath,
    statePath: path.join(stateDir, "state.json"),
    userDataDir: path.join(stateDir, "user-data"),
    workspacePath,
  };
}

async function createFakeHostToolchain(fakeHostDir: string): Promise<string> {
  const binDir = path.join(fakeHostDir, "bin");
  await mkdir(binDir, { recursive: true });

  const toolPath = path.join(binDir, "_fake-host-tool.mjs");
  await writeFile(toolPath, FAKE_HOST_TOOL, "utf8");
  await chmod(toolPath, 0o755);

  for (const toolName of ["docker", "devcontainer", "gh", "lsof"]) {
    const wrapperPath = path.join(binDir, toolName);
    await writeFile(
      wrapperPath,
      `#!/bin/sh\nDEVBOX_FAKE_TOOL=${toolName} exec "$(dirname "$0")/_fake-host-tool.mjs" "$@"\n`,
      "utf8",
    );
    await chmod(wrapperPath, 0o755);
  }

  return path.join(fakeHostDir, "commands.jsonl");
}

function runCli(fixture: ExampleFixture, args: string[]): CliResult {
  const result = Bun.spawnSync([process.execPath, "run", cliPath, ...args], {
    cwd: fixture.workspacePath,
    env: fixture.env,
    stderr: "pipe",
    stdout: "pipe",
  });

  return {
    exitCode: result.exitCode,
    stderr: Buffer.from(result.stderr).toString("utf8"),
    stdout: Buffer.from(result.stdout).toString("utf8"),
  };
}

async function runHostCommand(command: string[]): Promise<void> {
  const result = Bun.spawnSync(command, {
    stderr: "pipe",
    stdout: "pipe",
  });

  if (result.exitCode !== 0) {
    const stderr = Buffer.from(result.stderr).toString("utf8");
    throw new Error(stderr || `Command failed: ${command.join(" ")}`);
  }
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

function getStateDir(homeDir: string, workspacePath: string, xdgStateHome?: string): string {
  let root: string;
  if (process.platform === "darwin") {
    root = path.join(homeDir, "Library", "Application Support", "devbox");
  } else if (xdgStateHome) {
    root = path.join(xdgStateHome, "devbox");
  } else {
    root = path.join(homeDir, ".local", "state", "devbox");
  }
  return path.join(root, "workspaces", hashWorkspacePath(workspacePath));
}

async function readJson(filePath: string): Promise<any> {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function readCommandLog(commandLogPath: string): Promise<LoggedCommand[]> {
  if (!existsSync(commandLogPath)) {
    return [];
  }

  const content = await readFile(commandLogPath, "utf8");
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LoggedCommand);
}
