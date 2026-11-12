# ntfy notifications plugin — design

## Intent and why

A Paperclip plugin that forwards organisation (company) events to
[ntfy](https://ntfy.sh) topics, for teams who want push notifications through
ntfy instead of Telegram or Discord. Works against the public `ntfy.sh`
service or a self-hosted ntfy server (e.g. docker-compose), which expose the
identical publish API — only the base URL differs.

## Goals

- Publish selected Paperclip domain events to ntfy topics via HTTP `POST`
  (`{baseUrl}/{topic}`), per https://docs.ntfy.sh/publish/.
- Org-level configuration: ntfy base URL, publish authentication
  (none | access token | username+password), default priority/tags.
- Admin-owned **channels**: named ntfy targets
  `{ id, name, topic, categories[], priority?, tags? }` created by a company
  owner/admin. **Channels own a fixed category set** — a topic carries
  exactly the categories on its channel.
- Per-member **subscriptions**: which members (human users and agents) are
  granted which channels — i.e. subscription = `member ↔ channel`. This is
  what makes per-member control exact: ntfy topics are broadcast, so anyone
  holding a topic name hears everything published to it.
- All admin reads and mutations gated server-side to owner/admin via the
  authenticated actor (`actor.userId` → membership role ∈ {owner, admin}).
- Server-status panel in the admin UI: probe ntfy reachability, probe the
  host for a stopped/missing ntfy container under Docker **or Podman**,
  and offer guided setup (start stopped container / generate +
  `compose up` / manual instructions) — always on explicit admin action.
  When both runtimes are present, the admin picks which to use.
- Secrets (access token / password) referenced by id and resolved through
  `ctx.secrets` (`secret_ref` bindings), never stored in plaintext state.
- `Click` links in notifications back to the Paperclip entity, built from a
  configurable `appBaseUrl`.
- A "Send test notification" action so admins can verify a channel.
- A plugin page UI ("Notifications") for channels, subscriptions, server
  status, and setup.
- Tests using `createTestHarness` from `@paperclipai/plugin-sdk/testing`.

## Non-goals

- Installing the ntfy CLI on the host — publishing is a single HTTPS POST;
  the CLI is for subscribing/testing on a user's own device.
- Per-member self-service configuration (admin owns all of it, per user
  direction).
- Two-way bridge (ntfy replies → Paperclip comments/actions).
- Per-topic subscriber management on the ntfy server itself (admins share
  topic names out-of-band; users subscribe in their own ntfy app).
- Agent wake-ups driven by notifications (agents may be subscribed, but the
  notification is informational only).
- Installing a container runtime itself (Docker/Podman);
  unattended/automatic `compose` runs (setup actions are always
  admin-triggered).

## Anti-goals

- Storing ntfy credentials in plaintext state or config.
- A shared "everything" topic that leaks restricted alerts to unsubscribed
  members (channel-owned categories + member↔channel subscriptions prevent
  this).
- Requiring the public ntfy.sh — self-hosted must work identically.
- Letting non-admin members enumerate channel topics/subscriptions
  (admin surface is actor-gated end to end).

## Constraints

- Plugin worker runs under the Paperclip plugin host (JSON-RPC over stdio);
  authored in TypeScript, run with Bun. Workers are trusted code — shelling
  out (e.g. `docker`/`podman` probes) is permitted.
- Host APIs are capability-gated by the manifest.
- Company-scoped plugin state via `ctx.state` (`scopeKind: "company"`).
- Org-level operator config via manifest `instanceConfigSchema`, resolved
  per-company by `ctx.config.get(companyId)`. `definePlugin` must set
  `multiCompanyConfig: true` so per-company config works on multi-company
  instances.
- `ctx.data` handlers receive **no actor context** — they cannot be
  actor-gated. All admin reads/mutations therefore go through manifest
  `apiRoutes` (`auth: "board"`, which supplies the authenticated
  `actor.userId`); the UI uses `fetch` against those routes rather than
  `usePluginData`.
- Event payloads are thin (`PluginEvent.payload` is `unknown`) — the worker
  needs entity read capabilities to format useful messages and build
  `PAP-123`-style refs (company `issuePrefix` via `companies.read`).
- `ctx.secrets.resolve` requires the object binding shape
  `{ type: "secret_ref", secretId }` — config stores plain secret-id strings
  (`accessTokenSecretId`, `passwordSecretId`) and the worker wraps them.
- `onHealth` / `onValidateConfig` are not company-scoped — they do
  config-shape checks only, no `ctx.config`/`ctx.state` calls.
- Worker `instanceInfo` exposes only `instanceId` + `hostVersion`:
  deployment mode and the host's public URL are **not** visible to the
  worker. The admin UI (same-origin JS) reads `window.location` to suggest
  defaults instead.

## Approaches considered

**A. Admin-defined channels + member↔channel subscriptions (chosen).**
Admin creates channels (topic + fixed category set + defaults), then
grants channels to members. Per-member control is exact because a topic
only ever carries its channel's categories. Matches the user's decision
that admins own topics and share them to specific people.

**B. Channels + per-member category matrix.** Rejected: if two members
share a channel with different category sets, the union is published to
one topic and both hear everything — silently leaks restricted alerts.

**C. Auto-generated per-member topics.** Less admin work but spreads
secret/topic management across members; rejected per user direction.

**D. Single org topic.** Cannot enforce per-user restrictions. Rejected.

## How it gets built

- Language/runtime: TypeScript on Bun (project already scaffolded;
  `@paperclipai/plugin-sdk` installed).
- Build: `bun build` producing `dist/worker.js` (worker) and `dist/ui/`
  (UI bundle).
- Manifest (`src/manifest.ts`):
  - `id`: `paperclip.ntfy`, `apiVersion: 1`, `categories: ["connector"]`.
  - `entrypoints`: `{ worker: "dist/worker.js", ui: "dist/ui" }`.
  - `capabilities`: `events.subscribe`, `http.outbound`,
    `plugin.state.read`, `plugin.state.write`, `access.members.read`,
    `secrets.read-ref`, `activity.log.write`, `api.routes.register`,
    `ui.page.register`, `companies.read`, `issues.read`, `agents.read`,
    `projects.read`, `goals.read`.
  - `instanceConfigSchema` (JSON Schema):
    - `baseUrl` (string, default `https://ntfy.sh`)
    - `appBaseUrl` (string — Paperclip public URL for `Click` links)
    - `authMode` (`"none" | "token" | "basic"`, default `"none"`)
    - `accessTokenSecretId` (string — Paperclip secret id, `authMode=token`)
    - `username` (string), `passwordSecretId` (string) — `authMode=basic`
    - `defaultPriority` (1–5, default 3), `defaultTags` (string)
  - `apiRoutes` (all `auth: "board"`, `capability: "api.routes.register"`;
    worker verifies owner/admin before answering):
    - `GET /admin/state` → channels, subscriptions, members (for matrix UI)
    - `PUT /admin/channels/:id`, `DELETE /admin/channels/:id`
    - `PUT /admin/subscriptions` → set a member's granted channels
    - `POST /admin/test` → send test notification to a channel
    - `GET /admin/server-status` → ntfy health probe + container-runtime
      probe results
    - `POST /admin/server-setup` → `{ op: "start-container" | "compose-up",
      runtime: "docker" | "podman" }`
  - `ui.slots`: `page` slot `notifications-admin`, `exportName`
    `NotificationsAdminPage`.
- Worker (`src/worker.ts`): `definePlugin` + `runWorker`,
  `multiCompanyConfig: true`.
  - **Event categories** (v1): `issues` (issue.created, issue.updated,
    issue.comment.created), `approvals` (approval.created,
    approval.decided), `agents` (agent.run.started, agent.run.finished,
    agent.run.failed, agent.status_changed), `budget`
    (budget.incident.opened, budget.incident.resolved), `goals`
    (goal.created, goal.updated), `projects` (project.created,
    project.updated).
  - On each event: map to category → load company channels → publish once
    per channel whose `categories` include it → `POST {baseUrl}/{topic}`
    with `Authorization`, `Title`, `Priority`, `Tags`, `Click` headers;
    body = formatted summary (actor, entity ref like `PAP-123`, what
    changed — fetched via the declared read capabilities).
  - Publish via `ctx.http.fetch` (host-traced/audited). Failures logged
    via `ctx.logger` + `ctx.activity`; best-effort, no retry queue in v1.
  - Admin gate helper: resolve `actor.userId` → `ctx.access.members.list`
    → active member with `membershipRole ∈ {owner, admin}`, else 403.
  - **Server status** (`GET /admin/server-status`):
    1. `GET {baseUrl}/v1/health` → `up` / `auth-required` / `unreachable`.
    2. If unreachable: probe for runtimes — `command -v docker` and
       `command -v podman` → `runtimes: ["docker", "podman"]` (either or
       both). For each found runtime, `<runtime> ps -a --filter name=ntfy`
       → `container-stopped` (with container id + which runtime) or
       `none`. If a runtime exists but has no compose support
       (`<runtime> compose version` fails; also try `podman-compose` /
       `docker-compose` binaries), report it so the UI can still offer
       "start stopped container" but hide compose-up. No runtime at all →
       `no-runtime` → manual install instructions. All shell probes
       wrapped in try/catch with timeouts; failure → manual guidance.
  - **Server setup** (`POST /admin/server-setup`, owner/admin only;
    `runtime` param required when both are present):
    - `start-container`: `<runtime> start <containerId>` then re-probe.
    - `compose-up`: write a generated `docker-compose.yml`
      (`binwiederhier/ntfy` image, `serve`, published port e.g. `2580:80`,
      sensible default `server.yml` with cache + optional auth) into a
      plugin-managed directory, run compose (`<runtime> compose up -d`,
      falling back to `podman-compose`/`docker-compose` binaries), then
      re-probe and return the suggested `baseUrl` (`http://<host>:2580`)
      for the admin to confirm. Podman note: rootless Podman is fine —
      the published port is still reachable on the host.
  - State (company scope): `channels` → `NtfyChannel[]`,
    `subscriptions` → `{ principalId, principalType, channelId }[]`.
  - `onHealth`: reports setup() ran + last publish outcome kept in-process.
    `onValidateConfig`: schema/shape checks only (valid URL, auth fields
    consistent with authMode).
- UI (`src/ui/`): `NotificationsAdminPage` —
  - **Setup section**: on load, suggests `baseUrl` from
    `window.location` (localhost/`*.local` → `https://ntfy.sh`; FQDN →
    `https://{hostname}` — admin adjusts port/subdomain) and `appBaseUrl`
    from `window.location.origin`. Shows server-status probe result with
    the appropriate action button or manual instructions.
  - **Channels**: list/create/edit/delete with per-channel category
    checkboxes, priority, tags, "Send test" button.
  - **Subscriptions**: per channel, grant checkboxes over company members
    (names resolved via the host's own board HTTP APIs from the UI;
    agents included since `members.list` returns both principal types).
  - All data flows through the `apiRoutes` above (fetch + board session);
    non-admins get 403 and the page shows an "admin only" notice.

## Left to the builder

- Exact notification copy/message format per event type.
- UI styling details (plain React + minimal CSS).
- Compose-file specifics (volume paths, whether to enable ntfy auth in the
  generated config — default: none behind admin's own firewall, with a
  warning to secure it).
- Whether to batch/dedupe bursts (v1 publishes every event directly).
- File layout inside `src/` beyond the named entrypoints.
