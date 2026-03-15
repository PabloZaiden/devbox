import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { DOCKER_DESKTOP_SSH_AUTH_SOCK_SOURCE } from "../src/constants";
import {
  buildManagedConfig,
  discoverDevcontainerConfig,
  getDefaultRemoteWorkspaceFolder,
  getContainerSshAuthSockPath,
  getGeneratedConfigPath,
  getLegacyGeneratedConfigPath,
  getManagedContainerName,
  getManagedLabels,
  parseArgs,
  prepareKnownHostsMount,
  resolvePort,
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
      "type=bind,source=/tmp/agent.sock,target=/tmp/devbox-ssh-auth.sock",
      "type=bind,source=/tmp/known_hosts,target=/tmp/devbox-known_hosts,readonly",
    ]);
    expect(managed.containerEnv).toEqual({
      FOO: "bar",
      GH_TOKEN: "${localEnv:GH_TOKEN}",
      SSH_AUTH_SOCK: "/tmp/devbox-ssh-auth.sock",
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
});

describe("getContainerSshAuthSockPath", () => {
  test("uses a stable tmp path for host sockets and preserves Docker Desktop host services", () => {
    expect(getContainerSshAuthSockPath("/tmp/agent.sock")).toBe("/tmp/devbox-ssh-auth.sock");
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
