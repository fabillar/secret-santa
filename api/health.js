// GET /api/health — setup check. Reports whether required configuration is
// present and Redis is reachable. Never returns secret values.
import { endpoint, sendJson } from './_lib/http.js';
import { getRedis } from './_lib/redis.js';
import { rateLimit } from './_lib/security.js';

export default endpoint(['GET'], async (req, res) => {
  const config = {
    upstashUrl: Boolean(process.env.UPSTASH_REDIS_REST_URL),
    upstashToken: Boolean(process.env.UPSTASH_REDIS_REST_TOKEN),
    adminPassword: Boolean(process.env.ADMIN_PASSWORD),
    sessionSecret: (process.env.SESSION_SECRET || '').length >= 32,
  };
  let redis = false;
  try {
    await rateLimit(req, 'health', 30, 60_000);
    redis = (await getRedis().ping()) === 'PONG';
  } catch (err) {
    if (err?.status === 429) throw err;
    redis = false;
  }
  const ok = redis && Object.values(config).every(Boolean);
  sendJson(res, ok ? 200 : 503, { ok, redis, config });
});
