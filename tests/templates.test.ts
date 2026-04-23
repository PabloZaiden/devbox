import { describe, expect, test } from "bun:test";
import { getTemplateDefinition, listTemplateSummaries } from "../src/templates";

describe("built-in templates", () => {
  test("uses the official Bun image instead of an installer script", () => {
    const template = getTemplateDefinition("bun");
    expect(template).not.toBeNull();
    if (!template) {
      throw new Error("Expected the built-in bun template to exist.");
    }

    expect(template.description).toBe("Official Bun 1.3.13 image on Debian trixie.");
    expect(template.base).toBe("trixie");
    expect(template.image).toBe("oven/bun:1.3.13");
    expect(template.pinnedReference).toBe("oven/bun:1.3.13");
    expect(template.runnerCompatible).toBe(true);
    expect(template.config).toEqual({
      image: "oven/bun:1.3.13",
    });
  });

  test("exposes the pinned Bun image in template summaries", () => {
    const bunTemplate = listTemplateSummaries().find((template) => template.name === "bun");
    expect(bunTemplate).toEqual({
      name: "bun",
      description: "Official Bun 1.3.13 image on Debian trixie.",
      source: "built-in",
      base: "trixie",
      image: "oven/bun:1.3.13",
      pinnedReference: "oven/bun:1.3.13",
      runtimeVersion: "Bun 1.3.13",
      languages: ["bun", "javascript", "typescript"],
      runnerCompatible: true,
    });
  });
});
