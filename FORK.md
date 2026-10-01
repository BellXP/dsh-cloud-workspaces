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
    - fs **stat micro-cache** (2.5 s TTL, key = op+hostId+remotePath, missing paths negatively
      cached): the sidebar's resolve→lstat→stat→read chain no longer pays a duplicate SFTP RTT per
      stat. Built first in `src/fs-ssh.ts` (dormant preset path) — **ported onto the live seam in
      v0.6.0** (see 10); this bullet originally overstated it as already seam-deployed.
    - fs **pseudo-watch**: SFTP has no inotify, so `watch()` polls an mtime/attrs
      fingerprint (file = 1 RTT lstat, directory = 1 RTT readdir) every 3 s and issues the
      content-free `changed()` invalidation — the sidebar file tree auto-follows agent edits
      instead of requiring manual refresh. Transient errors are tolerated (5 consecutive failures
      ≈ 15 s before the feed gives up and falls back to watch-unsupported behavior); ENOENT is a
      fingerprint change, so create/delete events fire too. Same history: built in `fs-ssh.ts`,
      landed on the seam in v0.6.0 (the fs-ssh declaration keeps no `override` because the repo's
      0.1.1-rc.2 devDeps typing has no `watch` on `FileSystem`; the seam mounts it as an
      own-property duck patch instead).
    - Deferred: remote-aware terminal shell tab labels (`terminalEnvironment`/`resolveExecutable`
      carry no cwd, so global seam routing can't attribute them to a session; needs an agent-scope
      patch — see seam-terminal notes).
    - Tests repaired to 124/124: the three session-tool cases were re-based on the persistent-shell
      surface; the stale `setSettings`/`:memory:` fixtures in typert/http-proxy tests (broken since
      the settings-mirror retirement and illegal `:` in Windows filenames respectively) were fixed.
10. **Feature: readable placeholder labels + seam cache/watch landing + BOM fix** (2026-10-01, v0.6.0):
    - **Client: PathLabel rewrite** — the sidebar file-tree header AND the document-preview
      header render paths through the official `PathLabel` (pure presentational, pathPartsOf →
      subdued directory + primary name, `title` hover; no slot, no hook). A MutationObserver
      rewrites `span[data-path-label]` elements whose title is placeholder-shaped
      (`…\.dsh\remote\<hostId>\<base64url>[…\nested\tail]` — the nested tail landed in v0.7.1:
      the file preview header carries `<placeholder root>\g15.sh`, which the root-only v0.6.0
      regex missed) into `MANote-W8-00:/home/ma-user/x00968307[/sub/g15.sh]`. Purely cosmetic —
      the routing keys are untouched; idempotent under React re-renders (it rewrites whatever
      React resets).
    - **Client: workspace auto-titling** — the workspace list row shows `title ?? basename(cwd)`,
      and a fresh cloud workspace's basename is the base64url segment. When (and only when) the
      title is still the auto-derived basename, the client renames it via the OFFICIAL
      `workspaces.rename` to `主机 · 远端名` — once per workspaceId (localStorage ledger
      `dsh.cloudWorkspaces.autoTitled`), never overriding user renames, failures not retried.
    - **Host: seam cache + pseudo-watch actually deployed** — change 9's stat micro-cache and
      fingerprint pseudo-watch ported from the dormant `fs-ssh.ts` onto `src/seam-fs.ts`: the
      read chain (lstat/stat/streamText/readBytes prechecks) shares a 2.5 s TTL cache
      (op-split keys, negative caching), and `watch()` polls a 3 s mtime/attrs fingerprint —
      the sidebar tree now auto-refreshes on remote changes and degrades to manual refresh only
      after 5 consecutive failures.
    - **Fix: UTF-8 BOM in package.json** (v0.5.2) — a PowerShell write had left an EF BB BF BOM
      that made dsh's profile loader fail `JSON.parse` and silently skip the WHOLE bundle (the
      sidebar went local-looking AND the delete menu vanished, session-manager had the same
      bug). Bytes verified to start with `0x7B`; a 53-check BOM/JSON guard now runs in the
      workspace smoke test.
    - Tests: 138/138 (13 new in `tests/seam-fs.test.ts`: cache hit/TTL/op-split/negative-cache/
      passthrough/read-chain sharing; watch change/close/absent→present/dir-content/failure-limit/
      local-unsupported; teardown restores prototype). tsc + tsdown + `test-built-lib.mjs` green.
11. **Feature: rich diff presentation for remote edit/write** (2026-10-01, v0.7.0):
    - Symptom: cloud edits rendered a bare `edited /home/…/arguments.py (1 replacement(s))`
      line — no expandable diff, no line numbers. The UI renders a tool row expandable only
      when the tool definition carries `presentCall`/`presentResult`; bash/read shadow tools
      already did, edit/write did not (the presentation bridge leaves such rows inert by
      design, 2026-08-31 lesson applied to the wrong subset).
    - edit/write now carry the official dsh-tool-fs presentation trio: `presentCall` diff card
      built from call arguments; `output.presentationMeta` computing context-3 hunks via
      `structuredPatch` (`diff` ^9.0.0 added as a bundled dependency — vendored into
      node_modules from the local npx cache because corepack could not fetch on this network;
      a networked `pnpm install` will reconcile the lockfile); `presentResult` maps the
      persisted meta back to a diff card, falling back to the args diff when meta is absent
      (official edit returns undefined there, which lets raw result text replace the card —
      exactly the look this change removes).
    - write gained a before-image (readFile first; ENOENT-like → `operation: create` with
      `oldText: null`, other read errors propagate) matching the official output shape
      {path, operation, before, after}; edit output now carries before/after as an
      LF-normalized diff basis while matching and writing stay on the raw bytes — CRLF files
      keep their line endings (covered by a regression test).
    - Tests: 141/141 (+3). tsc + tsdown + `test-built-lib.mjs` green; bundle verified to
      inline the diff implementation (no runtime import beyond the profile externals).
12. **Feature: login-env snapshots — fast terminals & session shells on slow-profile hosts**
    (2026-10-01, v0.8.0):
    - Diagnosis (live, MANote-W8-00): bare connect 517 ms, non-login shell 532 ms, but a
      LOGIN shell takes **24–77 s** — `~/.bashrc` line 11 sources
      `/usr/local/Ascend/nnal/atb/set_env.sh`, which imports torch_npu/collect_env on every
      login. The sidebar terminal (login shell) and the session persistent shell (`bash -l`)
      both pay it; only the first is visible as "terminal starts slowly".
    - **Capture** (`src/login-env.ts` + `SshRuntime.captureLoginEnv`): one background
      `bash -lc 'export -p; declare -f; alias; PS1'` per host, volatile vars filtered
      (SSH_*/PWD/SHLVL/TERM/COLUMNS/…), assembled into a sourceable snapshot written to
      `~/.cache/dsh-cloud-workspaces/login-env.sh` on the host and registered in the store
      (`loginEnv` field on host entries, survives host edits).
    - **Replay**: the sidebar terminal opens `bash --noprofile --norc -i` via exec-with-PTY
      (engine.openShell gained an optional command) and bootstraps
      `[ -f snapshot ] && . snapshot; cd <workspace>; marker/pid…`; the session persistent
      shell opens `bash --noprofile --norc` with the same source line (constructor and every
      rebuild). Environment parity: exports + shell functions (declare -f) + aliases + PS1.
    - **Zero-config adoption**: first successful connection per host fires the capture in
      the background (once per boot; results persist in the store); terminals wait an
      in-flight capture at most 3 s. `loginEnvScriptFor` verifies the remote file once per
      boot (one `test -f` exec) and returns undefined when missing — every consumer then
      falls back to the original login-shell path, so a lost/stale snapshot can never make
      things worse. Settings → SSH 连接 gained a 预热终端环境 button (typert
      `refreshLoginEnv`) to re-capture after profile changes; HostRow shows the result pill.
    - Tests: 152/152 (+11): login-env parse/assemble/volatile-filter/PS1-quoting; capture →
      store → verified-path flow; remote-missing → undefined fallback; auto-capture fired on
      connect; fast terminal spawn (PTY exec + guarded source + no shell request); session
      shell envScript pass-through. FakeClient exec mocks now accept the 3-arg
      (command, {pty}, cb) form.
13. **Feature: quick-add to conversation from the sidebar** (2026-10-01, v0.9.0):
    - Insertion core (client): the official composer is session-addressed via
      `sessions.scope(id).get('conversation').input.for(actx)` → shell (`insertText` with an
      end-of-draft span + `draftRev` CAS, `setDraft` fallback, `focus`). The main session is
      the `retainedBy.mainView > 0` row — same rule the official workspace UI uses. Plain
      `@path ` text is auto-decorated into a chip by the composer's scan, so no chip API is
      needed. Works for local sessions too.
    - Preview header (official slot `sidebar.right.tab.document.actions`, props
      `{ absolutePath }`): 「@ 引用此文件」 inserts the workspace-relative path (forward
      slashes; outside-cwd falls back to the readable remote/absolute form);
      「引用选中段」 quotes the DOM selection as a fenced block with the file name and a
      language tag (4000-char cap). Empty selection / no main session flash inline hints.
    - Terminal: xterm selections live inside the canvas and the terminal package exposes no
      action slot, so the PathLabel MutationObserver sweep also injects a small
      「引用到对话」 float button into each `.xterm` (position:relative); clicking reads the
      clipboard (covers every copy path: Ctrl+Shift+C / right-click) and inserts a quoted
      terminal-output block.
    - Smoke: +6 pure-function checks (relative reference inside/outside cwd, quote block
      shape/empty/truncation). FORK.md 12's numbers still hold; client-only change, no build.
15. **Tooling: dsh 契约探针（升级雷达）+ OS 泛化审计** (2026-10-01, v0.9.1):
    - `scripts/check-dsh-contract.mjs` — 逐条探测本插件依赖的每个 dsh 表面并**按名字**报断开：
      host 侧真实加载包（defineTool 的 presentationMeta/presentCall 包装、**ToolRuntime 全链路
      执行结果携带 meta.diffs**——v0.7.0 修复的那条契约、dsh-fs 导出面、SubprocessRuntime、
      bindTypertRemote、四个 peer 可解析），client 侧对 dist 做字符串契约探测（7 个插槽名、
      edit/write 行按名分发、结算态 meta.diffs、workspaces.rename、retainedBy.mainView、
      input.for、insertText+draftRev、sessions scope/byId、PathLabel、dsh-subprocess-local 的
      spawnTerminal）。用法：无参 = 查本仓库 devDeps（client 包记 SKIP）；传参 =
      `node scripts/check-dsh-contract.mjs <完整dsh树/@deepseek-ai>` 升级前预检（对 0.1.1 与
      0.2.0 两棵树各 30/30 通过）。`tests/dsh-contract.test.ts` 挂进 pnpm test——升级 devDeps
      即红绿可见。工作区总冒烟 smoke-plugins.mjs 也串了三仓库的探针。
    - OS 泛化审计结论：代码已按「本机路径 node:path / 远端路径 posix」双轨设计——Windows 专属
      代码仅 `store.ts tightenWindowsAcl`（`process.platform==='win32'` 守卫）与开发用
      `start-dsh-web.ps1`；client 端正则全部双分隔符（`[\/\\]`）。
    - **Linux 真机验证已通过（flex-1，Ubuntu x86_64 + node v22.20，2026-10-01）**：
      `node run-linux-tests.mjs flex-1`（可复跑）——git archive 打包 → 经插件自家引擎（含 HTTP
      代理链）SFTP 上传 → 裸容器自动自举 node v22.20（npmmirror）→ `npm install
      --legacy-peer-deps`（npmmirror）→ vitest **154/154** + 契约探针 **30/30**。真机首跑抓到
      两个真问题并已修复：① POSIX 本机占位根映射回归（v0.5.1 的姊妹 bug，见 change 16）；
      ② 纯净 npm 安装缺 12 个 peer-only 的 @deepseek-ai 包（Windows 的 pnpm
      auto-install-peers 掩盖了它）——已显式登记进 devDependencies，克隆即 `npm install
      --legacy-peer-deps` 可用。macOS 未实测，但路径/进程分支与 Linux 同轨（glibc/darwin
      差异仅在不涉及的 native 层）。
    - session-manager 同款探针（8 契约，含 **projectKey 实测锚点**：用磁盘上观察到的真实目录名
      锁死编码重实现，dsh 改算法时先红）；lib/index.js 增 `export const __test = { projectKey,
      encodeSegment }` 测试面。solarized 同款（4 契约：设置插槽 + 主题注册面 + token 词汇）。
16. **Fix: POSIX-local placeholder root mapping + clean npm install** (2026-10-01, v0.9.2):
    - `resolveRemotePath` 在 posix-绝对分支同样把「占位根本身」映射回远端根——此前仅修了
      Windows 形态（v0.5.1）；POSIX 本机上占位路径天然 posix 绝对，落进该分支时 `rel === ''`
      被排除，整条占位路径被当作远端路径返回（Linux/Mac 本机跑 dsh 的话侧栏树会全空）。
      跨平台回归用例双分隔符均绿。
    - devDependencies 显式登记 12 个 peer-only 包（dsh-scope/dsh-timeout/dsh-agent/
      dsh-attachment/dsh-code-runtime/dsh-session/dsh-session-persistence/dsh-storage/
      dsh-storage-domain/dsh-user-approval/cordis-plugin-include/cordis-plugin-loader）——
      pnpm 的 auto-install-peers 在 Windows 上掩盖了纯净 npm 安装的缺口。

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
- **Remote sidebar (seam) limits**: `watch` on remote targets is a 3 s fingerprint poll
  (pseudo-watch, v0.6.0) — no native inotify, so sub-3 s remote changes surface on the next tick
  and 5 consecutive failures degrade the tree to manual refresh; stat results are micro-cached
  2.5 s (missing paths too), so a fresh view can be up to ~2.5 s behind a remote write; remote
  path canonicalization is lexical (remote symlinks are not resolved into distinct keys); the
  sidebar is read-only so no fs write methods are routed (agent writes go through the shadow
  tools); terminal shell label may show the local shell name while the remote login shell
  actually runs. If the fs/subprocess providers are ever reloaded via the plugin manager,
  restart dsh web to re-arm the seams.
- `.pnpm-store/` here is local build state; `node_modules/` regenerates via the rebuild steps
