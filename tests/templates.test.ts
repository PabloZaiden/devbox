import { describe, expect, test } from "bun:test";
import { getTemplateDefinition, listTemplateDefinitions, listTemplateSummaries } from "../src/templates";

describe("built-in templates", () => {
  test("standardizes every template on the noble base image with docker-in-docker", () => {
    for (const template of listTemplateDefinitions()) {
      expect(template.base).toBe("noble");
      expect(template.image).toBe("mcr.microsoft.com/devcontainers/base:noble");
      expect(template.pinnedReference).toContain("mcr.microsoft.com/devcontainers/base:noble");
      expect(template.config).toEqual(
        expect.objectContaining({
          image: "mcr.microsoft.com/devcontainers/base:noble",
          features: expect.objectContaining({
            "ghcr.io/devcontainers/features/docker-in-docker:2": {},
          }),
        }),
      );
    }
  });

  test("builds the typescript template from node and bun features", () => {
    const template = getTemplateDefinition("typescript");
    expect(template).not.toBeNull();
    if (!template) {
      throw new Error("Expected the built-in typescript template to exist.");
    }

    expect(template.description).toBe("Node.js and Bun on Ubuntu noble via devcontainer features.");
    expect(template.base).toBe("noble");
    expect(template.image).toBe("mcr.microsoft.com/devcontainers/base:noble");
    expect(template.pinnedReference).toBe(
      "mcr.microsoft.com/devcontainers/base:noble + ghcr.io/devcontainers/features/docker-in-docker:2 + ghcr.io/devcontainers/features/node:1 + ghcr.io/devcontainers-extra/features/bun:1",
    );
    expect(template.runnerCompatible).toBe(true);
    expect(template.config).toEqual({
      image: "mcr.microsoft.com/devcontainers/base:noble",
      features: {
        "ghcr.io/devcontainers/features/docker-in-docker:2": {},
        "ghcr.io/devcontainers/features/node:1": {},
        "ghcr.io/devcontainers-extra/features/bun:1": {},
      },
    });
  });

  test("exposes the unified typescript template in summaries", () => {
    const typescriptTemplate = listTemplateSummaries().find((template) => template.name === "typescript");
    expect(typescriptTemplate).toEqual({
      name: "typescript",
      description: "Node.js and Bun on Ubuntu noble via devcontainer features.",
      source: "built-in",
      base: "noble",
      image: "mcr.microsoft.com/devcontainers/base:noble",
      pinnedReference:
        "mcr.microsoft.com/devcontainers/base:noble + ghcr.io/devcontainers/features/docker-in-docker:2 + ghcr.io/devcontainers/features/node:1 + ghcr.io/devcontainers-extra/features/bun:1",
      runtimeVersion: "Node.js + Bun",
      languages: ["node", "bun", "typescript", "javascript"],
      runnerCompatible: true,
    });
  });
});
