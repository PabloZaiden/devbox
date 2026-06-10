#!/usr/bin/env bash
set -euo pipefail

# get the latest vscode-generated auth sock, if available
VSCODE_SSH_AUTH_SOCK=""
mapfile -t vscode_ssh_socks < <(compgen -G "/tmp/vscode-ssh*.sock" || true)
if [[ ${#vscode_ssh_socks[@]} -gt 0 ]]; then
  VSCODE_SSH_AUTH_SOCK=$(ls -1t "${vscode_ssh_socks[@]}" | head -n 1)
fi

if [ -n "${VSCODE_SSH_AUTH_SOCK}" ]; then
  export SSH_AUTH_SOCK=${VSCODE_SSH_AUTH_SOCK}
fi

append_unique_line() {
  local file="$1"
  local line="$2"

  mkdir -p "$(dirname "$file")"
  touch "$file"
  if ! grep -qxF "$line" "$file"; then
    printf '%s\n' "$line" >> "$file"
  fi
}

if [ -n "${SSH_AUTH_SOCK:-}" ]; then
  ssh_auth_sock_export="export SSH_AUTH_SOCK=\"${SSH_AUTH_SOCK}\""
  append_unique_line "$HOME/.profile" "$ssh_auth_sock_export"
  append_unique_line "$HOME/.bashrc" "$ssh_auth_sock_export"
  append_unique_line "$HOME/.zshenv" "$ssh_auth_sock_export"
fi

CRED_FILE="${CRED_FILE:-.devbox/ssh/credentials}"
SSH_PORT="${SSH_PORT:-5001}"

as_root() {
  if [[ "$(id -u)" -eq 0 ]]; then
    "$@"
    return
  fi

  if command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
    sudo -n "$@"
    return
  fi

  echo "ERROR: need root privileges (run as root or configure passwordless sudo)" >&2
  exit 1
}

as_root_bash() {
  local cmd="$1"

  if [[ "$(id -u)" -eq 0 ]]; then
    bash -lc "$cmd"
    return
  fi

  if command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
    sudo -n bash -lc "$cmd"
    return
  fi

  echo "ERROR: need root privileges (run as root or configure passwordless sudo)" >&2
  exit 1
}

resolve_path() {
  local path="$1"
  local dir_path

  dir_path="$(cd "$(dirname "$path")" && pwd -P)"
  printf '%s/%s\n' "$dir_path" "$(basename "$path")"
}

# Prefer the non-root invoker when using sudo
CURRENT_USER="${SUDO_USER:-$(id -un)}"

# Install deps and prep sshd dirs
as_root_bash '
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

missing_packages=()
for package in openssh-server uuid-runtime dtach tmux git; do
  if ! dpkg-query -W -f="\${db:Status-Status}" "$package" 2>/dev/null | grep -qx installed; then
    missing_packages+=("$package")
  fi
done

if [[ ${#missing_packages[@]} -gt 0 ]]; then
  apt-get update
  apt-get install -y --no-install-recommends "${missing_packages[@]}"
  rm -rf /var/lib/apt/lists/*
else
  echo "All apt packages already installed; skipping apt-get install."
fi

mkdir -p /var/run/sshd
mkdir -p /etc/ssh/sshd_config.d
'

# install GitHub CLI if missing
if command -v gh >/dev/null 2>&1; then
  echo "GitHub CLI already installed; skipping."
else
  as_root_bash '
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

apt-get update
if ! apt-get install -y --no-install-recommends gh; then
  echo "Default apt sources do not provide gh; configuring the official GitHub CLI repository."
  apt-get install -y --no-install-recommends ca-certificates curl gnupg
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | tee /etc/apt/keyrings/githubcli-archive-keyring.gpg >/dev/null
  chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list
  apt-get update
  apt-get install -y --no-install-recommends gh
fi
rm -rf /var/lib/apt/lists/*
'
fi

# install nvm and Node.js 24 if Node.js is missing
if command -v node >/dev/null 2>&1; then
  echo "Node.js already installed; skipping nvm and Node.js installation."
else
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.4/install.sh | bash
  if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    echo "ERROR: nvm was not installed at $NVM_DIR" >&2
    exit 1
  fi
  \. "$NVM_DIR/nvm.sh"
  nvm install 24
fi
node -v
npm -v

# install fresh editor
npm install -g @fresh-editor/fresh-editor

# set $HOME/.npmrc and $HOME/.bunfig.toml to have minimum release date to 3 days
echo "min-release-age=3" > "$HOME/.npmrc"
echo "[install]
minimumReleaseAge = 259200" > "$HOME/.bunfig.toml"
append_unique_line "$HOME/.tmux.conf" "set -g mouse on"

# Use existing password if present, otherwise create it once
if [[ -f "$CRED_FILE" ]]; then
  PASS="$(tr -d '\r\n' < "$CRED_FILE")"
  if [[ -z "${PASS}" ]]; then
    echo "ERROR: ${CRED_FILE} exists but is empty" >&2
    exit 1
  fi
else
  PASS="$(uuidgen | tr "[:upper:]" "[:lower:]")"
  umask 077
  mkdir -p "$(dirname "$CRED_FILE")"
  printf '%s' "$PASS" > "$CRED_FILE"
fi

# If CURRENT_USER is root, allow root SSH. Otherwise, keep root SSH disabled.
if [[ "$CURRENT_USER" == "root" ]]; then
  PERMIT_ROOT_LOGIN="yes"
else
  PERMIT_ROOT_LOGIN="no"
fi

# Ensure user exists + set password + configure sshd
as_root_bash "
set -euo pipefail

if ! id -u '${CURRENT_USER}' >/dev/null 2>&1; then
  useradd -m -s /bin/bash '${CURRENT_USER}'
fi

echo '${CURRENT_USER}:${PASS}' | chpasswd

cat >/etc/ssh/sshd_config.d/99-local.conf <<EOF
Port ${SSH_PORT}
PasswordAuthentication yes
KbdInteractiveAuthentication yes
UsePAM yes
PermitRootLogin ${PERMIT_ROOT_LOGIN}
EOF
chmod 0644 /etc/ssh/sshd_config.d/99-local.conf

if ! grep -qE '^\\s*Include\\s+/etc/ssh/sshd_config\\.d/\\*\\.conf\\s*$' /etc/ssh/sshd_config; then
  echo 'Include /etc/ssh/sshd_config.d/*.conf' >> /etc/ssh/sshd_config
fi
"

# If git exists and this is a repo, ignore locally without touching .gitignore
if command -v git >/dev/null 2>&1; then
  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    REPO_ROOT="$(cd "$(git rev-parse --show-toplevel)" && pwd -P)"
    CRED_FILE_ABS="$(resolve_path "$CRED_FILE")"

    if [[ "$CRED_FILE_ABS" == "$REPO_ROOT"/* ]]; then
      EXCLUDE_FILE="${REPO_ROOT}/.git/info/exclude"
      RELATIVE_CRED_PATH="${CRED_FILE_ABS#"$REPO_ROOT"/}"
      PATTERN="/${RELATIVE_CRED_PATH}"

      mkdir -p "${REPO_ROOT}/.git/info"
      touch "$EXCLUDE_FILE"
      if ! grep -qxF "$PATTERN" "$EXCLUDE_FILE"; then
        printf '\n%s\n' "$PATTERN" >> "$EXCLUDE_FILE"
      fi
    fi
  fi
fi

echo "SSH user: ${CURRENT_USER}"
echo "SSH pass: ${PASS}"
echo "SSH port: ${SSH_PORT}"
echo "PermitRootLogin: ${PERMIT_ROOT_LOGIN}"

# Start sshd in background (reads Port from config, but we also pass -p to be explicit)
as_root /usr/sbin/sshd -p "$SSH_PORT"

echo "To stop SSH server, run:"
echo "pkill -TERM -x sshd || true"
