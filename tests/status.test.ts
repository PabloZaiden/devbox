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
});
