// Entry point: build the Fastify app, run the startup side-effects (config
// migration, cron schedule, an initial fetch) and start listening.
import { buildApp } from './app.js';
import { ensureConfig, getConfigPath } from './store.js';
import { refreshAll } from './fetcher.js';
import { syncAllAudits } from './audits.js';
import { scheduleCron } from './cron.js';

const PORT = Number(process.env.PORT || 3000);
const CRON_SCHEDULE = process.env.CRON_SCHEDULE || '*/15 * * * *';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const VIEWER_PASSWORD = process.env.VIEWER_PASSWORD || '';
const VIEWER_USER = process.env.VIEWER_USER || 'viewer';

async function start() {
  await ensureConfig();
  console.log('[startup] config file:', getConfigPath());

  if (!ADMIN_PASSWORD) {
    console.warn(
      '[startup] WARNING: ADMIN_PASSWORD is not set — admin (write) actions are disabled.'
    );
  }
  if (VIEWER_PASSWORD) {
    console.log('[startup] read-only viewer account enabled (user: %s)', VIEWER_USER);
  }
  if (!ADMIN_PASSWORD && !VIEWER_PASSWORD) {
    console.warn(
      '[startup] WARNING: neither ADMIN_PASSWORD nor VIEWER_PASSWORD is set — nobody can log in. Set at least one.'
    );
  }
  if (!process.env.SESSION_SECRET) {
    console.warn(
      '[startup] WARNING: SESSION_SECRET is not set — using a random per-process secret, so logins are dropped on restart.'
    );
  }

  const app = await buildApp();
  const access = app.accessConfig();
  if (access.ranges.length) {
    console.log(
      '[startup] source-IP allowlist active: %s (public: /api/public/*, /api/health; trusted proxy hops: %s)',
      access.ranges.join(', '),
      access.trustProxy === false ? 0 : access.trustProxy
    );
  } else if (access.trustProxy === true) {
    console.warn(
      '[startup] WARNING: TRUST_PROXY_HOPS is not set — X-Forwarded-* headers from any hop are trusted. Set it to 0 (no proxy) or the number of reverse proxies.'
    );
  }

  // Schedule periodic fetches.
  try {
    scheduleCron(CRON_SCHEDULE, async () => {
      console.log('[cron] refreshing endpoints…');
      const { endpoints } = await refreshAll();
      // Keep open patch-audit rounds in line (new/upgraded/removed instances).
      await syncAllAudits(endpoints).catch((e) => console.error('[cron] audit sync failed:', e.message));
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

  await app.listen({ port: PORT, host: '0.0.0.0' });
  console.log('[startup] listening on http://0.0.0.0:' + PORT);
}

start().catch((err) => {
  console.error('[startup] failed:', err);
  process.exit(1);
});
