import { runUpdateCommand as runInstallerUpdateCommand, type UpdaterDependencies } from "@pablozaiden/installer";
import { DEVBOX_VERSION } from "./version";

const GITHUB_REPOSITORY = "pablozaiden/devbox";
const BINARY_NAME = "devbox";

export interface UpdateCommandOptions {
  checkOnly: boolean;
  version?: string;
}

export type DevboxUpdateDependencies = Partial<UpdaterDependencies> & {
  currentVersion?: string;
};

export const DEVBOX_UPDATER_CONFIG = {
  repository: GITHUB_REPOSITORY,
  binaryName: BINARY_NAME,
  currentVersion: DEVBOX_VERSION,
  productName: "Devbox",
  checksum: { required: true },
};

export async function runUpdateCommand(
  command: UpdateCommandOptions,
  dependencyOverrides: DevboxUpdateDependencies = {},
): Promise<number> {
  const { currentVersion, ...installerDependencyOverrides } = dependencyOverrides;
  return await runInstallerUpdateCommand(
    command,
    {
      ...DEVBOX_UPDATER_CONFIG,
      currentVersion: currentVersion ?? DEVBOX_UPDATER_CONFIG.currentVersion,
    },
    installerDependencyOverrides,
  );
}
