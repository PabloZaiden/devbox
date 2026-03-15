import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  buildManagedConfig,
  discoverDevcontainerConfig,
  getDefaultRemoteWorkspaceFolder,
  getGeneratedConfigPath,
  getLegacyGeneratedConfigPath,
  getManagedContainerName,
  getManagedLabels,
  parseArgs,
  resolvePort,
  type DevcontainerConfig,
} from "../src/core";

const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempPaths.splice(0).map(async (tempPath) => {
      await Bun.$`rm -rf ${tempPath}`.quiet();
    }),
  );
});

describe("parseArgs", () => {
  test("supports positional up port", () => {
    expect(parseArgs(["5001"])).toEqual({ command: "up", port: 5001, allowMissingSsh: false });
  });

  test("supports rebuild with flag port and allow-missing-ssh", () => {
    expect(parseArgs(["rebuild", "--allow-missing-ssh", "--port", "5002"])).toEqual({
      command: "rebuild",
      port: 5002,
      allowMissingSsh: true,
    });
  });

  test("down rejects ports", () => {
    expect(() => parseArgs(["down", "5001"])).toThrow();
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
    });

    expect(managed.runArgs).toEqual(["--init", "--name", "devbox-example-5001", "-p", "5001:5001"]);
    expect(managed.mounts).toEqual([
      "type=bind,source=/tmp/a,target=/tmp/a",
      "type=bind,source=/tmp/agent.sock,target=/tmp/devbox-ssh-auth.sock",
      "type=bind,source=/tmp/known_hosts,target=/tmp/devbox-known_hosts,readonly",
    ]);
    expect(managed.containerEnv).toEqual({
      FOO: "bar",
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
      },
    );

    expect(managed.mounts).toEqual(["type=bind,source=/tmp/a,target=/tmp/a"]);
    expect(managed.containerEnv).toEqual({
      FOO: "bar",
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
      },
    );

    expect(managed.runArgs).toEqual(["-p", "5001:5001", "--name", "devbox-example-5001"]);
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
