import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  ariseManagedWorkspaces,
  discoverStoppedManagedWorkspaces,
  getStoredDevcontainerSubpath,
  inspectWorkspaceRestartReadiness,
  recoverWorkspaceMount,
} from "../src/arise";
import type { DockerInspect, WorkspaceState } from "../src/core";

const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempPaths.splice(0).map(async (tempPath) => {
      await rm(tempPath, { recursive: true, force: true });
    }),
  );
});

describe("recoverWorkspaceMount", () => {
  test("recovers the host workspace from the shallowest /workspaces bind mount", () => {
    const recovered = recoverWorkspaceMount({
      Id: "container-1",
      Mounts: [
        {
          Type: "bind",
          Source: "/tmp/project/.git",
          Destination: "/workspaces/project/.git",
        },
        {
          Type: "bind",
          Source: "/tmp/project",
          Destination: "/workspaces/project",
        },
      ],
    });

    expect(recovered).toEqual({
      source: "/tmp/project",
      destination: "/workspaces/project",
    });
  });

  test("rejects containers without a /workspaces bind mount", () => {
    expect(
      recoverWorkspaceMount({
        Id: "container-1",
        Mounts: [
          {
            Type: "bind",
            Source: "/tmp/project",
            Destination: "/srv/project",
          },
        ],
      }),
    ).toEqual({
      reason: "Container has no bind mount targeting a workspace under /workspaces.",
    });
  });

  test("rejects ambiguous top-level workspace mounts", () => {
    expect(
      recoverWorkspaceMount({
        Id: "container-1",
        Mounts: [
          {
            Type: "bind",
            Source: "/tmp/project-a",
            Destination: "/workspaces/project-a",
          },
          {
            Type: "bind",
            Source: "/tmp/project-b",
            Destination: "/workspaces/project-b",
          },
        ],
      }),
    ).toEqual({
      reason: "Container has multiple equally likely workspace bind mounts under /workspaces.",
    });
  });
});

describe("discoverStoppedManagedWorkspaces", () => {
  test("groups duplicate stopped containers by recovered workspace and keeps the newest as primary", () => {
    const containers: DockerInspect[] = [
      {
        Id: "container-new",
        Created: "2026-03-20T00:00:00.000Z",
        Name: "/devbox-project-5001",
        State: { Running: false, Status: "exited" },
        Mounts: [
          {
            Type: "bind",
            Source: "/tmp/project",
            Destination: "/workspaces/project",
          },
        ],
      },
      {
        Id: "container-old",
        Created: "2026-03-19T00:00:00.000Z",
        Name: "/devbox-project-5001",
        State: { Running: false, Status: "created" },
        Mounts: [
          {
            Type: "bind",
            Source: "/tmp/project",
            Destination: "/workspaces/project",
          },
        ],
      },
      {
        Id: "container-running",
        Created: "2026-03-21T00:00:00.000Z",
        Name: "/devbox-running-5002",
        State: { Running: true, Status: "running" },
        Mounts: [
          {
            Type: "bind",
            Source: "/tmp/running",
            Destination: "/workspaces/running",
          },
        ],
      },
      {
        Id: "container-skipped",
        Created: "2026-03-18T00:00:00.000Z",
        Name: "/devbox-skipped-5003",
        State: { Running: false, Status: "exited" },
        Mounts: [
          {
            Type: "bind",
            Source: "/tmp/skipped",
            Destination: "/srv/skipped",
          },
        ],
      },
    ];

    const result = discoverStoppedManagedWorkspaces(containers);

    expect(result.workspaces).toEqual([
      {
        workspacePath: "/tmp/project",
        workspaceMountDestination: "/workspaces/project",
        primaryContainerId: "container-new",
        primaryContainerName: "devbox-project-5001",
        primaryContainerState: "exited",
        primaryCreatedAt: "2026-03-20T00:00:00.000Z",
        port: 5001,
        containerIds: ["container-new", "container-old"],
        duplicateContainerIds: ["container-old"],
      },
    ]);
    expect(result.skippedContainers).toEqual([
      {
        containerId: "container-skipped",
        containerName: "devbox-skipped-5003",
        reason: "Container has no bind mount targeting a workspace under /workspaces.",
      },
    ]);
  });
});

describe("inspectWorkspaceRestartReadiness", () => {
  test("accepts workspaces with persisted devbox leftovers", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "devbox-arise-"));
    tempPaths.push(workspacePath);
    await writeFile(path.join(workspacePath, ".sshcred"), "password\n", "utf8");

    const readiness = await inspectWorkspaceRestartReadiness(workspacePath);

    expect(readiness.eligible).toBe(true);
    expect(readiness.foundArtifacts).toEqual([".sshcred"]);
    expect(readiness.reasons).toEqual([]);
    expect(readiness.hasCredentialFile).toBe(true);
  });

  test("accepts workspaces with saved state or host key leftovers", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "devbox-arise-"));
    tempPaths.push(workspacePath);
    await mkdir(path.join(workspacePath, ".devbox-ssh-host-keys"));

    const readiness = await inspectWorkspaceRestartReadiness(workspacePath);

    expect(readiness.eligible).toBe(true);
    expect(readiness.foundArtifacts).toEqual([".devbox-ssh-host-keys/"]);
    expect(readiness.hasHostKeysDir).toBe(true);
  });

  test("rejects missing workspaces", async () => {
    const workspacePath = path.join(os.tmpdir(), "devbox-arise-missing");
    const readiness = await inspectWorkspaceRestartReadiness(workspacePath);

    expect(readiness.eligible).toBe(false);
    expect(readiness.reasons).toContain("Workspace directory no longer exists.");
  });

  test("rejects workspaces without any devbox leftovers", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "devbox-arise-"));
    tempPaths.push(workspacePath);

    const readiness = await inspectWorkspaceRestartReadiness(workspacePath);

    expect(readiness.eligible).toBe(false);
    expect(readiness.reasons[0]).toContain("No devbox restart leftovers were found");
  });
});

describe("getStoredDevcontainerSubpath", () => {
  test("returns undefined for default config paths", () => {
    const workspacePath = "/tmp/project";
    expect(getStoredDevcontainerSubpath(workspacePath, "/tmp/project/.devcontainer/devcontainer.json")).toBeUndefined();
    expect(getStoredDevcontainerSubpath(workspacePath, "/tmp/project/.devcontainer.json")).toBeUndefined();
  });

  test("returns the nested subpath for saved nested devcontainer configs", () => {
    expect(
      getStoredDevcontainerSubpath("/tmp/project", "/tmp/project/.devcontainer/services/api/devcontainer.json"),
    ).toBe(path.join("services", "api"));
  });
});

describe("ariseManagedWorkspaces", () => {
  test("restarts eligible workspaces, skips stale ones, and continues after failures", async () => {
    const logs: string[] = [];
    const removedContainerGroups: string[][] = [];
    const restarted: string[] = [];
    const states = new Map<string, WorkspaceState | null>([
      [
        "/tmp/ok",
        {
          version: 2,
          workspacePath: "/tmp/ok",
          workspaceHash: "hash-ok",
          port: 5001,
          configSource: "repo",
          sourceConfigPath: "/tmp/ok/.devcontainer/services/api/devcontainer.json",
          generatedConfigPath: "/tmp/ok/.devcontainer/.devcontainer.json",
          labels: { "devbox.managed": "true", "devbox.workspace": "hash-ok" },
          userDataDir: "/tmp/state-ok",
          template: null,
          updatedAt: "2026-03-20T00:00:00.000Z",
        },
      ],
      ["/tmp/fail", null],
    ]);

    const summary = await ariseManagedWorkspaces({
      loadManagedContainers: async () => [
        {
          Id: "ok-new",
          Created: "2026-03-20T00:00:00.000Z",
          Name: "/devbox-ok-5001",
          State: { Running: false, Status: "exited" },
          Mounts: [{ Type: "bind", Source: "/tmp/ok", Destination: "/workspaces/ok" }],
        },
        {
          Id: "ok-old",
          Created: "2026-03-19T00:00:00.000Z",
          Name: "/devbox-ok-5001",
          State: { Running: false, Status: "created" },
          Mounts: [{ Type: "bind", Source: "/tmp/ok", Destination: "/workspaces/ok" }],
        },
        {
          Id: "fail-one",
          Created: "2026-03-21T00:00:00.000Z",
          Name: "/devbox-fail-5003",
          State: { Running: false, Status: "exited" },
          Mounts: [{ Type: "bind", Source: "/tmp/fail", Destination: "/workspaces/fail" }],
        },
        {
          Id: "skip-one",
          Created: "2026-03-18T00:00:00.000Z",
          Name: "/devbox-skip-5004",
          State: { Running: false, Status: "exited" },
          Mounts: [{ Type: "bind", Source: "/tmp/skip", Destination: "/workspaces/skip" }],
        },
        {
          Id: "ignored-one",
          Created: "2026-03-17T00:00:00.000Z",
          Name: "/devbox-ignored-5005",
          State: { Running: false, Status: "exited" },
          Mounts: [{ Type: "bind", Source: "/tmp/ignored", Destination: "/srv/ignored" }],
        },
      ],
      inspectWorkspaceRestartReadiness: async (workspacePath) => {
        if (workspacePath === "/tmp/skip") {
          return {
            eligible: false,
            workspacePath,
            reasons: ["Workspace directory no longer exists."],
            foundArtifacts: [],
            statePath: "/tmp/state",
            credentialPath: "/tmp/cred",
            sshMetadataPath: "/tmp/meta",
            hostKeysPath: "/tmp/keys",
            hasStateFile: false,
            hasCredentialFile: false,
            hasSshMetadataFile: false,
            hasHostKeysDir: false,
          };
        }

        return {
          eligible: true,
          workspacePath,
          reasons: [],
          foundArtifacts: workspacePath === "/tmp/ok" ? [".sshcred"] : ["saved state"],
          statePath: "/tmp/state",
          credentialPath: "/tmp/cred",
          sshMetadataPath: "/tmp/meta",
          hostKeysPath: "/tmp/keys",
          hasStateFile: workspacePath === "/tmp/fail",
          hasCredentialFile: workspacePath === "/tmp/ok",
          hasSshMetadataFile: false,
          hasHostKeysDir: false,
        };
      },
      loadWorkspaceState: async (workspacePath) => states.get(workspacePath) ?? null,
      removeContainers: async (containerIds) => {
        removedContainerGroups.push(containerIds);
      },
      restartWorkspace: async (input) => {
        restarted.push(input.workspacePath);
        if (input.workspacePath === "/tmp/fail") {
          expect(input.explicitPort).toBe(5003);
          expect(input.devcontainerSubpath).toBeUndefined();
          throw new Error("boom");
        }
        expect(input.devcontainerSubpath).toBe(path.join("services", "api"));
        expect(input.explicitPort).toBeUndefined();
      },
      log: (message) => logs.push(message),
      formatError: (error) => (error instanceof Error ? error.message : String(error)),
    });

    expect(restarted).toEqual(["/tmp/fail", "/tmp/ok"]);
    expect(removedContainerGroups).toEqual([["ok-old"]]);
    expect(summary.restartedWorkspaces).toEqual(["/tmp/ok"]);
    expect(summary.failedWorkspaces).toEqual([{ workspacePath: "/tmp/fail", reason: "boom" }]);
    expect(summary.skippedWorkspaces).toEqual([
      { workspacePath: "/tmp/skip", reasons: ["Workspace directory no longer exists."] },
    ]);
    expect(summary.skippedContainers).toEqual([
      {
        containerId: "ignored-one",
        containerName: "devbox-ignored-5005",
        reason: "Container has no bind mount targeting a workspace under /workspaces.",
      },
    ]);
    expect(logs).toContain("Continuing with remaining stopped workspaces...");
    expect(logs[0]).toBe("Scanning for stopped managed devbox containers...");
  });
});
