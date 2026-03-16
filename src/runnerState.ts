export interface RunnerCredentials {
  user: string | null;
  password: string | null;
  sshPort: number | null;
  permitRootLogin: boolean | null;
}

export interface RunnerMetadata {
  version: number;
  sshUser: string | null;
  sshPort: number | null;
  permitRootLogin: boolean | null;
}

export const RUNNER_METADATA_VERSION = 1;

export function parseRunnerCredentials(content: string): RunnerCredentials {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const summaryCredentials = parseSummaryCredentials(lines);
  if (summaryCredentials !== null) {
    return summaryCredentials;
  }

  const keyValueCredentials = parseKeyValueCredentials(lines);
  if (keyValueCredentials !== null) {
    return keyValueCredentials;
  }

  if (lines.length === 1) {
    return {
      user: null,
      password: lines[0],
      sshPort: null,
      permitRootLogin: null,
    };
  }

  return {
    user: null,
    password: null,
    sshPort: null,
    permitRootLogin: null,
  };
}

export function createRunnerMetadata(input: {
  sshUser: string | null;
  sshPort: number | null;
  permitRootLogin: boolean | null;
}): RunnerMetadata {
  return {
    version: RUNNER_METADATA_VERSION,
    sshUser: normalizeString(input.sshUser),
    sshPort: normalizePort(input.sshPort),
    permitRootLogin: input.permitRootLogin ?? null,
  };
}

export function parseRunnerMetadata(content: string): RunnerMetadata {
  const trimmed = content.trim();
  if (!trimmed) {
    throw new Error("File was empty.");
  }

  const parsed = JSON.parse(trimmed) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Expected a JSON object.");
  }

  const record = parsed as Record<string, unknown>;
  if (record.version !== RUNNER_METADATA_VERSION) {
    throw new Error(`Unsupported version: ${String(record.version)}.`);
  }

  return {
    version: RUNNER_METADATA_VERSION,
    sshUser: normalizeString(record.sshUser),
    sshPort: normalizePort(record.sshPort),
    permitRootLogin: typeof record.permitRootLogin === "boolean" ? record.permitRootLogin : null,
  };
}

export function serializeRunnerMetadata(metadata: RunnerMetadata): string {
  return `${JSON.stringify(metadata, null, 2)}\n`;
}

function parseSummaryCredentials(lines: string[]): RunnerCredentials | null {
  const map = new Map<string, string>();

  for (const line of lines) {
    const match = line.match(/^(SSH user|SSH pass|SSH port|PermitRootLogin):\s*(.*)$/);
    if (!match) {
      continue;
    }

    map.set(match[1], match[2]);
  }

  if (map.size === 0) {
    return null;
  }

  return {
    user: normalizeString(map.get("SSH user") ?? null),
    password: normalizeString(map.get("SSH pass") ?? null),
    sshPort: parsePortValue(map.get("SSH port") ?? null),
    permitRootLogin: parsePermitRootLogin(map.get("PermitRootLogin") ?? null),
  };
}

function parseKeyValueCredentials(lines: string[]): RunnerCredentials | null {
  const map = new Map<string, string>();

  for (const line of lines) {
    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim().toLowerCase();
    const value = line.slice(separatorIndex + 1).trim();
    if (!key) {
      continue;
    }

    map.set(key, value);
  }

  if (map.size === 0) {
    return null;
  }

  return {
    user: normalizeString(map.get("user") ?? map.get("ssh_user") ?? null),
    password: normalizeString(map.get("pass") ?? map.get("password") ?? map.get("ssh_pass") ?? null),
    sshPort: parsePortValue(map.get("port") ?? map.get("ssh_port") ?? null),
    permitRootLogin: parsePermitRootLogin(
      map.get("permitrootlogin") ?? map.get("permit_root_login") ?? map.get("permit-root-login") ?? null,
    ),
  };
}

function parsePermitRootLogin(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "yes" || normalized === "true" || normalized === "1") {
    return true;
  }
  if (normalized === "no" || normalized === "false" || normalized === "0") {
    return false;
  }
  return null;
}

function normalizePort(value: unknown): number | null {
  return parsePortValue(value);
}

function parsePortValue(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isInteger(value) ? value : null;
  }

  if (typeof value !== "string") {
    return null;
  }

  return /^\d+$/.test(value) ? Number(value) : null;
}

function normalizeString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}
