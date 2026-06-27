// Map a resolved IPv4 address to one or more tags (network / organisation)
// based on a configurable list of IP ranges. Dependency-free, IPv4 only.
//
// Config format (one mapping per line):
//   <range>: <tag>
// where <range> is either CIDR ("134.76.0.0/16") or an octet prefix
// ("134.76" => /16, "10" => /8, "192.168.1" => /24). Lines starting with #
// and blank lines are ignored. Example:
//   134.76: GWDG
import { promises as fs } from 'node:fs';

// Dotted IPv4 -> unsigned 32-bit int, or null if malformed.
export function ipToInt(ip) {
  const parts = String(ip).split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const o = Number(p);
    if (o > 255) return null;
    n = n * 256 + o;
  }
  return n >>> 0;
}

// Pad an octet prefix to a full dotted quad, validating each octet.
function padOctets(s) {
  const octets = String(s).split('.');
  if (octets.length === 0 || octets.length > 4) return null;
  for (const o of octets) {
    if (!/^\d{1,3}$/.test(o) || Number(o) > 255) return null;
  }
  const full = octets.slice();
  while (full.length < 4) full.push('0');
  return full.join('.');
}

// Parse a range spec (CIDR or octet prefix) into { base, mask } or null.
export function parseRangeSpec(spec) {
  const s = String(spec).trim();
  if (!s) return null;
  let ipText, bits;
  if (s.includes('/')) {
    const slash = s.indexOf('/');
    bits = Number(s.slice(slash + 1).trim());
    if (!Number.isInteger(bits) || bits < 0 || bits > 32) return null;
    ipText = padOctets(s.slice(0, slash).trim());
  } else {
    const octets = s.split('.');
    if (octets.length < 1 || octets.length > 4) return null;
    bits = octets.length * 8;
    ipText = padOctets(s);
  }
  if (!ipText) return null;
  const base = ipToInt(ipText);
  if (base == null) return null;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return { base: (base & mask) >>> 0, mask };
}

// Parse the config text into an array of { base, mask, label }.
export function parseRanges(text) {
  const ranges = [];
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const spec = line.slice(0, idx).trim();
    const label = line.slice(idx + 1).trim();
    if (!spec || !label) continue;
    const r = parseRangeSpec(spec);
    if (!r) continue;
    ranges.push({ base: r.base, mask: r.mask, label });
  }
  return ranges;
}

// Return the de-duplicated tags whose range contains `ip` (order preserved).
export function tagsForIp(ip, ranges) {
  const n = ipToInt(ip);
  if (n == null || !Array.isArray(ranges)) return [];
  const out = [];
  for (const r of ranges) {
    if (((n & r.mask) >>> 0) === r.base && !out.includes(r.label)) out.push(r.label);
  }
  return out;
}

// Load and parse the ranges file; returns [] if missing or unreadable.
export async function loadRanges(filePath) {
  try {
    return parseRanges(await fs.readFile(filePath, 'utf8'));
  } catch {
    return [];
  }
}
