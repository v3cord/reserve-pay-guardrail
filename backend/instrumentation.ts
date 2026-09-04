/**
 * Next.js instrumentation hook — runs once at server startup before any
 * request is handled. Used to initialise singletons that depend on
 * environment variables (token bucket, etc.).
 *
 * https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */
export async function register() {
  // Only run in the Node.js runtime (not the Edge runtime)
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { setTokenBucket, RedisTokenBucket, InMemoryTokenBucket } =
      await import('./lib/tokenBucket');

    if (process.env.REDIS_URL) {
      console.log('[startup] Redis URL detected — initialising RedisTokenBucket');
      setTokenBucket(new RedisTokenBucket(process.env.REDIS_URL));
    } else {
      console.log('[startup] No REDIS_URL — using InMemoryTokenBucket (single-instance only)');
      setTokenBucket(new InMemoryTokenBucket());
    }
  }
}
