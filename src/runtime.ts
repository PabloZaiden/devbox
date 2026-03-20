import { spawn } from "node:child_process";
import { access, appendFile, mkdir, readFile, realpath } from "node:fs/promises";
import { accessSync, constants as fsConstants } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { Readable } from "node:stream";
import {
  type DockerInspect,
  type UpResult,
  getContainerSshAuthSockPath,
  UserError,
  quoteShell,
} from "./core";
import {
  DOCKER_DESKTOP_SSH_AUTH_SOCK_SOURCE,
  KNOWN_HOSTS_TARGET,
  MANAGED_LABEL_KEY,
  RUNNER_CRED_FILENAME,
  RUNNER_HOST_KEYS_DIRNAME,
  RUNNER_URL,
  WORKSPACE_LABEL_KEY,
} from "./constants";
import { parseRunnerCredentials, type RunnerCredentials } from "./runnerState";

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

class CommandError extends Error {
  constructor(
    readonly command: string[],
    readonly result: ExecResult,
  ) {
    super(`Command failed: ${command.join(" ")}`);
    this.name = "CommandError";
  }
}

interface ExecOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  stdoutMode?: "capture" | "raw" | "devcontainer-json";
  stderrMode?: "capture" | "raw" | "devcontainer-json";
  allowFailure?: boolean;
}

interface ResolvedSshAuthSock {
  sshAuthSock: string | null;
  warning?: string;
}

export interface ResolvedHostEnvironment extends ResolvedSshAuthSock {
  gitUserName: string | null;
  gitUserEmail: string | null;
  githubToken: string | null;
  githubTokenWarning?: string;
}

export interface ResolvedGhCliToken {
  token: string | null;
  warning?: string;
}

export interface PortAvailability {
  available: boolean;
  pids: string[];
}

export function isExecutableAvailable(command: string): boolean {
  return findExecutableOnPath(command) !== null;
}

export function buildStopManagedSshdScript(): string {
  return [
    "pids=$(ps -eo pid=,comm= | while read -r pid comm; do",
    '  if [ "$comm" = "sshd" ]; then printf \'%s\\n\' "$pid"; fi',
    "done)",
    'if [ -n "$pids" ]; then kill $pids; fi',
  ].join("\n");
}

export function getRunnerCredFile(remoteWorkspaceFolder: string): string {
  const trimmed = remoteWorkspaceFolder.endsWith("/")
    ? remoteWorkspaceFolder.slice(0, -1)
    : remoteWorkspaceFolder;
  return `${trimmed}/${RUNNER_CRED_FILENAME}`;
}

export function getRunnerSummaryLines(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => /^(SSH user|SSH pass|SSH port|PermitRootLogin): /.test(line));
}

export function formatDevcontainerProgressLine(line: string): string | null {
  const cleaned = redactSensitiveOutput(stripAnsi(line)).trim();
  if (!cleaned) {
    return null;
  }

  if (
    looksLikeDevcontainerUserEnvProbeDump(cleaned) ||
    cleaned.startsWith("bash: cannot set terminal process group") ||
    cleaned === "bash: no job control in this shell"
  ) {
    return null;
  }

  try {
    const parsed = JSON.parse(cleaned) as Record<string, unknown>;
    const text = typeof parsed.text === "string" ? stripAnsi(parsed.text).trim() : "";
    const type = typeof parsed.type === "string" ? parsed.type : "";
    const level = typeof parsed.level === "number" ? parsed.level : undefined;

    if (parsed.outcome !== undefined) {
      return null;
    }

    if (!text) {
      return null;
    }

    if (text.startsWith("Error:")) {
      return redactSensitiveOutput(text);
    }

    if (type === "start") {
      if (text === "Resolving Remote") {
        return "Preparing devcontainer...";
      }
      if (text === "Starting container") {
        return "Starting container...";
      }
      return null;
    }

    if (type === "raw" && text === "Container started") {
      return "Container started. Finishing devcontainer setup...";
    }

    if (text.startsWith("workspace root: ")) {
      return `Workspace: ${text.slice("workspace root: ".length)}`;
    }

    if (text === "Inspecting container") {
      return "Inspecting container...";
    }

    if (text.startsWith("userEnvProbe")) {
      return "Checking container environment...";
    }

    const lifecycleProgress = formatDevcontainerLifecycleProgress(text);
    if (lifecycleProgress) {
      return lifecycleProgress;
    }

    if (
      text === "No user features to update" ||
      text.startsWith("Run: ") ||
      text.startsWith("Run in container: ") ||
      text.startsWith("Exit code ")
    ) {
      return null;
    }

    if (level !== undefined && level >= 2) {
      return null;
    }

    return text;
  } catch {
    return cleaned;
  }
}

export function requiresSshAuthSockPermissionFix(sshAuthSockSource: string | null): boolean {
  return sshAuthSockSource === DOCKER_DESKTOP_SSH_AUTH_SOCK_SOURCE;
}

export function buildEnsureSshAuthSockAccessibleScript(containerSshAuthSock: string): string {
  return `if [ -S ${quoteShell(containerSshAuthSock)} ]; then chmod 666 ${quoteShell(containerSshAuthSock)}; fi`;
}

export function buildAssertConfiguredSshAuthSockScript(): string {
  return [
    'if [ -z "${SSH_AUTH_SOCK:-}" ]; then',
    "  exit 0",
    "fi",
    'if [ -S "$SSH_AUTH_SOCK" ]; then',
    "  exit 0",
    "fi",
    'printf \'%s\\n\' "SSH_AUTH_SOCK points to a missing socket inside the container: $SSH_AUTH_SOCK. Run devbox rebuild to refresh SSH agent sharing." >&2',
    "exit 1",
  ].join("\n");
}

export function buildConfigureGitIdentityScript(input: {
  gitUserName: string | null;
  gitUserEmail: string | null;
}): string | null {
  const commands: string[] = [];

  if (input.gitUserName) {
    commands.push(
      'current_git_user_name="$(git config --global --get user.name 2>/dev/null || true)"',
      'if [ -z "$current_git_user_name" ]; then',
      `  git config --global user.name ${quoteShell(input.gitUserName)}`,
      "fi",
    );
  }

  if (input.gitUserEmail) {
    commands.push(
      'current_git_user_email="$(git config --global --get user.email 2>/dev/null || true)"',
      'if [ -z "$current_git_user_email" ]; then',
      `  git config --global user.email ${quoteShell(input.gitUserEmail)}`,
      "fi",
    );
  }

  if (commands.length === 0) {
    return null;
  }

  return [
    "if ! command -v git >/dev/null 2>&1; then",
    "  exit 0",
    "fi",
    ...commands,
  ].join("\n");
}

export function buildInteractiveShellScript(): string {
  return [
    "if command -v bash >/dev/null 2>&1; then",
    "  exec bash -l",
    "fi",
    "exec sh",
  ].join("\n");
}

export function getRunnerHostKeysDir(remoteWorkspaceFolder: string): string {
  const trimmed = remoteWorkspaceFolder.endsWith("/")
    ? remoteWorkspaceFolder.slice(0, -1)
    : remoteWorkspaceFolder;
  return `${trimmed}/${RUNNER_HOST_KEYS_DIRNAME}`;
}

export function buildRestoreRunnerHostKeysScript(remoteWorkspaceFolder: string): string {
  const hostKeysDir = getRunnerHostKeysDir(remoteWorkspaceFolder);
  return [
    `if [ -d ${quoteShell(hostKeysDir)} ]; then`,
    "  mkdir -p /etc/ssh",
    `  find ${quoteShell(hostKeysDir)} -maxdepth 1 -type f -name 'ssh_host_*' -exec cp {} /etc/ssh/ \\;`,
    "  chmod 600 /etc/ssh/ssh_host_*_key 2>/dev/null || true",
    "  chmod 644 /etc/ssh/ssh_host_*_key.pub 2>/dev/null || true",
    "fi",
  ].join("\n");
}

export function buildPersistRunnerHostKeysScript(remoteWorkspaceFolder: string): string {
  const hostKeysDir = getRunnerHostKeysDir(remoteWorkspaceFolder);
  const wsDir = quoteShell(remoteWorkspaceFolder);
  return [
    `mkdir -p ${quoteShell(hostKeysDir)}`,
    `find /etc/ssh -maxdepth 1 -type f -name 'ssh_host_*' -exec cp {} ${quoteShell(hostKeysDir)}/ \\;`,
    `chmod 755 ${quoteShell(hostKeysDir)}`,
    `chmod 644 ${quoteShell(hostKeysDir)}/ssh_host_*_key 2>/dev/null || true`,
    `chmod 644 ${quoteShell(hostKeysDir)}/ssh_host_*_key.pub 2>/dev/null || true`,
    `ws_owner=$(stat -c '%u:%g' ${wsDir} 2>/dev/null) && [ -n "$ws_owner" ] && chown -R "$ws_owner" ${quoteShell(hostKeysDir)} 2>/dev/null || true`,
  ].join("\n");
}

export function buildCopyKnownHostsScript(sourcePath = KNOWN_HOSTS_TARGET): string {
  return [
    `if [ ! -e ${quoteShell(sourcePath)} ]; then`,
    "  printf '%s\\n' 'missing'",
    `elif [ ! -f ${quoteShell(sourcePath)} ]; then`,
    "  printf '%s\\n' 'missing'",
    `elif [ ! -s ${quoteShell(sourcePath)} ]; then`,
    "  printf '%s\\n' 'empty'",
    "else",
    "  umask 077",
    `  if mkdir -p ~/.ssh && cp ${quoteShell(sourcePath)} ~/.ssh/known_hosts && chmod 600 ~/.ssh/known_hosts; then`,
    "    printf '%s\\n' 'copied'",
    "  else",
    "    exit 1",
    "  fi",
    "fi",
  ].join("\n");
}

export function resolveSshAuthSockSource(input: {
  hostEnvSshAuthSock?: string;
  hostEnvSockExists: boolean;
  dockerDesktopHostServiceAvailable: boolean;
  allowMissingSsh: boolean;
}): ResolvedSshAuthSock {
  const hostEnvSshAuthSock = input.hostEnvSshAuthSock?.trim() || undefined;

  if (input.dockerDesktopHostServiceAvailable) {
    return { sshAuthSock: DOCKER_DESKTOP_SSH_AUTH_SOCK_SOURCE };
  }

  if (hostEnvSshAuthSock && input.hostEnvSockExists) {
    return { sshAuthSock: hostEnvSshAuthSock };
  }

  const detail = hostEnvSshAuthSock
    ? `SSH_AUTH_SOCK does not exist: ${hostEnvSshAuthSock}.`
    : "No usable SSH agent socket was found. Set SSH_AUTH_SOCK or use Docker Desktop host services.";

  if (input.allowMissingSsh) {
    return {
      sshAuthSock: null,
      warning: `${detail} Continuing without SSH agent sharing.`,
    };
  }

  throw new UserError(`${detail} Pass --allow-missing-ssh to continue without SSH agent sharing.`);
}

export async function ensureHostEnvironment(options: {
  allowMissingSsh: boolean;
  workspacePath: string;
}): Promise<ResolvedHostEnvironment> {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new UserError(`Unsupported platform: ${process.platform}. macOS and Linux are supported in v1.`);
  }

  if (!isExecutableAvailable("docker")) {
    throw new UserError("Docker is required but was not found in PATH.");
  }

  if (!isExecutableAvailable("devcontainer")) {
    throw new UserError("Dev Container CLI is required but was not found in PATH.");
  }

  const hostEnvSshAuthSock = process.env.SSH_AUTH_SOCK?.trim() || undefined;
  const hostEnvSockExists = hostEnvSshAuthSock ? await pathExists(hostEnvSshAuthSock) : false;
  const [dockerDesktopHostServiceAvailable, gitUserName, gitUserEmail, ghCliToken] = await Promise.all([
    hasDockerDesktopHostService(),
    tryGetGitConfig(options.workspacePath, "user.name"),
    tryGetGitConfig(options.workspacePath, "user.email"),
    tryGetGhCliToken(),
  ]);

  return {
    ...resolveSshAuthSockSource({
      hostEnvSshAuthSock,
      hostEnvSockExists,
      dockerDesktopHostServiceAvailable,
      allowMissingSsh: options.allowMissingSsh,
    }),
    gitUserName,
    gitUserEmail,
    githubToken: ghCliToken.token,
    githubTokenWarning: ghCliToken.warning,
  };
}

export async function ensureGeneratedConfigIgnored(
  workspacePath: string,
  generatedConfigPath: string,
): Promise<void> {
  await ensurePathIgnored(workspacePath, generatedConfigPath);
}

export async function ensurePathIgnored(workspacePath: string, absolutePath: string): Promise<void> {
  const gitTopLevel = await tryGetGitTopLevel(workspacePath);
  if (!gitTopLevel) {
    return;
  }

  const canonicalGitTopLevel = await resolveComparablePath(gitTopLevel);
  const canonicalTargetPath = await resolveComparablePath(absolutePath);
  const relative = path.relative(canonicalGitTopLevel, canonicalTargetPath);
  if (!relative || relative.startsWith("..")) {
    return;
  }

  const normalized = `/${relative.split(path.sep).join("/")}`;
  const excludePath = await tryGetGitPath(workspacePath, "info/exclude");
  if (!excludePath) {
    return;
  }
  await mkdir(path.dirname(excludePath), { recursive: true });

  let current = "";
  try {
    current = await readFile(excludePath, "utf8");
  } catch {
    current = "";
  }

  const lines = new Set(current.split(/\r?\n/).filter(Boolean));
  if (lines.has(normalized)) {
    return;
  }

  const prefix = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
  await appendFile(excludePath, `${prefix}${normalized}\n`, "utf8");
}

async function resolveComparablePath(inputPath: string): Promise<string> {
  try {
    return await realpath(inputPath);
  } catch {
    const parentPath = path.dirname(inputPath);
    if (parentPath === inputPath) {
      return inputPath;
    }

    try {
      return path.join(await realpath(parentPath), path.basename(inputPath));
    } catch {
      return inputPath;
    }
  }
}

export async function listManagedContainers(labels: Record<string, string>): Promise<string[]> {
  const args = ["ps", "-aq"];
  for (const [key, value] of Object.entries(labels)) {
    args.push("--filter", `label=${key}=${value}`);
  }

  const result = await execute(["docker", ...args], {
    stdoutMode: "capture",
    stderrMode: "capture",
  });

  return result.stdout
    .split(/\s+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export async function inspectContainers(containerIds: string[]): Promise<DockerInspect[]> {
  if (containerIds.length === 0) {
    return [];
  }

  const result = await execute(["docker", "inspect", ...containerIds], {
    stdoutMode: "capture",
    stderrMode: "capture",
  });

  return JSON.parse(result.stdout) as DockerInspect[];
}

export async function assertPortAvailable(port: number, allowIfManagedContainerOwnsPort: boolean): Promise<void> {
  const availability = await probePortAvailability(port);
  if (availability.available) {
    return;
  }

  if (allowIfManagedContainerOwnsPort) {
    return;
  }

  if (availability.pids.length > 0) {
    throw new UserError(`Host port ${port} is already in use by PID(s): ${availability.pids.join(", ")}.`);
  }

  throw new UserError(`Host port ${port} is already in use.`);
}

export async function findFirstAvailablePort(
  startPort: number,
  isPortAvailable: (port: number) => Promise<boolean> = defaultIsPortAvailable,
): Promise<number> {
  if (!Number.isInteger(startPort) || startPort < 1 || startPort > 65535) {
    throw new UserError(`Port must be between 1 and 65535. Received: ${startPort}`);
  }

  for (let port = startPort; port <= 65535; port += 1) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }

  throw new UserError(`No available host port was found starting at ${startPort}.`);
}

export async function removeContainers(containerIds: string[]): Promise<void> {
  if (containerIds.length === 0) {
    return;
  }

  await execute(["docker", "rm", "--force", ...containerIds], {
    stdoutMode: "raw",
    stderrMode: "raw",
  });
}

export async function devcontainerUp(input: {
  workspacePath: string;
  generatedConfigPath: string;
  userDataDir: string;
  labels: Record<string, string>;
  processEnv?: Record<string, string | undefined>;
}): Promise<UpResult> {
  await mkdir(input.userDataDir, { recursive: true });

  const args = [
    "devcontainer",
    "up",
    "--workspace-folder",
    input.workspacePath,
    "--mount-workspace-git-root",
    "false",
    "--config",
    input.generatedConfigPath,
    "--user-data-folder",
    input.userDataDir,
    "--log-format",
    "json",
  ];

  for (const [key, value] of Object.entries(input.labels)) {
    args.push("--id-label", `${key}=${value}`);
  }

  const result = await execute(args, {
    env: input.processEnv,
    stdoutMode: "devcontainer-json",
    stderrMode: "devcontainer-json",
  });

  const outcome = parseDevcontainerOutcome(result.stdout);
  if (!outcome || outcome.outcome !== "success" || typeof outcome.containerId !== "string") {
    throw new UserError("devcontainer up did not return a success outcome.");
  }

  return outcome;
}

export async function copyKnownHosts(
  containerId: string,
  hostKnownHostsPath?: string | null,
): Promise<"copied" | "missing" | "empty"> {
  let outcome: string;
  if (hostKnownHostsPath) {
    await dockerWriteFile(containerId, hostKnownHostsPath, KNOWN_HOSTS_TARGET);
    outcome = (await devcontainerExec(containerId, buildCopyKnownHostsScript(), { quiet: true })).stdout.trim();
  } else {
    outcome = (await devcontainerExec(containerId, buildCopyKnownHostsScript(), { quiet: true })).stdout.trim();
  }

  if (outcome === "copied" || outcome === "missing" || outcome === "empty") {
    return outcome;
  }

  throw new UserError(`Unexpected known_hosts copy result: ${outcome || "<empty>"}.`);
}

export async function configureGitIdentity(
  containerId: string,
  gitUserName: string | null,
  gitUserEmail: string | null,
): Promise<void> {
  const script = buildConfigureGitIdentityScript({ gitUserName, gitUserEmail });
  if (!script) {
    return;
  }

  await devcontainerExec(containerId, script, { quiet: true });
}

export async function stopManagedSshd(containerId: string): Promise<void> {
  await dockerExec(containerId, buildStopManagedSshdScript(), {
    quiet: true,
    user: "root",
  });
}

export async function ensureSshAuthSockAccessible(
  containerId: string,
  sshAuthSockSource: string | null,
): Promise<void> {
  const containerSshAuthSock = getContainerSshAuthSockPath(sshAuthSockSource);
  if (!containerSshAuthSock) {
    throw new UserError("Cannot adjust SSH agent socket permissions when SSH sharing is disabled.");
  }

  await dockerExec(containerId, buildEnsureSshAuthSockAccessibleScript(containerSshAuthSock), {
    quiet: true,
    user: "root",
  });
}

export async function assertConfiguredSshAuthSockAvailable(containerId: string): Promise<void> {
  await dockerExec(containerId, buildAssertConfiguredSshAuthSockScript(), {
    quiet: true,
  });
}

export async function restoreRunnerHostKeys(
  containerId: string,
  remoteWorkspaceFolder: string,
): Promise<void> {
  await dockerExec(containerId, buildRestoreRunnerHostKeysScript(remoteWorkspaceFolder), {
    quiet: true,
    user: "root",
  });
}

export async function startRunner(
  containerId: string,
  port: number,
  remoteWorkspaceFolder: string,
): Promise<RunnerCredentials> {
  const script = `curl -fsSL ${quoteShell(getRunnerUrl())} | env SSH_PORT=${quoteShell(String(port))} CRED_FILE=${quoteShell(getRunnerCredFile(remoteWorkspaceFolder))} bash`;
  const result = await devcontainerExec(containerId, script, { quiet: true });
  const summaryLines = getRunnerSummaryLines(result.stdout);
  const parsedSummary = parseRunnerCredentials(summaryLines.join("\n"));

  if (summaryLines.length > 0) {
    console.log("\nSSH server:");
    for (const line of summaryLines) {
      console.log(`  ${line}`);
    }
  } else {
    const output = result.stdout.trim();
    if (output) {
      console.log(output);
    }
  }

  return {
    user: parsedSummary.user,
    password: parsedSummary.password,
    sshPort: parsedSummary.sshPort ?? port,
    permitRootLogin: parsedSummary.permitRootLogin,
  };
}

export async function persistRunnerHostKeys(
  containerId: string,
  remoteWorkspaceFolder: string,
): Promise<void> {
  await dockerExec(containerId, buildPersistRunnerHostKeysScript(remoteWorkspaceFolder), {
    quiet: true,
    user: "root",
  });
}

function getRunnerUrl(): string {
  const override = process.env.DEVBOX_RUNNER_URL?.trim();
  return override && override.length > 0 ? override : RUNNER_URL;
}

export function resolveShellContainerId(input: {
  containers: DockerInspect[];
  preferredContainerId?: string;
}): string {
  const running = input.containers.filter((container) => container.State?.Running);

  if (input.preferredContainerId) {
    const preferred = running.find((container) => container.Id === input.preferredContainerId);
    if (preferred) {
      return preferred.Id;
    }
  }

  if (running.length === 1) {
    return running[0].Id;
  }

  if (running.length === 0) {
    throw new UserError("No running managed container was found for this workspace. Run `devbox up` first.");
  }

  throw new UserError("More than one managed container is running for this workspace. Run `devbox down` first.");
}

export function buildDevcontainerShellCommand(
  containerId: string,
  terminalSize?: { columns?: number; rows?: number },
): string[] {
  const args = ["devcontainer", "exec", "--container-id", containerId];

  if (terminalSize?.columns && terminalSize.columns > 0) {
    args.push("--terminal-columns", String(terminalSize.columns));
  }
  if (terminalSize?.rows && terminalSize.rows > 0) {
    args.push("--terminal-rows", String(terminalSize.rows));
  }

  args.push("sh", "-lc", buildInteractiveShellScript());
  return args;
}

export async function openInteractiveShell(containerId: string): Promise<number> {
  return executeInteractive(
    buildDevcontainerShellCommand(containerId, {
      columns: process.stdout.isTTY ? process.stdout.columns : undefined,
      rows: process.stdout.isTTY ? process.stdout.rows : undefined,
    }),
  );
}

async function hasDockerDesktopHostService(): Promise<boolean> {
  const result = await execute(["docker", "info", "--format", "{{.OperatingSystem}}"], {
    stdoutMode: "capture",
    stderrMode: "capture",
    allowFailure: true,
  });

  if (result.exitCode !== 0) {
    return false;
  }

  return result.stdout.toLowerCase().includes("docker desktop");
}

async function devcontainerExec(
  containerId: string,
  script: string,
  options: { quiet: boolean },
): Promise<ExecResult> {
  const args = ["devcontainer", "exec", "--container-id", containerId, "sh", "-lc", script];
  return execute(args, {
    stdoutMode: options.quiet ? "capture" : "raw",
    stderrMode: options.quiet ? "capture" : "raw",
  });
}

async function dockerWriteFile(containerId: string, sourcePath: string, destinationPath: string): Promise<void> {
  const content = await readFile(sourcePath);
  const subprocess = spawn(
    "docker",
    [
      "exec",
      "-i",
      "--user",
      "root",
      containerId,
      "sh",
      "-lc",
      `cat > ${quoteShell(destinationPath)} && chmod 644 ${quoteShell(destinationPath)}`,
    ],
    {
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  subprocess.stdin?.end(content);

  const stdoutPromise = consumeStream(subprocess.stdout, "capture", false);
  const stderrPromise = consumeStream(subprocess.stderr, "capture", true);
  const exitCode = await new Promise<number>((resolve, reject) => {
    subprocess.once("error", reject);
    subprocess.once("close", (code) => {
      resolve(code ?? 0);
    });
  });
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);

  if (exitCode !== 0) {
    throw new CommandError(["docker", "exec", "-i", "--user", "root", containerId, "sh", "-lc", "<streamed known_hosts>"], {
      stdout,
      stderr,
      exitCode,
    });
  }
}

async function dockerExec(
  containerId: string,
  script: string,
  options: { quiet: boolean; user?: string },
): Promise<ExecResult> {
  const args = ["docker", "exec"];
  if (options.user) {
    args.push("--user", options.user);
  }
  args.push(containerId, "sh", "-lc", script);

  return execute(args, {
    stdoutMode: options.quiet ? "capture" : "raw",
    stderrMode: options.quiet ? "capture" : "raw",
  });
}

async function tryGetGitTopLevel(workspacePath: string): Promise<string | null> {
  try {
    const result = await execute(["git", "-C", workspacePath, "rev-parse", "--show-toplevel"], {
      stdoutMode: "capture",
      stderrMode: "capture",
      allowFailure: true,
    });

    if (result.exitCode !== 0) {
      return null;
    }

    const trimmed = result.stdout.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

async function tryGetGitPath(workspacePath: string, suffix: string): Promise<string | null> {
  if (!isExecutableAvailable("git")) {
    return null;
  }

  try {
    const result = await execute(["git", "-C", workspacePath, "rev-parse", "--path-format=absolute", "--git-path", suffix], {
      stdoutMode: "capture",
      stderrMode: "capture",
      allowFailure: true,
    });

    if (result.exitCode !== 0) {
      return null;
    }

    const trimmed = result.stdout.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

async function tryGetGitConfig(workspacePath: string, key: "user.name" | "user.email"): Promise<string | null> {
  if (!isExecutableAvailable("git")) {
    return null;
  }

  const result = await execute(["git", "config", "--get", key], {
    cwd: workspacePath,
    stdoutMode: "capture",
    stderrMode: "capture",
    allowFailure: true,
  });

  if (result.exitCode !== 0) {
    return null;
  }

  const trimmed = result.stdout.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function resolveGhCliToken(input: {
  ghAvailable: boolean;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
}): ResolvedGhCliToken {
  if (!input.ghAvailable) {
    return { token: null };
  }

  const token = input.stdout?.trim() ?? "";
  if (input.exitCode === 0) {
    if (token.length > 0) {
      return { token };
    }

    return {
      token: null,
      warning: "GitHub CLI returned an empty auth token. Continuing without GH_TOKEN injection.",
    };
  }

  if (looksLikeGhUnauthenticatedError(input.stderr ?? "")) {
    return { token: null };
  }

  return {
    token: null,
    warning: "GitHub CLI auth token lookup failed. Continuing without GH_TOKEN injection.",
  };
}

export function looksLikeGhUnauthenticatedError(stderr: string): boolean {
  const normalized = stderr.toLowerCase();
  return (
    normalized.includes("not logged into any hosts") ||
    normalized.includes("authentication required") ||
    normalized.includes("run gh auth login")
  );
}

async function tryGetGhCliToken(): Promise<ResolvedGhCliToken> {
  if (!isExecutableAvailable("gh")) {
    return { token: null };
  }

  const result = await execute(["gh", "auth", "token"], {
    stdoutMode: "capture",
    stderrMode: "capture",
    allowFailure: true,
  });

  return resolveGhCliToken({
    ghAvailable: true,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  });
}

async function findListeningPids(port: number): Promise<string[]> {
  if (isExecutableAvailable("lsof")) {
    const result = await execute(["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
      stdoutMode: "capture",
      stderrMode: "capture",
      allowFailure: true,
    });

    if (result.exitCode === 0) {
      return result.stdout
        .split(/\s+/)
        .map((entry) => entry.trim())
        .filter(Boolean);
    }

    if (result.exitCode === 1) {
      return [];
    }

    throw new UserError(
      `Could not determine whether port ${port} is free because lsof failed with exit code ${result.exitCode}.`,
    );
  }

  return [];
}

export async function probePortAvailability(
  port: number,
  options?: {
    canUseLsof?: boolean;
    listListeningPids?: (port: number) => Promise<string[]>;
    tryBindPort?: (port: number) => Promise<boolean>;
  },
): Promise<PortAvailability> {
  const canUseLsof = options?.canUseLsof ?? isExecutableAvailable("lsof");
  if (canUseLsof) {
    const pids = await (options?.listListeningPids ?? findListeningPids)(port);
    return {
      available: pids.length === 0,
      pids,
    };
  }

  return {
    available: await (options?.tryBindPort ?? tryBindPort)(port),
    pids: [],
  };
}

async function defaultIsPortAvailable(port: number): Promise<boolean> {
  const availability = await probePortAvailability(port);
  return availability.available;
}

async function tryBindPort(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const server = createServer();
    let settled = false;

    const finish = (callback: () => void) => {
      if (settled) {
        return;
      }

      settled = true;
      server.removeAllListeners();
      callback();
    };

    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") {
        finish(() => resolve(false));
        return;
      }

      finish(() =>
        reject(
          new UserError(
            `Could not determine whether port ${port} is free because a fallback bind probe failed: ${error.message}.`,
          ),
        ),
      );
    });

    server.once("listening", () => {
      server.close((error) => {
        if (error) {
          finish(() =>
            reject(
              new UserError(
                `Could not determine whether port ${port} is free because a fallback bind probe could not close cleanly: ${error.message}.`,
              ),
            ),
          );
          return;
        }

        finish(() => resolve(true));
      });
    });

    server.listen({ port, exclusive: true });
  });
}

async function execute(command: string[], options: ExecOptions): Promise<ExecResult> {
  const env = { ...process.env, ...(options.env ?? {}) } as Record<string, string>;
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete env[key];
    }
  }

  const subprocess = spawn(command[0], command.slice(1), {
    cwd: options.cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stdoutPromise = consumeStream(subprocess.stdout, options.stdoutMode ?? "capture", false);
  const stderrPromise = consumeStream(subprocess.stderr, options.stderrMode ?? "capture", true);
  const exitPromise = new Promise<number>((resolve, reject) => {
    subprocess.once("error", reject);
    subprocess.once("close", (exitCode) => {
      resolve(exitCode ?? 0);
    });
  });
  const [stdout, stderr, exitCode] = await Promise.all([stdoutPromise, stderrPromise, exitPromise]);

  const result = { stdout, stderr, exitCode };
  if (exitCode !== 0 && !options.allowFailure) {
    throw new CommandError(command, result);
  }

  return result;
}

async function executeInteractive(command: string[], options?: Pick<ExecOptions, "cwd" | "env">): Promise<number> {
  const env = { ...process.env, ...(options?.env ?? {}) } as Record<string, string>;
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete env[key];
    }
  }

  const subprocess = spawn(command[0], command.slice(1), {
    cwd: options?.cwd,
    env,
    stdio: "inherit",
  });

  return new Promise<number>((resolve, reject) => {
    subprocess.once("error", reject);
    subprocess.once("close", (exitCode) => {
      resolve(exitCode ?? 0);
    });
  });
}

async function consumeStream(
  stream: Readable | null,
  mode: NonNullable<ExecOptions["stdoutMode"]> | NonNullable<ExecOptions["stderrMode"]>,
  useStderr: boolean,
): Promise<string> {
  if (!stream) {
    return "";
  }

  const writer = useStderr ? process.stderr : process.stdout;
  stream.setEncoding("utf8");
  let captured = "";
  let buffered = "";
  let lastRenderedProgressLine: string | null = null;

  for await (const chunk of stream) {
    const text = typeof chunk === "string" ? chunk : String(chunk);
    captured += text;

    if (mode === "raw") {
      writer.write(text);
      continue;
    }

    if (mode === "capture") {
      continue;
    }

    buffered += text;
    let newlineIndex = buffered.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = buffered.slice(0, newlineIndex);
      buffered = buffered.slice(newlineIndex + 1);
      lastRenderedProgressLine = renderDevcontainerJsonLine(line, writer, lastRenderedProgressLine);
      newlineIndex = buffered.indexOf("\n");
    }
  }

  if (mode === "devcontainer-json" && buffered.length > 0) {
    renderDevcontainerJsonLine(buffered, writer, lastRenderedProgressLine);
  }

  return captured;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function findExecutableOnPath(command: string): string | null {
  if (command.includes(path.sep)) {
    return isExecutablePath(command) ? command : null;
  }

  const pathValue = process.env.PATH ?? "";
  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) {
      continue;
    }

    const candidate = path.join(directory, command);
    if (isExecutablePath(candidate)) {
      return candidate;
    }
  }

  return null;
}

function isExecutablePath(candidate: string): boolean {
  try {
    accessSync(candidate, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function renderDevcontainerJsonLine(
  line: string,
  writer: NodeJS.WriteStream,
  previousLine: string | null,
): string | null {
  const formatted = formatDevcontainerProgressLine(line);
  if (formatted && formatted !== previousLine) {
    writer.write(`${formatted}\n`);
    return formatted;
  }

  return previousLine;
}

function parseDevcontainerOutcome(stdout: string): UpResult | null {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(lines[index]) as Record<string, unknown>;
      if (typeof parsed.outcome === "string") {
        return parsed as unknown as UpResult;
      }
    } catch {
      // Ignore non-JSON lines.
    }
  }

  return null;
}

export function isCommandError(error: unknown): error is CommandError {
  return error instanceof CommandError;
}

export function formatCommandError(error: CommandError): string {
  const stderr = error.result.stderr.trim();
  const stdout = error.result.stdout.trim();
  const details = isGhAuthTokenCommand(error.command) ? "<redacted>" : redactSensitiveOutput(stderr || stdout);

  if (!details) {
    return `${error.message} (exit ${error.result.exitCode})`;
  }

  return `${error.message}\n${details}`;
}

export function redactSensitiveOutput(text: string): string {
  return text
    .replace(/(\bGH_TOKEN=)([^\s"'`]+)/g, "$1<redacted>")
    .replace(/("GH_TOKEN"\s*:\s*")([^"]*)(")/g, '$1<redacted>$3')
    .replace(/(\bGH_TOKEN:\s*)(\S+)/g, "$1<redacted>");
}

function stripAnsi(text: string): string {
  return text.replace(/\u001B\[[0-9;]*m/g, "");
}

function formatDevcontainerLifecycleProgress(text: string): string | null {
  if (!text.startsWith("LifecycleCommandExecutionMap:")) {
    return null;
  }

  const commandMatch = text.match(
    /\b(initializeCommand|onCreateCommand|updateContentCommand|postCreateCommand|postStartCommand|postAttachCommand)\b/,
  );
  if (commandMatch) {
    return `Running ${commandMatch[1]}...`;
  }

  return "Running devcontainer lifecycle commands...";
}

function looksLikeDevcontainerUserEnvProbeDump(text: string): boolean {
  const match = text.match(/^([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})([\s\S]*)\1$/i);
  if (!match) {
    return false;
  }

  return /\b(?:GH_TOKEN|HOME|HOSTNAME|PATH|PWD|SHLVL|SSH_AUTH_SOCK|USER)=/.test(match[2]);
}

function isGhAuthTokenCommand(command: string[]): boolean {
  return command[0] === "gh" && command[1] === "auth" && command[2] === "token";
}

export function labelsForWorkspaceHash(workspaceHash: string): Record<string, string> {
  return {
    [MANAGED_LABEL_KEY]: "true",
    [WORKSPACE_LABEL_KEY]: workspaceHash,
  };
}
