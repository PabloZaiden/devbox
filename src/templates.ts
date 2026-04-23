type DevcontainerConfig = Record<string, unknown>;

export interface DevboxTemplateDefinition {
  name: string;
  description: string;
  source: "built-in";
  base: string;
  image: string | null;
  pinnedReference: string;
  runtimeVersion: string;
  languages: string[];
  runnerCompatible: boolean;
  config: DevcontainerConfig;
}

export interface DevboxTemplateSummary {
  name: string;
  description: string;
  source: "built-in";
  base: string;
  image: string | null;
  pinnedReference: string;
  runtimeVersion: string;
  languages: string[];
  runnerCompatible: boolean;
}

const BUN_VERSION = "1.3.13";
const BASE_IMAGE = "mcr.microsoft.com/devcontainers/base:2.1.8-ubuntu24.04";
const BUN_IMAGE = `oven/bun:${BUN_VERSION}`;

const TEMPLATE_DEFINITIONS: Record<string, DevboxTemplateDefinition> = {
  ubuntu: {
    name: "ubuntu",
    description: "Ubuntu 24.04 base image with common devcontainer tooling.",
    source: "built-in",
    base: "ubuntu24.04",
    image: BASE_IMAGE,
    pinnedReference: BASE_IMAGE,
    runtimeVersion: "Ubuntu 24.04",
    languages: [],
    runnerCompatible: true,
    config: {
      image: BASE_IMAGE,
    },
  },
  dotnet: {
    name: "dotnet",
    description: ".NET 10 SDK on Ubuntu 24.04.",
    source: "built-in",
    base: "ubuntu24.04",
    image: "mcr.microsoft.com/devcontainers/dotnet:2.0.7-10.0-noble",
    pinnedReference: "mcr.microsoft.com/devcontainers/dotnet:2.0.7-10.0-noble",
    runtimeVersion: ".NET 10.0",
    languages: ["dotnet", "csharp", "fsharp"],
    runnerCompatible: true,
    config: {
      image: "mcr.microsoft.com/devcontainers/dotnet:2.0.7-10.0-noble",
    },
  },
  "node-typescript": {
    name: "node-typescript",
    description: "Node.js 24 with TypeScript tooling on Debian bookworm.",
    source: "built-in",
    base: "bookworm",
    image: "mcr.microsoft.com/devcontainers/typescript-node:4.0.8-24-bookworm",
    pinnedReference: "mcr.microsoft.com/devcontainers/typescript-node:4.0.8-24-bookworm",
    runtimeVersion: "Node.js 24",
    languages: ["node", "typescript", "javascript"],
    runnerCompatible: true,
    config: {
      image: "mcr.microsoft.com/devcontainers/typescript-node:4.0.8-24-bookworm",
    },
  },
  bun: {
    name: "bun",
    description: `Official Bun ${BUN_VERSION} image on Debian trixie.`,
    source: "built-in",
    base: "trixie",
    image: BUN_IMAGE,
    pinnedReference: BUN_IMAGE,
    runtimeVersion: `Bun ${BUN_VERSION}`,
    languages: ["bun", "javascript", "typescript"],
    runnerCompatible: true,
    config: {
      image: BUN_IMAGE,
    },
  },
  python: {
    name: "python",
    description: "Python 3.14 on Debian bookworm.",
    source: "built-in",
    base: "bookworm",
    image: "mcr.microsoft.com/devcontainers/python:3.0.7-3.14-bookworm",
    pinnedReference: "mcr.microsoft.com/devcontainers/python:3.0.7-3.14-bookworm",
    runtimeVersion: "Python 3.14",
    languages: ["python"],
    runnerCompatible: true,
    config: {
      image: "mcr.microsoft.com/devcontainers/python:3.0.7-3.14-bookworm",
    },
  },
  go: {
    name: "go",
    description: "Go 1.26 on Debian bookworm.",
    source: "built-in",
    base: "bookworm",
    image: "mcr.microsoft.com/devcontainers/go:2.1.2-1.26-bookworm",
    pinnedReference: "mcr.microsoft.com/devcontainers/go:2.1.2-1.26-bookworm",
    runtimeVersion: "Go 1.26",
    languages: ["go"],
    runnerCompatible: true,
    config: {
      image: "mcr.microsoft.com/devcontainers/go:2.1.2-1.26-bookworm",
    },
  },
  rust: {
    name: "rust",
    description: "Rust stable toolchain image on Debian bookworm.",
    source: "built-in",
    base: "bookworm",
    image: "mcr.microsoft.com/devcontainers/rust:2.0.10-1-bookworm",
    pinnedReference: "mcr.microsoft.com/devcontainers/rust:2.0.10-1-bookworm",
    runtimeVersion: "Rust stable (image release 2.0.10)",
    languages: ["rust"],
    runnerCompatible: true,
    config: {
      image: "mcr.microsoft.com/devcontainers/rust:2.0.10-1-bookworm",
    },
  },
  java: {
    name: "java",
    description: "Java 25 LTS on Debian bookworm.",
    source: "built-in",
    base: "bookworm",
    image: "mcr.microsoft.com/devcontainers/java:3.0.7-25-bookworm",
    pinnedReference: "mcr.microsoft.com/devcontainers/java:3.0.7-25-bookworm",
    runtimeVersion: "Java 25 LTS",
    languages: ["java"],
    runnerCompatible: true,
    config: {
      image: "mcr.microsoft.com/devcontainers/java:3.0.7-25-bookworm",
    },
  },
};

export function listTemplateDefinitions(): DevboxTemplateDefinition[] {
  return Object.values(TEMPLATE_DEFINITIONS).map(cloneTemplateDefinition);
}

export function listTemplateSummaries(): DevboxTemplateSummary[] {
  return listTemplateDefinitions().map((definition) => ({
    name: definition.name,
    description: definition.description,
    source: definition.source,
    base: definition.base,
    image: definition.image,
    pinnedReference: definition.pinnedReference,
    runtimeVersion: definition.runtimeVersion,
    languages: [...definition.languages],
    runnerCompatible: definition.runnerCompatible,
  }));
}

export function getTemplateDefinition(name: string): DevboxTemplateDefinition | null {
  const definition = TEMPLATE_DEFINITIONS[name];
  return definition ? cloneTemplateDefinition(definition) : null;
}

function cloneTemplateDefinition(definition: DevboxTemplateDefinition): DevboxTemplateDefinition {
  return {
    ...definition,
    languages: [...definition.languages],
    config: structuredClone(definition.config),
  };
}
