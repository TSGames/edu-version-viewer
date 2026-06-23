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
- Admin user configured via environment variables (HTTP Basic auth).
- **Configurable cron** schedule that fetches every endpoint.
- Admins can add/remove endpoints; cards show version + last sync.
- **Simple URL recognition**: paste a hostname or a full URL — it is normalized
  to `…/edu-sharing/rest/_about` automatically.
- Captures **everything** from the endpoint (services, features, plugins, raw JSON).
- Storage in a mounted volume as a JSON config file.

## Quick start (local)

```bash
ADMIN_PASSWORD=secret DATA_DIR=./data node src/server.js
# open http://localhost:3000
```

Click **Admin**, log in (`admin` / your password), then add an endpoint, e.g.:

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

## Configuration (environment variables)

| Variable             | Default          | Purpose                                   |
| -------------------- | ---------------- | ----------------------------------------- |
| `PORT`               | `3000`           | HTTP port                                 |
| `DATA_DIR`           | `/data`          | Directory for `config.json` (volume)      |
| `ADMIN_USER`         | `admin`          | Admin username                            |
| `ADMIN_PASSWORD`     | _(none)_         | Admin password — **required** for admin actions |
| `CRON_SCHEDULE`      | `*/15 * * * *`   | When to poll endpoints (5-field cron)     |
| `REQUEST_TIMEOUT_MS` | `10000`          | Per-request fetch timeout                 |

If `ADMIN_PASSWORD` is unset, the app still runs and shows data, but all admin
(write) actions are disabled.

### Cron format

Standard 5-field cron: `minute hour day-of-month month day-of-week`.
Supports `*`, `a`, `a-b`, `a-b/n`, `*/n`, and comma lists. Examples:

- `*/15 * * * *` — every 15 minutes (default)
- `0 * * * *` — hourly
- `0 6 * * 1-5` — 06:00 on weekdays

## API

| Method   | Path                          | Auth  | Description                         |
| -------- | ----------------------------- | ----- | ---------------------------------- |
| `GET`    | `/api/endpoints`              | —     | List endpoints (summary)           |
| `GET`    | `/api/endpoints/:id`          | —     | Single endpoint incl. raw JSON     |
| `POST`   | `/api/endpoints`              | admin | Add `{ url, label? }`              |
| `DELETE` | `/api/endpoints/:id`          | admin | Remove an endpoint                 |
| `POST`   | `/api/endpoints/:id/refresh`  | admin | Refresh one endpoint now           |
| `POST`   | `/api/refresh`                | admin | Refresh all endpoints now          |
| `GET`    | `/api/me`                     | admin | Verify admin credentials           |
| `GET`    | `/api/health`                 | —     | Health check                       |

## Tests

```bash
node --test
```

Covers URL normalization, cron parsing/matching, and version/service extraction
(using the real `_about` response shape).

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
