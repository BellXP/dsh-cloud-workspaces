# Changelog

All notable changes to `dsh-cloud-workspaces` are documented here.

## [v0.10.1] — 2026-11-26

### Added
- **`~/.ssh/config` import now carries proxy settings.** `importSshConfig` translates a recognised HTTP-proxy `ProxyCommand` into the entry's native `httpProxy` (so no ncat is needed inside dsh): ncat `--proxy host:port --proxy-type http [--proxy-auth "user:pass"]` (quoted Windows paths and `--opt=value` forms included), OpenBSD `nc -X connect -x host:port`, and `connect -H host:port`. `ProxyJump` aliases that name an imported block become the entry's `proxyJump` chain; patterns, inline `user@host:port` hops and dangling aliases are dropped instead of failing at dial time. SOCKS helpers, `ssh -W` and unknown commands are left untouched (configure those by hand). Existing `-inter` style duplicate hosts therefore import as working proxy hosts. `importSshConfig(text?)` accepts config text for tests; `httpProxyFromProxyCommand` and `proxyJumpFromValue` are exported pure functions

## [v0.10.0] — 2026-11-26

### Changed
- **Targets dsh 0.2.2-rc.5** (previously 0.2.0-rc.2 with devDependencies pinned to 0.1.1-rc.2); every `@deepseek-ai/dsh-*` peer is now `>=0.2.2-rc.5 <0.3.0-0`, devDependencies are pinned to `0.2.2-rc.5` (`@deepseek-ai/cordis` 4.1.0, `@deepseek-ai/schemastery` 3.19.0), and `engines.node` is `>=24.9.0` (dsh 0.2.1-rc.2+ requires Node 24)
- `src/fs-ssh.ts` implements the `FileSystem` members dsh 0.2.x added — `readByteRange`, `patchText` (official `applyHunks`, `FS_PATCH_MISMATCH`), `deleteFile` and `moveFile` (canonical lock order, `FS_SAME_TARGET`, two-phase `sourceDeleted`/`sourceFailure`) — with `watch` now an `override`
- `src/subprocess-ssh.ts` implements `SubprocessRuntime.terminalEnvironment` (remote login shell probe) and the `SubprocessHandle.control` member (a spec requesting a control channel is rejected up front over SSH)
- `src/job-runner.ts` follows the dsh-jobs 0.2.x contract: the remote log is a `JobOutputSource` the registry pumps (`read(fromByte)` → text/`nextOffset`/`lossy`) instead of the removed `JobHooks.readOutput`, and background jobs are owned by `exec.agent.id` (`SessionId`) rather than the agent object; the log fetch now uses an exact byte cursor (`tail -c +N | head -c 64KiB | base64`) with UTF-8 boundary-safe offsets, local trimming of delivered bytes and a final drain before settlement
- `src/typert.ts` types the host typert contribution with the official `TypertContribution` (`@deepseek-ai/dsh-typert-registry` now declares `register` itself) and ships an empty reflection model instead of `undefined`
- `client/index.js`: the native directory picker is read from the new `uiWorkspace` service (old `workspaces` face and `remote.directoryPicker` kept as fallbacks), and the dual-tab workspace picker also fills the third directory-flow hole `workspace.picker.directoryFlow` introduced by ui-workspace
- `scripts/check-dsh-contract.mjs` (30 → 49 checks) mounts `@deepseek-ai/dsh-tool-executor-native` for the `meta.diffs` full-chain probe (ToolRuntime no longer executes by itself), probes the 0.2.2 surfaces above, and anchors the PathLabel check to the `data-path-label` DOM contract in the web frontend bundle
- Imports use `@deepseek-ai/schemastery` (dsh no longer ships the bare `schemastery` package)

### Removed
- The `./invariant` companion plugin (source, export, tsdown entry and `@deepseek-ai/dsh-invariants` devDependency) — dsh 0.2.0-rc.2 removed the runtime-invariant registry and every `/invariant` subpath; `@deepseek-ai/dsh-code-runtime` devDependency (package no longer shipped)

### Fixed
- Background job output: the previous `dd` block-aligned fetch silently skipped the remainder of a not-yet-full 64 KiB block, and multibyte characters split across fetches rendered as replacement characters; both are gone, and the last ≤3 s of a finished command's output is no longer lost at settlement
- `test-built-lib.mjs` locates the `HostStore` chunk by class name (the shared chunk is no longer named `engine-*`)

## [v0.3.0] — 2026-09-18

### Added
- **Remote background jobs**: `bash` (cloud sessions) and `ssh_exec` gained `run_in_background` — commands register as first-class DSH jobs via the official `ctx.jobs` contract (kind `ssh`); `job_output` / `job_list` / `job_kill`, completion notices and the jobs UI all work out of the box
- `src/job-runner.ts`: persistent exec-channel wrapper (authoritative exit status, zero polling), incremental `dd` output reads of a remote log, process-group kill (TERM → KILL), honest orphan reporting on connection loss
- Design spec `docs/07-design-remote-jobs.md`; repo knowledge base `docs/REPO-WIKI.md`

## [v0.2.2] — 2026-09-05

### Security
- Password storage converged: settings documents never persist secrets again; the 0600 store is the single authority, with Windows `icacls` ACL tightening and a one-time startup migration of existing plaintext entries
- Host-id prototype-pollution guard (`isSafeHostId`) on both store keys and settings reads

### Added
- `read_image` shadow tool (SFTP binary read + magic sniff + base64 image blocks, 8 MiB cap)
- Shared file-diagnostic logger `src/debug-log.ts` (512 KiB rotation)

### Fixed
- `ctx.on('agent/created')` hook subscription (AgentRegistry has no `on` — routing silently never fired before); real-machine verified: 7 shadow tools register per cloud session

## [v0.2.1] — 2026-08-31

### Added
- **Preset-less cloud workspaces**: dual-tab workspace picker (Local / Cloud SSH) filling the official `directory-flow` slots; placeholder dirs adopted by the official workspace registry
- Session-scoped shadow tools (`bash` / `read` / `write` / `edit` / `glob` / `grep`) routed by session cwd, with official rich-UI presenters (expandable terminal/read cards)
- Dynamic per-session system-prompt section announcing the remote identity
- Full code audit: 12 fixes (connection-pool double release, stale-rejection self-heal, ProxyJump probe leaks, oversized-file streaming, parent-dir creation on write, UI race/timeout guards, …)

## [v0.2.0] — 2026-08-30

### Added
- M4 real-server acceptance (E2E harness `scripts/e2e-real-server.mjs`, 25 checks)
- SSH host settings card (host CRUD, keyboard-interactive password auth, key auth, ProxyJump), remote directory browser with create/delete, placeholder workspaces
- jsonSafe output boundary for all typert endpoints and tool results

## [v0.1.x] — 2026-08-16 → 08-28

### Added
- ssh2 engine (pooling / keepalive / broken rebuild / ProxyJump / SFTP / PTY), shared `SshRuntime` (`ctx.ssh`), global `ssh_*` agent tools, `fs-ssh` / `subprocess-ssh` capability adapters (legacy seam route)
