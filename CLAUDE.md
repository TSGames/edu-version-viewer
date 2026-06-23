# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Workflow

- **Work directly on `main`.** Commit and push changes straight to `main`;
  do not create feature branches or pull requests unless explicitly asked.

## Project overview

`edu-version-viewer` is a dependency-free Node.js app that polls edu-sharing
`_about` endpoints on a cron schedule and shows version, last sync,
services/modules, features and plugins. Node built-ins only — no runtime
dependencies, no build step.

- `src/server.js` — HTTP server: static frontend + small JSON API, HTTP Basic
  auth (admin/viewer roles via env).
- `src/fetcher.js` — fetches and summarizes `_about` responses.
- `src/store.js` — JSON config persistence in `DATA_DIR` (default `/data`).
- `src/cron.js` — minimal cron scheduler (`CRON_SCHEDULE`).
- `src/url.js` — normalizes input into an `_about` URL.
- `src/auth.js` — resolves an Authorization header to a role.
- `public/` — vanilla frontend (`index.html`, `app.js`, `style.css`).

## Commands

- Start: `npm start` (env: `PORT`, `ADMIN_PASSWORD`, `VIEWER_PASSWORD`,
  `DATA_DIR`, `CRON_SCHEDULE`).
- Test: `npm test` (`node --test`).
