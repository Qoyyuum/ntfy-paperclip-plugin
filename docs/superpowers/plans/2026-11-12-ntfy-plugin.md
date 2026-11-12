# ntfy-paperclip-plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build, test, and publish a Paperclip plugin that forwards company events to ntfy topics with admin-owned channels, member↔channel subscriptions, and guided ntfy server setup (Docker or Podman).

**Architecture:** Paperclip plugin worker (ESM, Node 24 target) subscribing to domain events and publishing to ntfy over HTTP; admin surface via actor-gated manifest `apiRoutes`; React admin page in a `page` UI slot. Publishing = single `POST {baseUrl}/{topic}` with ntfy headers.

**Tech Stack:** TypeScript, Bun (dev/test/build tooling — but worker runtime is Node 24, so runtime code uses `node:` APIs only), `@paperclipai/plugin-sdk`, React for the UI bundle.

**Spec:** `docs/superpowers/specs/2026-11-12-ntfy-notifications-design.md`

## Global Constraints

- npm package name: `ntfy-paperclip-plugin`; manifest `id`: `paperclip.ntfy`, `apiVersion: 1`.
- Worker bundle is ESM targeting **node24** (host runs `node dist/worker.js`) — no `Bun.*` APIs in `src/`; use `node:child_process`, `node:fs`, global `fetch`.
- `definePlugin` must set `multiCompanyConfig: true`.
- Worker bundle: everything bundled; external `react`, `react-dom`. UI bundle: external `react`, `react-dom`, `react/jsx-runtime`, `@paperclipai/plugin-sdk/ui`, `@paperclipai/plugin-sdk/ui/hooks`. Manifest bundle: external `@paperclipai/plugin-sdk`.
- Secrets never stored in plaintext; config holds `accessTokenSecretId` / `passwordSecretId` (secret ids), worker wraps as `{type:"secret_ref", secretId}` for `ctx.secrets.resolve`.
- All admin reads/mutations are owner/admin-gated via `actor.userId` → membership role ∈ `{owner, admin}`.
- `onHealth`/`onValidateConfig` never call company-scoped APIs.
- Tests: `bun test`. Typecheck: `bun check`.
- Conventional commits (`feat:`, `fix:`, `chore:`, `test:`).

## Review Focus

1. `Authorization` header construction — token mode must produce `Bearer <token>`, basic mode `Basic base64(user:pass)`; a wrong header silently 401s every publish. (Task 4 test asserts the exact header.)
2. Non-admin / non-member actors must get 403 on **every** admin route including `GET /admin/state` (reads leak topic names). (Task 7 test.)
3. `baseUrl`/`topic` joining — trailing slashes must not produce `//topic` or drop path segments. (Task 4 test.)
4. Hosts without docker/podman: probes must return `no-runtime`, never throw. (Task 8 test with exec stub.)
5. Events whose entity fetch fails (e.g. deleted issue) must still publish a notification rather than die in the event handler. (Task 6 test.)

---

### Task 1: Repo, manifest, and build scaffold

**Files:**
- Create: `src/manifest.ts`, `scripts/build.ts`, `package.json` (update), `.gitignore` (update), `LICENSE`
- Modify: `package.json`, `.gitignore`
- Test: `tests/manifest.test.ts`

**Interfaces:**
- Produces: `export const manifest: PaperclipPluginManifestV1` (also `export default`) from `src/manifest.ts`; `bun run build` → `dist/worker.js`, `dist/manifest.js`, `dist/ui/`; `bun test`, `bun run typecheck`.

Manifest contents (from spec): `id: "paperclip.ntfy"`, `apiVersion: 1`, `version` — read from package.json at build time or duplicated as `"0.1.0"`, `displayName: "ntfy Notifications"`, `description`, `author: "Paperclip community"`, `categories: ["connector"]`, `entrypoints: { worker: "dist/worker.js", ui: "dist/ui" }`, capabilities: `events.subscribe`, `http.outbound`, `plugin.state.read`, `plugin.state.write`, `access.members.read`, `secrets.read-ref`, `activity.log.write`, `api.routes.register`, `ui.page.register`, `companies.read`, `issues.read`, `agents.read`, `projects.read`, `goals.read`. `instanceConfigSchema` per spec (baseUrl default `https://ntfy.sh`, appBaseUrl, authMode enum, accessTokenSecretId, username, passwordSecretId, defaultPriority 1–5 default 3, defaultTags). `apiRoutes` (all `auth: "board"`, `capability: "api.routes.register"`, `companyResolution`: GETs `{from:"query", key:"companyId"}`, mutations `{from:"body", key:"companyId"}`):
- `GET /admin/state` routeKey `admin-state`
- `PUT /admin/channels/:id` routeKey `channel-upsert`
- `DELETE /admin/channels/:id` routeKey `channel-delete` (companyId via body)
- `PUT /admin/subscriptions` routeKey `subscriptions-set`
- `POST /admin/test` routeKey `test-send`
- `GET /admin/server-status` routeKey `server-status`
- `POST /admin/server-setup` routeKey `server-setup`
`ui.slots`: `[{ type: "page", id: "notifications-admin", displayName: "ntfy Notifications", exportName: "NotificationsAdminPage", routePath: "ntfy" }]`.

`scripts/build.ts` uses `Bun.build` (dev-tool only — Bun API OK here) mirroring the bundler presets: worker `src/worker.ts`→`dist` (format esm, target node24 equivalent — Bun `target: "node"`, external `react`,`react-dom`), manifest `src/manifest.ts`→`dist` (external `@paperclipai/plugin-sdk`), UI `src/ui/index.tsx`→`dist/ui` (target browser, externals listed above). sourcemap on, no minify.

package.json: `name: "ntfy-paperclip-plugin"`, `version: "0.1.0"`, `"type": "module"`, `license: "MIT"`, `files: ["dist", "README.md", "LICENSE"]`, scripts `build`, `test`, `typecheck`; dependency `@paperclipai/plugin-sdk` stays. `.gitignore` gains `dist/`. LICENSE: MIT. `git init` + initial commit.

- [ ] **Step 1: Write the failing test** `tests/manifest.test.ts` asserting `manifest.id === "paperclip.ntfy"`, `apiVersion === 1`, all seven apiRoutes have `capability === "api.routes.register"` and `auth === "board"`, and the page slot has `exportName === "NotificationsAdminPage"`.
- [ ] **Step 2: Run `bun test` — expect FAIL (no src/manifest.ts).**
- [ ] **Step 3: Create `src/manifest.ts`, `scripts/build.ts`, update package.json/.gitignore, write LICENSE.**
- [ ] **Step 4: Run `bun test` — PASS; run `bun run build` — produces `dist/manifest.js` (worker/ui fail until those entries exist is OK only if build tolerates missing entries — make build skip absent entrypoints with a warning).**
- [ ] **Step 5: `git init`, `git add -A`, commit `chore: scaffold plugin package, manifest, and build`.**

### Task 2: Config parsing and auth header (`src/config.ts`)

**Files:**
- Create: `src/config.ts`
- Test: `tests/config.test.ts`

**Interfaces:**
- Produces:
  - `export interface NtfyPluginConfig { baseUrl: string; appBaseUrl: string | null; authMode: "none"|"token"|"basic"; accessTokenSecretId: string | null; username: string | null; passwordSecretId: string | null; defaultPriority: number; defaultTags: string }`
  - `export function parseConfig(raw: Record<string, unknown>): NtfyPluginConfig` — defaults baseUrl `https://ntfy.sh` (also when empty/whitespace), strips trailing `/` from baseUrl/appBaseUrl, clamps defaultPriority to 1–5.
  - `export async function buildAuthHeader(cfg: NtfyPluginConfig, resolveSecret: (ref: {type:"secret_ref"; secretId:string}, opts?: {companyId?:string; configPath?:string}) => Promise<string>, companyId: string): Promise<string | null>` — `token`→`Bearer <resolved>`, `basic`→`Basic base64(username:resolvedPassword)`, `none`→null. Throws a descriptive error if a required secret id is missing.

- [ ] **Step 1: Write failing tests**: default parse fills `https://ntfy.sh`/priority 3; `baseUrl: "https://x.io/"` → `https://x.io`; token mode with stub resolver returning `tk_abc` → `Bearer tk_abc` and resolver received `{type:"secret_ref", secretId:"sid1"}`; basic mode → `Basic dXNlcjpwYXNz` for user/pass; token mode without `accessTokenSecretId` throws.
- [ ] **Step 2: `bun test tests/config.test.ts` — FAIL.**
- [ ] **Step 3: Implement `src/config.ts`.** Note: `btoa` exists in Node 24 — use it, or `Buffer.from(s).toString("base64")`.
- [ ] **Step 4: `bun test` — PASS.**
- [ ] **Step 5: Commit `feat: config parsing and ntfy auth header`.**

### Task 3: Company-scoped state (`src/state.ts`)

**Files:**
- Create: `src/state.ts`
- Test: `tests/state.test.ts`

**Interfaces:**
- Consumes: `ctx.state` (`{scopeKind:"company", scopeId, stateKey}`).
- Produces:
  - `export interface NtfyChannel { id: string; name: string; topic: string; categories: string[]; priority?: number; tags?: string }`
  - `export interface NtfySubscription { principalId: string; principalType: "user"|"agent"; channelId: string }`
  - `export interface NtfyCompanyState { channels: NtfyChannel[]; subscriptions: NtfySubscription[] }`
  - `export async function loadState(ctx: PluginContext, companyId: string): Promise<NtfyCompanyState>` — merges `channels` + `subscriptions` state keys, defaults `[]`, drops malformed entries.
  - `export async function saveChannels(ctx, companyId, channels)` / `saveSubscriptions(ctx, companyId, subscriptions)`.

- [ ] **Step 1: Failing test using `createTestHarness({manifest})` + `plugin.definition.setup` is NOT needed — call functions against `harness.ctx.state` directly.** Seed via `ctx.state.set`, assert loadState round-trips; unknown state → `{channels:[], subscriptions:[]}`; malformed entry (missing `topic`) dropped.
- [ ] **Step 2: FAIL → Step 3: implement → Step 4: PASS.**
- [ ] **Step 5: Commit `feat: company-scoped channel/subscription state`.**

### Task 4: ntfy publish + health client (`src/ntfy.ts`)

**Files:**
- Create: `src/ntfy.ts`
- Test: `tests/ntfy.test.ts`

**Interfaces:**
- Produces:
  - `export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>`
  - `export interface NtfyPublishInput { baseUrl: string; topic: string; authHeader: string|null; title: string; body: string; priority?: number; tags?: string; click?: string }`
  - `export async function publish(fetchFn: FetchLike, input: NtfyPublishInput): Promise<void>` — `POST {baseUrl}/{topic}` (encode topic segment, single `/` join), body = input.body; headers `Title`,`Authorization`(if set),`Priority`,`Tags`,`Click`. Non-2xx → throw with status.
  - `export type NtfyHealth = "up"|"auth-required"|"unreachable"`; `export async function healthCheck(fetchFn: FetchLike, baseUrl: string, authHeader: string|null, timeoutMs = 5000): Promise<NtfyHealth>` — `GET {baseUrl}/v1/health` with `AbortSignal.timeout`; 2xx→up, 401/403→auth-required, anything else/throw→unreachable.

- [ ] **Step 1: Failing test spinning a real `Bun.serve` on port 0 asserting: method POST, path `/mytopic` when baseUrl has trailing slash, exact `Authorization: Bearer tk_x` header, `Title`/`Priority`/`Tags`/`Click` headers, body text. 500 response → throws. Health: fake 200→`up`, 401→`auth-required`, closed port→`unreachable`.**
- [ ] **Step 2: FAIL → Step 3: implement → Step 4: PASS.**
- [ ] **Step 5: Commit `feat: ntfy publish and health client`.**

### Task 5: Admin gate (`src/admin.ts`)

**Files:**
- Create: `src/admin.ts`
- Test: `tests/admin.test.ts`

**Interfaces:**
- Produces: `export async function requireAdmin(ctx: PluginContext, companyId: string, userId: string | null | undefined): Promise<PluginAccessMember>` — throws `AdminRequiredError` (message "admin_required") unless the member list contains an active member with `principalType==="user"`, `principalId===userId`, `membershipRole ∈ {"owner","admin"}`. `AdminRequiredError` exported so routes map it to 403.

- [ ] **Step 1: Failing test with `createTestHarness`: seed `accessMembers` — owner user, viewer user, agent member; assert owner passes, viewer throws `admin_required`, `null` userId throws, agent principalId match throws.**
- [ ] **Step 2–5: FAIL → implement → PASS → commit `feat: owner/admin authorization gate`.**

### Task 6: Event categories, formatting, dispatch (`src/events.ts`, `src/dispatch.ts`)

**Files:**
- Create: `src/events.ts`, `src/dispatch.ts`
- Test: `tests/dispatch.test.ts`

**Interfaces:**
- `src/events.ts` produces:
  - `export const EVENT_CATEGORIES = ["issues","approvals","agents","budget","goals","projects"] as const; export type EventCategory = typeof EVENT_CATEGORIES[number]`
  - `export const EVENT_CATEGORY_MAP: Record<string, EventCategory>` — the full event→category map from the spec.
  - `export function categoryFor(eventType: string): EventCategory | null`
  - `export interface FormattedNotification { title: string; body: string; click?: string }`
  - `export async function formatEvent(ctx: PluginContext, event: PluginEvent, cfg: NtfyPluginConfig): Promise<FormattedNotification>` — fetches entity via read clients (issue → title + `issuePrefix-identifier` ref + `/{companyPrefix or issuePrefix}/issues/...` click under appBaseUrl; agent/run, approval, goal, project similarly); on fetch failure returns a generic title+body (never throws). `click` only when `cfg.appBaseUrl` set.
- `src/dispatch.ts` produces: `export async function dispatchEvent(ctx: PluginContext, event: PluginEvent): Promise<{published: number; failed: number}>` — `categoryFor` → null → `{0,0}`; `ctx.config.get(companyId)` → `parseConfig`; `buildAuthHeader` (missing-secret error → log + `{published:0, failed:0}`); `loadState` → for each channel containing the category → `publish(ctx.http.fetch, ...)`; each failure logged via `ctx.logger` + `ctx.activity`, counted, loop continues.

- [ ] **Step 1: Failing test**: harness + `plugin.definition.setup` not needed — call `dispatchEvent` against `harness.ctx` after seeding config (`setConfig`), state channels, and issues; stub `ctx.http.fetch` (assign a `Bun.serve`-backed or counting stub on the harness ctx) to capture calls. Assert: `issue.created` → POSTs exactly to the channel with `issues` category and not to the `agents` channel; uncategorized event type → no calls; fetch failure → notification still sent (generic text); one channel throwing (server 500) → `failed:1`, other channel still published.
- [ ] **Step 2: FAIL → Step 3: implement both files → Step 4: PASS.**
- [ ] **Step 5: Commit `feat: event formatting and channel dispatch`.**

### Task 7: Admin API routes (`src/routes.ts`)

**Files:**
- Create: `src/routes.ts`
- Test: `tests/routes.test.ts`

**Interfaces:**
- Produces: `export async function handleApiRequest(ctx: PluginContext, input: PluginApiRequestInput): Promise<PluginApiResponse>` — switch on `input.routeKey`; wraps `requireAdmin` (403 body `{error:"admin_required"}` when thrown); each handler returns `{status?, body}`.
  - `admin-state`: `{channels, subscriptions, members}` — members from `ctx.access.members.list` (active only), mapped to `{principalId, principalType, membershipRole}`.
  - `channel-upsert`: body `{id?, name, topic, categories[], priority?, tags?}` → validate non-empty topic + categories ⊆ EVENT_CATEGORIES; `id` absent → `crypto.randomUUID()`; upsert; on delete of channel also drop its subscriptions (handled here for updates; delete route removes subs too).
  - `channel-delete`: removes channel + its subscriptions.
  - `subscriptions-set`: body `{principalId, principalType, channelIds[]}` → replace that principal's subscriptions; validate every channelId exists.
  - `test-send`: body `{channelId}` → publish a test message to that channel's topic ("Test notification from Paperclip ntfy plugin"); returns publish result/error.
  - `server-status`: delegates to Task 8 `getServerStatus(cfg)`.
  - `server-setup`: delegates to Task 8 `runSetup(ctx, input.body)`.

- [ ] **Step 1: Failing tests**: non-admin actor (`actor.userId` = viewer's principalId) → `{status:403}` on `admin-state` AND on `channel-upsert`; admin upserts channel → appears in `admin-state`; upsert with bogus category → `{status:400}`; `subscriptions-set` with unknown channelId → 400; `test-send` against fake ntfy server → 200 and server saw POST.
- [ ] **Step 2: FAIL → Step 3: implement → Step 4: PASS.** Invoke via `plugin.definition.onApiRequest!({routeKey, ... , actor:{actorType:"user", userId}, companyId, ...})` directly on a definition built from a test `setup` — simplest: export a `buildPlugin()` factory from `src/worker.ts` used by both `worker.ts` export and tests (adjust if needed in Task 9; for now test the route handler function directly with `harness.ctx` + a fabricated `PluginApiRequestInput`).
- [ ] **Step 5: Commit `feat: actor-gated admin API routes`.**

### Task 8: Runtime probe + ntfy setup (`src/server-setup.ts`)

**Files:**
- Create: `src/server-setup.ts`
- Test: `tests/server-setup.test.ts`

**Interfaces:**
- Produces:
  - `export type ExecFn = (cmd: string, args: string[], opts?: {timeoutMs?: number}) => Promise<{stdout: string; stderr: string}>`
  - `export interface RuntimeProbe { runtimes: Array<{name:"docker"|"podman"; compose: boolean; stoppedContainers: Array<{id:string; name:string}>}> }`
  - `export async function probeRuntimes(exec: ExecFn): Promise<RuntimeProbe>` — for each of docker/podman: `command -v <rt>` (via `exec("sh",["-c","command -v docker"])`) → `<rt> compose version` or `<rt>-compose version` → `<rt> ps -a --format "{{.ID}} {{.Names}}" --filter name=ntfy` parsed for stopped (use `ps -a` + `inspect` state or `--filter status=exited`). Never throws — missing binary → runtime absent.
  - `export function composeFileYaml(port: number): string` — `binwiederhier/ntfy` image, `command: serve`, `ports: ["<port>:80"]`, volume `./data:/var/cache/ntfy` (or named volume), minimal embedded `server.yml` config via `NTFY_*` env vars or mounted file — keep it simple: env `NTFY_BASE_URL` optional, `NTFY_CACHE_FILE`, `NTFY_BEHIND_PROXY`.
  - `export async function runSetup(ctx, body: {op:"start-container"|"compose-up"; runtime:"docker"|"podman"; containerId?:string; port?:number}, exec?: ExecFn): Promise<PluginApiResponse>` — `start-container` → `<rt> start <id>` then `healthCheck`; `compose-up` → write compose file under `~/.local/share/ntfy-paperclip-plugin/` (node:fs) → `<rt> compose -f <file> up -d` (fallback `<rt>-compose`) → re-probe → return `{status, body:{baseUrl: "http://<host>:<port>"}}`. Default `exec` = promisified `node:child_process.execFile` with 15s timeout.
  - `export async function getServerStatus(ctx, cfg): Promise<PluginApiResponse>` — healthCheck first; if `up`/`auth-required` → report; else `probeRuntimes` → report `runtimes`, `stoppedContainers`, `composeAvailable` — status strings: `up | auth-required | unreachable-with-runtime | unreachable-no-runtime`.

- [ ] **Step 1: Failing tests**: exec stub where `command -v docker` fails but podman works → `runtimes` = `[{name:"podman", ...}]`; `ps -a` output containing exited ntfy container → listed in `stoppedContainers`; compose probe fails → `compose:false`; `runSetup` `compose-up` writes the yaml file (assert via node:fs on a tmp HOME — make dir configurable param defaulting to that path) and calls exec with `compose` args; exec throwing on all commands → `runtimes:[]` not a throw.
- [ ] **Step 2: FAIL → Step 3: implement → Step 4: PASS.**
- [ ] **Step 5: Commit `feat: docker/podman probe and ntfy server setup`.**

### Task 9: Worker wiring (`src/worker.ts`)

**Files:**
- Create: `src/worker.ts`
- Modify: none (routes already call `handleApiRequest`, dispatch already written)
- Test: `tests/worker.test.ts`

**Interfaces:**
- Produces: `export default plugin` (`definePlugin` result) + `runWorker(plugin, import.meta.url)` last line. `setup(ctx)` registers `ctx.events.on(t, handler)` for **every** key of `EVENT_CATEGORY_MAP` → `dispatchEvent`; sets `plugin.definition.onApiRequest = handleApiRequest` via `definePlugin({setup, onApiRequest: (input)=>handleApiRequest(ctx,input), onHealth, onValidateConfig})` — note `onApiRequest` signature takes only input; capture `ctx` from setup in a closure variable.
  - `onHealth`: `{status:"ok", details:{lastPublish: lastPublishResult}}` from an in-process variable — no company calls.
  - `onValidateConfig(config)`: `{ok, errors?, warnings?}` — baseUrl parses as URL; authMode token requires accessTokenSecretId; basic requires username+passwordSecretId; warns when appBaseUrl unset (no Click links).

- [ ] **Step 1: Failing test**: `createTestHarness({manifest})` → `plugin.definition.setup(harness.ctx)` → `harness.emit("issue.created", {...}, {companyId, entityId, entityType:"issue"})` with seeded channel/config/stubbed fetch → ntfy POST observed. `onValidateConfig` bad authMode combo → `errors` non-empty.
- [ ] **Step 2: FAIL → Step 3: implement → Step 4: PASS + `bun check`.**
- [ ] **Step 5: `bun run build` → `dist/worker.js` exists; `node dist/worker.js` starts without crashing (it should idle on stdio — sanity check: spawn, wait 2s, kill, no stderr).**
- [ ] **Step 6: Commit `feat: worker entrypoint wiring`.**

### Task 10: Admin UI (`src/ui/index.tsx`, `src/ui/api.ts`)

**Files:**
- Create: `src/ui/index.tsx`, `src/ui/api.ts`, `src/ui/styles.css`
- Test: none (UI verified via build + manual smoke; note in commit)

**Interfaces:**
- Consumes: all Task 7 apiRoutes; `useHostContext` for `companyId` + `companyPrefix`.
- Produces: `export function NotificationsAdminPage({context}: PluginPageProps)` (named export matching slot `exportName`).

`src/ui/api.ts`:
- `async function resolveApiBase(): Promise<string>` — cached; fetch `GET /api/plugins` (board session, same-origin), find entry whose `pluginKey`/`manifestJson.id` is `paperclip.ntfy`, return `/api/plugins/{id}/api`; fallback `/api/plugins/paperclip.ntfy/api`.
- `apiGet(path, companyId)`, `apiSend(method, path, body)`.

`NotificationsAdminPage` sections:
- **Server setup**: probe result via `GET /admin/server-status`; suggest `baseUrl` — hostname `localhost|127.0.0.1|*.local` → `https://ntfy.sh`, else `https://{hostname}`; `appBaseUrl` ← `window.location.origin`. Status `unreachable` → runtime pick UI when both docker+podman found → `POST /admin/server-setup`; `no-runtime` → manual instructions link (https://docs.ntfy.sh/install/). Note: config itself is written via the host's instance settings form — the page displays current config via `admin-state` (worker includes non-secret config echo) and deep-links/instructs to plugin settings for saving baseUrl/auth fields.
- **Channels**: list + create/edit form (name, topic, category checkboxes, priority, tags) → `channel-upsert`/`channel-delete`; "Send test" → `test-send`.
- **Subscriptions**: per channel, member checkboxes (from `admin-state` members; display `principalType`, role, and name when resolvable via host API — fallback short id) → `subscriptions-set`.
- 403 responses → "Admin only" notice.

- [ ] **Step 1: Implement all three files.**
- [ ] **Step 2: `bun run build` → `dist/ui/index.js` exists; `bun check` clean.**
- [ ] **Step 3: Commit `feat: notifications admin page`.**

### Task 11: CI + publish workflows

**Files:**
- Create: `.github/workflows/ci.yml`, `.github/workflows/publish.yml`, `jsr.json`
- Modify: `README.md` (real usage docs: install, config, channels/subscriptions, setup flow), `package.json` (`publishConfig.access: "public"`, `repository` field)

`publish.yml`: trigger on GitHub `release: [published]`; jobs: build+test; `npm publish --provenance --access public` (setup-node + `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}`); `bunx jsr publish --allow-dirty` is NOT needed — use `npx jsr@latest publish` with OIDC (jsr supports tokenless publish from GHA once package+scope exist). jsr.json: `{"name": "@<jsr-scope>/ntfy-paperclip-plugin", "version": "0.1.0", "exports": "./src/worker.ts"}` — **scope placeholder; user must create/own the JSR scope** (document in README + note at handoff).

- [ ] **Step 1: Write workflows + jsr.json + README.**
- [ ] **Step 2: Validate YAML parses (`bun -e` or `npx yaml` — simplest: `git diff --check` + eyeball; actions linting optional).**
- [ ] **Step 3: Commit `chore: ci and publish workflows`.**

### Task 12: GitHub repo + full verification

- [ ] **Step 1: `gh auth status` — if authed: `gh repo create ntfy-paperclip-plugin --public --source . --push`; else report to user that repo creation needs their `gh auth login`.**
- [ ] **Step 2: Full verify: `bun check`, `bun test`, `bun run build`, `npm pack --dry-run` (or `bun pm pack`) shows dist+README+LICENSE only.**
- [ ] **Step 3: Commit remaining changes; push.**

---

## Self-review notes

- Spec coverage: publish ✓(T4,6), config schema ✓(T1,2), channels/subscriptions ✓(T3,7), admin gating reads+writes ✓(T5,7), server status/setup docker+podman ✓(T8), secrets via secret_ref ✓(T2), Click links ✓(T2,6), test-send ✓(T7), UI ✓(T10), harness tests ✓(all), CI/publish ✓(T11,12).
- `onConfigChanged` not implemented → host restarts worker on config change (acceptable default per SDK).
