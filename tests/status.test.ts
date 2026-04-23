import { describe, expect, test } from "bun:test";
import type { DockerInspect, WorkspaceState } from "../src/core";
import { createRunnerMetadata, parseRunnerCredentials, serializeRunnerMetadata } from "../src/runnerState";
import { getDevboxStatus } from "../src/status";

describe("parseRunnerCredentials", () => {
  test("extracts a password from the password-only persisted file", () => {
    expect(parseRunnerCredentials("secret\n")).toEqual({
      user: null,
      password: "secret",
      sshPort: null,
      permitRootLogin: null,
    });
  });

  test("extracts runner credentials from a legacy summary format", () => {
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

  test("extracts runner credentials from a legacy key-value format", () => {
    expect(
      parseRunnerCredentials(
        ["user=root", "pass=password", "port=5007", "permitRootLogin=yes", ""].join("\n"),
      ),
    ).toEqual({
      user: "root",
      password: "password",
      sshPort: 5007,
      permitRootLogin: true,
    });
  });
});

describe("getDevboxStatus", () => {
  test("prefers live container data and config hints when available", async () => {
    const state: WorkspaceState = {
      version: 2,
      workspacePath: "/tmp/ws",
      workspaceHash: "workspace-hash",
      port: 5001,
      configSource: "repo",
      sourceConfigPath: "/tmp/ws/.devcontainer/devcontainer.json",
      generatedConfigPath: "/tmp/ws/.devcontainer/.devcontainer.json",
      labels: { "devbox.managed": "true", "devbox.workspace": "workspace-hash" },
      userDataDir: "/tmp/ws-state",
      template: null,
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
            return "secret\n";
          }
          if (filePath === "/tmp/ws/.devbox-ssh.json") {
            return serializeRunnerMetadata(
              createRunnerMetadata({
                sshUser: "vscode",
                sshPort: 5001,
                permitRootLogin: false,
                publicKeyConfigured: true,
                publicKeySource: "/home/me/.ssh/id_rsa.pub",
              }),
            );
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
    expect(status.sshUser).toBe("vscode");
    expect(status.sshPort).toBe(5001);
    expect(status.permitRootLogin).toBe(false);
    expect(status.publicKeyConfigured).toBe(true);
    expect(status.publicKeySource).toBe("/home/me/.ssh/id_rsa.pub");
    expect(status.workdir).toBe("/custom/workdir");
    expect(status.workdirSource).toBe("config");
    expect(status.remoteUser).toBe("vscode");
    expect(status.containerId).toBe("container-2");
    expect(status.containerCount).toBe(2);
    expect(status.hasSshMetadataFile).toBe(true);
    expect(status.warnings).toEqual([
      "Found 2 managed containers for this workspace; reporting the preferred container.",
    ]);
  });

  test("falls back to default workdir, password file, and metadata file without saved state", async () => {
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
            return "password\n";
          }
          if (filePath === "/tmp/no-state/.devbox-ssh.json") {
            return serializeRunnerMetadata(
              createRunnerMetadata({
                sshUser: "root",
                sshPort: 5010,
                permitRootLogin: true,
                publicKeyConfigured: false,
              }),
            );
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
    expect(status.sshUser).toBe("root");
    expect(status.sshPort).toBe(5010);
    expect(status.permitRootLogin).toBe(true);
    expect(status.publicKeyConfigured).toBe(false);
    expect(status.publicKeySource).toBeNull();
    expect(status.workdir).toBe("/workspaces/no-state");
    expect(status.workdirSource).toBe("default");
    expect(status.hasStateFile).toBe(false);
    expect(status.hasCredentialFile).toBe(true);
    expect(status.hasSshMetadataFile).toBe(true);
    expect(status.warnings).toEqual([
      "`remoteUser` is unavailable because the devcontainer config does not set `remoteUser` or `containerUser`.",
    ]);
  });

  test("continues to later config candidates after a parse error", async () => {
    const status = await getDevboxStatus(
      {
        workspacePath: "/tmp/parse-fallback",
        state: {
          version: 2,
          workspacePath: "/tmp/parse-fallback",
          workspaceHash: "workspace-hash",
          port: 5001,
          configSource: "repo",
          sourceConfigPath: "/tmp/parse-fallback/custom/devcontainer.json",
          generatedConfigPath: "/tmp/parse-fallback/.devcontainer/.devcontainer.json",
          labels: { "devbox.managed": "true", "devbox.workspace": "workspace-hash" },
          userDataDir: "/tmp/state",
          template: null,
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
          version: 2,
          workspacePath: "/tmp/object-fallback",
          workspaceHash: "workspace-hash",
          port: 5001,
          configSource: "repo",
          sourceConfigPath: "/tmp/object-fallback/custom/devcontainer.json",
          generatedConfigPath: "/tmp/object-fallback/.devcontainer/.devcontainer.json",
          labels: { "devbox.managed": "true", "devbox.workspace": "workspace-hash" },
          userDataDir: "/tmp/state",
          template: null,
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
          version: 2,
          workspacePath: "/tmp/no-container",
          workspaceHash: "workspace-hash",
          port: 5001,
          configSource: "repo",
          sourceConfigPath: "/tmp/no-container/.devcontainer/devcontainer.json",
          generatedConfigPath: "/tmp/no-container/.devcontainer/.devcontainer.json",
          labels: { "devbox.managed": "true", "devbox.workspace": "workspace-hash" },
          userDataDir: "/tmp/state",
          template: null,
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

  test("explains missing SSH metadata when only the runner password file is present", async () => {
    const status = await getDevboxStatus(
      {
        workspacePath: "/tmp/password-only",
        state: {
          version: 2,
          workspacePath: "/tmp/password-only",
          workspaceHash: "workspace-hash",
          port: 5005,
          configSource: "repo",
          sourceConfigPath: "/tmp/password-only/.devcontainer/devcontainer.json",
          generatedConfigPath: "/tmp/password-only/.devcontainer/.devcontainer.json",
          labels: { "devbox.managed": "true", "devbox.workspace": "workspace-hash" },
          userDataDir: "/tmp/state",
          template: null,
          lastContainerId: "container-1",
          updatedAt: "2026-03-16T00:00:00.000Z",
        },
      },
      {
        listManagedContainers: async () => ["container-1"],
        inspectContainers: async () => [
          {
            Id: "container-1",
            Name: "/devbox-password-only-5005",
            State: { Running: true, Status: "running" },
            NetworkSettings: {
              Ports: {
                "5005/tcp": [{ HostIp: "0.0.0.0", HostPort: "5005" }],
              },
            },
          },
        ],
        readFile: async (filePath) => {
          if (filePath === "/tmp/password-only/.sshcred") {
            return "password\n";
          }
          if (filePath === "/tmp/password-only/.devcontainer/devcontainer.json") {
            return '{ "workspaceFolder": "/custom/workdir" }';
          }
          const error = new Error(`Missing file: ${filePath}`) as Error & { code?: string };
          error.code = "ENOENT";
          throw error;
        },
      },
    );

    expect(status.password).toBe("password");
    expect(status.sshPort).toBe(5005);
    expect(status.sshUser).toBeNull();
    expect(status.permitRootLogin).toBeNull();
    expect(status.hasSshMetadataFile).toBe(false);
    expect(status.warnings).toContain(
      "Devbox SSH metadata file was not found: /tmp/password-only/.devbox-ssh.json. `sshUser` and `permitRootLogin` are unavailable. Start the workspace again with this devbox version to persist them.",
    );
    expect(status.warnings).toContain(
      "`remoteUser` is unavailable because the devcontainer config does not set `remoteUser` or `containerUser`.",
    );
  });

  test("prefers the stored SSH port binding over unrelated published ports", async () => {
    const status = await getDevboxStatus(
      {
        workspacePath: "/tmp/port-selection",
        state: {
          version: 2,
          workspacePath: "/tmp/port-selection",
          workspaceHash: "workspace-hash",
          port: 5001,
          configSource: "repo",
          sourceConfigPath: "/tmp/port-selection/.devcontainer/devcontainer.json",
          generatedConfigPath: "/tmp/port-selection/.devcontainer/.devcontainer.json",
          labels: { "devbox.managed": "true", "devbox.workspace": "workspace-hash" },
          userDataDir: "/tmp/state",
          template: null,
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
    expect(status.sshPort).toBe(5001);
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
            return "password\n";
          }
          if (filePath === "/tmp/docker-missing/.devbox-ssh.json") {
            return serializeRunnerMetadata(
              createRunnerMetadata({
                sshUser: "root",
                sshPort: 5010,
                permitRootLogin: true,
              }),
            );
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
      "Docker was not found in PATH; reporting saved workspace state and persisted SSH files only.",
    );
  });
});
