// HTTP server: serves the static frontend and a small JSON API.
// Zero external dependencies — Node built-ins only.
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { loadConfig, saveConfig, ensureConfig, getConfigPath } from './store.js';
import { fetchEndpoint, refreshAll, refreshOne } from './fetcher.js';
import { scheduleCron } from './cron.js';
import { normalizeAboutUrl, deriveLabel } from './url.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const PORT = Number(process.env.PORT || 3000);
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const CRON_SCHEDULE = process.env.CRON_SCHEDULE || '*/15 * * * *';
const MAX_BODY = 1024 * 1024; // 1 MB

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

function timingSafeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) {
    // Compare against self to keep timing roughly constant, then fail.
    crypto.timingSafeEqual(ba, ba);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

function isAuthorized(req) {
  if (!ADMIN_PASSWORD) return false; // refuse admin actions if no password set
  const header = req.headers['authorization'] || '';
  const m = /^Basic\s+(.+)$/i.exec(header);
  if (!m) return false;
  let decoded;
  try {
    decoded = Buffer.from(m[1], 'base64').toString('utf8');
  } catch {
    return false;
  }
  const idx = decoded.indexOf(':');
  if (idx < 0) return false;
  const user = decoded.slice(0, idx);
  const pass = decoded.slice(idx + 1);
  // Evaluate both to avoid short-circuit timing leaks.
  const userOk = timingSafeEqual(user, ADMIN_USER);
  const passOk = timingSafeEqual(pass, ADMIN_PASSWORD);
  return userOk && passOk;
}

function requireAdmin(req, res) {
  if (isAuthorized(req)) return true;
  res.writeHead(401, {
    'WWW-Authenticate': 'Basic realm="edu-version-viewer", charset="UTF-8"',
    'Content-Type': 'application/json; charset=utf-8',
  });
  res.end(JSON.stringify({ error: 'Unauthorized' }));
  return false;
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
    const config = await loadConfig();
    sendJson(res, 200, { endpoints: config.endpoints.map(summaryOf) });
    return;
  }

  // POST /api/endpoints -> add (admin)
  if (urlPath === '/api/endpoints' && method === 'POST') {
    if (!requireAdmin(req, res)) return;
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
    const config = await loadConfig();
    if (config.endpoints.some((e) => e.url === url)) {
      sendJson(res, 409, { error: 'Endpoint already exists' });
      return;
    }
    const endpoint = {
      id: crypto.randomUUID(),
      label: (payload.label && String(payload.label).trim()) || deriveLabel(url),
      url,
      lastSync: null,
      lastStatus: 'pending',
      error: null,
      version: null,
      renderservice: null,
      services: [],
      features: null,
      plugins: null,
      raw: null,
    };
    await fetchEndpoint(endpoint); // fetch immediately so data shows up
    config.endpoints.push(endpoint);
    await saveConfig(config);
    sendJson(res, 201, { endpoint: summaryOf(endpoint) });
    return;
  }

  // POST /api/refresh -> refresh all (admin)
  if (urlPath === '/api/refresh' && method === 'POST') {
    if (!requireAdmin(req, res)) return;
    const config = await refreshAll();
    sendJson(res, 200, { endpoints: config.endpoints.map(summaryOf) });
    return;
  }

  // GET /api/me -> credential check
  if (urlPath === '/api/me' && method === 'GET') {
    if (!requireAdmin(req, res)) return;
    sendJson(res, 200, { admin: true, user: ADMIN_USER });
    return;
  }

  // /api/endpoints/:id  and  /api/endpoints/:id/refresh
  const idMatch = /^\/api\/endpoints\/([^/]+)(\/refresh)?$/.exec(urlPath);
  if (idMatch) {
    const id = idMatch[1];
    const isRefresh = Boolean(idMatch[2]);

    if (!isRefresh && method === 'GET') {
      const config = await loadConfig();
      const endpoint = config.endpoints.find((e) => e.id === id);
      if (!endpoint) {
        sendJson(res, 404, { error: 'Not found' });
        return;
      }
      sendJson(res, 200, { endpoint });
      return;
    }

    if (!isRefresh && method === 'DELETE') {
      if (!requireAdmin(req, res)) return;
      const config = await loadConfig();
      const before = config.endpoints.length;
      config.endpoints = config.endpoints.filter((e) => e.id !== id);
      if (config.endpoints.length === before) {
        sendJson(res, 404, { error: 'Not found' });
        return;
      }
      await saveConfig(config);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (isRefresh && method === 'POST') {
      if (!requireAdmin(req, res)) return;
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
      '[startup] WARNING: ADMIN_PASSWORD is not set — admin actions are disabled until you set it.'
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
