# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Workflow

- **Work directly on `main`.** Commit and push changes straight to `main`;
  do not create feature branches or pull requests unless explicitly asked.
  This applies even if a session is configured with a different working
  branch — develop and push on `main` unless the user says otherwise.

## Project overview

`edu-version-viewer` is a small Node.js app (Node ≥ 20, ESM). The **frontend**
is intentionally dependency-free (vanilla JS, no framework, no build step); the
**backend** may use npm dependencies. It polls edu-sharing
`_about` endpoints on a cron schedule and shows, per endpoint: version, last
sync, status, services/modules, features and plugins. The full raw `_about`
response is stored so nothing is lost.

Access has two roles: **admin** (read + write) and **viewer** (read-only).
The browser UI logs in once via a form (`POST /api/login`) and then rides a
**server-side session** (`@fastify/session`, in-memory store; the `evv_session`
cookie holds only the opaque session id, data lives server-side) instead of
re-sending credentials on every request. `POST /api/logout` truly invalidates the
session. The static shell (HTML/JS/CSS, no data) is public so the login form can
load; all data lives behind `/api/*`. API clients / CI may still authenticate
with **HTTP Basic** on each request (`roleForRequest` accepts a live session or a
Basic header). Sessions are in-memory, so a restart logs everyone out.

## Layout

Backend (`src/`):
- `app.js` — `buildApp()` Fastify factory: registers `@fastify/cookie` +
  `@fastify/session` + `@fastify/static`, the role-based `requireRole(min)`
  preHandler and `roleForRequest` (session or Basic), and all `/api/*` routes.
  Exported (no listen) so tests drive it via `app.inject()`.
- `server.js` — entry point: builds the app, runs startup side-effects
  (`ensureConfig`, cron schedule, initial refresh) and `app.listen()`.
- `fetcher.js` — fetches an `_about` URL (http/https, redirects, timeout) and
  `summarize()`s it into `version`, `renderservice`, `rs2`, `services`,
  `features`, `plugins`, `raw`.
- `store.js` — persistence in `DATA_DIR` (default `/data`), atomic writes via
  temp file + rename. Split into durable config and volatile fetch data:
  `config.json` holds only the durable fields (`id, label, publicName, url,
  addedAt, notes, pwLink, repoType, hosting, showInApp, showInBrowserPlugin`) per
  endpoint; each endpoint's latest fetch result (incl. the large `raw` blob)
  lives in `fetches/<id>.json`. `ensureConfig()` migrates a legacy single-file
  `config.json` into this layout and prunes orphaned fetch files. Merged views
  via `loadMerged()` / `loadMergedOne()`. Before every content-changing
  `saveConfig()` the previous `config.json` is copied to
  `backups/config-<iso>-<nnn>.json`; only the newest 10 are kept (no-op
  rewrites, e.g. at startup, don't create a backup).
- `cron.js` — minimal 5-field cron parser + scheduler (`parseCron`,
  `matches`, `scheduleCron`). Evaluates once per minute.
- `url.js` — `normalizeAboutUrl()` turns pasted input into an
  `/edu-sharing/rest/_about` URL; `deriveLabel()` for a default label.
- `audits.js` — patch-audit rounds ("Patch-Runden"): validation, sync against
  current endpoints, manual entry status, close/reopen, CSV export. Per-round
  in-process lock (cron sync vs. admin edits).
- `version.js` — numeric version compare (`versionKey`, `isAtLeast`) and
  `minorOf()` (base version `N.M`).
- `auth.js` — HTTP Basic parsing + constant-time role resolver
  (`makeAuthenticator`/`roleFor`). Sessions are handled by `@fastify/session`.

Frontend (`public/`, vanilla JS, no framework/build):
- `index.html` — header, admin panel (add/refresh, admins only), sort toolbar,
  card grid.
- `audits.js` — Patch-Runden UI (loaded before `app.js`, shares its globals at
  call time): hash routing (`#audits`, `#audits/new`, `#audits/<id>`,
  `#audits/<id>/edit`), overview, form, detail table, two-step close dialog,
  instance badges and the round filter in the toolbar.
- `app.js` — fetches `/api/*`, renders cards, admin actions; sorting and
  open-section persistence across the 30s auto-refresh.
- `style.css` — light theme; all colors are CSS variables in `:root`.

Other: `Dockerfile`, `docker-compose*.yml`, `.github/workflows/ci.yml`
(tests + image build), tests in `test/` (`node --test`).

## Behavior notes / conventions

- **Status resilience**: a single failed fetch does not flip a card to
  `error`. Each endpoint has a `failCount`; it only becomes `error` after
  **more than** `FAIL_THRESHOLD` (default 2) consecutive failures, and resets
  on success. Latest error kept in `lastError`.
- **Sorting**: cards can be sorted by Label, URL, Status, or Version. Version
  sorts numerically (`10.0` after `9.0`); unknown versions last; status groups
  problems first.
- **Filtering**: a version dropdown (built from the versions present: `N.x`
  per major, `N.M.x` per minor when a major has several, plus `unbekannt`;
  persisted in `localStorage`) narrows the list. The live search matches
  label, URL, version and connected repo titles; a query like `>=10.0`,
  `<9.1`, `=10`, `!=9` compares versions numerically (unknown never matches).
  A repo-type select (Dev/Staging/Prod) and an "Extern ausblenden" checkbox
  (hides `hosting === 'external'`) narrow further; both persisted in
  `localStorage`.
  Below the grid a client-side **CSV export** (semicolon, BOM, formula-injection
  safe) downloads exactly the currently filtered + sorted instances.
- **RS2 pill**: when `renderingService2 != null` in the response, a green
  `RS2` pill is shown in the card badges.
- **features/plugins** chips render only the object `id`, not the raw JSON.
- **Per-endpoint metadata**: admins can edit each card (`PATCH /api/endpoints/:id`)
  to set a free-text `notes` (textarea), a `pwLink` (e.g. a password-manager
  URL, opened `target="_blank"`), a `repoType` (`dev`/`staging`/`prod`) and a
  `hosting` (`cluster`/`docker`/`external`). `pwLink` is normalized to http(s)
  and `repoType`/`hosting` are validated against an allow-list (invalid → 400,
  empty clears). All shown as badges. The card title links to
  `<origin>/edu-sharing`.
- **Public instance list**: each endpoint has two opt-in flags `showInApp` /
  `showInBrowserPlugin` (booleans, **default `false`**, validated → 400) and an
  optional `publicName`. `GET /api/public/instances?target=app|browserPlugin`
  is **unauthenticated** (CORS `*`, `Cache-Control: max-age=300`) and returns
  only `{ name, url, version }` for flagged endpoints: `name` = `publicName`,
  falling back to `label`; `url` = portal URL (`portalUrl()` in `url.js`);
  `version` may be `null`. Optional `minVersion` (e.g. `11.0` → `>= 11.0`,
  numeric compare via `src/version.js`, unknown versions excluded, invalid →
  400). Missing/invalid `target` → 400. Never expose other
  fields there.
- **Connected repositories**: on each successful `_about` fetch a best-effort
  secondary call to `<base>/edu-sharing/rest/network/v1/repositories`
  (`repositoriesUrl()` in `url.js`) lists the connected repositories. The home
  repo (`isHomeRepo`) is dropped; only `repositoryType` + `title` are kept
  (stored as the `repositories` fetch field, shown as chips on cards and a
  count badge in the list). This endpoint is **not always accessible** (can
  return 401/403); any failure is tolerated, never flips the status, and keeps
  the previous list.
- **Automatic network tags**: on each fetch the endpoint's host is resolved to
  an IPv4 (`dns.lookup`) and matched against `src/ipranges.js` ranges loaded
  from `IP_RANGES_FILE` (default `<DATA_DIR>/ip-ranges.conf`). Each match adds a
  tag; the resolved IP (`resolvedIp`) and `networkTags` are stored as volatile
  fetch fields and rendered as 🌐 badges. Range format is `<range>: <tag>` with
  `<range>` a CIDR (`134.76.0.0/16`) or octet prefix (`134.76` = /16). See
  `ip-ranges.example.conf`. Resolution failures degrade gracefully (no tag).
- **Patch-Runden (security-patch audits)** — **admin only** (viewers get 403,
  no tab/badges). `_about` reports no patch level, so a round is defined by
  manually selected affected **base versions** (`N.M`, plus `unknown`) and an
  optional `repoTypes` scope. Further optional scope filters (`inScope()` in
  `src/audits.js`, mirrored by `clientInScope()` in `public/audits.js` for the
  form's live count): `excludeHosting` (`cluster`/`docker`/`external`/`unset`),
  `includeTags`/`excludeTags` (network tags), `components` (`rs2`,
  `renderservice`, `feature:<id>`, `plugin:<id>`; any must match),
  `minVersion`/`fixedVersion` (full-version range, only applied when the
  reported version is at least as precise), `includeIds`/`excludeIds` (manual,
  exclude wins). Filters only exclude on **known** data: unset hosting,
  unresolved host, never-fetched `_about` (`fetched: false` in the list view)
  or an imprecise version keep the instance in scope. An `open` entry that
  falls out of scope becomes `not-affected` (by `system`, with the reason) and
  returns to `open` when back in scope; manually set states are never touched.
  The scope is shown on the detail page and as an `Umfang` CSV column. The
  detail table has client-only view filters (search, status, type, hosting,
  edited by me / never edited manually, hide removed). Plus free-text `notes` ("Vermerke", e.g. new
  minimum version, git commit/MR links; URLs rendered clickable, editable
  inline on the detail page while open); each affected instance's status is set
  **manually**: `open` / `patched` / `accepted` / `not-affected`, with comment,
  actor and timestamp (per-entry `log`). Stored one file per round as
  `audits/<uuid>.json` (id = `crypto.randomUUID()`); every change backs up the
  previous file to `backups/audit-<uuid>-<iso>-<nnn>.json` (newest 10 per
  round). Automatic bookkeeping only, on read and after each refresh/cron:
  newly affected instances are added as `open`; an `open` instance that moves
  to a non-affected base version becomes `not-affected` (by `system`); deleted
  endpoints keep their snapshot flagged `removed`. Never auto-`patched`.
  `dueDate` is optional and never closes a round (overdue only shown). Closing
  needs a two-step confirmation (UI) and `confirmTitle` == title (API); closed
  rounds are read-only and frozen (open entries flagged `openAtClose`).
  Reopening needs no confirmation. Routes: `GET/POST /api/audits`,
  `GET/PATCH /api/audits/:id`, `PATCH /api/audits/:id/entries/:endpointId`,
  `POST /api/audits/:id/close|reopen`, `GET /api/audits/:id/export.csv`
  (semicolon CSV with BOM, formula-injection safe).
- The periodic refresh re-renders all cards but preserves which `<details>`
  the user had open (keyed by endpoint id + summary label; cards carry a
  `data-id`).
- UI text is German.

## Commands

- Start: `npm start`
  - Env: `PORT` (default 3000), `ADMIN_USER`/`ADMIN_PASSWORD`,
    `VIEWER_USER`/`VIEWER_PASSWORD`, `DATA_DIR` (default `/data`),
    `CRON_SCHEDULE` (default `*/15 * * * *`), `REQUEST_TIMEOUT_MS`,
    `FAIL_THRESHOLD`, `IP_RANGES_FILE` (default `<DATA_DIR>/ip-ranges.conf`),
    `SESSION_SECRET` (signs the session-id cookie, ≥32 chars; random per process
    if unset → restart logs everyone out), `SESSION_TTL_SECONDS` (default 3600).
    An account with an empty password is disabled.
- Test: `npm test` (`node --test`).
- **Auth guard test** (`test/api-auth.test.js`, own CI step before the full
  suite): `buildApp()` records every route (`app.registeredRoutes()`); every
  `/api` route must be listed in the test's `ACCESS` table as `public`,
  `viewer` or `admin` — an unlisted (or stale) route fails the build. For all
  non-public routes it checks missing/wrong/malformed credentials and forged or
  logged-out session cookies → 401 (never issuing a session), viewer on admin
  routes → 403 (Basic and session), and that valid roles pass. **When adding
  an `/api` route, add it to `ACCESS`.** The Docker smoke test in CI repeats the
  401/403 checks against the built container.
