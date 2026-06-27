// Fetches an edu-sharing `_about` endpoint and extracts version / services /
// features. Stores the *entire* raw response so nothing is lost ("alles catchen").
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import { loadConfig, loadFetch, saveFetch, defaultFetch, getIpRangesPath } from './store.js';
import { loadRanges, tagsForIp } from './ipranges.js';

const TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 10000);
const MAX_REDIRECTS = 3;
const USER_AGENT = 'edu-version-viewer/1.0';

// Tolerate a few transient fetch failures before flagging an endpoint as
// errored, so a single hiccup doesn't immediately turn the card red. Only
// after MORE than this many consecutive failures does the status flip to
// 'error'. A successful fetch resets the counter.
const FAIL_THRESHOLD = Number(process.env.FAIL_THRESHOLD || 2);

function httpGetJson(url, redirectsLeft = MAX_REDIRECTS) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch {
      reject(new Error('Invalid URL'));
      return;
    }

    const lib = target.protocol === 'http:' ? http : https;
    const req = lib.get(
      target,
      {
        headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
        timeout: TIMEOUT_MS,
      },
      (res) => {
        const { statusCode = 0, headers } = res;

        // Follow redirects.
        if (statusCode >= 300 && statusCode < 400 && headers.location) {
          res.resume();
          if (redirectsLeft <= 0) {
            reject(new Error('Too many redirects'));
            return;
          }
          const next = new URL(headers.location, target).toString();
          resolve(httpGetJson(next, redirectsLeft - 1));
          return;
        }

        if (statusCode < 200 || statusCode >= 300) {
          res.resume();
          reject(new Error('HTTP ' + statusCode));
          return;
        }

        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
          if (body.length > 5 * 1024 * 1024) {
            req.destroy(new Error('Response too large'));
          }
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            reject(new Error('Invalid JSON response'));
          }
        });
      }
    );

    req.on('timeout', () => req.destroy(new Error('Request timed out')));
    req.on('error', (err) => reject(err));
  });
}

// Pull the human-facing version out of various possible shapes.
export function extractVersion(raw) {
  const v = raw && raw.version;
  if (v == null) return null;
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  if (typeof v === 'object') {
    if (v.repository != null) return String(v.repository);
    if (v.name != null) return String(v.name);
    if (v.major != null) {
      return [v.major, v.minor].filter((x) => x != null).join('.');
    }
  }
  return null;
}

export function extractServices(raw) {
  if (!raw || !Array.isArray(raw.services)) return [];
  return raw.services.map((s) => (s && s.name ? String(s.name) : null)).filter(Boolean);
}

// Build the summary that gets merged onto an endpoint record after a fetch.
export function summarize(raw) {
  return {
    version: extractVersion(raw),
    renderservice:
      raw && raw.version && raw.version.renderservice != null
        ? String(raw.version.renderservice)
        : null,
    // Whether a second rendering service (RS2) is wired up.
    rs2: Boolean(raw && raw.renderingService2 != null),
    services: extractServices(raw),
    features: raw && raw.features != null ? raw.features : null,
    plugins: raw && raw.plugins != null ? raw.plugins : null,
    raw,
  };
}

function hostFromUrl(u) {
  try {
    return new URL(u).hostname;
  } catch {
    return null;
  }
}

// Resolve a hostname to an IPv4 address, or null on any failure.
async function resolveIp(host) {
  if (!host) return null;
  try {
    const { address } = await dns.promises.lookup(host, { family: 4 });
    return address;
  } catch {
    return null;
  }
}

// Fetch a single endpoint object (mutated in place) and return it. `ranges` is
// the parsed IP-range list; when omitted it is loaded from the configured file.
export async function fetchEndpoint(endpoint, ranges) {
  if (ranges === undefined) ranges = await loadRanges(getIpRangesPath());
  const now = new Date().toISOString();

  // Resolve the host and derive automatic network/organisation tags. This is
  // independent of the HTTP fetch so tags stay current even when a fetch fails.
  const ip = await resolveIp(hostFromUrl(endpoint.url));
  endpoint.resolvedIp = ip;
  endpoint.networkTags = ip ? tagsForIp(ip, ranges) : [];

  try {
    const raw = await httpGetJson(endpoint.url);
    Object.assign(endpoint, summarize(raw), {
      lastSync: now,
      lastStatus: 'ok',
      error: null,
      failCount: 0,
    });
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    endpoint.failCount = (endpoint.failCount || 0) + 1;
    endpoint.lastSync = now;
    // Keep the last known-good status until failures exceed the threshold.
    // The most recent error is always recorded for diagnostics.
    endpoint.lastError = message;
    if (endpoint.failCount > FAIL_THRESHOLD) {
      endpoint.lastStatus = 'error';
      endpoint.error = message;
    }
  }
  return endpoint;
}

// Refresh every configured endpoint; each fetch is persisted independently.
// Returns merged (config + fetch) endpoint objects.
export async function refreshAll() {
  const { endpoints } = await loadConfig();
  const ranges = await loadRanges(getIpRangesPath());
  const merged = [];
  for (const cfg of endpoints) {
    const ep = { ...cfg, ...((await loadFetch(cfg.id)) || defaultFetch()) };
    await fetchEndpoint(ep, ranges);
    await saveFetch(ep.id, ep);
    merged.push(ep);
  }
  return { endpoints: merged };
}

// Refresh a single endpoint by id and persist. Returns the merged endpoint.
export async function refreshOne(id) {
  const { endpoints } = await loadConfig();
  const cfg = endpoints.find((e) => e.id === id);
  if (!cfg) return null;
  const ranges = await loadRanges(getIpRangesPath());
  const ep = { ...cfg, ...((await loadFetch(id)) || defaultFetch()) };
  await fetchEndpoint(ep, ranges);
  await saveFetch(id, ep);
  return ep;
}
