import Redis from 'ioredis';
import { Redis as UpstashRedis } from '@upstash/redis';
import { IRedisTokenBucket, TokenBucketAcquireResult } from './types';

// ---------------------------------------------------------------------------
// Lua script for atomic check-and-decrement (ioredis / TCP Redis only)
// ---------------------------------------------------------------------------
const LUA_ACQUIRE_SCRIPT = `
  local key = KEYS[1]
  local amount = tonumber(ARGV[1])
  local defaultCap = tonumber(ARGV[2])

  local current = redis.call('get', key)
  if not current then
    current = defaultCap
  else
    current = tonumber(current)
  end

  if current >= amount then
    local remaining = current - amount
    redis.call('set', key, tostring(remaining))
    return {1, remaining}
  else
    return {0, current}
  end
`;

// ---------------------------------------------------------------------------
// InMemoryTokenBucket — used in tests and as a last-resort fallback
// ---------------------------------------------------------------------------
export class InMemoryTokenBucket implements IRedisTokenBucket {
  private budgets: Map<string, number> = new Map();

  async acquireReserve(agentId: string, requestedPaise: number, initialTotalPaise?: number): Promise<TokenBucketAcquireResult> {
    return this.acquireReserveToken(agentId, requestedPaise, initialTotalPaise);
  }

  async acquireReserveToken(agentId: string, amountPaise: number, sessionCapPaise?: number): Promise<TokenBucketAcquireResult> {
    const current = this.budgets.get(agentId) ?? (sessionCapPaise || 1000000);
    if (current >= amountPaise) {
      const remaining = current - amountPaise;
      this.budgets.set(agentId, remaining);
      return { allowed: true, remainingPaise: remaining, remainingBudgetPaise: remaining };
    }
    return { allowed: false, remainingPaise: current, remainingBudgetPaise: current };
  }

  async releaseReserve(agentId: string, amountPaise: number): Promise<number> {
    return this.releaseReserveToken(agentId, amountPaise);
  }

  async releaseReserveToken(agentId: string, amountPaise: number): Promise<number> {
    const current = this.budgets.get(agentId) ?? 0;
    const updated = current + amountPaise;
    this.budgets.set(agentId, updated);
    return updated;
  }

  async refundReserve(agentId: string, amountPaise: number): Promise<number> {
    return this.releaseReserveToken(agentId, amountPaise);
  }

  async setRemainingBudget(agentId: string, remainingPaise: number): Promise<void> {
    this.budgets.set(agentId, remainingPaise);
  }

  async getRemainingBudget(agentId: string): Promise<number> {
    return this.budgets.get(agentId) ?? 100000;
  }

  async reset(agentId?: string): Promise<void> {
    if (agentId) this.budgets.delete(agentId);
    else this.budgets.clear();
  }

  async close(): Promise<void> {}
}

// ---------------------------------------------------------------------------
// UpstashTokenBucket — HTTP REST client, works on Vercel serverless / Edge.
//
// Reads the env vars that Vercel's Redis (Upstash) integration injects:
//   KV_REST_API_URL + KV_REST_API_TOKEN              (Vercel KV integration)
//   UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN (direct Upstash)
//
// Atomic acquire uses a WATCH / GET / SET pipeline with retry (optimistic
// locking), because the Upstash REST API does not support Lua eval.
// ---------------------------------------------------------------------------
export class UpstashTokenBucket implements IRedisTokenBucket {
  private client: UpstashRedis;
  private fallback = new InMemoryTokenBucket();

  constructor(url?: string, token?: string) {
    const resolvedUrl =
      url ||
      process.env.KV_REST_API_URL ||
      process.env.UPSTASH_REDIS_REST_URL;

    const resolvedToken =
      token ||
      process.env.KV_REST_API_TOKEN ||
      process.env.UPSTASH_REDIS_REST_TOKEN;

    if (!resolvedUrl || !resolvedToken) {
      throw new Error(
        '[UpstashTokenBucket] Missing REST URL or token. ' +
        'Set KV_REST_API_URL + KV_REST_API_TOKEN (or UPSTASH_REDIS_REST_* variants).'
      );
    }

    this.client = new UpstashRedis({ url: resolvedUrl, token: resolvedToken });
  }

  private key(agentId: string) {
    return `token_bucket:${agentId}`;
  }

  /**
   * Fully atomic check-and-decrement.
   *
   * The GET, the budget check, and the SET are all inside a single Lua script
   * sent to Upstash's /eval endpoint. Redis executes Lua atomically — no other
   * command can interleave between the read and the write. There are no
   * separate client-side GET/SET calls and no retry loop needed.
   *
   * Returns: [allowed(0|1), remaining_after_operation]
   */
  async acquireReserveToken(
    agentId: string,
    amountPaise: number,
    sessionCapPaise?: number
  ): Promise<TokenBucketAcquireResult> {
    const k = this.key(agentId);
    const cap = sessionCapPaise || 1000000;

    try {
      const res = await this.client.eval(
        `local current = redis.call('get', KEYS[1])
         if not current then
           current = tonumber(ARGV[2])
         else
           current = tonumber(current)
         end
         local amount = tonumber(ARGV[1])
         if current >= amount then
           local remaining = current - amount
           redis.call('set', KEYS[1], tostring(remaining))
           return {1, remaining}
         else
           return {0, current}
         end`,
        [k],
        [amountPaise.toString(), cap.toString()]
      ) as [number, number];

      const allowed = res[0] === 1;
      const remaining = res[1];
      return { allowed, remainingPaise: remaining, remainingBudgetPaise: remaining };
    } catch (err) {
      console.error('[UpstashTokenBucket] acquireReserveToken error', err);
      // Fail-closed in production
      if (process.env.NODE_ENV === 'production') {
        return {
          allowed: false,
          remainingPaise: 0,
          remainingBudgetPaise: 0,
          reason: 'Budget cluster unavailable — request rejected (fail-closed).',
        };
      }
      return this.fallback.acquireReserveToken(agentId, amountPaise, sessionCapPaise);
    }
  }

  async acquireReserve(agentId: string, requestedPaise: number, initialTotalPaise?: number): Promise<TokenBucketAcquireResult> {
    return this.acquireReserveToken(agentId, requestedPaise, initialTotalPaise);
  }

  async releaseReserveToken(agentId: string, amountPaise: number): Promise<number> {
    try {
      const k = this.key(agentId);
      // INCRBY is safe without CAS — releasing can never cause an overspend
      const updated = await this.client.incrby(k, amountPaise);
      return updated;
    } catch (err) {
      console.error('[UpstashTokenBucket] releaseReserveToken error', err);
      return 0;
    }
  }

  async releaseReserve(agentId: string, amountPaise: number): Promise<number> {
    return this.releaseReserveToken(agentId, amountPaise);
  }

  async refundReserve(agentId: string, amountPaise: number): Promise<number> {
    return this.releaseReserveToken(agentId, amountPaise);
  }

  async setRemainingBudget(agentId: string, remainingPaise: number): Promise<void> {
    try {
      await this.client.set(this.key(agentId), remainingPaise.toString());
    } catch (err) {
      console.error('[UpstashTokenBucket] setRemainingBudget error', err);
    }
  }

  async getRemainingBudget(agentId: string): Promise<number> {
    try {
      const val = await this.client.get<string>(this.key(agentId));
      return val !== null ? parseInt(val as string, 10) : 100000;
    } catch {
      return this.fallback.getRemainingBudget(agentId);
    }
  }

  async reset(agentId?: string): Promise<void> {
    try {
      if (agentId) {
        await this.client.del(this.key(agentId));
      } else {
        // Scan-delete all token_bucket:* keys
        let cursor = 0;
        do {
          const [nextCursor, keys] = await this.client.scan(cursor, { match: 'token_bucket:*', count: 100 });
          cursor = nextCursor;
          if (keys.length > 0) {
            await this.client.del(...keys);
          }
        } while (cursor !== 0);
      }
    } catch (err) {
      console.error('[UpstashTokenBucket] reset error', err);
    }
  }

  async close(): Promise<void> {
    // HTTP client — nothing to close
  }
}

// ---------------------------------------------------------------------------
// RedisTokenBucket — ioredis TCP client, for local dev with a plain REDIS_URL
// ---------------------------------------------------------------------------
export class RedisTokenBucket implements IRedisTokenBucket {
  private client: Redis | null = null;
  private fallback = new InMemoryTokenBucket();

  constructor(redisUrl?: string) {
    if (redisUrl || process.env.REDIS_URL) {
      try {
        this.client = new Redis(redisUrl || process.env.REDIS_URL!);
      } catch (err) {
        console.warn('[RedisTokenBucket] Failed to connect to Redis', err);
      }
    }
  }

  private async failClosedFallback(agentId: string, amountPaise: number, sessionCapPaise?: number): Promise<TokenBucketAcquireResult> {
    if (process.env.NODE_ENV === 'production') {
      return {
        allowed: false,
        remainingPaise: 0,
        remainingBudgetPaise: 0,
        reason: 'Distributed budget cluster (Redis) unavailable. Request rejected under Fail-Closed policy.',
      };
    }
    return this.fallback.acquireReserveToken(agentId, amountPaise, sessionCapPaise);
  }

  async acquireReserve(agentId: string, requestedPaise: number, initialTotalPaise?: number): Promise<TokenBucketAcquireResult> {
    return this.acquireReserveToken(agentId, requestedPaise, initialTotalPaise);
  }

  async acquireReserveToken(agentId: string, amountPaise: number, sessionCapPaise?: number): Promise<TokenBucketAcquireResult> {
    if (!this.client) return this.failClosedFallback(agentId, amountPaise, sessionCapPaise);
    try {
      const key = `token_bucket:${agentId}`;
      const defaultCap = sessionCapPaise || 1000000;
      const res = (await this.client.eval(LUA_ACQUIRE_SCRIPT, 1, key, amountPaise.toString(), defaultCap.toString())) as [number, number];
      const allowed = res[0] === 1;
      const remainingBudgetPaise = res[1];
      return { allowed, remainingPaise: remainingBudgetPaise, remainingBudgetPaise };
    } catch {
      return this.failClosedFallback(agentId, amountPaise, sessionCapPaise);
    }
  }

  async releaseReserve(agentId: string, amountPaise: number): Promise<number> {
    return this.releaseReserveToken(agentId, amountPaise);
  }

  async releaseReserveToken(agentId: string, amountPaise: number): Promise<number> {
    if (!this.client) {
      if (process.env.NODE_ENV === 'production') return 0;
      return this.fallback.releaseReserveToken(agentId, amountPaise);
    }
    try {
      return await this.client.incrby(`token_bucket:${agentId}`, amountPaise);
    } catch {
      if (process.env.NODE_ENV === 'production') return 0;
      return this.fallback.releaseReserveToken(agentId, amountPaise);
    }
  }

  async refundReserve(agentId: string, amountPaise: number): Promise<number> {
    return this.releaseReserveToken(agentId, amountPaise);
  }

  async setRemainingBudget(agentId: string, remainingPaise: number): Promise<void> {
    if (!this.client) {
      if (process.env.NODE_ENV !== 'production') this.fallback.setRemainingBudget(agentId, remainingPaise);
      return;
    }
    try {
      await this.client.set(`token_bucket:${agentId}`, remainingPaise.toString());
    } catch {
      if (process.env.NODE_ENV !== 'production') this.fallback.setRemainingBudget(agentId, remainingPaise);
    }
  }

  async getRemainingBudget(agentId: string): Promise<number> {
    if (!this.client) return this.fallback.getRemainingBudget(agentId);
    try {
      const val = await this.client.get(`token_bucket:${agentId}`);
      return val !== null ? parseInt(val, 10) : 100000;
    } catch {
      return this.fallback.getRemainingBudget(agentId);
    }
  }

  async reset(agentId?: string): Promise<void> {
    if (this.client) {
      if (agentId) {
        await this.client.del(`token_bucket:${agentId}`);
      } else {
        const keys = await this.client.keys('token_bucket:*');
        if (keys.length > 0) await this.client.del(...keys);
      }
    }
    return this.fallback.reset(agentId);
  }

  async close(): Promise<void> {
    if (this.client) await this.client.quit();
  }
}

// ---------------------------------------------------------------------------
// Singleton — replaced at startup by instrumentation.ts
// ---------------------------------------------------------------------------
let activeBucket: IRedisTokenBucket = new InMemoryTokenBucket();

export function getTokenBucket(): IRedisTokenBucket {
  return activeBucket;
}

export function setTokenBucket(bucket: IRedisTokenBucket): void {
  activeBucket = bucket;
}
