// Fastify application factory. `buildApp()` wires up plugins, sessions, auth and
// routes and returns the instance WITHOUT listening, so it can be driven both by
// `server.js` (which adds the startup side-effects) and by tests via
// `app.inject()`.
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import session from '@fastify/session';
import fastifyStatic from '@fastify/static';

import {
  loadConfig,
  saveConfig,
  loadMerged,
  loadMergedOne,
  saveFetch,
  deleteFetch,
  defaultFetch,
} from './store.js';
import { fetchEndpoint, refreshAll, refreshOne } from './fetcher.js';
import { normalizeAboutUrl, deriveLabel } from './url.js';
import { makeAuthenticator } from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MAX_BODY = 1024 * 1024; // 1 MB

// Per-endpoint classification fields. Empty string means "not set".
const REPO_TYPES = ['dev', 'staging', 'prod'];
const HOSTING_TYPES = ['cluster', 'docker', 'external'];
const RANK = { viewer: 1, admin: 2 };

// Strip the heavy `raw` blob from the list view.
function summaryOf(e) {
  const { raw, ...rest } = e;
  return rest;
}

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

export async function buildApp(opts = {}) {
  const adminUser = opts.adminUser ?? process.env.ADMIN_USER ?? 'admin';
  const adminPassword = opts.adminPassword ?? process.env.ADMIN_PASSWORD ?? '';
  const viewerUser = opts.viewerUser ?? process.env.VIEWER_USER ?? 'viewer';
  const viewerPassword = opts.viewerPassword ?? process.env.VIEWER_PASSWORD ?? '';
  // @fastify/session requires a secret of at least 32 characters. The default
  // (64 hex chars) is random per process, so restarts invalidate logins.
  const sessionSecret =
    opts.sessionSecret || process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
  const sessionTtlMs =
    Math.max(60, Number(opts.sessionTtlSeconds ?? process.env.SESSION_TTL_SECONDS) || 3600) * 1000;

  // Resolves an Authorization header to a role: 'admin' | 'viewer' | null.
  const roleFor = makeAuthenticator({ adminUser, adminPassword, viewerUser, viewerPassword });
  const userForRole = (role) => (role === 'admin' ? adminUser : viewerUser);

  const app = Fastify({
    bodyLimit: MAX_BODY, // oversized bodies -> 413 automatically
    trustProxy: true, // honor x-forwarded-proto for `secure` cookies behind a proxy
    logger: opts.logger ?? false,
  });

  // Keep all error/JSON shapes as { error } for the frontend.
  app.setErrorHandler((err, req, reply) => {
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    if (status >= 500) req.log.error(err);
    reply.code(status).send({ error: err.message || 'Internal server error' });
  });

  // @fastify/cookie must be registered before @fastify/session.
  await app.register(cookie);
  await app.register(session, {
    secret: sessionSecret,
    cookieName: 'evv_session',
    // Don't persist (or set a cookie for) anonymous sessions, so unauthenticated
    // requests stay cookie-free and keep returning 401.
    saveUninitialized: false,
    rolling: true, // sliding expiry: active sessions don't expire mid-use
    cookie: {
      maxAge: sessionTtlMs,
      httpOnly: true,
      sameSite: 'lax',
      secure: 'auto', // Secure only when the (proxy-resolved) request is https
      path: '/',
    },
  });

  // Resolve a request to a role: a live session, else an Authorization: Basic
  // header (so API clients / CI keep working without a login round-trip).
  app.decorate('roleForRequest', function roleForRequest(req) {
    if (req.session && req.session.role) return req.session.role;
    return roleFor(req.headers['authorization'] || '');
  });

  // preHandler factory enforcing a minimum role. No WWW-Authenticate header, so
  // the browser shows our login form instead of the native Basic dialog.
  function requireRole(min) {
    return async function (req, reply) {
      const role = app.roleForRequest(req);
      if (!role) return reply.code(401).send({ error: 'Unauthorized' });
      if (RANK[role] < RANK[min]) return reply.code(403).send({ error: 'Forbidden' });
    };
  }

  // ---------- API routes ----------

  app.get('/api/health', async () => ({ ok: true }));

  app.get('/api/endpoints', { preHandler: requireRole('viewer') }, async () => {
    const endpoints = await loadMerged();
    return { endpoints: endpoints.map(summaryOf) };
  });

  app.post('/api/endpoints', { preHandler: requireRole('admin') }, async (req, reply) => {
    const payload = req.body || {};
    let url;
    try {
      url = normalizeAboutUrl(payload.url);
    } catch (e) {
      return reply.code(400).send({ error: e.message });
    }
    let pwLink, repoType, hosting;
    try {
      pwLink = normalizeLink(payload.pwLink);
      repoType = normalizeEnum(payload.repoType, REPO_TYPES, 'repoType');
      hosting = normalizeEnum(payload.hosting, HOSTING_TYPES, 'hosting');
    } catch (e) {
      return reply.code(400).send({ error: e.message });
    }
    const config = await loadConfig();
    if (config.endpoints.some((e) => e.url === url)) {
      return reply.code(409).send({ error: 'Endpoint already exists' });
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
    await saveConfig(config);
    await saveFetch(endpoint.id, endpoint);
    return reply.code(201).send({ endpoint: summaryOf(endpoint) });
  });

  app.post('/api/refresh', { preHandler: requireRole('admin') }, async () => {
    const config = await refreshAll();
    return { endpoints: config.endpoints.map(summaryOf) };
  });

  // Validate credentials once and start a session.
  app.post('/api/login', async (req, reply) => {
    const body = req.body || {};
    const user = body.user != null ? String(body.user) : '';
    const pass = body.password != null ? String(body.password) : '';
    const header = 'Basic ' + Buffer.from(user + ':' + pass).toString('base64');
    const role = roleFor(header);
    if (!role) return reply.code(401).send({ error: 'Ungültige Anmeldedaten' });
    req.session.role = role;
    req.session.user = userForRole(role);
    return { role, user: userForRole(role), canWrite: role === 'admin' };
  });

  app.post('/api/logout', async (req) => {
    await req.session.destroy();
    return { ok: true };
  });

  app.get('/api/me', async (req, reply) => {
    const role = app.roleForRequest(req);
    if (!role) return reply.code(401).send({ error: 'Unauthorized' });
    return { role, user: userForRole(role), canWrite: role === 'admin' };
  });

  app.get('/api/endpoints/:id', { preHandler: requireRole('viewer') }, async (req, reply) => {
    const endpoint = await loadMergedOne(req.params.id);
    if (!endpoint) return reply.code(404).send({ error: 'Not found' });
    return { endpoint };
  });

  app.patch('/api/endpoints/:id', { preHandler: requireRole('admin') }, async (req, reply) => {
    const payload = req.body || {};
    const config = await loadConfig();
    const cfg = config.endpoints.find((e) => e.id === req.params.id);
    if (!cfg) return reply.code(404).send({ error: 'Not found' });
    if (payload.label !== undefined) {
      const label = String(payload.label).trim();
      if (label) cfg.label = label;
    }
    if (payload.notes !== undefined) cfg.notes = String(payload.notes);
    try {
      if (payload.pwLink !== undefined) cfg.pwLink = normalizeLink(payload.pwLink);
      if (payload.repoType !== undefined) {
        cfg.repoType = normalizeEnum(payload.repoType, REPO_TYPES, 'repoType');
      }
      if (payload.hosting !== undefined) {
        cfg.hosting = normalizeEnum(payload.hosting, HOSTING_TYPES, 'hosting');
      }
    } catch (e) {
      return reply.code(400).send({ error: e.message });
    }
    await saveConfig(config);
    return { endpoint: summaryOf(await loadMergedOne(req.params.id)) };
  });

  app.delete('/api/endpoints/:id', { preHandler: requireRole('admin') }, async (req, reply) => {
    const config = await loadConfig();
    const before = config.endpoints.length;
    config.endpoints = config.endpoints.filter((e) => e.id !== req.params.id);
    if (config.endpoints.length === before) return reply.code(404).send({ error: 'Not found' });
    await saveConfig(config);
    await deleteFetch(req.params.id);
    return { ok: true };
  });

  app.post(
    '/api/endpoints/:id/refresh',
    { preHandler: requireRole('admin') },
    async (req, reply) => {
      const endpoint = await refreshOne(req.params.id);
      if (!endpoint) return reply.code(404).send({ error: 'Not found' });
      return { endpoint: summaryOf(endpoint) };
    }
  );

  // ---------- static shell (public; no data) ----------
  // Registered last so explicit /api routes win. Unmatched routes hit the
  // not-found handler below.
  await app.register(fastifyStatic, { root: PUBLIC_DIR, prefix: '/' });

  app.setNotFoundHandler((req, reply) => {
    if ((req.raw.url || '').startsWith('/api/')) {
      return reply.code(404).send({ error: 'Unknown API route' });
    }
    return reply.code(404).send({ error: 'Not found' });
  });

  return app;
}
