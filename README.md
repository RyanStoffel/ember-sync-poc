# ember-sync-poc

Proof of concept for the live GitHub-to-Jira synchronization named in the Ember
requirements (section 3.4, and the project management view in the launch floor
in section 4.1). It validates the claim in section 5 that both systems can be
reliably observed and acted on programmatically, in both directions, without
the two of them rewriting each other in a loop, and it does so across any
number of independent workspaces: each workspace pairs one GitHub repository
with one Jira project and syncs on its own poll loop and history.

Access is OAuth-only. There is no API-token or local `gh` login fallback: the
application will not expose any workspace or start syncing until both GitHub
and Jira have been connected through the real OAuth flow. Both providers are
connected once, at the account level, and every workspace shares that
connection.

## Run locally

```
npm install
npm run dev       # dashboard on http://localhost:4000, ts run via tsx
npm test          # invariant tests
npm run typecheck
npm run build      # production build to dist/
npm start          # runs the compiled build (node dist/main.js)
```

Open http://localhost:4000. You will land on a sign-in screen until both
GitHub and Jira are connected. Once connected, every row in the dashboard acts
on the real system behind it. Edits made anywhere else (the GitHub web UI,
`gh issue edit`, `curl` against the Jira API) show up the same way, because the
dashboard is only a viewer, never a shortcut into the engine.

Without `JIRA_USE_SIMULATOR=false`, Jira runs as a local stand-in
(`src/jira-sim/`) that speaks the real Jira Cloud REST v3 request and response
shapes and fires the real webhook payloads, so the whole engine runs unchanged
against a live Atlassian site once that flag is off.

## OAuth setup

Ember needs one GitHub OAuth App and one Atlassian OAuth 2.0 (3LO)
integration, each pointed at the public host Ember runs on.

### GitHub

Create an OAuth App under **GitHub Settings -> Developer settings -> OAuth
Apps**. Set the callback URL to:

```text
https://YOUR_HOST/auth/github/callback
```

### Atlassian

Create an OAuth 2.0 (3LO) integration in the
[Atlassian developer console](https://developer.atlassian.com/console/myapps/)
with **resource-level** access. Add the Jira platform API with the classic
scopes `read:jira-user`, `read:jira-work`, `write:jira-work`, and
`manage:jira-webhook`. The last one is what lets Ember register its own Jira
webhook over the OAuth connection instead of requiring a manual step in Jira
Settings. Under **Authorization**, set the callback URL to:

```text
https://YOUR_HOST/auth/atlassian/callback
```

The requested scopes also include `offline_access`, which is what lets a
session survive a restart via a refresh token.

Added `manage:jira-webhook` to an app that was already connected? Existing
sessions carry the old scope set; disconnect and reconnect Jira from the
Setup page so the new authorization actually includes it.

### Environment

```bash
export OAUTH_BASE_URL=https://YOUR_HOST
export GITHUB_OAUTH_CLIENT_ID='github-client-id'
export GITHUB_OAUTH_CLIENT_SECRET='github-client-secret'
export ATLASSIAN_OAUTH_CLIENT_ID='atlassian-client-id'
export ATLASSIAN_OAUTH_CLIENT_SECRET='atlassian-client-secret'

# Required: encrypts the on-disk OAuth token store.
export SESSION_SECRET="$(openssl rand -hex 32)"

# Optional: only if pointing at real Jira Cloud instead of the local stand-in.
export JIRA_USE_SIMULATOR=false
export JIRA_BASE_URL=https://your-site.atlassian.net

# Recommended once Jira Cloud is wired up: see "Jira webhook" below.
export JIRA_WEBHOOK_SECRET="$(openssl rand -hex 20)"
```

GitHub repositories and Jira projects are chosen per workspace, from the
Setup page inside the app, never from environment variables. `JIRA_BASE_URL`
only tells Ember which Atlassian site to talk to; it is shared by every
workspace, since one Jira Cloud site can host many projects.

### Jira webhook

Ember registers its own Jira webhook automatically, per workspace, the
moment a workspace's Jira project connects — there is no Jira Settings page
to visit. It uses Jira Cloud's dynamic webhook REST API
(`POST /rest/api/3/webhook`), scoped by JQL to that one project
(`project = KEY`), authenticated with the same OAuth token used for
everything else. This is a different mechanism from the classic
**Jira Settings -> System -> Webhooks** admin page; a dynamic webhook never
appears there.

Subscribed events: Issue created, Issue updated, Comment created. Dynamic
webhooks expire after 30 days, so a maintenance loop re-extends every
workspace's webhook once a day; if Jira drops one outright (revoked consent,
repeated delivery failures), the same loop notices on its next pass and
re-registers it. The webhook URL still carries the same shared-secret query
parameter as before:

```text
https://YOUR_HOST/webhooks/jira?token=YOUR_JIRA_WEBHOOK_SECRET
```

because Jira does not sign dynamic webhook deliveries any more than it signs
classic ones. Without `JIRA_WEBHOOK_SECRET` set, the endpoint accepts
unsigned requests and Ember logs a warning at boot.

GitHub stays polling-based even in production (5 second interval by default);
it never needed a public callback for events, so there is nothing to
register there beyond the OAuth App above.

## Deploy to Fly.io

```
Dockerfile           multi-stage build: tsc build, then node:22-alpine runtime
fly.toml             app config: single always-on machine, /data volume mount
tsconfig.build.json  compiles src/ to dist/, mirroring the directory structure
```

```bash
flyctl auth login
flyctl apps create YOUR_APP_NAME
flyctl volumes create ember_data --app YOUR_APP_NAME --region YOUR_REGION --size 1

flyctl secrets set --app YOUR_APP_NAME \
  OAUTH_BASE_URL=https://YOUR_APP_NAME.fly.dev \
  GITHUB_OAUTH_CLIENT_ID=... GITHUB_OAUTH_CLIENT_SECRET=... \
  ATLASSIAN_OAUTH_CLIENT_ID=... ATLASSIAN_OAUTH_CLIENT_SECRET=... \
  SESSION_SECRET=$(openssl rand -hex 32) \
  JIRA_WEBHOOK_SECRET=$(openssl rand -hex 20) \
  JIRA_USE_SIMULATOR=false JIRA_BASE_URL=https://your-site.atlassian.net

flyctl deploy --app YOUR_APP_NAME
```

`fly.toml` mounts a persistent volume at `/data` and sets `EMBER_DATA_DIR=/data`,
so the encrypted OAuth token store, the GitHub-Jira link registry, and the
saved workspace settings all survive a redeploy or a machine restart.
`min_machines_running = 1` and `auto_stop_machines = false` keep the GitHub
poll loop running continuously rather than scaling to zero between requests.
`GET /health` is an unauthenticated liveness check for Fly's own monitoring.

## Security model

This is a single-tenant proof of concept, not a multi-user product, and the
security posture is scoped to that:

- **OAuth tokens are encrypted at rest** (AES-256-GCM, key derived from
  `SESSION_SECRET`) in `tokens.ts`, never written in plaintext, never sent to
  the browser. `hydrateSessionsFromDisk()` restores both sessions on boot, and
  a maintenance loop refreshes tokens proactively before they expire.
- **The Jira webhook requires a shared secret** in its query string, since
  Jira's classic webhook UI does not sign requests.
- **State-mutating routes require a session cookie** minted on first page
  load (`ensureSessionCookie`), in addition to both providers being
  connected. This stops a stranger who only knows the URL from pausing sync,
  changing settings, or triggering GitHub/Jira writes, without implementing
  full multi-user accounts, which is out of scope for a proof of concept.
- **OAuth state is single-use and time-boxed** (10 minutes) to prevent replay
  across the authorization redirect.

What this does not do: rate limiting, IP allow-listing, or Jira webhook
payload signature verification beyond the shared-secret query parameter
(Jira Cloud's classic webhook delivery does not offer HMAC signing the way
GitHub's webhook delivery does).

## Branch workflow

Jira-origin tickets automatically create a GitHub issue and a branch from the
repository default branch:

```text
feature/ESP-123-add-login
```

The branch is then polled every five seconds:

| GitHub activity | Jira transition |
| --- | --- |
| First new commit on the branch | In Progress |
| Pull request opened | In Review |
| Pull request merged | Done |
| Pull request closed without merging | No Done transition |

The implementation records the branch head and observed pull request number in
the link registry, so restarting Ember does not replay the same transition.
GitHub issue control labels mirror the intermediate statuses: `in-progress`
and `in-review`. Jira must have an `In Review` status and an available
transition to it.

## Workspaces and the Setup page

A workspace is one GitHub repository paired with one Jira project. The
dashboard's rail lists every workspace and switches the whole view — board,
activity, connected pairs, event stream — to whichever one is selected.
Creating another workspace never repeats OAuth: both providers are connected
once, at the account level, and every workspace reuses that connection.

The Setup view covers both layers:

1. Connected accounts (once, account-wide): GitHub and Jira, each with a real
   OAuth redirect, showing the connected account's real name and avatar.
2. This workspace: its name, GitHub repository and Jira project (both
   autocompleted from what the connected accounts can see), and its
   board-column labels. Changing the repository or project rebuilds this
   workspace's association registry rather than mixing links from two
   different projects. A workspace can also be deleted, which stops its
   poll loop and drops its history.

Each workspace persists to its own directory,
`data/workspaces/<id>/links.json`; the workspace list itself lives in
`data/workspaces.json`. OAuth tokens persist once, account-wide, to
`data/oauth-tokens.enc` (encrypted). All of it lives under `EMBER_DATA_DIR`,
which is a Fly volume in production.

## Shape

```
src/
  main.ts              boot order: hydrate sessions, dashboard, Jira sim, every workspace's engine
  server.ts             dashboard routes, SSE event stream, OAuth + webhook receivers
  oauth.ts              OAuth flows, session cookies, token refresh loop
  tokens.ts              encrypted token storage, provider token refresh calls
  workspaces.ts          workspace CRUD, persisted to data/workspaces.json
  config.ts              account-wide settings: OAuth, ports, the Jira site URL
  adf.ts                 Atlassian Document Format <-> plain text
  events.ts              append-only decision log type, fanned out over SSE
  github/client.ts       GitHub REST, ETag conditional polling, parameterized by repo
  jira/client.ts         Jira Cloud REST v3 (Basic auth or OAuth bearer), parameterized by project
  jira-sim/               local Jira: REST v3 subset, transitions, webhooks, scoped by project
  sync/
    manager.ts            owns one SyncEngine per workspace; routes Jira webhooks by project key
    engine.ts             bidirectional propagation, reconcile, conflicts, for one workspace
    mapping.ts            field and state mapping
    links.ts              GitHub <-> Jira link registry plus last-known snapshots, one per workspace
    echo.ts                content fingerprints for our own GitHub writes
web/
  login.html              OAuth-only sign-in screen
  index.html               the project management view, workspace switcher included
```

## Findings

These are the parts that were not obvious before building it.

**The two state models do not line up, and the gap has to be encoded
somewhere.** GitHub issues have two states, Jira has four statuses (To Do, In
Progress, In Review, Done). Mapping `In Progress` onto `open` loses
information, and the next poll reads it back as `To Do`, so the ticket
oscillates. The fix is control labels on the GitHub side (`in-progress`,
`in-review`) which make the round trip lossless. Label comparison then has to
deliberately ignore those labels, or a status change looks like a label edit
and bounces back. `test/sync.test.ts` pins both invariants.

**Loop prevention needs two different mechanisms, because the two APIs expose
different facts.** Jira webhooks name the authenticated principal, so the
engine writes as a service account and drops any event authored by it. That
check is exact. GitHub gives no actor for a poll-observed field change, so a
write the engine made is indistinguishable from a human edit. There the guard
is the link snapshot, refreshed from the PATCH response so a later poll sees no
diff, plus expiring content fingerprints covering the case where a poll was
already in flight when the write landed.

**GitHub cannot push to a local process, and polling it is nearly free, but
only if the ETag cache is keyed correctly.** GitHub does not charge a 304
against the rate limit. Keying the cache by endpoint rather than full request
path (which changes every poll because of the moving `since` parameter) is
what makes idle polling actually free.

**`since` at the Unix epoch returns nothing.** GitHub's issue list answers a
`since` value at or near the epoch with an empty array rather than everything,
so full sweeps have to omit the parameter entirely.

**Jira takes documents, not strings.** Descriptions and comment bodies in REST
v3 are Atlassian Document Format, so every text field crossing the boundary
needs conversion in both directions (`adf.ts`).

**Mirrored comments need an origin marker in the body.** GitHub issue comments
carry no metadata channel, so origin cannot be recovered from the author. The
marker is what stops comments ping-ponging.

**Missed events have to be recoverable, and conflicts need a stated winner.**
Pausing the engine and editing both sides is the same situation as a webhook
delivery lost while the service was down. Resuming runs a full reconcile that
diffs both sides against the stored snapshots. When both changed, GitHub wins,
because it is the side holding the code.

**OAuth tokens expire on different schedules per provider.** GitHub access
tokens last about 8 hours when the app has expiring tokens enabled; Atlassian
access tokens last about 1 hour and rotate the refresh token on every use. A
proactive refresh loop (checked every 4 minutes, refreshed inside a 10 minute
margin) keeps both sessions alive indefinitely without the user ever noticing
a token nearing expiry.
