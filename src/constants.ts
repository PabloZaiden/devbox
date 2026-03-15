export const CLI_NAME = "devbox";
export const LEGACY_GENERATED_CONFIG_BASENAME = ".devbox.generated.devcontainer.json";
export const MANAGED_LABEL_KEY = "devbox.managed";
export const WORKSPACE_LABEL_KEY = "devbox.workspace";
export const SSH_AUTH_SOCK_TARGET = "/tmp/devbox-ssh-auth.sock";
export const DOCKER_DESKTOP_SSH_AUTH_SOCK_SOURCE = "/run/host-services/ssh-auth.sock";
export const KNOWN_HOSTS_TARGET = "/tmp/devbox-known_hosts";
export const KNOWN_HOSTS_SNAPSHOT_FILENAME = "known_hosts";
export const RUNNER_CRED_FILENAME = ".sshcred";
export const RUNNER_HOST_KEYS_DIRNAME = ".devbox-ssh-host-keys";
export const RUNNER_URL =
  "https://raw.githubusercontent.com/PabloZaiden/ssh-server-runner/main/ssh-server.sh";
export const STATE_VERSION = 1;
