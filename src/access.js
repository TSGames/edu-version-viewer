// Central source-IP allowlist and proxy trust. Everything except the explicitly
// public routes (PUBLIC_ROUTES) is only reachable from ALLOWED_SOURCE_RANGES.
//
// The client IP comes from Fastify's `req.ip`, which depends on `trustProxy`:
//   TRUST_PROXY_HOPS=0  -> ignore X-Forwarded-* entirely (direct exposure)
//   TRUST_PROXY_HOPS=N  -> trust the last N proxies; req.ip is the address the
//                          outermost trusted proxy saw (robust even when a
//                          proxy appends to a client-supplied X-Forwarded-For)
//   unset               -> legacy: trust every hop (spoofable). Not allowed
//                          together with an allowlist.
import { ipToInt, parseRangeSpec } from './ipranges.js';

// Route patterns (as registered) that bypass the allowlist: the public
// instance list and the health check used by kubelet probes / Docker.
export const PUBLIC_ROUTES = ['/api/health', '/api/public/instances'];

export class AccessConfigError extends Error {}

// "134.76.0.0/16, 10.0.0.0/8 192.168" -> [{ base, mask, spec }]. Throws on
// any invalid entry so a typo never silently opens (or closes) access.
export function parseSourceRanges(input) {
  const list = Array.isArray(input) ? input : String(input ?? '').split(/[\s,;]+/);
  const out = [];
  for (const raw of list) {
    const spec = String(raw).trim();
    if (!spec) continue;
    const r = parseRangeSpec(spec);
    if (!r) throw new AccessConfigError(`ALLOWED_SOURCE_RANGES: invalid range "${spec}"`);
    out.push({ ...r, spec });
  }
  return out;
}

// TRUST_PROXY_HOPS -> Fastify `trustProxy` value (true | false | number), or
// undefined when unset.
export function parseTrustProxyHops(value) {
  if (value == null || String(value).trim() === '') return undefined;
  const s = String(value).trim();
  if (!/^\d+$/.test(s)) throw new AccessConfigError(`TRUST_PROXY_HOPS: expected a number >= 0, got "${s}"`);
  const n = Number(s);
  return n === 0 ? false : n;
}

// Resolve both settings (explicit options win over env) and validate them.
export function resolveAccessConfig(opts = {}, env = process.env) {
  const ranges = parseSourceRanges(opts.allowedSourceRanges ?? env.ALLOWED_SOURCE_RANGES);
  const hops =
    opts.trustProxyHops !== undefined ? parseTrustProxyHops(opts.trustProxyHops) : parseTrustProxyHops(env.TRUST_PROXY_HOPS);
  if (ranges.length && hops === undefined) {
    throw new AccessConfigError(
      'ALLOWED_SOURCE_RANGES requires TRUST_PROXY_HOPS (0 = no proxy, 1 = one reverse proxy / ingress, …); ' +
        'otherwise the client IP could be spoofed via X-Forwarded-For'
    );
  }
  return { ranges, trustProxy: hops === undefined ? true : hops };
}

// IPv4 (also IPv4-mapped IPv6 like "::ffff:10.0.0.1") inside one of `ranges`.
// Plain IPv6 never matches: the ranges are IPv4 only.
export function ipAllowed(ip, ranges) {
  const v4 = String(ip || '').replace(/^::ffff:/i, '');
  const n = ipToInt(v4);
  if (n == null) return false;
  return ranges.some((r) => ((n & r.mask) >>> 0) === r.base);
}

// Fastify onRequest hook enforcing the allowlist. Uses the *matched route
// pattern* (not the raw URL) for the public exemption, so encoded or dotted
// paths can't sneak past it; unmatched URLs (404) are restricted too.
export function makeAllowlistHook(ranges) {
  return async function allowlist(req, reply) {
    const route = req.routeOptions && req.routeOptions.url;
    if (route && PUBLIC_ROUTES.includes(route)) return;
    if (ipAllowed(req.ip, ranges)) return;
    const isApi = String(req.url).startsWith('/api/');
    return reply
      .code(403)
      .type(isApi ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8')
      .send(isApi ? JSON.stringify({ error: 'Forbidden' }) : 'Forbidden');
  };
}
