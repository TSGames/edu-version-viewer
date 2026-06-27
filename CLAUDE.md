# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Workflow

- **Work directly on `main`.** Commit and push changes straight to `main`;
  do not create feature branches or pull requests unless explicitly asked.
  This applies even if a session is configured with a different working
  branch — develop and push on `main` unless the user says otherwise.

## Project overview

`edu-version-viewer` is a small, **dependency-free** Node.js app (Node ≥ 20,
ESM, built-ins only — no runtime deps, no build step). It polls edu-sharing
`_about` endpoints on a cron schedule and shows, per endpoint: version, last
sync, status, services/modules, features and plugins. The full raw `_about`
response is stored so nothing is lost.

The whole UI sits behind HTTP Basic auth with two roles: **admin**
(read + write) and **viewer** (read-only).

## Layout

Backend (`src/`):
- `server.js` — HTTP server: serves the static frontend and a JSON API under
  `/api/*`. Enforces roles, handles add/delete/refresh of endpoints.
- `fetcher.js` — fetches an `_about` URL (http/https, redirects, timeout) and
  `summarize()`s it into `version`, `renderservice`, `rs2`, `services`,
  `features`, `plugins`, `raw`.
- `store.js` — persistence in `DATA_DIR` (default `/data`), atomic writes via
  temp file + rename. Split into durable config and volatile fetch data:
  `config.json` holds only `{ id, label, url, addedAt, notes, pwLink }` per
  endpoint; each endpoint's latest fetch result (incl. the large `raw` blob)
  lives in `fetches/<id>.json`. `ensureConfig()` migrates a legacy single-file
  `config.json` into this layout and prunes orphaned fetch files. Merged views
  via `loadMerged()` / `loadMergedOne()`.
- `cron.js` — minimal 5-field cron parser + scheduler (`parseCron`,
  `matches`, `scheduleCron`). Evaluates once per minute.
- `url.js` — `normalizeAboutUrl()` turns pasted input into an
  `/edu-sharing/rest/_about` URL; `deriveLabel()` for a default label.
- `auth.js` — HTTP Basic parsing + constant-time role resolver.

Frontend (`public/`, vanilla JS, no framework/build):
- `index.html` — header, admin panel (add/refresh, admins only), sort toolbar,
  card grid.
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
- The periodic refresh re-renders all cards but preserves which `<details>`
  the user had open (keyed by endpoint id + summary label; cards carry a
  `data-id`).
- UI text is German.

## Commands

- Start: `npm start`
  - Env: `PORT` (default 3000), `ADMIN_USER`/`ADMIN_PASSWORD`,
    `VIEWER_USER`/`VIEWER_PASSWORD`, `DATA_DIR` (default `/data`),
    `CRON_SCHEDULE` (default `*/15 * * * *`), `REQUEST_TIMEOUT_MS`,
    `FAIL_THRESHOLD`, `IP_RANGES_FILE` (default `<DATA_DIR>/ip-ranges.conf`).
    An account with an empty password is disabled.
- Test: `npm test` (`node --test`).
