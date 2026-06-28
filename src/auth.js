// Dependency-free authentication helpers (HTTP Basic, role-based).
import crypto from 'node:crypto';

// Constant-time string comparison that tolerates differing lengths.
export function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) {
    // Keep timing roughly constant, then fail.
    crypto.timingSafeEqual(ba, ba);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

// Parse an "Authorization: Basic …" header into { user, pass } or null.
export function parseBasic(authHeader) {
  if (!authHeader) return null;
  const m = /^Basic\s+(.+)$/i.exec(authHeader);
  if (!m) return null;
  let decoded;
  try {
    decoded = Buffer.from(m[1], 'base64').toString('utf8');
  } catch {
    return null;
  }
  const idx = decoded.indexOf(':');
  if (idx < 0) return null;
  return { user: decoded.slice(0, idx), pass: decoded.slice(idx + 1) };
}

// Parse a Cookie header into a plain object. Tolerates spaces and missing values.
export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    if (!k) continue;
    out[k] = part.slice(idx + 1).trim();
  }
  return out;
}

// Stateless signed session token: base64url("<role>.<expMs>") + "." + HMAC.
// No server-side store needed; the signature + expiry are self-contained.
export function signSession(role, expMs, secret) {
  const payload = `${role}.${expMs}`;
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return Buffer.from(payload).toString('base64url') + '.' + sig;
}

// Verify a session token. Returns the role ('admin'|'viewer') or null if the
// signature is invalid, the token is malformed, or it has expired.
export function verifySession(token, secret, now = Date.now()) {
  if (!token || typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot < 0) return null;
  let payload;
  try {
    payload = Buffer.from(token.slice(0, dot), 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const sig = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const sep = payload.lastIndexOf('.');
  if (sep < 0) return null;
  const role = payload.slice(0, sep);
  const expMs = Number(payload.slice(sep + 1));
  if (!Number.isFinite(expMs) || now >= expMs) return null;
  if (role !== 'admin' && role !== 'viewer') return null;
  return role;
}

// Build a role resolver. Returns a function (authHeader) -> 'admin' | 'viewer' | null.
// - admin is primary (can read + write).
// - viewer is an optional read-only account.
// - an account with an empty password is disabled.
export function makeAuthenticator({ adminUser, adminPassword, viewerUser, viewerPassword }) {
  return function roleFor(authHeader) {
    const creds = parseBasic(authHeader);
    if (!creds) return null;

    // Evaluate both account checks fully (no short-circuit) for steadier timing.
    const isAdmin =
      Boolean(adminPassword) &&
      safeEqual(creds.user, adminUser) &&
      safeEqual(creds.pass, adminPassword);
    const isViewer =
      Boolean(viewerPassword) &&
      safeEqual(creds.user, viewerUser) &&
      safeEqual(creds.pass, viewerPassword);

    if (isAdmin) return 'admin';
    if (isViewer) return 'viewer';
    return null;
  };
}
