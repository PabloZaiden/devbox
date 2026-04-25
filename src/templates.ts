type DevcontainerConfig = Record<string, unknown>;
type DevcontainerFeatureOptions = Record<string, unknown>;

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

const BASE_IMAGE = "mcr.microsoft.com/devcontainers/base:noble";
const BASE_NAME = "noble";
const DOCKER_IN_DOCKER_FEATURE = "ghcr.io/devcontainers/features/docker-in-docker:2";
const DOTNET_FEATURE = "ghcr.io/devcontainers/features/dotnet:2";
const GO_FEATURE = "ghcr.io/devcontainers/features/go:1";
const JAVA_FEATURE = "ghcr.io/devcontainers/features/java:1";
const NODE_FEATURE = "ghcr.io/devcontainers/features/node:1";
const RUST_FEATURE = "ghcr.io/devcontainers/features/rust:1";
const BUN_FEATURE = "ghcr.io/devcontainers-extra/features/bun:1";
const UV_FEATURE = "ghcr.io/devcontainers-extra/features/uv:1";

const TEMPLATE_DEFINITIONS: Record<string, DevboxTemplateDefinition> = {
  ubuntu: createTemplateDefinition({
    name: "ubuntu",
    description: "Ubuntu noble base image with Docker-in-Docker preinstalled.",
    runtimeVersion: "Ubuntu noble",
    languages: [],
  }),
  dotnet: createTemplateDefinition({
    name: "dotnet",
    description: ".NET SDK on Ubuntu noble via the official devcontainer feature.",
    runtimeVersion: ".NET SDK",
    languages: ["dotnet", "csharp", "fsharp"],
    features: [DOTNET_FEATURE],
  }),
  typescript: createTemplateDefinition({
    name: "typescript",
    description: "Node.js and Bun on Ubuntu noble via devcontainer features.",
    runtimeVersion: "Node.js + Bun",
    languages: ["node", "bun", "typescript", "javascript"],
    features: [NODE_FEATURE, BUN_FEATURE],
  }),
  python: createTemplateDefinition({
    name: "python",
    description: "Python workflows on Ubuntu noble via the uv feature.",
    runtimeVersion: "Python via uv",
    languages: ["python"],
    features: [UV_FEATURE],
  }),
  go: createTemplateDefinition({
    name: "go",
    description: "Go on Ubuntu noble via the official devcontainer feature.",
    runtimeVersion: "Go",
    languages: ["go"],
    features: [GO_FEATURE],
  }),
  rust: createTemplateDefinition({
    name: "rust",
    description: "Rust on Ubuntu noble via the official devcontainer feature.",
    runtimeVersion: "Rust",
    languages: ["rust"],
    features: [RUST_FEATURE],
  }),
  java: createTemplateDefinition({
    name: "java",
    description: "Java on Ubuntu noble via the official devcontainer feature.",
    runtimeVersion: "Java",
    languages: ["java"],
    features: [JAVA_FEATURE],
  }),
};

function createTemplateDefinition(input: {
  name: string;
  description: string;
  runtimeVersion: string;
  languages: string[];
  features?: string[];
}): DevboxTemplateDefinition {
  const featureRefs = [DOCKER_IN_DOCKER_FEATURE, ...(input.features ?? [])];

  return {
    name: input.name,
    description: input.description,
    source: "built-in",
    base: BASE_NAME,
    image: BASE_IMAGE,
    pinnedReference: [BASE_IMAGE, ...featureRefs].join(" + "),
    runtimeVersion: input.runtimeVersion,
    languages: [...input.languages],
    runnerCompatible: true,
    config: {
      image: BASE_IMAGE,
      features: buildFeatureMap(featureRefs),
    },
  };
}

function buildFeatureMap(featureRefs: string[]): Record<string, DevcontainerFeatureOptions> {
  return Object.fromEntries(featureRefs.map((featureRef) => [featureRef, {}]));
}

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
