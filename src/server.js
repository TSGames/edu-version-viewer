// HTTP server: serves the static frontend and a small JSON API.
// Zero external dependencies — Node built-ins only.
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  loadConfig,
  saveConfig,
  ensureConfig,
  getConfigPath,
  loadMerged,
  loadMergedOne,
  saveFetch,
  deleteFetch,
  defaultFetch,
} from './store.js';
import { fetchEndpoint, refreshAll, refreshOne } from './fetcher.js';
import { scheduleCron } from './cron.js';
import { normalizeAboutUrl, deriveLabel } from './url.js';
import { makeAuthenticator, parseCookies, signSession, verifySession } from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const PORT = Number(process.env.PORT || 3000);
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const VIEWER_USER = process.env.VIEWER_USER || 'viewer';
const VIEWER_PASSWORD = process.env.VIEWER_PASSWORD || '';
const CRON_SCHEDULE = process.env.CRON_SCHEDULE || '*/15 * * * *';
const MAX_BODY = 1024 * 1024; // 1 MB

// Session cookie: clients authenticate once (login form or Basic) and then ride
// a signed, time-limited cookie instead of re-sending credentials every request.
// SESSION_SECRET should be set in production (and shared across replicas);
// without it a random per-process secret is used, so restarts invalidate logins.
const SESSION_COOKIE = 'evv_session';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const SESSION_TTL_MS = Math.max(60, Number(process.env.SESSION_TTL_SECONDS) || 3600) * 1000;

// Resolves an Authorization header to a role: 'admin' | 'viewer' | null.
const roleFor = makeAuthenticator({
  adminUser: ADMIN_USER,
  adminPassword: ADMIN_PASSWORD,
  viewerUser: VIEWER_USER,
  viewerPassword: VIEWER_PASSWORD,
});

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// ---------- helpers ----------

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

// Strip the heavy `raw` blob from the list view.
function summaryOf(e) {
  const { raw, ...rest } = e;
  return rest;
}

// Per-endpoint classification fields. Empty string means "not set".
const REPO_TYPES = ['dev', 'staging', 'prod'];
const HOSTING_TYPES = ['cluster', 'docker', 'external'];

// Validate an optional enum value; '' / null clears it. Throws on bad input.
function normalizeEnum(value, allowed, field) {
  if (value == null || value === '') return '';
  const v = String(value);
  if (!allowed.includes(v)) throw new Error('Invalid ' + field);
  return v;
}

// Normalize an optional link (e.g. password-manager URL). Empty -> ''.
// Prepends https:// when no scheme is given; only http(s) allowed.
function normalizeLink(input) {
  if (input == null) return '';
  const raw = String(input).trim();
  if (raw === '') return '';
  // Only prepend https:// when no scheme was given; an explicit non-http(s)
  // scheme (ftp:, javascript:, …) must be rejected, not coerced.
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
  let url;
  try {
    url = new URL(hasScheme ? raw : 'https://' + raw);
  } catch {
    throw new Error('Invalid link URL');
  }
  if (!/^https?:$/.test(url.protocol)) {
    throw new Error('Only http(s) links are supported');
  }
  return url.toString();
}

const RANK = { viewer: 1, admin: 2 };

// Resolve a request to a role using either a valid session cookie or, as a
// fallback, an Authorization: Basic header (so API clients / CI keep working).
function roleForRequest(req) {
  const cookies = parseCookies(req.headers['cookie'] || '');
  const fromCookie = verifySession(cookies[SESSION_COOKIE], SESSION_SECRET);
  if (fromCookie) return fromCookie;
  return roleFor(req.headers['authorization'] || '');
}

// No WWW-Authenticate header: the UI uses a login form (POST /api/login), so we
// must not trigger the browser's native Basic dialog. CI/API clients may still
// send Basic; they just get a plain 401 instead of a challenge.
function send401(res) {
  sendJson(res, 401, { error: 'Unauthorized' });
}

// Set-Cookie value for a fresh session, or one that clears it.
function sessionCookie(req, role) {
  const token = signSession(role, Date.now() + SESSION_TTL_MS, SESSION_SECRET);
  const secure =
    req.headers['x-forwarded-proto'] === 'https' || Boolean(req.socket && req.socket.encrypted);
  const attrs = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}
function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

// Enforce a minimum role. Returns true if allowed, otherwise writes the
// appropriate 401/403 response and returns false.
//   min = 'viewer' -> viewer or admin
//   min = 'admin'  -> admin only
function requireRole(req, res, min) {
  const role = roleForRequest(req);
  if (!role) {
    send401(res);
    return false;
  }
  if (RANK[role] < RANK[min]) {
    sendJson(res, 403, { error: 'Forbidden' });
    return false;
  }
  return true;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const body = await readBody(req);
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch {
    throw new Error('Invalid JSON body');
  }
}

// ---------- static files ----------

async function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath);
  if (rel === '/' || rel === '') rel = '/index.html';

  // Resolve safely inside PUBLIC_DIR (prevent path traversal).
  const resolved = path.normalize(path.join(PUBLIC_DIR, rel));
  if (resolved !== PUBLIC_DIR && !resolved.startsWith(PUBLIC_DIR + path.sep)) {
    sendJson(res, 403, { error: 'Forbidden' });
    return;
  }

  try {
    const data = await fs.readFile(resolved);
    const ext = path.extname(resolved).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': data.length,
    });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: 'Not found' });
  }
}

// ---------- API ----------

async function handleApi(req, res, urlPath) {
  const method = req.method;

  // GET /api/endpoints -> summaries (no raw blob)
  if (urlPath === '/api/endpoints' && method === 'GET') {
    if (!requireRole(req, res, 'viewer')) return;
    const endpoints = await loadMerged();
    sendJson(res, 200, { endpoints: endpoints.map(summaryOf) });
    return;
  }

  // POST /api/endpoints -> add (admin)
  if (urlPath === '/api/endpoints' && method === 'POST') {
    if (!requireRole(req, res, 'admin')) return;
    let payload;
    try {
      payload = await readJsonBody(req);
    } catch (e) {
      sendJson(res, 400, { error: e.message });
      return;
    }
    let url;
    try {
      url = normalizeAboutUrl(payload.url);
    } catch (e) {
      sendJson(res, 400, { error: e.message });
      return;
    }
    let pwLink, repoType, hosting;
    try {
      pwLink = normalizeLink(payload.pwLink);
      repoType = normalizeEnum(payload.repoType, REPO_TYPES, 'repoType');
      hosting = normalizeEnum(payload.hosting, HOSTING_TYPES, 'hosting');
    } catch (e) {
      sendJson(res, 400, { error: e.message });
      return;
    }
    const config = await loadConfig();
    if (config.endpoints.some((e) => e.url === url)) {
      sendJson(res, 409, { error: 'Endpoint already exists' });
      return;
    }
    const endpoint = {
      id: crypto.randomUUID(),
      label: (payload.label && String(payload.label).trim()) || deriveLabel(url),
      url,
      addedAt: new Date().toISOString(),
      notes: payload.notes != null ? String(payload.notes) : '',
      pwLink,
      repoType,
      hosting,
      ...defaultFetch(),
    };
    await fetchEndpoint(endpoint); // fetch immediately so data shows up
    config.endpoints.push(endpoint);
    await saveConfig(config); // durable config (strips fetch fields)
    await saveFetch(endpoint.id, endpoint); // latest fetch result
    sendJson(res, 201, { endpoint: summaryOf(endpoint) });
    return;
  }

  // POST /api/refresh -> refresh all (admin)
  if (urlPath === '/api/refresh' && method === 'POST') {
    if (!requireRole(req, res, 'admin')) return;
    const config = await refreshAll();
    sendJson(res, 200, { endpoints: config.endpoints.map(summaryOf) });
    return;
  }

  // POST /api/login -> validate credentials once, set a 1h session cookie.
  if (urlPath === '/api/login' && method === 'POST') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (e) {
      sendJson(res, 400, { error: e.message });
      return;
    }
    const user = body.user != null ? String(body.user) : '';
    const pass = body.password != null ? String(body.password) : '';
    const header = 'Basic ' + Buffer.from(user + ':' + pass).toString('base64');
    const role = roleFor(header);
    if (!role) {
      sendJson(res, 401, { error: 'Ungültige Anmeldedaten' });
      return;
    }
    res.setHeader('Set-Cookie', sessionCookie(req, role));
    sendJson(res, 200, {
      role,
      user: role === 'admin' ? ADMIN_USER : VIEWER_USER,
      canWrite: role === 'admin',
    });
    return;
  }

  // POST /api/logout -> clear the session cookie.
  if (urlPath === '/api/logout' && method === 'POST') {
    res.setHeader('Set-Cookie', clearSessionCookie());
    sendJson(res, 200, { ok: true });
    return;
  }

  // GET /api/me -> who am I (role + user)
  if (urlPath === '/api/me' && method === 'GET') {
    const role = roleForRequest(req);
    if (!role) {
      send401(res);
      return;
    }
    sendJson(res, 200, {
      role,
      user: role === 'admin' ? ADMIN_USER : VIEWER_USER,
      canWrite: role === 'admin',
    });
    return;
  }

  // /api/endpoints/:id  and  /api/endpoints/:id/refresh
  const idMatch = /^\/api\/endpoints\/([^/]+)(\/refresh)?$/.exec(urlPath);
  if (idMatch) {
    const id = idMatch[1];
    const isRefresh = Boolean(idMatch[2]);

    if (!isRefresh && method === 'GET') {
      if (!requireRole(req, res, 'viewer')) return;
      const endpoint = await loadMergedOne(id);
      if (!endpoint) {
        sendJson(res, 404, { error: 'Not found' });
        return;
      }
      sendJson(res, 200, { endpoint });
      return;
    }

    // PATCH /api/endpoints/:id -> edit label / notes / pwLink / repoType / hosting (admin)
    if (!isRefresh && method === 'PATCH') {
      if (!requireRole(req, res, 'admin')) return;
      let payload;
      try {
        payload = await readJsonBody(req);
      } catch (e) {
        sendJson(res, 400, { error: e.message });
        return;
      }
      const config = await loadConfig();
      const cfg = config.endpoints.find((e) => e.id === id);
      if (!cfg) {
        sendJson(res, 404, { error: 'Not found' });
        return;
      }
      if (payload.label !== undefined) {
        const label = String(payload.label).trim();
        if (label) cfg.label = label;
      }
      if (payload.notes !== undefined) {
        cfg.notes = String(payload.notes);
      }
      if (payload.pwLink !== undefined) {
        try {
          cfg.pwLink = normalizeLink(payload.pwLink);
        } catch (e) {
          sendJson(res, 400, { error: e.message });
          return;
        }
      }
      try {
        if (payload.repoType !== undefined) {
          cfg.repoType = normalizeEnum(payload.repoType, REPO_TYPES, 'repoType');
        }
        if (payload.hosting !== undefined) {
          cfg.hosting = normalizeEnum(payload.hosting, HOSTING_TYPES, 'hosting');
        }
      } catch (e) {
        sendJson(res, 400, { error: e.message });
        return;
      }
      await saveConfig(config);
      sendJson(res, 200, { endpoint: summaryOf(await loadMergedOne(id)) });
      return;
    }

    if (!isRefresh && method === 'DELETE') {
      if (!requireRole(req, res, 'admin')) return;
      const config = await loadConfig();
      const before = config.endpoints.length;
      config.endpoints = config.endpoints.filter((e) => e.id !== id);
      if (config.endpoints.length === before) {
        sendJson(res, 404, { error: 'Not found' });
        return;
      }
      await saveConfig(config);
      await deleteFetch(id);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (isRefresh && method === 'POST') {
      if (!requireRole(req, res, 'admin')) return;
      const endpoint = await refreshOne(id);
      if (!endpoint) {
        sendJson(res, 404, { error: 'Not found' });
        return;
      }
      sendJson(res, 200, { endpoint: summaryOf(endpoint) });
      return;
    }
  }

  sendJson(res, 404, { error: 'Unknown API route' });
}

// ---------- server ----------

const server = http.createServer(async (req, res) => {
  try {
    const urlPath = (req.url || '/').split('?')[0];
    if (urlPath === '/api/health') {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (urlPath.startsWith('/api/')) {
      await handleApi(req, res, urlPath);
      return;
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      // The static shell (HTML/JS/CSS, no data) is public so the login form can
      // load. All actual data sits behind /api/* and stays role-protected.
      await serveStatic(req, res, urlPath);
      return;
    }
    sendJson(res, 405, { error: 'Method not allowed' });
  } catch (err) {
    console.error('[server] error:', err);
    if (!res.headersSent) sendJson(res, 500, { error: 'Internal server error' });
  }
});

async function start() {
  await ensureConfig();
  console.log('[startup] config file:', getConfigPath());

  if (!ADMIN_PASSWORD) {
    console.warn(
      '[startup] WARNING: ADMIN_PASSWORD is not set — admin (write) actions are disabled.'
    );
  }
  if (VIEWER_PASSWORD) {
    console.log('[startup] read-only viewer account enabled (user: %s)', VIEWER_USER);
  }
  if (!ADMIN_PASSWORD && !VIEWER_PASSWORD) {
    console.warn(
      '[startup] WARNING: neither ADMIN_PASSWORD nor VIEWER_PASSWORD is set — nobody can log in. Set at least one.'
    );
  }

  // Schedule periodic fetches.
  try {
    scheduleCron(CRON_SCHEDULE, async () => {
      console.log('[cron] refreshing endpoints…');
      await refreshAll();
    });
    console.log('[startup] cron schedule:', CRON_SCHEDULE);
  } catch (e) {
    console.error('[startup] invalid CRON_SCHEDULE "%s": %s', CRON_SCHEDULE, e.message);
    process.exit(1);
  }

  // Initial fetch shortly after boot so data appears without waiting for cron.
  setTimeout(() => {
    refreshAll()
      .then(() => console.log('[startup] initial refresh done'))
      .catch((e) => console.error('[startup] initial refresh failed:', e.message));
  }, 1000);

  server.listen(PORT, () => {
    console.log('[startup] listening on http://0.0.0.0:' + PORT);
  });
}

start();
