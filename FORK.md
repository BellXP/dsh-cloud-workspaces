# FORK.md — this checkout is a LIVE dsh plugin (read me before deleting/moving)

This folder is not an archive — it is the **active installation** of a patched
`dsh-cloud-workspaces` plugin, loaded by `dsh web` at every boot:

- Profile: `C:\Users\x00968307\.dsh\profiles\web`
  - `package.json` → `"dsh-cloud-workspaces": "link:<this folder>"`
  - `node_modules\dsh-cloud-workspaces` → junction into this folder
  - `dsh.profile.bundles` → `dsh-cloud-workspaces`
- Every restart reads `lib\*.js` (host half) and `client\index.js` (browser half) from here.
  Deleting, moving, or renaming this folder breaks the plugin until re-linked.

**To relocate** (e.g. before wiping the agent workspace that currently hosts this folder):

```powershell
# 1. Move this folder to a stable, space-FREE path (spaces break link: adds), e.g.:
#    C:\Users\x00968307\dsh-cloud-workspaces
# 2. Re-link the profile to the new location:
dsh plugin --profile web add link:C:\Users\x00968307\dsh-cloud-workspaces
#    (or: node <dsh-install>\lib\bin.js plugin --profile web add link:...)
# 3. Restart dsh web and confirm Settings → SSH 连接 lists MANote-W8-00.
```

## What this fork is

Upstream: `dsh-cloud-workspaces` v0.3.0 (github.com/harryopo/dsh-cloud-workspaces, Apache-2.0),
running against **dsh 0.2.0-rc.2** (also loads on 0.1.7-rc.2 — the peer ranges span both). 0.2.0
added a plugin compatibility gate (`dsh-app-boot` checks every `@deepseek-ai/dsh*` peerDependency
against the runtime with `semver.satisfies(..., {includePrerelease:true})`); this fork declares
`>=0.1.1-rc.2 <0.3.0` on all eight peers, verified against the bundled semver 7.8.5. The complete
diff vs upstream is archived next to this file as `dsh-cloud-workspaces-0.1.7-fork.patch` (also
applyable with `git apply` onto a fresh upstream clone). Summary of the changes:

1. **Host half, 0.1.7 settings-API migration** — upstream imports
   `installSettingsSection`/`settingsNamespace` from `@deepseek-ai/dsh-settings`, removed in
   0.1.7 (host half failed to import). The settings mirror is retired; the 0600 host store
   `~/.dsh/dsh-remote-ide.json` is the single authoritative storage; typert CRUD is
   store-backed (`src/host-settings.ts`, `src/typert.ts`, `src/index.ts`).
2. **Client half, 0.1.7 typert codec contract** — result codecs are `{mode:'src-json'}`;
   parameter codecs are strict with `typeSymbol` + `create()` passthrough schemas registered
   in the contribution's `schemas` table (0.1.7's registry validates `create()`, and its
   gateway `requireStrictInputs` rejects src-json parameters). All in `client/index.js`.
3. **Client robustness** — typert `$mount` failures surface as a visible error instead of
   eternal loading; the workspace-picker slot registration is guarded so it cannot take down
   the settings card.
4. **Feature: per-host optional HTTP CONNECT proxy** — the host form offers 通过 HTTP 代理连接
   (address/port/user/password, Basic auth), the equivalent of the `ncat --proxy-type http`
   `-inter` entries in `~/.ssh/config`, but native; composes with ProxyJump (tunnels the
   chain's first dial). `connectHttpProxy()` in `src/engine.ts`; write-only credentials in
   `src/store.ts`; `tests/http-proxy.test.ts` covers it.
5. **Fix: proxy hosts failed the 测试连接 button** (2026-09-30, live flex-* incident) — the
   settings-card test call sends no `httpProxy` field, so proxy-only hosts (direct TCP blocked)
   were tested with a direct dial and timed out after 15 s ("Timed out while waiting for
   handshake") while actually being reachable. `testConnection()` in `src/typert.ts` now falls
   back to the saved proxy when the form omits it (same inheritance semantics as the password).
   The workspace-picker path was never affected — it always used the full stored entry.
6. **Feature: remote sidebar file tree + terminal** (2026-10, the 0.1.7 UI seams) — with a cloud
   workspace session active, the web sidebar now follows the session onto the server:
   - **File tree / preview** (`src/seam-fs.ts`): the official `workspaceFiles` service reads
     through `ctx.fs`; this seam wraps the live fs instance's `resolve/lstat/stat/listDir/
     streamText/readBytes/readByteRange/watch` with path-based routing — paths inside the
     placeholder tree (`~/.dsh/remote/…`) go to SFTP on the session's host, everything else
     falls through to the local backend untouched. `targetKey`s stay in placeholder-local form
     so the unpatched `processPath/fileUrl/contains` (pure string ops) keep the tree hierarchy
     correct. `watch` throws for remote targets → the sidebar degrades to its official
     `watch-unsupported` mode (manual refresh; no auto-refresh of remote changes).
   - **Terminal** (`src/seam-terminal.ts` + `src/subprocess-ssh.ts`): the official terminal
     controller spawns PTYs via `ctx.subprocess.spawnTerminal` with `spec.cwd` = session
     workspace; the seam routes placeholder cwds to an SSH PTY on that host (remote login
     shell, `cd` to the workspace, full process-group cleanup). The local shell picker is
     ignored for remote terminals — the terminal IS the remote world (label may still say
     pwsh/cmd; cosmetic). 0.1.7's added `resize`/`inspectActivity` are implemented
     (activity reports `unknown` → no idle auto-close).
   - Seams install via `ctx.inject` when the services appear, patch own-properties, and
     restore on unload. They follow the plugin's enabled switch. Both verified live against
     flex-1 (`test-seam-live.mjs`).
7. **dsh 0.2.0-rc.2 compatibility** (2026-09-30) — the new peer gate skipped the whole bundle
   until the peer ranges were widened (see above). A byte-diff of the 0.1.7-rc.2 vs 0.2.0-rc.2
   package trees (old tarballs recovered from the local npm `_cacache`) proved every wrapped
   surface is **byte-identical**: dsh-fs FileSystem + types, dsh-subprocess
   SubprocessRuntime/spec/handle, workspace-files' ctx.fs call set and error mappings, the
   terminal controller's spawnTerminal call and handle consumption, the typert codec validation
   (strict `create()` + gateway `requireStrictInputs` + src-json results), the
   `settings.section` / workspace-picker slots, and the `dsh.bundle.patch`/`dsh.client`
   manifest loading. Upstream's only change is an internal shell-candidate dedup refactor that
   does not touch the wrapped paths — no code changes were needed beyond the peer ranges.
8. **Feature: persistent session shell** (2026-09-30, plan B) — the shadow `bash` tool now runs
   foreground commands on ONE per-session `bash -l` channel (sentinel protocol: unique marker +
   `$?`/`$PWD` per command) instead of a fresh exec channel per call. Measured on a proxied host:
   ~310 ms → **~50 ms** per command (6×), plus real state persistence — `cd`, `exports`, activated
   environments survive between calls (explicit `workdir` still forces a cd; the sentinel carries
   `$PWD` so rebuilds resume the directory). Timeout kills the channel locally at the deadline
   (KILL signal + destroy; the next call rebuilds), transport errors fall back to one-shot exec
   so a command is never lost, and idle channels self-close after the engine's idle timeout.
   `engine.openShellSession()` in `src/engine.ts`; verified live by `test-persistent-live.mjs`.
9. **Perf: shared-shell search + fs stat cache + pseudo-watch** (2026-10-01) — three follow-ups on the
    persistent shell and the fs seam, from the post-0.2.0 backlog:
    - `grep`/`glob` shadow tools now probe on the session's persistent shell (same channel as `bash`,
      absolute paths, no cwd churn) instead of a fresh one-shot exec per call — saves the ~300 ms
      channel setup on every search; the 30 s timeout and one-shot-exec fallback semantics carry over.
    - fs seam read-side **stat micro-cache** (2.5 s TTL per targetKey): the sidebar's
      resolve→lstat→stat→read chain no longer pays a duplicate SFTP RTT per stat. Write guards still
      go through the authoritative uncached `probe`, and writes invalidate the entry on commit.
    - fs seam **pseudo-watch**: SFTP has no inotify, so `watch()` now polls an mtime/attrs
      fingerprint (file = 1 RTT stat, directory = 1 RTT readdir) every 3 s and issues the
      content-free `changed()` invalidation — the sidebar file tree auto-follows agent edits
      instead of requiring manual refresh. Transient errors are tolerated (5 consecutive failures
      ≈ 15 s before the feed gives up and falls back to watch-unsupported behavior); ENOENT is a
      fingerprint change, so create/delete events fire too. Declared without `override` because
      the repo's 0.1.1-rc.2 devDeps typing has no `watch` on `FileSystem` (the 0.2.0 runtime base
      class does; the method shadows it).
    - Deferred: remote-aware terminal shell tab labels (`terminalEnvironment`/`resolveExecutable`
      carry no cwd, so global seam routing can't attribute them to a session; needs an agent-scope
      patch — see seam-terminal notes).
    - Tests repaired to 124/124: the three session-tool cases were re-based on the persistent-shell
      surface; the stale `setSettings`/`:memory:` fixtures in typert/http-proxy tests (broken since
      the settings-mirror retirement and illegal `:` in Windows filenames respectively) were fixed.

## Rebuild (after editing src/ — client/index.js needs no build)

```powershell
cd <this folder>
# pnpm 10.x any way you have it. On the corporate network, set first:
$env:NODE_USE_SYSTEM_CA = "1"            # corporate mirror certs from the Windows store
$env:COREPACK_NPM_REGISTRY = "https://mirrors.tools.huawei.com/npm"
corepack pnpm install --ignore-scripts --config.node-linker=hoisted
node node_modules\typescript\bin\tsc -p tsconfig.build.json
node node_modules\tsdown\dist\run.mjs
# restart dsh web — host lib AND client bytes are read at boot
```

Validate the built lib without any toolchain (works even inside dsh's file sandbox):

```powershell
node test-built-lib.mjs    # in this folder: 5 runtime checks (proxy dial + seam path routing)
node test-seam-live.mjs flex-1   # LIVE: remote shell + SFTP shapes (needs the host reachable)
node test-persistent-live.mjs flex-1   # LIVE: persistent shell semantics + perf (needs the host)
```

## Update from upstream

```powershell
git stash          # keeps this fork's changes
git pull
git stash pop      # resolve conflicts if upstream moved the same lines
# rebuild as above; restart dsh web
# if upstream ships its own 0.1.7 fix, drop the superseded parts of changes 1–2
```

## Daily use

- Hosts live in `~/.dsh/dsh-remote-ide.json` (0600; edit by hand only while dsh web is stopped)
- Settings → SSH 连接: add hosts (direct / HTTP proxy / ProxyJump bastion), Test, Save
- 添加工作区 → 云端（SSH）→ pick host → browse → bind: that session's bash/read/write/edit/
  glob/grep + `ssh_*` tools run on the server
- Debug log: `~/.dsh/dsh-remote-ide-debug.log` (session routing, typert registration,
  listHosts/saveHost outcomes). Browser errors carry the `[dsh-remote-ide]` prefix in F12.

## Caveats

- No SSH host-key pinning (upstream limitation) — fine on a trusted intranet
- Remote commands run with the SSH account's full rights (no dsh sandbox remotely)
- Passwords/proxy credentials are plaintext in the 0600 store — prefer key auth
- **Remote sidebar (seam) limits**: no `watch` on remote targets (file tree needs manual
  refresh); remote path canonicalization is lexical (remote symlinks are not resolved into
  distinct keys); the sidebar is read-only so no fs write methods are routed (agent writes go
  through the shadow tools); terminal shell label may show the local shell name while the
  remote login shell actually runs. If the fs/subprocess providers are ever reloaded via the
  plugin manager, restart dsh web to re-arm the seams.
- `.pnpm-store/` here is local build state; `node_modules/` regenerates via the rebuild steps
