/**
 * Next.js instrumentation hook — called once at server startup before any
 * request is handled. Wires up the token bucket singleton based on whichever
 * Redis environment variables are present.
 *
 * Priority order:
 *   1. KV_REST_API_URL / KV_REST_API_TOKEN          → UpstashTokenBucket (Vercel KV integration)
 *   2. UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN → UpstashTokenBucket (direct Upstash)
 *   3. REDIS_URL                                    → RedisTokenBucket (ioredis TCP, local dev)
 *   4. fallback                                     → InMemoryTokenBucket (single-instance only)
 *
 * https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const { setTokenBucket, UpstashTokenBucket, RedisTokenBucket, InMemoryTokenBucket } =
    await import('./lib/tokenBucket');

  const hasUpstash =
    (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) ||
    (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);

  const hasTcpRedis = Boolean(process.env.REDIS_URL);

  if (hasUpstash) {
    console.log('[startup] Upstash REST vars detected — initialising UpstashTokenBucket');
    setTokenBucket(new UpstashTokenBucket());
  } else if (hasTcpRedis) {
    console.log('[startup] REDIS_URL detected — initialising RedisTokenBucket (ioredis)');
    setTokenBucket(new RedisTokenBucket(process.env.REDIS_URL));
  } else {
    console.warn('[startup] No Redis env vars found — using InMemoryTokenBucket (single-instance only, not suitable for concurrent production use)');
    setTokenBucket(new InMemoryTokenBucket());
  }
}
