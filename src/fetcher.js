// Fetches an edu-sharing `_about` endpoint and extracts version / services /
// features. Stores the *entire* raw response so nothing is lost ("alles catchen").
import http from 'node:http';
import https from 'node:https';
import { loadConfig, saveConfig } from './store.js';

const TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 10000);
const MAX_REDIRECTS = 3;
const USER_AGENT = 'edu-version-viewer/1.0';

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
    services: extractServices(raw),
    features: raw && raw.features != null ? raw.features : null,
    plugins: raw && raw.plugins != null ? raw.plugins : null,
    raw,
  };
}

// Fetch a single endpoint object (mutated in place) and return it.
export async function fetchEndpoint(endpoint) {
  const now = new Date().toISOString();
  try {
    const raw = await httpGetJson(endpoint.url);
    Object.assign(endpoint, summarize(raw), {
      lastSync: now,
      lastStatus: 'ok',
      error: null,
    });
  } catch (err) {
    endpoint.lastSync = now;
    endpoint.lastStatus = 'error';
    endpoint.error = err && err.message ? err.message : String(err);
  }
  return endpoint;
}

// Refresh every configured endpoint and persist once.
export async function refreshAll() {
  const config = await loadConfig();
  for (const endpoint of config.endpoints) {
    await fetchEndpoint(endpoint);
  }
  await saveConfig(config);
  return config;
}

// Refresh a single endpoint by id and persist.
export async function refreshOne(id) {
  const config = await loadConfig();
  const endpoint = config.endpoints.find((e) => e.id === id);
  if (!endpoint) return null;
  await fetchEndpoint(endpoint);
  await saveConfig(config);
  return endpoint;
}
