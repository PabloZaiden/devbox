import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  type DockerInspect,
  type UpResult,
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
  SSH_AUTH_SOCK_TARGET,
  WORKSPACE_LABEL_KEY,
} from "./constants";

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

export interface ResolvedHostEnvironment {
  sshAuthSock: string | null;
  warning?: string;
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
  const cleaned = stripAnsi(line).trim();
  if (!cleaned) {
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
      return text;
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
      return "Container started.";
    }

    if (text.startsWith("workspace root: ")) {
      return `Workspace: ${text.slice("workspace root: ".length)}`;
    }

    if (
      text === "No user features to update" ||
      text === "Inspecting container" ||
      text.startsWith("Run: ") ||
      text.startsWith("Run in container: ") ||
      text.startsWith("userEnvProbe") ||
      text.startsWith("LifecycleCommandExecutionMap:") ||
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

export function buildEnsureSshAuthSockAccessibleScript(): string {
  return `if [ -S ${quoteShell(SSH_AUTH_SOCK_TARGET)} ]; then chmod 666 ${quoteShell(SSH_AUTH_SOCK_TARGET)}; fi`;
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
  return [
    `mkdir -p ${quoteShell(hostKeysDir)}`,
    `find /etc/ssh -maxdepth 1 -type f -name 'ssh_host_*' -exec cp {} ${quoteShell(hostKeysDir)}/ \\;`,
    `chmod 700 ${quoteShell(hostKeysDir)}`,
    `chmod 600 ${quoteShell(hostKeysDir)}/ssh_host_*_key 2>/dev/null || true`,
    `chmod 644 ${quoteShell(hostKeysDir)}/ssh_host_*_key.pub 2>/dev/null || true`,
  ].join("\n");
}

export function resolveSshAuthSockSource(input: {
  hostEnvSshAuthSock?: string;
  hostEnvSockExists: boolean;
  dockerDesktopHostServiceAvailable: boolean;
  allowMissingSsh: boolean;
}): ResolvedHostEnvironment {
  const hostEnvSshAuthSock = input.hostEnvSshAuthSock?.trim() || undefined;

  if (hostEnvSshAuthSock && input.hostEnvSockExists) {
    return { sshAuthSock: hostEnvSshAuthSock };
  }

  if (input.dockerDesktopHostServiceAvailable) {
    return { sshAuthSock: DOCKER_DESKTOP_SSH_AUTH_SOCK_SOURCE };
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
}): Promise<ResolvedHostEnvironment> {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new UserError(`Unsupported platform: ${process.platform}. macOS and Linux are supported in v1.`);
  }

  if (!Bun.which("docker")) {
    throw new UserError("Docker is required but was not found in PATH.");
  }

  if (!Bun.which("devcontainer")) {
    throw new UserError("Dev Container CLI is required but was not found in PATH.");
  }

  const hostEnvSshAuthSock = process.env.SSH_AUTH_SOCK?.trim() || undefined;
  const hostEnvSockExists = hostEnvSshAuthSock ? await Bun.file(hostEnvSshAuthSock).exists() : false;
  const dockerDesktopHostServiceAvailable =
    (!hostEnvSshAuthSock || !hostEnvSockExists) && (await hasDockerDesktopHostService());

  return resolveSshAuthSockSource({
    hostEnvSshAuthSock,
    hostEnvSockExists,
    dockerDesktopHostServiceAvailable,
    allowMissingSsh: options.allowMissingSsh,
  });
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

  const relative = path.relative(gitTopLevel, absolutePath);
  if (!relative || relative.startsWith("..")) {
    return;
  }

  const normalized = `/${relative.split(path.sep).join("/")}`;
  const excludePath = path.join(gitTopLevel, ".git", "info", "exclude");
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
  const pids = await findListeningPids(port);
  if (pids.length === 0) {
    return;
  }

  if (allowIfManagedContainerOwnsPort) {
    return;
  }

  throw new UserError(`Host port ${port} is already in use by PID(s): ${pids.join(", ")}.`);
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
    stdoutMode: "devcontainer-json",
    stderrMode: "devcontainer-json",
  });

  const outcome = parseDevcontainerOutcome(result.stdout);
  if (!outcome || outcome.outcome !== "success" || typeof outcome.containerId !== "string") {
    throw new UserError("devcontainer up did not return a success outcome.");
  }

  return outcome;
}

export async function copyKnownHosts(containerId: string): Promise<void> {
  const script = `if [ -f ${quoteShell(KNOWN_HOSTS_TARGET)} ]; then umask 077 && mkdir -p ~/.ssh && cp ${quoteShell(KNOWN_HOSTS_TARGET)} ~/.ssh/known_hosts && chmod 600 ~/.ssh/known_hosts; fi`;
  await devcontainerExec(containerId, script, { quiet: true });
}

export async function stopManagedSshd(containerId: string): Promise<void> {
  await devcontainerExec(containerId, buildStopManagedSshdScript(), { quiet: true });
}

export async function ensureSshAuthSockAccessible(containerId: string): Promise<void> {
  await dockerExec(containerId, buildEnsureSshAuthSockAccessibleScript(), {
    quiet: true,
    user: "root",
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
): Promise<void> {
  const script = `curl -fsSL ${quoteShell(RUNNER_URL)} | env SSH_PORT=${quoteShell(String(port))} CRED_FILE=${quoteShell(getRunnerCredFile(remoteWorkspaceFolder))} bash`;
  const result = await devcontainerExec(containerId, script, { quiet: true });
  const summaryLines = getRunnerSummaryLines(result.stdout);

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

async function findListeningPids(port: number): Promise<string[]> {
  if (Bun.which("lsof")) {
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

async function execute(command: string[], options: ExecOptions): Promise<ExecResult> {
  const env = { ...process.env, ...(options.env ?? {}) } as Record<string, string>;
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete env[key];
    }
  }

  const subprocess = Bun.spawn(command, {
    cwd: options.cwd,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdoutPromise = consumeStream(subprocess.stdout, options.stdoutMode ?? "capture", false);
  const stderrPromise = consumeStream(subprocess.stderr, options.stderrMode ?? "capture", true);
  const [stdout, stderr, exitCode] = await Promise.all([stdoutPromise, stderrPromise, subprocess.exited]);

  const result = { stdout, stderr, exitCode };
  if (exitCode !== 0 && !options.allowFailure) {
    throw new CommandError(command, result);
  }

  return result;
}

async function consumeStream(
  stream: ReadableStream<Uint8Array> | null,
  mode: NonNullable<ExecOptions["stdoutMode"]> | NonNullable<ExecOptions["stderrMode"]>,
  useStderr: boolean,
): Promise<string> {
  if (!stream) {
    return "";
  }

  const writer = useStderr ? process.stderr : process.stdout;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let captured = "";
  let buffered = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    const chunk = decoder.decode(value, { stream: true });
    captured += chunk;

    if (mode === "raw") {
      writer.write(chunk);
      continue;
    }

    if (mode === "capture") {
      continue;
    }

    buffered += chunk;
    let newlineIndex = buffered.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = buffered.slice(0, newlineIndex);
      buffered = buffered.slice(newlineIndex + 1);
      renderDevcontainerJsonLine(line, writer);
      newlineIndex = buffered.indexOf("\n");
    }
  }

  const remaining = decoder.decode();
  if (remaining) {
    captured += remaining;
    if (mode === "raw") {
      writer.write(remaining);
    } else if (mode === "devcontainer-json") {
      buffered += remaining;
    }
  }

  if (mode === "devcontainer-json" && buffered.length > 0) {
    renderDevcontainerJsonLine(buffered, writer);
  }

  return captured;
}

function renderDevcontainerJsonLine(line: string, writer: NodeJS.WriteStream): void {
  const formatted = formatDevcontainerProgressLine(line);
  if (formatted) {
    writer.write(`${formatted}\n`);
  }
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
  const details = stderr || stdout;

  if (!details) {
    return `${error.message} (exit ${error.result.exitCode})`;
  }

  return `${error.message}\n${details}`;
}

function stripAnsi(text: string): string {
  return text.replace(/\u001B\[[0-9;]*m/g, "");
}

export function labelsForWorkspaceHash(workspaceHash: string): Record<string, string> {
  return {
    [MANAGED_LABEL_KEY]: "true",
    [WORKSPACE_LABEL_KEY]: workspaceHash,
  };
}
