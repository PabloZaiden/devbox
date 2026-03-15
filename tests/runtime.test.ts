import { describe, expect, test } from "bun:test";
import { DOCKER_DESKTOP_SSH_AUTH_SOCK_SOURCE } from "../src/constants";
import type { DockerInspect } from "../src/core";
import {
  buildAssertConfiguredSshAuthSockScript,
  buildConfigureGitIdentityScript,
  buildDevcontainerShellCommand,
  buildEnsureSshAuthSockAccessibleScript,
  buildInteractiveShellScript,
  findFirstAvailablePort,
  buildPersistRunnerHostKeysScript,
  buildRestoreRunnerHostKeysScript,
  buildStopManagedSshdScript,
  formatDevcontainerProgressLine,
  getRunnerCredFile,
  getRunnerHostKeysDir,
  getRunnerSummaryLines,
  isExecutableAvailable,
  looksLikeGhUnauthenticatedError,
  probePortAvailability,
  redactSensitiveOutput,
  resolveShellContainerId,
  resolveGhCliToken,
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

describe("findFirstAvailablePort", () => {
  test("returns the starting port when it is available", async () => {
    await expect(findFirstAvailablePort(5001, async () => true)).resolves.toBe(5001);
  });

  test("skips unavailable ports until it finds a free one", async () => {
    const checkedPorts: number[] = [];

    await expect(
      findFirstAvailablePort(5001, async (port) => {
        checkedPorts.push(port);
        return port === 5003;
      }),
    ).resolves.toBe(5003);

    expect(checkedPorts).toEqual([5001, 5002, 5003]);
  });

  test("rejects invalid starting ports", async () => {
    await expect(findFirstAvailablePort(0, async () => true)).rejects.toThrow(
      "Port must be between 1 and 65535. Received: 0",
    );
  });

  test("throws when there are no available ports in range", async () => {
    await expect(findFirstAvailablePort(65535, async () => false)).rejects.toThrow(
      "No available host port was found starting at 65535.",
    );
  });
});

describe("probePortAvailability", () => {
  test("uses lsof PID results when available", async () => {
    await expect(
      probePortAvailability(5001, {
        canUseLsof: true,
        listListeningPids: async () => ["1234"],
      }),
    ).resolves.toEqual({
      available: false,
      pids: ["1234"],
    });
  });

  test("falls back to bind probing when lsof is unavailable", async () => {
    await expect(
      probePortAvailability(5001, {
        canUseLsof: false,
        tryBindPort: async () => false,
      }),
    ).resolves.toEqual({
      available: false,
      pids: [],
    });
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

describe("buildConfigureGitIdentityScript", () => {
  test("returns null when the host has no git identity to copy", () => {
    expect(
      buildConfigureGitIdentityScript({
        gitUserName: null,
        gitUserEmail: null,
      }),
    ).toBeNull();
  });

  test("fills in missing container git config without overwriting existing values", () => {
    const script = buildConfigureGitIdentityScript({
      gitUserName: "Pablo O'Brian",
      gitUserEmail: "pablo+dev@example.com",
    });

    expect(script).not.toBeNull();
    if (!script) {
      return;
    }

    expect(script).toContain("if ! command -v git >/dev/null 2>&1; then");
    expect(script).toContain('current_git_user_name="$(git config --global --get user.name 2>/dev/null || true)"');
    expect(script).toContain('if [ -z "$current_git_user_name" ]; then');
    expect(script).toContain(`git config --global user.name 'Pablo O'"'"'Brian'`);
    expect(script).toContain('current_git_user_email="$(git config --global --get user.email 2>/dev/null || true)"');
    expect(script).toContain('if [ -z "$current_git_user_email" ]; then');
    expect(script).toContain("git config --global user.email 'pablo+dev@example.com'");
  });

  test("only configures host values that are available", () => {
    const script = buildConfigureGitIdentityScript({
      gitUserName: null,
      gitUserEmail: "pablo+dev@example.com",
    });

    expect(script).not.toBeNull();
    if (!script) {
      return;
    }

    expect(script).not.toContain("user.name");
    expect(script).toContain("git config --global user.email 'pablo+dev@example.com'");
  });
});

describe("resolveGhCliToken", () => {
  test("returns null when gh is unavailable", () => {
    expect(resolveGhCliToken({ ghAvailable: false })).toEqual({ token: null });
  });

  test("returns a trimmed token when gh auth token succeeds", () => {
    expect(resolveGhCliToken({ ghAvailable: true, exitCode: 0, stdout: "  secret-token  \n" })).toEqual({
      token: "secret-token",
    });
  });

  test("treats unauthenticated gh output as an optional no-op", () => {
    expect(
      resolveGhCliToken({
        ghAvailable: true,
        exitCode: 1,
        stderr: "You are not logged into any hosts. Run gh auth login to authenticate.",
      }),
    ).toEqual({ token: null });
  });

  test("returns a safe warning for unexpected gh failures", () => {
    expect(
      resolveGhCliToken({
        ghAvailable: true,
        exitCode: 1,
        stderr: "transport error",
      }),
    ).toEqual({
      token: null,
      warning: "GitHub CLI auth token lookup failed. Continuing without GH_TOKEN injection.",
    });
  });

  test("returns a safe warning when gh succeeds without a token", () => {
    expect(resolveGhCliToken({ ghAvailable: true, exitCode: 0, stdout: " \n" })).toEqual({
      token: null,
      warning: "GitHub CLI returned an empty auth token. Continuing without GH_TOKEN injection.",
    });
  });
});

describe("looksLikeGhUnauthenticatedError", () => {
  test("recognizes common gh authentication prompts", () => {
    expect(looksLikeGhUnauthenticatedError("Run gh auth login to authenticate.")).toBe(true);
    expect(looksLikeGhUnauthenticatedError("authentication required")).toBe(true);
    expect(looksLikeGhUnauthenticatedError("network timeout")).toBe(false);
  });
});

describe("redactSensitiveOutput", () => {
  test("redacts GH_TOKEN values from plain text and JSON-like output", () => {
    expect(redactSensitiveOutput("GH_TOKEN=secret-value")).toBe("GH_TOKEN=<redacted>");
    expect(redactSensitiveOutput('{"GH_TOKEN":"secret-value"}')).toBe('{"GH_TOKEN":"<redacted>"}');
    expect(redactSensitiveOutput("GH_TOKEN: secret-value")).toBe("GH_TOKEN: <redacted>");
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
      formatDevcontainerProgressLine('{"type":"raw","level":1,"text":"Container started"}'),
    ).toBe("Container started. Finishing devcontainer setup...");
    expect(
      formatDevcontainerProgressLine('{"type":"text","level":1,"text":"workspace root: /tmp/ws"}'),
    ).toBe("Workspace: /tmp/ws");
    expect(
      formatDevcontainerProgressLine('{"type":"text","level":1,"text":"Inspecting container"}'),
    ).toBe("Inspecting container...");
    expect(
      formatDevcontainerProgressLine('{"type":"text","level":1,"text":"userEnvProbe shell: /bin/bash"}'),
    ).toBe("Checking container environment...");
    expect(
      formatDevcontainerProgressLine(
        '{"type":"text","level":1,"text":"LifecycleCommandExecutionMap: {\\"postCreateCommand\\":\\"npm install\\"}"}',
      ),
    ).toBe("Running postCreateCommand...");
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

  test("redacts GH_TOKEN values in surfaced progress output", () => {
    expect(formatDevcontainerProgressLine("GH_TOKEN=secret-value")).toBe("GH_TOKEN=<redacted>");
    expect(formatDevcontainerProgressLine('{"type":"text","level":1,"text":"GH_TOKEN=secret-value"}')).toBe(
      "GH_TOKEN=<redacted>",
    );
  });
});

describe("isExecutableAvailable", () => {
  test("finds common executables on PATH", () => {
    expect(isExecutableAvailable("sh")).toBe(true);
  });
});
