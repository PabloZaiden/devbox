import { describe, expect, test } from "bun:test";
import type { DockerInspect, WorkspaceState } from "../src/core";
import { getDevboxStatus, parseRunnerCredentials } from "../src/status";

describe("parseRunnerCredentials", () => {
  test("extracts runner credentials from the persisted file content", () => {
    expect(
      parseRunnerCredentials(
        ["SSH user: vscode", "SSH pass: secret", "SSH port: 5007", "PermitRootLogin: no", ""].join("\n"),
      ),
    ).toEqual({
      user: "vscode",
      password: "secret",
      sshPort: 5007,
      permitRootLogin: false,
    });
  });
});

describe("getDevboxStatus", () => {
  test("prefers live container data and config hints when available", async () => {
    const state: WorkspaceState = {
      version: 1,
      workspacePath: "/tmp/ws",
      workspaceHash: "workspace-hash",
      port: 5001,
      sourceConfigPath: "/tmp/ws/.devcontainer/devcontainer.json",
      generatedConfigPath: "/tmp/ws/.devcontainer/.devcontainer.json",
      labels: { "devbox.managed": "true", "devbox.workspace": "workspace-hash" },
      userDataDir: "/tmp/ws-state",
      lastContainerId: "container-2",
      updatedAt: "2026-03-16T00:00:00.000Z",
    };
    const containers: DockerInspect[] = [
      {
        Id: "container-1",
        Name: "/devbox-ws-5001",
        State: { Running: false, Status: "exited" },
      },
      {
        Id: "container-2",
        Name: "/devbox-ws-5001",
        State: { Running: true, Status: "running" },
        NetworkSettings: {
          Ports: {
            "5001/tcp": [{ HostIp: "0.0.0.0", HostPort: "5001" }],
          },
        },
      },
    ];

    const status = await getDevboxStatus(
      {
        workspacePath: "/tmp/ws",
        state,
      },
      {
        listManagedContainers: async () => containers.map((container) => container.Id),
        inspectContainers: async () => containers,
        readFile: async (filePath) => {
          if (filePath === "/tmp/ws/.sshcred") {
            return ["SSH user: vscode", "SSH pass: secret", "SSH port: 5001", "PermitRootLogin: no", ""].join("\n");
          }
          if (filePath === state.sourceConfigPath) {
            return '{ "workspaceFolder": "/custom/workdir", "remoteUser": "vscode" }';
          }
          const error = new Error(`Missing file: ${filePath}`) as Error & { code?: string };
          error.code = "ENOENT";
          throw error;
        },
      },
    );

    expect(status.running).toBe(true);
    expect(status.port).toBe(5001);
    expect(status.password).toBe("secret");
    expect(status.workdir).toBe("/custom/workdir");
    expect(status.workdirSource).toBe("config");
    expect(status.remoteUser).toBe("vscode");
    expect(status.containerId).toBe("container-2");
    expect(status.containerCount).toBe(2);
    expect(status.warnings).toEqual([
      "Found 2 managed containers for this workspace; reporting the preferred container.",
    ]);
  });

  test("falls back to default workdir and credential data without saved state", async () => {
    const status = await getDevboxStatus(
      {
        workspacePath: "/tmp/no-state",
        state: null,
      },
      {
        listManagedContainers: async () => [],
        inspectContainers: async () => [],
        readFile: async (filePath) => {
          if (filePath === "/tmp/no-state/.sshcred") {
            return ["SSH user: root", "SSH pass: password", "SSH port: 5010", "PermitRootLogin: yes", ""].join("\n");
          }
          const error = new Error(`Missing file: ${filePath}`) as Error & { code?: string };
          error.code = "ENOENT";
          throw error;
        },
      },
    );

    expect(status.running).toBe(false);
    expect(status.port).toBe(5010);
    expect(status.password).toBe("password");
    expect(status.workdir).toBe("/workspaces/no-state");
    expect(status.workdirSource).toBe("default");
    expect(status.hasStateFile).toBe(false);
    expect(status.hasCredentialFile).toBe(true);
  });

  test("continues to later config candidates after a parse error", async () => {
    const status = await getDevboxStatus(
      {
        workspacePath: "/tmp/parse-fallback",
        state: {
          version: 1,
          workspacePath: "/tmp/parse-fallback",
          workspaceHash: "workspace-hash",
          port: 5001,
          sourceConfigPath: "/tmp/parse-fallback/custom/devcontainer.json",
          generatedConfigPath: "/tmp/parse-fallback/.devcontainer/.devcontainer.json",
          labels: { "devbox.managed": "true", "devbox.workspace": "workspace-hash" },
          userDataDir: "/tmp/state",
          lastContainerId: null,
          updatedAt: "2026-03-16T00:00:00.000Z",
        },
      },
      {
        isDockerAvailable: () => false,
        readFile: async (filePath) => {
          if (filePath === "/tmp/parse-fallback/custom/devcontainer.json") {
            return "{";
          }
          if (filePath === "/tmp/parse-fallback/.devcontainer/devcontainer.json") {
            return '{ "workspaceFolder": "/workspace/fallback", "remoteUser": "vscode" }';
          }
          const error = new Error(`Missing file: ${filePath}`) as Error & { code?: string };
          error.code = "ENOENT";
          throw error;
        },
      },
    );

    expect(status.workdir).toBe("/workspace/fallback");
    expect(status.remoteUser).toBe("vscode");
    expect(status.warnings).toContain(
      "Could not parse devcontainer config for status hints: /tmp/parse-fallback/custom/devcontainer.json.",
    );
  });

  test("continues to later config candidates after a non-object config", async () => {
    const status = await getDevboxStatus(
      {
        workspacePath: "/tmp/object-fallback",
        state: {
          version: 1,
          workspacePath: "/tmp/object-fallback",
          workspaceHash: "workspace-hash",
          port: 5001,
          sourceConfigPath: "/tmp/object-fallback/custom/devcontainer.json",
          generatedConfigPath: "/tmp/object-fallback/.devcontainer/.devcontainer.json",
          labels: { "devbox.managed": "true", "devbox.workspace": "workspace-hash" },
          userDataDir: "/tmp/state",
          lastContainerId: null,
          updatedAt: "2026-03-16T00:00:00.000Z",
        },
      },
      {
        isDockerAvailable: () => false,
        readFile: async (filePath) => {
          if (filePath === "/tmp/object-fallback/custom/devcontainer.json") {
            return '["not-an-object"]';
          }
          if (filePath === "/tmp/object-fallback/.devcontainer/devcontainer.json") {
            return '{ "workspaceFolder": "/workspace/object-fallback", "containerUser": "node" }';
          }
          const error = new Error(`Missing file: ${filePath}`) as Error & { code?: string };
          error.code = "ENOENT";
          throw error;
        },
      },
    );

    expect(status.workdir).toBe("/workspace/object-fallback");
    expect(status.remoteUser).toBe("node");
    expect(status.warnings).toContain(
      "Devcontainer config for status hints was not a JSON object: /tmp/object-fallback/custom/devcontainer.json.",
    );
  });

  test("keeps containerId null when only the persisted lastContainerId remains", async () => {
    const status = await getDevboxStatus(
      {
        workspacePath: "/tmp/no-container",
        state: {
          version: 1,
          workspacePath: "/tmp/no-container",
          workspaceHash: "workspace-hash",
          port: 5001,
          sourceConfigPath: "/tmp/no-container/.devcontainer/devcontainer.json",
          generatedConfigPath: "/tmp/no-container/.devcontainer/.devcontainer.json",
          labels: { "devbox.managed": "true", "devbox.workspace": "workspace-hash" },
          userDataDir: "/tmp/state",
          lastContainerId: "container-stale",
          updatedAt: "2026-03-16T00:00:00.000Z",
        },
      },
      {
        listManagedContainers: async () => [],
        inspectContainers: async () => [],
        readFile: async () => {
          const error = new Error("Missing file") as Error & { code?: string };
          error.code = "ENOENT";
          throw error;
        },
      },
    );

    expect(status.containerId).toBeNull();
    expect(status.lastContainerId).toBe("container-stale");
    expect(status.containerCount).toBe(0);
  });

  test("prefers the stored SSH port binding over unrelated published ports", async () => {
    const status = await getDevboxStatus(
      {
        workspacePath: "/tmp/port-selection",
        state: {
          version: 1,
          workspacePath: "/tmp/port-selection",
          workspaceHash: "workspace-hash",
          port: 5001,
          sourceConfigPath: "/tmp/port-selection/.devcontainer/devcontainer.json",
          generatedConfigPath: "/tmp/port-selection/.devcontainer/.devcontainer.json",
          labels: { "devbox.managed": "true", "devbox.workspace": "workspace-hash" },
          userDataDir: "/tmp/state",
          lastContainerId: "container-1",
          updatedAt: "2026-03-16T00:00:00.000Z",
        },
      },
      {
        listManagedContainers: async () => ["container-1"],
        inspectContainers: async () => [
          {
            Id: "container-1",
            Name: "/devbox-port-selection-5001",
            State: { Running: true, Status: "running" },
            NetworkSettings: {
              Ports: {
                "3000/tcp": [{ HostIp: "0.0.0.0", HostPort: "3000" }],
                "5001/tcp": [{ HostIp: "0.0.0.0", HostPort: "15001" }],
              },
            },
          },
        ],
        readFile: async () => {
          const error = new Error("Missing file") as Error & { code?: string };
          error.code = "ENOENT";
          throw error;
        },
      },
    );

    expect(status.port).toBe(15001);
    expect(status.publishedPorts["3000/tcp"]?.[0]?.hostPort).toBe(3000);
    expect(status.publishedPorts["5001/tcp"]?.[0]?.hostPort).toBe(15001);
  });

  test("falls back to state and credential data when docker is unavailable", async () => {
    const status = await getDevboxStatus(
      {
        workspacePath: "/tmp/docker-missing",
        state: null,
      },
      {
        isDockerAvailable: () => false,
        listManagedContainers: async () => {
          throw new Error("listManagedContainers should not be called when docker is unavailable");
        },
        inspectContainers: async () => {
          throw new Error("inspectContainers should not be called when docker is unavailable");
        },
        readFile: async (filePath) => {
          if (filePath === "/tmp/docker-missing/.sshcred") {
            return ["SSH user: root", "SSH pass: password", "SSH port: 5010", "PermitRootLogin: yes", ""].join("\n");
          }
          const error = new Error(`Missing file: ${filePath}`) as Error & { code?: string };
          error.code = "ENOENT";
          throw error;
        },
      },
    );

    expect(status.running).toBe(false);
    expect(status.containerCount).toBe(0);
    expect(status.port).toBe(5010);
    expect(status.warnings).toContain(
      "Docker was not found in PATH; reporting saved workspace state and credentials only.",
    );
  });
});
