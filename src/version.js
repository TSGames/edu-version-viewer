// Numeric version comparison (mirrors the frontend sort in public/app.js), so
// "10.0" > "9.0" and "11.0" === "11.0.0". Non-digit parts act as separators.

// "9.1.2" -> [9, 1, 2]; null for empty / digit-less input.
export function versionKey(v) {
  if (v == null || v === '') return null;
  const parts = String(v)
    .split(/[^0-9]+/)
    .filter((s) => s !== '')
    .map(Number);
  return parts.length ? parts : null;
}

// <0 / 0 / >0 like a sort comparator. Both keys must be non-null.
export function compareKeys(ka, kb) {
  for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
    const diff = (ka[i] || 0) - (kb[i] || 0);
    if (diff) return diff;
  }
  return 0;
}

// True when `version` >= `min`. Unknown versions never satisfy a minimum.
export function isAtLeast(version, min) {
  const kv = versionKey(version);
  const km = versionKey(min);
  if (kv == null || km == null) return false;
  return compareKeys(kv, km) >= 0;
}
