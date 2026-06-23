// Simple URL recognition: turn whatever the admin pastes into a usable
// edu-sharing `_about` endpoint URL.
//
// Rules (kept intentionally simple):
//   1. Trim input, prepend https:// if no scheme is present.
//   2. If the path already references `_about`, use it as-is.
//   3. Otherwise drop a trailing slash and append `/edu-sharing/rest/_about`.
//   4. Validate by constructing a URL; throw on failure.

const ABOUT_PATH = '/edu-sharing/rest/_about';

export function normalizeAboutUrl(input) {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new Error('URL is required');
  }

  let raw = input.trim();
  if (!/^https?:\/\//i.test(raw)) {
    raw = 'https://' + raw;
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Invalid URL: ' + input);
  }

  if (!/^https?:$/.test(url.protocol)) {
    throw new Error('Only http(s) URLs are supported');
  }

  // Already points at an _about endpoint -> keep the explicit path.
  if (url.pathname.includes('_about')) {
    return url.toString();
  }

  // Strip trailing slash(es) from the (possibly empty) base path and append.
  const base = url.pathname.replace(/\/+$/, '');
  url.pathname = base + ABOUT_PATH;
  url.search = '';
  url.hash = '';
  return url.toString();
}

// Derive a friendly default label from the host (and a path hint if present).
export function deriveLabel(urlString) {
  try {
    const url = new URL(urlString);
    return url.hostname;
  } catch {
    return urlString;
  }
}
