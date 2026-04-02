import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import pkg from "../package.json";
import { DOCKER_DESKTOP_SSH_AUTH_SOCK_SOURCE } from "../src/constants";
import {
  buildManagedConfig,
  describeUpPortStrategy,
  discoverDevcontainerConfig,
  formatReadyMessage,
  getDefaultRemoteWorkspaceFolder,
  getContainerSshAuthSockPath,
  getGeneratedConfigPath,
  getLegacyGeneratedConfigPath,
  getManagedContainerName,
  getManagedPortFromContainerName,
  getManagedLabels,
  helpText,
  parseArgs,
  prepareKnownHostsMount,
  resolvePort,
  resolveUpPortPreference,
  type DevcontainerConfig,
} from "../src/core";

const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempPaths.splice(0).map(async (tempPath) => {
      await rm(tempPath, { recursive: true, force: true });
    }),
  );
});

describe("parseArgs", () => {
  test("shows help when no args are provided", () => {
    expect(parseArgs([])).toEqual({ command: "help", allowMissingSsh: false });
  });

  test("supports up with a positional port", () => {
    expect(parseArgs(["up", "5001"])).toEqual({ command: "up", port: 5001, allowMissingSsh: false });
  });

  test("supports rebuild with flag port and allow-missing-ssh", () => {
    expect(parseArgs(["rebuild", "--allow-missing-ssh", "--port", "5002"])).toEqual({
      command: "rebuild",
      port: 5002,
      allowMissingSsh: true,
    });
  });

  test("supports the shell subcommand", () => {
    expect(parseArgs(["shell"])).toEqual({ command: "shell", allowMissingSsh: false });
  });

  test("supports the status subcommand", () => {
    expect(parseArgs(["status"])).toEqual({ command: "status", allowMissingSsh: false });
  });

  test("supports the arise subcommand", () => {
    expect(parseArgs(["arise"])).toEqual({ command: "arise", allowMissingSsh: false });
  });

  test("supports selecting a devcontainer subpath", () => {
    expect(parseArgs(["up", "5001", "--devcontainer-subpath", "services/api"])).toEqual({
      command: "up",
      port: 5001,
      allowMissingSsh: false,
      devcontainerSubpath: path.join("services", "api"),
    });
    expect(parseArgs(["up", "--devcontainer-subpath=python"])).toEqual({
      command: "up",
      allowMissingSsh: false,
      devcontainerSubpath: "python",
    });
  });

  test("requires an explicit command for options or ports", () => {
    expect(() => parseArgs(["5001"])).toThrow("A command is required.");
    expect(() => parseArgs(["--devcontainer-subpath=python"])).toThrow("A command is required.");
  });

  test("rejects devcontainer subpaths that escape .devcontainer", () => {
    expect(() => parseArgs(["up", "5001", "--devcontainer-subpath", "../api"])).toThrow(
      "Devcontainer subpath must stay inside .devcontainer.",
    );
  });

  test("down rejects ports", () => {
    expect(() => parseArgs(["down", "5001"])).toThrow();
  });

  test("shell rejects ports and devcontainer subpaths", () => {
    expect(() => parseArgs(["shell", "5001"])).toThrow("The shell command does not accept a port.");
    expect(() => parseArgs(["shell", "--devcontainer-subpath", "services/api"])).toThrow(
      "The shell command does not accept --devcontainer-subpath.",
    );
  });

  test("status rejects ports and unrelated options", () => {
    expect(() => parseArgs(["status", "5001"])).toThrow("The status command does not accept a port.");
    expect(() => parseArgs(["status", "--devcontainer-subpath", "services/api"])).toThrow(
      "The status command does not accept --devcontainer-subpath.",
    );
    expect(() => parseArgs(["status", "--allow-missing-ssh"])).toThrow(
      "The status command does not accept --allow-missing-ssh.",
    );
  });

  test("arise rejects ports and unrelated options", () => {
    expect(() => parseArgs(["arise", "5001"])).toThrow("The arise command does not accept a port.");
    expect(() => parseArgs(["arise", "--devcontainer-subpath", "services/api"])).toThrow(
      "The arise command does not accept --devcontainer-subpath.",
    );
    expect(() => parseArgs(["arise", "--allow-missing-ssh"])).toThrow(
      "The arise command does not accept --allow-missing-ssh.",
    );
  });
});

describe("helpText", () => {
  test("does not include a Notes section", () => {
    expect(helpText()).not.toContain("Notes:");
  });

  test("includes the package version", () => {
    expect(helpText()).toContain(pkg.version);
  });

  test("includes core sections", () => {
    const text = helpText();
    expect(text).toContain("Usage:");
    expect(text).toContain("Commands:");
    expect(text).toContain("Options:");
  });

  test("lists all commands", () => {
    const text = helpText();
    expect(text).toContain("up");
    expect(text).toContain("rebuild");
    expect(text).toContain("shell");
    expect(text).toContain("status");
    expect(text).toContain("arise");
    expect(text).toContain("down");
    expect(text).toContain("help");
  });
});

describe("resolvePort", () => {
  test("reuses stored port", () => {
    expect(
      resolvePort("up", undefined, {
        version: 1,
        workspacePath: "/tmp/ws",
        workspaceHash: "hash",
        port: 5003,
        sourceConfigPath: "/tmp/ws/.devcontainer/devcontainer.json",
        generatedConfigPath: "/tmp/ws/.devcontainer/.devbox.generated.devcontainer.json",
        labels: { managed: "true" },
        userDataDir: "/tmp/state",
        updatedAt: new Date().toISOString(),
      }),
    ).toBe(5003);
  });
});

describe("resolveUpPortPreference", () => {
  const state = {
    version: 1,
    workspacePath: "/tmp/ws",
    workspaceHash: "hash",
    port: 5003,
    sourceConfigPath: "/tmp/ws/.devcontainer/devcontainer.json",
    generatedConfigPath: "/tmp/ws/.devcontainer/.devbox.generated.devcontainer.json",
    labels: { managed: "true" },
    userDataDir: "/tmp/state",
    updatedAt: new Date().toISOString(),
  };

  test("prefers an explicit port", () => {
    expect(resolveUpPortPreference({ explicitPort: 5001, state, existingPublishedPort: 5002 })).toBe(5001);
  });

  test("reuses the stored workspace port when no explicit port is provided", () => {
    expect(resolveUpPortPreference({ explicitPort: undefined, state, existingPublishedPort: 5002 })).toBe(5003);
  });

  test("falls back to an existing managed container port when state is missing", () => {
    expect(resolveUpPortPreference({ explicitPort: undefined, state: null, existingPublishedPort: 5004 })).toBe(5004);
  });

  test("returns undefined when up should auto-assign a new port", () => {
    expect(resolveUpPortPreference({ explicitPort: undefined, state: null, existingPublishedPort: undefined })).toBeUndefined();
  });
});

describe("getManagedPortFromContainerName", () => {
  test("round-trips the managed container name format", () => {
    const containerName = getManagedContainerName("/tmp/my-workspace", 5007);
    expect(getManagedPortFromContainerName(containerName)).toBe(5007);
    expect(getManagedPortFromContainerName(`/${containerName}`)).toBe(5007);
  });

  test("ignores names that do not follow the managed naming convention", () => {
    expect(getManagedPortFromContainerName("my-container")).toBeUndefined();
    expect(getManagedPortFromContainerName("/devbox-example")).toBeUndefined();
  });
});

describe("describeUpPortStrategy", () => {
  test("describes the stored-port reuse and auto-assignment behavior", () => {
    expect(describeUpPortStrategy()).toBe(
      "Reuse the previous workspace port when available, otherwise auto-assign the first free port starting at 5001.",
    );
  });
});

describe("discoverDevcontainerConfig", () => {
  test("finds nested devcontainer file", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "devbox-test-"));
    tempPaths.push(tempDir);
    await mkdir(path.join(tempDir, ".devcontainer"), { recursive: true });
    await writeFile(
      path.join(tempDir, ".devcontainer", "devcontainer.json"),
      `{
        // comment is valid jsonc
        "image": "mcr.microsoft.com/devcontainers/base:ubuntu"
      }`,
    );

    const discovered = await discoverDevcontainerConfig(tempDir);
    expect(discovered.path).toBe(path.join(tempDir, ".devcontainer", "devcontainer.json"));
    expect(discovered.config.image).toBe("mcr.microsoft.com/devcontainers/base:ubuntu");
  });

  test("finds a devcontainer file in the requested subpath", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "devbox-test-"));
    tempPaths.push(tempDir);
    await mkdir(path.join(tempDir, ".devcontainer", "services", "api"), { recursive: true });
    await writeFile(
      path.join(tempDir, ".devcontainer", "services", "api", "devcontainer.json"),
      `{ "image": "mcr.microsoft.com/devcontainers/typescript-node:1-22-bookworm" }`,
    );

    const discovered = await discoverDevcontainerConfig(tempDir, path.join("services", "api"));
    expect(discovered.path).toBe(path.join(tempDir, ".devcontainer", "services", "api", "devcontainer.json"));
    expect(discovered.config.image).toBe("mcr.microsoft.com/devcontainers/typescript-node:1-22-bookworm");
  });

  test("falls back to workspace-root .devcontainer.json by default", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "devbox-test-"));
    tempPaths.push(tempDir);
    await writeFile(
      path.join(tempDir, ".devcontainer.json"),
      `{ "image": "mcr.microsoft.com/devcontainers/base:ubuntu" }`,
    );

    const discovered = await discoverDevcontainerConfig(tempDir);
    expect(discovered.path).toBe(path.join(tempDir, ".devcontainer.json"));
  });

  test("does not silently fall back when a requested subpath is missing", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "devbox-test-"));
    tempPaths.push(tempDir);
    await writeFile(
      path.join(tempDir, ".devcontainer.json"),
      `{ "image": "mcr.microsoft.com/devcontainers/base:ubuntu" }`,
    );

    await expect(discoverDevcontainerConfig(tempDir, "missing")).rejects.toThrow(
      "Expected .devcontainer/missing/devcontainer.json.",
    );
  });
});

describe("buildManagedConfig", () => {
  test("adds port publish, mounts and env", () => {
    const baseConfig: DevcontainerConfig = {
      image: "mcr.microsoft.com/devcontainers/base:ubuntu",
      runArgs: ["--init"],
      mounts: ["type=bind,source=/tmp/a,target=/tmp/a"],
      containerEnv: {
        FOO: "bar",
      },
    };

    const managed = buildManagedConfig(baseConfig, {
      port: 5001,
      containerName: "devbox-example-5001",
      sshAuthSock: "/tmp/agent.sock",
      knownHostsPath: "/tmp/known_hosts",
      githubTokenAvailable: true,
    });

    expect(managed.runArgs).toEqual(["--init", "--name", "devbox-example-5001", "-p", "5001:5001"]);
    expect(managed.mounts).toEqual([
      "type=bind,source=/tmp/a,target=/tmp/a",
      "type=bind,source=/tmp/agent.sock,target=/run/devbox-ssh-auth.sock",
    ]);
    expect(managed.containerEnv).toEqual({
      FOO: "bar",
      GH_TOKEN: "${localEnv:GH_TOKEN}",
      SSH_AUTH_SOCK: "/run/devbox-ssh-auth.sock",
    });
  });

  test("omits ssh mount and env when ssh sharing is disabled", () => {
    const managed = buildManagedConfig(
      {
        image: "mcr.microsoft.com/devcontainers/base:ubuntu",
        mounts: ["type=bind,source=/tmp/a,target=/tmp/a"],
        containerEnv: {
          FOO: "bar",
        },
      },
      {
        port: 5001,
        containerName: "devbox-example-5001",
        sshAuthSock: null,
        knownHostsPath: null,
        githubTokenAvailable: false,
      },
    );

    expect(managed.mounts).toEqual(["type=bind,source=/tmp/a,target=/tmp/a"]);
    expect(managed.containerEnv).toEqual({
      FOO: "bar",
    });
  });

  test("keeps the Docker Desktop SSH socket path inside the container", () => {
    const managed = buildManagedConfig(
      {
        image: "mcr.microsoft.com/devcontainers/base:ubuntu",
      },
      {
        port: 5001,
        containerName: "devbox-example-5001",
        sshAuthSock: DOCKER_DESKTOP_SSH_AUTH_SOCK_SOURCE,
        knownHostsPath: null,
        githubTokenAvailable: false,
      },
    );

    expect(managed.mounts).toEqual([
      `type=bind,source=${DOCKER_DESKTOP_SSH_AUTH_SOCK_SOURCE},target=${DOCKER_DESKTOP_SSH_AUTH_SOCK_SOURCE}`,
    ]);
    expect(managed.containerEnv).toEqual({
      SSH_AUTH_SOCK: DOCKER_DESKTOP_SSH_AUTH_SOCK_SOURCE,
    });
  });

  test("does not duplicate existing published port", () => {
    const managed = buildManagedConfig(
      {
        image: "mcr.microsoft.com/devcontainers/base:ubuntu",
        runArgs: ["--name", "custom-name", "-p", "5001:5001"],
      },
      {
        port: 5001,
        containerName: "devbox-example-5001",
        sshAuthSock: "/tmp/agent.sock",
        knownHostsPath: null,
        githubTokenAvailable: false,
      },
    );

    expect(managed.runArgs).toEqual(["-p", "5001:5001", "--name", "devbox-example-5001"]);
  });

  test("stores a localEnv placeholder instead of a persisted github token value", () => {
    const managed = buildManagedConfig(
      {
        image: "mcr.microsoft.com/devcontainers/base:ubuntu",
      },
      {
        port: 5001,
        containerName: "devbox-example-5001",
        sshAuthSock: null,
        knownHostsPath: null,
        githubTokenAvailable: true,
      },
    );

    expect(JSON.stringify(managed)).toContain('"GH_TOKEN":"${localEnv:GH_TOKEN}"');
    expect(JSON.stringify(managed)).not.toContain("ghp_");
  });

  test("forces root as the container user when requested", () => {
    const managed = buildManagedConfig(
      {
        image: "mcr.microsoft.com/devcontainers/base:ubuntu",
        remoteUser: "vscode",
        containerUser: "vscode",
      },
      {
        port: 5001,
        containerName: "devbox-example-5001",
        sshAuthSock: null,
        knownHostsPath: null,
        githubTokenAvailable: false,
        forceRootUser: true,
      },
    );

    expect(managed.remoteUser).toBe("root");
    expect(managed.containerUser).toBe("root");
  });
});

describe("prepareKnownHostsMount", () => {
  test("creates a staged snapshot for a non-empty host known_hosts file", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "devbox-test-"));
    tempPaths.push(tempDir);
    const homeDir = path.join(tempDir, "home");
    const userDataDir = path.join(tempDir, "user-data");
    await mkdir(path.join(homeDir, ".ssh"), { recursive: true });
    await writeFile(path.join(homeDir, ".ssh", "known_hosts"), "github.com ssh-ed25519 AAAAC3Nza...\n");
    const prepared = await prepareKnownHostsMount({ userDataDir, homeDir });
    expect(prepared.warning).toBeUndefined();
    expect(prepared.knownHostsPath).toBe(path.join(userDataDir, "known_hosts"));
    expect(await Bun.file(prepared.knownHostsPath!).text()).toBe("github.com ssh-ed25519 AAAAC3Nza...\n");
  });

  test("skips an empty host known_hosts file with a warning", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "devbox-test-"));
    tempPaths.push(tempDir);
    const homeDir = path.join(tempDir, "home");
    const userDataDir = path.join(tempDir, "user-data");
    await mkdir(path.join(homeDir, ".ssh"), { recursive: true });
    await writeFile(path.join(homeDir, ".ssh", "known_hosts"), "\n");
    const prepared = await prepareKnownHostsMount({ userDataDir, homeDir });
    expect(prepared.knownHostsPath).toBeNull();
    expect(prepared.warning).toContain("Host known_hosts is empty");
  });

  test("warns when the host known_hosts file is missing", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "devbox-test-"));
    tempPaths.push(tempDir);
    const homeDir = path.join(tempDir, "home");
    const userDataDir = path.join(tempDir, "user-data");
    await mkdir(path.join(homeDir, ".ssh"), { recursive: true });
    const prepared = await prepareKnownHostsMount({ userDataDir, homeDir });
    expect(prepared.knownHostsPath).toBeNull();
    expect(prepared.warning).toContain("Host known_hosts was not found");
  });

  test("skips symlinked host known_hosts files with a warning", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "devbox-test-"));
    tempPaths.push(tempDir);
    const homeDir = path.join(tempDir, "home");
    const sshDir = path.join(homeDir, ".ssh");
    const userDataDir = path.join(tempDir, "user-data");
    await mkdir(sshDir, { recursive: true });
    const realKnownHosts = path.join(tempDir, "known_hosts.real");
    await writeFile(realKnownHosts, "github.com ssh-ed25519 AAAAC3Nza...\n");
    await symlink(realKnownHosts, path.join(sshDir, "known_hosts"));
    const prepared = await prepareKnownHostsMount({ userDataDir, homeDir });
    expect(prepared.knownHostsPath).toBeNull();
    expect(prepared.warning).toContain("symbolic link");
  });

  test("warns instead of throwing when staging fails", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "devbox-test-"));
    tempPaths.push(tempDir);
    const homeDir = path.join(tempDir, "home");
    const userDataDir = path.join(tempDir, "user-data");
    await mkdir(path.join(homeDir, ".ssh"), { recursive: true });
    await writeFile(path.join(homeDir, ".ssh", "known_hosts"), "github.com ssh-ed25519 AAAAC3Nza...\n");
    await writeFile(userDataDir, "occupied\n");
    const prepared = await prepareKnownHostsMount({ userDataDir, homeDir });
    expect(prepared.knownHostsPath).toBeNull();
    expect(prepared.warning).toContain("could not be staged");
  });
});

describe("getContainerSshAuthSockPath", () => {
  test("uses a stable tmp path for host sockets and preserves Docker Desktop host services", () => {
    expect(getContainerSshAuthSockPath("/tmp/agent.sock")).toBe("/run/devbox-ssh-auth.sock");
    expect(getContainerSshAuthSockPath(DOCKER_DESKTOP_SSH_AUTH_SOCK_SOURCE)).toBe(
      DOCKER_DESKTOP_SSH_AUTH_SOCK_SOURCE,
    );
    expect(getContainerSshAuthSockPath(null)).toBeNull();
  });
});

describe("paths and labels", () => {
  test("uses accepted generated config names and labels", () => {
    expect(getGeneratedConfigPath("/tmp/ws/.devcontainer/devcontainer.json")).toBe(
      "/tmp/ws/.devcontainer/.devcontainer.json",
    );
    expect(getGeneratedConfigPath("/tmp/ws/.devcontainer.json")).toBe(
      "/tmp/ws/devcontainer.json",
    );
    expect(getLegacyGeneratedConfigPath("/tmp/ws/.devcontainer/devcontainer.json")).toBe(
      "/tmp/ws/.devcontainer/.devbox.generated.devcontainer.json",
    );
    expect(getDefaultRemoteWorkspaceFolder("/tmp/ws/example-project")).toBe(
      "/workspaces/example-project",
    );
    expect(getManagedContainerName("/tmp/ws/example-project", 5001)).toBe(
      "devbox-example-project-5001",
    );
    expect(getManagedContainerName("/tmp/ws/Project Name!", 6000)).toBe(
      "devbox-project-name-6000",
    );
    expect(getManagedLabels("hash123")).toEqual({
      "devbox.managed": "true",
      "devbox.workspace": "hash123",
    });
  });
});

describe("formatReadyMessage", () => {
  test("includes the default /workspaces project root in the final message", () => {
    const remoteWorkspaceFolder = getDefaultRemoteWorkspaceFolder("/tmp/ws/example-project");

    expect(formatReadyMessage("1234567890abcdef", 5001, remoteWorkspaceFolder)).toBe(
      "\nReady. 1234567890ab is available on port 5001.\nProject root inside the container: /workspaces/example-project",
    );
  });

  test("includes an explicit remote workspace folder from the devcontainer result", () => {
    expect(formatReadyMessage("abcdef1234567890", 6000, "/workspace/custom-root")).toBe(
      "\nReady. abcdef123456 is available on port 6000.\nProject root inside the container: /workspace/custom-root",
    );
  });
});
