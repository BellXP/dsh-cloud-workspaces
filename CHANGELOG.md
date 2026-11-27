# Changelog

All notable changes to `dsh-cloud-workspaces` are documented here.

## [v0.10.8] — 2026-11-27

### Fixed
- **Workspaces on nodes whose login shell misbehaves over SSH (Huawei Cloud ModelArts Ascend images), without touching the node.** Two independent faults, both reproduced on two fresh `dmtp-debug` nodes:
  - *The SFTP stream arrived pre-polluted.* sshd runs the subsystem as `$SHELL -c sftp-server`, and bash reads `~/.bashrc` whenever `SSH_CLIENT` is in the environment — no matter whether stdin is a socket or a pty. That file printed a banner to stdout, so ssh2 read ` __ ` as a packet length: `Packet length 543121184 exceeds max length of 262144` (OpenSSH's sftp: `Received message too long`). `sftp-preamble.ts` now hooks ssh2's `SFTP.prototype.push` (the single entry for inbound data) and drops everything before the first well-formed `SSH_FXP_VERSION` packet; a quiet shell loses zero bytes. It gives up after 256 KiB and when ssh2's internal layout is not recognised.
  - *`READDIR` of the home directory never came back.* The image's `sftp-server` stops answering (or dies) for that one directory; other directories are fine. `installResilientReaddir` (`sftp-list.ts`) wraps the session's `readdir`: no answer within `sftpReaddirTimeoutMs` (default 8 s), or a session-type error, drops the SFTP session, lists through the helper shell and marks the host; afterwards every listing on that connection goes straight to the shell and `engine.ls` no longer opens SFTP first. Real errors (missing, permission) are reported as before.
- **The first version of that fallback killed the whole SSH connection** (`cb is not a function`): ssh2's `readdir` pages a directory by re-invoking `this.readdir(where, opts, cb)` with a state object, and the wrapper mistook that continuation for a new listing. Continuation calls are now passed through untouched; a regression test emulates the paging.

### Added
- **`UtilityShell`**: one long-lived `bash --noprofile --norc` channel per connection for the engine's own small commands, NUL-free sentinel framing (`__DSH_REMOTE_IDE_EXIT__<code>__`), strictly serialised, closed on a timeout and reopened on the next call. On the Ascend image every `exec` channel costs a 15 s login shell (the rc file imports torch twice); the helper shell pays it once and then runs `find` in ~130 ms. Not yet used for `exec` itself.
- `EngineOptions.sftpReaddirTimeoutMs`.
- Tests (+22, 219 total): `sftp-resilience` (preamble gate incl. split packets and overflow, `find` output parsing with banners / CRLF / odd names, dangling and resolved links without extra `stat`, the resilient `readdir` in all five modes incl. ssh2's continuation calls) and `engine-resilience` (the switch landing on the connection record, later `ls` skipping SFTP, the helper shell's framing / serialisation / timeout-reopen / closed-shell reporting).

## [v0.10.7] — 2026-11-27

### Fixed
- **Symlinked directories were dead ends in the file tree and the workspace picker.** `readdir` reports a symbolic link with the link's own mode (`S_IFLNK`), which is neither a file nor a directory, so the fs seam's `listDir` typed such entries `other` and the sidebar tree showed them as leaves that never expand; `engine.ls` did the same, and the picker (which lists only `type: 'dir'` as sub-directories) could not enter them either. The official local fs backend `stat`s every listed child — following links — so on this machine a link to a folder *is* an expandable folder. Both listing paths now do the same (`src/sftp-list.ts`): only the symlink entries cost one extra `stat` each; a link reports what it points at (`dir` / `file`, with the target's size and mtime); a dangling link or a link loop stays `other` instead of failing the whole listing. `fs.lstat` still reports `symlink` for the entry itself, which the trust-boundary rules rely on. `ssh_ls` entries carry `symlink: true` for links and render as `l>d` / `l>-` / `l>?`.

### Added
- Tests (+11, 197 total): `sftp-list` (follow to dir / file, dangling, loop, ELOOP, failing `readdir`, chained links, no extra `stat` for plain entries), the fs seam's `listDir` over links (types, expanding a linked folder, reading through it, `lstat` unchanged, `FS_NOT_FOUND`), and the `ssh_ls` schema / render for `symlink`.

## [v0.10.6] — 2026-11-26

### Changed
- **Session shadow tools mirror the session's composition.** In a cloud workspace the `agent/created` hook registers remote `bash/read/write/edit/glob/grep/read_image`. It now takes a visibility snapshot of the agent scope *before* registering anything, and offers a remote tool only when the composition already exposes a tool of that name. `bash` is always offered (on Windows the local bash tool is platform-disabled, so the remote shell is the only one). A read-only preset (`tool-fs` with `write: false` / `edit: false`) therefore no longer receives remote `write`/`edit` behind its back, which is what lets role presets enforce "the reasoner and the verifier do not edit". When `read` is not observable or not offered at all, the previous full registration applies. The debug log names what was skipped: `… shadow tools; not offered by the composition, skipped: write,edit`.
- The remote-session prompt section says "Your shell and file tools (bash, read, glob, grep, and write/edit when your composition has them) execute on that server" instead of listing write/edit unconditionally.

### Added
- Tests (+4, 186 total): mirror rule with a read-only composition, the unobservable/read-less fallback, unknown names kept, and the hook-level check that the snapshot precedes any registration.

## [v0.10.5] — 2026-11-26

### Fixed
- `ssh_ls` failed on every non-empty directory ("`value.entries[n].mode` is not a declared property"): `engine.ls` sets the stat `mode` on each entry (the workspace picker reads it), but the tool's output schema closes the entry object with `additionalProperties: false` and never declared the field. The schema now declares the optional `mode`, so the agent sees the permission bits the engine already returned.

### Added
- Test (+1, 182 total): an `ssh_ls` result built from `engine.ls`-shaped entries must have every key declared in the output schema.

## [v0.10.4] — 2026-11-26

### Added
- **Manual `~/.ssh/config` import / sync.** `importSshConfig(text?, { update })` gains an update mode: besides adding new `Host` blocks it refreshes every existing entry that came from ssh config (tag `ssh-config`) in place — port, user, `IdentityFile`, `ProxyJump` and the HTTP proxy translated from a ncat/nc/connect `ProxyCommand` follow the file again (a proxy the file no longer declares is cleared), while description, environment label and the login-env snapshot are kept. Manually created entries are never touched. `ImportResult` reports `updated` / `updatedNames`. Surfaces: a **「从 ~/.ssh/config 导入 / 同步」** button in the SSH settings card and in the workspace picker (with an added/updated toast), `ssh_list { sync: true }` for the agent, and the typert invocation `importHosts(update)`.
- `ssh_workspace action: 'register'` binds a remote directory **and** adds the placeholder to the DSH workspace list through the official `WorkspaceRegistry.create` (`SshRuntime.registerWorkspace`), so a cloud workspace can be created end-to-end from the agent.
- Workspace picker: a remote-path input with **跳转** (Enter) so a deep path can be typed directly, a **filter** box for the current listing, a refresh button, sub-directory count, explicit empty states, and the list error rendered inline instead of only as a transient toast; a non-array `listRemoteDir` result is reported as an error. The settings-card directory browser gets the same path-jump input.
- Host-side `typert listRemoteDir` logs entry counts, durations and failures to `~/.dsh/dsh-remote-ide-debug.log`, so a picker that shows nothing leaves a trace of why.

### Fixed
- `ssh_list` keeps auto-importing only while the store is empty (unchanged); its previous empty-store hint now matches the explicit `sync` option.

## [v0.10.3] — 2026-11-26

### Changed
- **Robust login-environment prewarm for slow-profile hosts** (ModelArts/Atlas: `bash -l` 24–77 s because the platform `.bashrc` sources the Ascend `set_env.sh` scripts). The snapshot mechanism (capture once in the background, then start terminals with `bash --noprofile --norc -i` + source the snapshot) existed since v0.8.0 but degraded in three situations, all fixed:
  - a terminal requested while the background capture was still running fell back to the login shell after 3 s — it now waits for the capture (`terminalPrewarmWaitMs`, default 150 s; the login-shell fallback costs the same 24–77 s and leaves no snapshot behind), so the first terminal lands on the fast path and every later one starts in ~1 s;
  - a recorded snapshot whose remote file disappeared (pod rebuild wiped `~/.cache`) never re-captured — `ensureLoginEnv` skipped the host forever because it was "already recorded"; `loginEnvScriptFor` now clears the record and re-captures in the background;
  - snapshots never aged — a recorded snapshot older than `loginEnvMaxAgeMs` (default 24 h; 0 disables) is refreshed in the background on connect while the old one keeps serving terminals.
  Both knobs are plugin `Config` fields (`terminalPrewarmWaitMs`, `loginEnvMaxAgeMs`) passed through to `SshRuntime`.
- Measured on `notebook-4312` (ModelArts, 320 cores) with the built `spawnSshTerminal`: fast path **1.2 s / 0.9 s** bootstrap vs **38.7 s** login shell; the fast-path terminal reports `(PyTorch-2.6.0)`, `ASCEND_TOOLKIT_HOME=/usr/local/Ascend/cann-8.5.0`, correct `PS1`.

### Added
- Tests (+5, 179 total): first-terminal wait for an in-flight capture, configurable wait cap, snapshot loss → background recapture (success and failure paths), age-based refresh with the old snapshot still serving.

## [v0.10.2] — 2026-11-26

### Fixed
- **`~/.ssh/config` values wrapped in double quotes are now unquoted on import.** `IdentityFile "C:\Users\me\.ssh\id_ed25519"` (the Windows form for paths with spaces) used to be stored with its quotes, so the engine looked for a file literally named `"…id_ed25519"` and every connection failed with `private key not found`. Only a matching pair around the whole value is stripped; a `ProxyCommand` whose program path alone is quoted keeps its inner quotes
- `ssh_list` now really does what its hint promised: while the store is empty it imports `~/.ssh/config` from the DSH host first (with the v0.10.1 proxy translation), so the agent-facing flow works without the settings card; a failing import falls back to the empty-list hint
- Verified live against `flex-0522-4-inter` through the corporate HTTP CONNECT proxy with the built engine: exec 1.0 s cold / 0.95 s warm, SFTP read ok

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
