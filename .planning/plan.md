# Plan: secure GH_TOKEN injection from host `gh` into the devcontainer

## Problem statement

Add support for sourcing a GitHub authentication token from the host machine via `gh auth token` when the GitHub CLI is installed and already authenticated, then expose that value inside the devcontainer as `GH_TOKEN` without persisting the token to disk or printing it to stdout/stderr/log files.

## Objectives

1. Detect whether host-side `gh` is available and authenticated before attempting token injection.
2. Retrieve the token only in-memory, using a code path that does not echo or serialize the value.
3. Inject `GH_TOKEN` into the devcontainer at runtime without storing it in generated config files, workspace state files, or repository files.
4. Ensure command execution and status output never print the token or write it into logs.
5. Validate the behavior safely, including positive and negative cases, without revealing the token during tests or manual verification.

## Current codebase observations

- The root devcontainer definition is `.devcontainer/devcontainer.json`.
- `src/core.ts` already mutates `containerEnv` for SSH agent wiring, but managed config is currently written to disk through `writeManagedConfig(...)`.
- Because managed config is persisted as JSON, adding `GH_TOKEN` to `containerEnv` there would violate the requirement not to persist the token on the filesystem.
- `src/runtime.ts` already supports passing transient environment variables to spawned processes via the `execute(...)` and `executeInteractive(...)` helpers, which is the safest likely integration point for runtime-only injection.

## Proposed approach

Use host-side runtime environment injection instead of config-file mutation:

- Detect host `gh` availability/authentication from the CLI flow before `devcontainer up`.
- Fetch `gh auth token` into memory only.
- Thread the value through process environment for the `devcontainer up` invocation, and, if needed, through any follow-up `devcontainer exec` or shell entry points that must observe `GH_TOKEN`.
- Avoid writing the token into generated devcontainer JSON, workspace state, or any temporary file.
- Keep all logging/status messages token-free and validate presence using non-secret checks only.

## Tasks

### 1. Inspect and define the host auth discovery flow

- Identify the best place in the startup path to check for `gh` availability and authenticated state.
- Decide expected behavior when `gh` is missing, installed but unauthenticated, or returns an error.
- Keep the feature opportunistic: if no usable host token exists, continue normal startup without injecting `GH_TOKEN`.

**Likely files:** `src/cli.ts`, `src/runtime.ts`

**Dependencies:** None

**Estimated complexity:** Medium

### 2. Add an in-memory token acquisition helper

- Create a helper that runs `gh auth token` with captured output.
- Trim and validate the result without logging it.
- Return a structured result that distinguishes:
  - token available
  - `gh` unavailable
  - `gh` available but not authenticated
  - command failure
- Ensure failures are surfaced internally in a way that supports safe user messaging without leaking secrets.

**Likely files:** `src/runtime.ts` or a small helper module reused by CLI/runtime

**Dependencies:** Task 1

**Estimated complexity:** Medium

### 3. Inject `GH_TOKEN` at runtime only

- Extend the `devcontainer up` execution path so the spawned `devcontainer` process receives `GH_TOKEN` via its environment rather than through generated config JSON.
- Review whether downstream commands (`devcontainer exec`, interactive shell entry, lifecycle helpers) also need the same runtime env to preserve expected behavior after startup.
- Confirm that no token value is stored in:
  - `.devcontainer/.devcontainer.json` or other generated config files
  - workspace state files
  - command arguments
  - temporary files

**Likely files:** `src/cli.ts`, `src/runtime.ts`, potentially `src/core.ts` for avoiding accidental config-based wiring

**Dependencies:** Task 2

**Estimated complexity:** High

### 4. Harden logging and user-visible output

- Audit the touched code paths for any console output that could print command output or environment values.
- Keep user messaging high-level, for example reporting whether host GitHub auth was detected and injected, without exposing the value.
- Ensure thrown errors and diagnostics do not include secret-bearing command output unless it is redacted or replaced with a safe message.

**Likely files:** `src/cli.ts`, `src/runtime.ts`

**Dependencies:** Task 3

**Estimated complexity:** Medium

### 5. Add or update tests for secure behavior

- Add tests for the helper and orchestration logic:
  - `gh` missing
  - `gh` unauthenticated / non-zero exit
  - token present
  - no persistence into managed config output
  - no token in user-facing logs/messages
- Prefer existing test patterns and mocking strategy in the repository.

**Likely files:** `tests/**/*`

**Dependencies:** Tasks 2, 3, and 4

**Estimated complexity:** High

### 6. Validate end-to-end behavior safely

- Run the existing test suite and any relevant build steps before changes to establish baseline, then again after implementation.
- Validate that runtime injection works without printing the token:
  - verify `GH_TOKEN` is set inside the container using a non-secret assertion such as checking existence/length only
  - inspect generated config/state artifacts to confirm the token was not written
- Confirm the feature degrades gracefully when host `gh` is unavailable or unauthenticated.

**Likely commands later:** existing build/test commands plus a safe manual smoke check

**Dependencies:** Task 5

**Estimated complexity:** Medium

## Dependency graph

- Task 1 -> Task 2 -> Task 3 -> Task 4 -> Task 5 -> Task 6
- Task 4 is logically coupled to Task 3 because safe runtime injection is incomplete if logs can still expose command output.
- Task 6 depends on implementation and tests being in place.

## Notes and considerations

- The current `buildManagedConfig(...)` path is not an acceptable place to insert the token because `writeManagedConfig(...)` persists the result to disk.
- Passing secrets through command-line arguments is also unsafe because they may appear in process listings or debug output; environment injection is the preferred path here.
- Verification must avoid commands like `echo $GH_TOKEN`; use existence checks instead.
- If the host `gh` command can only run outside the containerized environment that executes `devbox`, implementation may require a clearly defined “host command” boundary; this should be confirmed during implementation.
- If runtime-only propagation through `devcontainer up` does not make `GH_TOKEN` visible where needed, a secondary plan should explore devcontainer-supported env passthrough mechanisms that remain memory-only and do not serialize the token.
