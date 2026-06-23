# edu-sharing Version Viewer

A small, **dependency-free** Node.js app that periodically polls one or more
[edu-sharing](https://edu-sharing.com) `_about` endpoints and displays each
instance's **version**, **last sync time**, and active **services / modules**
(plus features/plugins when present). The full raw `_about` response is stored,
so nothing is lost.

State is persisted as a single `config.json` file inside a mounted volume, so it
survives container restarts.

## Features

- Pure Node.js — **no runtime dependencies** (built-in `http`/`https` only).
- Simple static frontend — no framework, no build step.
- **Login required** (HTTP Basic) with two roles configured via env:
  an **admin** (read + write) and an optional **viewer** (read-only).
- **Configurable cron** schedule that fetches every endpoint.
- Admins can add/remove endpoints; cards show version + last sync.
- **Simple URL recognition**: paste a hostname or a full URL — it is normalized
  to `…/edu-sharing/rest/_about` automatically.
- Captures **everything** from the endpoint (services, features, plugins, raw JSON).
- Storage in a mounted volume as a JSON config file.

## Roles & authentication

The whole UI and the read API are behind a login. Two accounts are configured
via environment variables (HTTP Basic auth):

| Role       | Env vars                          | Rights        |
| ---------- | --------------------------------- | ------------- |
| **admin**  | `ADMIN_USER` / `ADMIN_PASSWORD`   | read + write  |
| **viewer** | `VIEWER_USER` / `VIEWER_PASSWORD` | read-only     |

- The **viewer** account is optional: leave `VIEWER_PASSWORD` empty to disable it.
- The **admin** account can also read; set at least `ADMIN_PASSWORD` so someone can log in.
- The browser shows its native login dialog; the role determines whether the
  admin controls (add / delete / refresh) are visible.
- Only `GET /api/health` is public (for the Docker health check).

> To "log out" of HTTP Basic auth, close the browser — credentials cannot be
> reliably cleared by the page itself.

## Quick start (local)

```bash
ADMIN_PASSWORD=secret VIEWER_PASSWORD=look DATA_DIR=./data node src/server.js
# open http://localhost:3000
```

Log in as `admin` / your password (or `viewer` / its password for read-only),
then — as admin — add an endpoint, e.g.:

```
stable.demo.edu-sharing.net
```

It is normalized to
`https://stable.demo.edu-sharing.net/edu-sharing/rest/_about`, fetched
immediately, and the version + services are shown.

## Docker

```bash
docker build -t edu-version-viewer .
docker run -p 3000:3000 \
  -e ADMIN_PASSWORD=secret \
  -e CRON_SCHEDULE="*/15 * * * *" \
  -v "$(pwd)/data:/data" \
  edu-version-viewer
```

### docker-compose

```bash
cp .env.example .env   # set ADMIN_PASSWORD
docker compose up --build
```

The config file is persisted at `./data/config.json`.

## Container Image (GHCR)

CI veröffentlicht das Image automatisch in die **GitHub Container Registry**:

```
ghcr.io/tsgames/edu-version-viewer
```

Gepusht wird nur bei Push auf `main` (Tag `latest` + `sha-…`) und bei
Versions-Tags `v*` (z. B. `v1.2.0` → `1.2.0`, `1.2`). Es wird der eingebaute
`GITHUB_TOKEN` genutzt — keine zusätzlichen Secrets nötig.

Das veröffentlichte Image direkt nutzen (ohne lokalen Build) — siehe
[`docker-compose.example.yml`](./docker-compose.example.yml):

```bash
cp .env.example .env   # ADMIN_PASSWORD setzen
docker compose -f docker-compose.example.yml up -d
```

In Produktion das Image am besten auf eine konkrete Version pinnen statt `:latest`.

### Portainer (ohne .env)

Für Portainer-Stacks gibt es [`docker-compose.portainer.yml`](./docker-compose.portainer.yml):
eine self-contained Variante **ohne `.env`-Variablen** und mit einem von Portainer
verwalteten Named Volume. Inhalt in Portainer → **Stacks → Add stack → Web editor**
einfügen und die Werte (vor allem `ADMIN_PASSWORD`) direkt im Editor anpassen.

## Configuration (environment variables)

| Variable             | Default          | Purpose                                   |
| -------------------- | ---------------- | ----------------------------------------- |
| `PORT`               | `3000`           | HTTP port                                 |
| `DATA_DIR`           | `/data`          | Directory for `config.json` (volume)      |
| `ADMIN_USER`         | `admin`          | Admin username                            |
| `ADMIN_PASSWORD`     | _(none)_         | Admin password (read + write) — set this so someone can log in |
| `VIEWER_USER`        | `viewer`         | Read-only username                        |
| `VIEWER_PASSWORD`    | _(none)_         | Read-only password — leave empty to disable the viewer account |
| `CRON_SCHEDULE`      | `*/15 * * * *`   | When to poll endpoints (5-field cron)     |
| `REQUEST_TIMEOUT_MS` | `10000`          | Per-request fetch timeout                 |

If `ADMIN_PASSWORD` is unset, admin (write) actions are disabled. If **both**
`ADMIN_PASSWORD` and `VIEWER_PASSWORD` are unset, nobody can log in — set at
least one.

### Cron format

Standard 5-field cron: `minute hour day-of-month month day-of-week`.
Supports `*`, `a`, `a-b`, `a-b/n`, `*/n`, and comma lists. Examples:

- `*/15 * * * *` — every 15 minutes (default)
- `0 * * * *` — hourly
- `0 6 * * 1-5` — 06:00 on weekdays

## API

| Method   | Path                          | Auth   | Description                        |
| -------- | ----------------------------- | ------ | ---------------------------------- |
| `GET`    | `/api/endpoints`              | viewer | List endpoints (summary)           |
| `GET`    | `/api/endpoints/:id`          | viewer | Single endpoint incl. raw JSON     |
| `POST`   | `/api/endpoints`              | admin  | Add `{ url, label? }`             |
| `DELETE` | `/api/endpoints/:id`          | admin  | Remove an endpoint                 |
| `POST`   | `/api/endpoints/:id/refresh`  | admin  | Refresh one endpoint now           |
| `POST`   | `/api/refresh`                | admin  | Refresh all endpoints now          |
| `GET`    | `/api/me`                     | viewer | Current role: `{ role, user, canWrite }` |
| `GET`    | `/api/health`                 | —      | Health check (public)              |

"viewer" means viewer **or** admin.

## Tests

```bash
node --test
```

Covers URL normalization, cron parsing/matching, version/service extraction
(using the real `_about` response shape), and role-based auth resolution.

## Data model (`config.json`)

```json
{
  "endpoints": [
    {
      "id": "uuid",
      "label": "stable.demo.edu-sharing.net",
      "url": "https://stable.demo.edu-sharing.net/edu-sharing/rest/_about",
      "lastSync": "2026-06-23T15:40:00.000Z",
      "lastStatus": "ok",
      "error": null,
      "version": "9.0",
      "renderservice": "9.0",
      "services": ["MEDIACENTER", "CONFIG", "..."],
      "features": null,
      "plugins": null,
      "raw": { "...": "full _about response" }
    }
  ]
}
```
