# devbox

`devbox` is a CLI that turns the devcontainer definition in the current directory into a repeatable "start my workspace and expose an SSH entrypoint" workflow.

It does not modify the original `devcontainer.json`. Instead, it generates a derived config next to it, ignores that file locally when possible, and manages the resulting container with stable labels.

## What it does

- Discovers `.devcontainer/devcontainer.json` or `.devcontainer.json` in the current directory.
- Reuses or creates the devcontainer with Docker + Dev Container CLI.
- Names the managed container as `devbox-<project>-<port>`.
- Publishes the same TCP port on host and container.
- Mounts the current directory into the container as the workspace.
- Shares a usable SSH agent socket with the container and copies `known_hosts` into the container.
- Runs the [`ssh-server-runner`](https://github.com/PabloZaiden/ssh-server-runner) one-liner inside the devcontainer.
- Persists the runner credentials on the mounted workspace as a local `.sshcred` file, and keeps SSH host keys in `.devbox-ssh-host-keys/`, so they survive `down` / `rebuild`.

## Installation

Install globally with Bun:

```bash
bun install -g @pablozaiden/devbox
```

Or install globally with npm:

```bash
npm install -g @pablozaiden/devbox
```

After either install, `devbox` is available in any directory.

## Requirements

- macOS or Linux
- [Node.js](https://nodejs.org/) or [Bun](https://bun.sh/) to run the installed CLI
- Docker
- Dev Container CLI available as `devcontainer`
- For SSH agent sharing: either a valid host `SSH_AUTH_SOCK`, or Docker Desktop host services
- A devcontainer using `image` or `Dockerfile`

`dockerComposeFile`-based devcontainers are intentionally out of scope for v1.

## Commands

```bash
# Start or reuse the devcontainer on port 5001
devbox 5001

# Same as above
devbox up 5001

# Continue even if SSH agent sharing is unavailable
devbox up 5001 --allow-missing-ssh

# Rebuild/recreate the managed devcontainer
devbox rebuild 5001

# Stop and remove the managed container while preserving the workspace-mounted SSH credentials
devbox down
```

If you omit the port for `up` or `rebuild`, `devbox` will reuse the last port stored for the current workspace.

## Development

```bash
bun install
bun test
bun run build
```

The build step emits a bundled executable JS entrypoint at `dist/devbox.js`.

For local development from this repository:

- use `bun run src/cli.ts` while iterating on source changes
- use `./dist/devbox.js` after `bun run build` to exercise the packaged artifact

For a quick smoke test, this repository includes `examples/smoke-workspace/.devcontainer/devcontainer.json`:

```bash
cd examples/smoke-workspace
../../dist/devbox.js up 5001 --allow-missing-ssh
```

## Notes

- The generated config is written next to the original devcontainer config, using the alternate accepted devcontainer filename so relative Dockerfile paths keep working.
- `down` removes managed containers but does not delete the workspace `.sshcred` or `.devbox-ssh-host-keys/`, so the SSH password and SSH host identity survive rebuilds.
- Re-running `devbox` after a host restart recreates the desired state: container up, port published, SSH runner started again.
- When Docker Desktop host services are available, `devbox` can share the SSH agent without relying on a host-shell `SSH_AUTH_SOCK`.
- On Docker Desktop, `devbox` prefers the Docker-provided SSH agent socket over the host `SSH_AUTH_SOCK`, which avoids macOS launchd socket mount issues.
- `--allow-missing-ssh` starts the workspace without mounting an SSH agent and prints a warning instead of failing.

## Releasing to npm

Publishing is wired through `.github/workflows/release-npm-package.yml`.

- Create a GitHub release tagged like `v1.2.3`.
- The workflow checks out that tag, sets `package.json` to version `1.2.3`, installs dependencies, runs tests, builds the package, and publishes `@pablozaiden/devbox` to npm.
- The workflow uses npm trusted publishing (`id-token: write`), so no npm token has to be stored in the repository.

Before the first release, enable trusted publishing for `@pablozaiden/devbox` in npm and connect it to the `PabloZaiden/devbox` GitHub repository.
