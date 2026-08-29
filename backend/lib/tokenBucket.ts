import Redis from 'ioredis';
import { IRedisTokenBucket, TokenBucketAcquireResult } from './types';

// Lua script for atomic check-and-decrement in Redis
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
    // Fail-Closed Security in production: Reject request if Redis is unreachable
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
      
      // Atomic Lua script execution
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
      const key = `token_bucket:${agentId}`;
      const updated = await this.client.incrby(key, amountPaise);
      return updated;
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
    if (!this.client) {
      return this.fallback.getRemainingBudget(agentId);
    }
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
    if (this.client) {
      await this.client.quit();
    }
  }
}

let activeBucket: IRedisTokenBucket = new InMemoryTokenBucket();

export function getTokenBucket(): IRedisTokenBucket {
  return activeBucket;
}

export function setTokenBucket(bucket: IRedisTokenBucket): void {
  activeBucket = bucket;
}