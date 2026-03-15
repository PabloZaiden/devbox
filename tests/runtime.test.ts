import { describe, expect, test } from "bun:test";
import { DOCKER_DESKTOP_SSH_AUTH_SOCK_SOURCE } from "../src/constants";
import type { DockerInspect } from "../src/core";
import {
  buildAssertConfiguredSshAuthSockScript,
  buildDevcontainerShellCommand,
  buildEnsureSshAuthSockAccessibleScript,
  buildInteractiveShellScript,
  buildPersistRunnerHostKeysScript,
  buildRestoreRunnerHostKeysScript,
  buildStopManagedSshdScript,
  formatDevcontainerProgressLine,
  getRunnerCredFile,
  getRunnerHostKeysDir,
  getRunnerSummaryLines,
  isExecutableAvailable,
  resolveShellContainerId,
  requiresSshAuthSockPermissionFix,
  resolveSshAuthSockSource,
} from "../src/runtime";

describe("resolveSshAuthSockSource", () => {
  test("prefers Docker Desktop host services when available", () => {
    expect(
      resolveSshAuthSockSource({
        hostEnvSshAuthSock: "/tmp/agent.sock",
        hostEnvSockExists: true,
        dockerDesktopHostServiceAvailable: true,
        allowMissingSsh: false,
      }),
    ).toEqual({
      sshAuthSock: DOCKER_DESKTOP_SSH_AUTH_SOCK_SOURCE,
    });
  });

  test("uses the host ssh socket when Docker Desktop host services are unavailable", () => {
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

describe("interactive shell helpers", () => {
  test("prefers bash and falls back to sh", () => {
    expect(buildInteractiveShellScript()).toContain("command -v bash");
    expect(buildInteractiveShellScript()).toContain("exec bash -l");
    expect(buildInteractiveShellScript()).toContain("exec sh");
  });

  test("builds the interactive devcontainer exec command", () => {
    expect(buildDevcontainerShellCommand("abc123", { columns: 120, rows: 40 })).toEqual([
      "devcontainer",
      "exec",
      "--container-id",
      "abc123",
      "--terminal-columns",
      "120",
      "--terminal-rows",
      "40",
      "sh",
      "-lc",
      buildInteractiveShellScript(),
    ]);
  });

  test("uses the preferred running container when available", () => {
    const containers: DockerInspect[] = [
      { Id: "stopped", State: { Running: false } },
      { Id: "running-a", State: { Running: true } },
      { Id: "running-b", State: { Running: true } },
    ];

    expect(
      resolveShellContainerId({
        containers,
        preferredContainerId: "running-b",
      }),
    ).toBe("running-b");
  });

  test("falls back to the only running container", () => {
    const containers: DockerInspect[] = [
      { Id: "stopped", State: { Running: false } },
      { Id: "running-a", State: { Running: true } },
    ];

    expect(resolveShellContainerId({ containers, preferredContainerId: "missing" })).toBe("running-a");
  });

  test("throws when no managed container is running", () => {
    const containers: DockerInspect[] = [{ Id: "stopped", State: { Running: false } }];

    expect(() => resolveShellContainerId({ containers })).toThrow(
      "No running managed container was found for this workspace. Run `devbox up` first.",
    );
  });

  test("throws when more than one running container is available without a preferred match", () => {
    const containers: DockerInspect[] = [
      { Id: "running-a", State: { Running: true } },
      { Id: "running-b", State: { Running: true } },
    ];

    expect(() => resolveShellContainerId({ containers })).toThrow(
      "More than one managed container is running for this workspace. Run `devbox down` first.",
    );
  });
});

describe("Docker Desktop SSH socket fix", () => {
  test("only applies the permission fix to the Docker Desktop host-service socket", () => {
    expect(requiresSshAuthSockPermissionFix(DOCKER_DESKTOP_SSH_AUTH_SOCK_SOURCE)).toBe(true);
    expect(requiresSshAuthSockPermissionFix("/private/tmp/agent.sock")).toBe(false);
    expect(requiresSshAuthSockPermissionFix(null)).toBe(false);
  });

  test("relaxes the mounted socket permissions inside the container", () => {
    expect(buildEnsureSshAuthSockAccessibleScript(DOCKER_DESKTOP_SSH_AUTH_SOCK_SOURCE)).toBe(
      "if [ -S '/run/host-services/ssh-auth.sock' ]; then chmod 666 '/run/host-services/ssh-auth.sock'; fi",
    );
  });

  test("fails fast when SSH_AUTH_SOCK points to a missing socket", () => {
    expect(buildAssertConfiguredSshAuthSockScript()).toContain('if [ -z "${SSH_AUTH_SOCK:-}" ]; then');
    expect(buildAssertConfiguredSshAuthSockScript()).toContain('if [ -S "$SSH_AUTH_SOCK" ]; then');
    expect(buildAssertConfiguredSshAuthSockScript()).toContain(
      "Run devbox rebuild to refresh SSH agent sharing.",
    );
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

describe("formatDevcontainerProgressLine", () => {
  test("maps useful devcontainer progress events to readable messages", () => {
    expect(
      formatDevcontainerProgressLine('{"type":"start","level":2,"text":"Resolving Remote"}'),
    ).toBe("Preparing devcontainer...");
    expect(
      formatDevcontainerProgressLine('{"type":"start","level":2,"text":"Starting container"}'),
    ).toBe("Starting container...");
    expect(
      formatDevcontainerProgressLine('{"type":"text","level":1,"text":"workspace root: /tmp/ws"}'),
    ).toBe("Workspace: /tmp/ws");
  });

  test("drops noisy low-level devcontainer log lines", () => {
    expect(
      formatDevcontainerProgressLine('{"type":"text","level":3,"text":"@devcontainers/cli 0.84.0"}'),
    ).toBeNull();
    expect(
      formatDevcontainerProgressLine('{"type":"text","level":2,"text":"Run: docker buildx version"}'),
    ).toBeNull();
    expect(
      formatDevcontainerProgressLine('{"type":"text","level":2,"text":"29.2.1"}'),
    ).toBeNull();
  });

  test("drops leaked env-probe dumps and bash job-control warnings", () => {
    const probeDump =
      "3a47c555-eed4-4f46-b2d8-d62c464a43e0HOSTNAME=3bbefbad0c97SSH_AUTH_SOCK=/tmp/devbox-ssh-auth.sockPWD=/HOME=/home/vscodePATH=/usr/local/binUSER=vscode3a47c555-eed4-4f46-b2d8-d62c464a43e0";

    expect(formatDevcontainerProgressLine(probeDump)).toBeNull();
    expect(
      formatDevcontainerProgressLine("bash: cannot set terminal process group (-1): Inappropriate ioctl for device"),
    ).toBeNull();
    expect(formatDevcontainerProgressLine("bash: no job control in this shell")).toBeNull();
  });
});

describe("isExecutableAvailable", () => {
  test("finds common executables on PATH", () => {
    expect(isExecutableAvailable("sh")).toBe(true);
  });
});
