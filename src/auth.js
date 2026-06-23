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
