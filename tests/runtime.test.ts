import { describe, expect, test } from "bun:test";
import { DOCKER_DESKTOP_SSH_AUTH_SOCK_SOURCE } from "../src/constants";
import {
  buildPersistRunnerHostKeysScript,
  buildRestoreRunnerHostKeysScript,
  buildStopManagedSshdScript,
  getRunnerCredFile,
  getRunnerHostKeysDir,
  getRunnerSummaryLines,
  resolveSshAuthSockSource,
} from "../src/runtime";

describe("resolveSshAuthSockSource", () => {
  test("uses the host ssh socket when it exists", () => {
    expect(
      resolveSshAuthSockSource({
        hostEnvSshAuthSock: "/tmp/agent.sock",
        hostEnvSockExists: true,
        dockerDesktopHostServiceAvailable: false,
        allowMissingSsh: false,
      }),
    ).toEqual({
      sshAuthSock: "/tmp/agent.sock",
    });
  });

  test("falls back to Docker Desktop host services when available", () => {
    expect(
      resolveSshAuthSockSource({
        hostEnvSshAuthSock: "/tmp/missing.sock",
        hostEnvSockExists: false,
        dockerDesktopHostServiceAvailable: true,
        allowMissingSsh: false,
      }),
    ).toEqual({
      sshAuthSock: DOCKER_DESKTOP_SSH_AUTH_SOCK_SOURCE,
    });
  });

  test("warns and continues without ssh when allowed", () => {
    expect(
      resolveSshAuthSockSource({
        hostEnvSockExists: false,
        dockerDesktopHostServiceAvailable: false,
        allowMissingSsh: true,
      }),
    ).toEqual({
      sshAuthSock: null,
      warning:
        "No usable SSH agent socket was found. Set SSH_AUTH_SOCK or use Docker Desktop host services. Continuing without SSH agent sharing.",
    });
  });

  test("throws when ssh is missing and continuing is not allowed", () => {
    expect(() =>
      resolveSshAuthSockSource({
        hostEnvSockExists: false,
        dockerDesktopHostServiceAvailable: false,
        allowMissingSsh: false,
      }),
    ).toThrow(
      "No usable SSH agent socket was found. Set SSH_AUTH_SOCK or use Docker Desktop host services. Pass --allow-missing-ssh to continue without SSH agent sharing.",
    );
  });
});

describe("buildStopManagedSshdScript", () => {
  test("uses newlines for the while loop body", () => {
    expect(buildStopManagedSshdScript()).toContain("while read -r pid comm; do\n");
    expect(buildStopManagedSshdScript()).toContain('\ndone)\n');
    expect(buildStopManagedSshdScript()).not.toContain("do;");
  });
});

describe("getRunnerCredFile", () => {
  test("stores runner credentials on the mounted workspace", () => {
    expect(getRunnerCredFile("/workspaces/example-project")).toBe(
      "/workspaces/example-project/.sshcred",
    );
    expect(getRunnerCredFile("/workspaces/example-project/")).toBe(
      "/workspaces/example-project/.sshcred",
    );
  });
});

describe("getRunnerHostKeysDir", () => {
  test("stores host keys on the mounted workspace", () => {
    expect(getRunnerHostKeysDir("/workspaces/example-project")).toBe(
      "/workspaces/example-project/.devbox-ssh-host-keys",
    );
  });
});

describe("runner host key scripts", () => {
  test("restores host keys from the mounted workspace", () => {
    const script = buildRestoreRunnerHostKeysScript("/workspaces/example-project");
    expect(script).toContain("/workspaces/example-project/.devbox-ssh-host-keys");
    expect(script).toContain("find '/workspaces/example-project/.devbox-ssh-host-keys'");
    expect(script).toContain("cp {} /etc/ssh/");
  });

  test("persists host keys back to the mounted workspace", () => {
    const script = buildPersistRunnerHostKeysScript("/workspaces/example-project");
    expect(script).toContain("mkdir -p '/workspaces/example-project/.devbox-ssh-host-keys'");
    expect(script).toContain("find /etc/ssh -maxdepth 1 -type f -name 'ssh_host_*'");
    expect(script).toContain("cp {} '/workspaces/example-project/.devbox-ssh-host-keys'/");
  });
});

describe("getRunnerSummaryLines", () => {
  test("extracts the ssh credential summary from runner output", () => {
    expect(
      getRunnerSummaryLines([
        "[INFO] Installing",
        "SSH user: vscode",
        "SSH pass: secret",
        "SSH port: 6000",
        "PermitRootLogin: no",
        "To stop SSH server, run:",
      ].join("\n")),
    ).toEqual([
      "SSH user: vscode",
      "SSH pass: secret",
      "SSH port: 6000",
      "PermitRootLogin: no",
    ]);
  });
});
