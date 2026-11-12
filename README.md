# ntfy-paperclip-plugin

A [Paperclip](https://paperclip.ing) plugin that forwards company events to
[ntfy](https://ntfy.sh) topics — for teams who want push notifications through
ntfy instead of Telegram or Discord. Works against the public `ntfy.sh`
service or any self-hosted ntfy server (e.g. docker-compose).

## What it does

- Publishes Paperclip domain events to ntfy topics via HTTP `POST`.
- **Channels**: admin-named targets `{ name, topic, categories, priority, tags }`.
  A channel owns a fixed category set — a topic carries exactly the categories
  on its channel.
- **Subscriptions**: the org owner/admin grants channels to specific members
  (human users and agents). ntfy topics are broadcast, so share each topic
  name only with its granted members.
- Event categories: `issues`, `approvals`, `agents`, `budget`, `goals`,
  `projects`.
- Guided server setup: the admin page probes the ntfy server, probes the host
  for Docker/Podman, and can start a stopped ntfy container or bring one up
  with a generated compose file.
- "Send test" button per channel.
- `Click` links back into Paperclip when `appBaseUrl` is configured.

## Development

```bash
bun install
bun test        # unit + integration tests (test harness + fake ntfy server)
bun check       # typecheck
bun run build   # dist/worker.js, dist/manifest.js, dist/ui/
```

## Configuration

Set in the plugin's instance settings (per company):

| Field | Purpose |
|-------|---------|
| `baseUrl` | ntfy server base URL (default `https://ntfy.sh`) |
| `appBaseUrl` | Paperclip public URL — enables `Click` links |
| `authMode` | `none` \| `token` \| `basic` |
| `accessTokenSecretId` | Paperclip secret id holding an ntfy `tk_…` token |
| `username` / `passwordSecretId` | basic-auth user + secret id |
| `defaultPriority` | 1–5 (default 3) |
| `defaultTags` | comma-separated tags on every notification |

Create secrets in Paperclip's secret store first, then paste the secret id —
nothing sensitive is stored in plugin config or state.

The **ntfy Notifications** page (`/:company/ntfy`) is where owners/admins
manage channels, member grants, server status and setup.

## Publishing

GitHub Actions (`publish.yml`) runs on every GitHub Release:

- **npm** (`ntfy-paperclip-plugin`) — needs an `NPM_TOKEN` repo secret
  (automation token), or configure npm trusted publishing for this repo and
  drop the token.
- **JSR** — tokenless via GitHub OIDC. Requires the JSR scope in `jsr.json`
  (`@paperclip-community` by default) to exist and to allow publishing from
  this repo. Change `jsr.json`'s `name` to a scope you own.

## License

MIT
