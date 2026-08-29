import Redis from 'ioredis';
import { EventEmitter } from 'events';

const REDIS_URL = process.env.REDIS_URL;

let pubClient: Redis | null = null;
let subClient: Redis | null = null;
const localEmitter = new EventEmitter();
let isSubscribed = false;
let redisAvailable = !!REDIS_URL;

function getRedisClient(role: 'pub' | 'sub'): Redis | null {
  if (!REDIS_URL || !redisAvailable || process.env.NODE_ENV === 'test') {
    return null;
  }

  try {
    const client = new Redis(REDIS_URL, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      lazyConnect: true,
      retryStrategy: () => null, // Do not repeat reconnection attempts if Redis is unreachable
    });

    client.on('error', (err) => {
      if (redisAvailable) {
        console.warn(
          `[Redis ${role.toUpperCase()} Notice] Redis unreachable (${(err as Error)?.message || 'ECONNREFUSED'}). Operating with in-memory SSE event bus.`
        );
        redisAvailable = false;
      }
    });

    return client;
  } catch {
    redisAvailable = false;
    return null;
  }
}

export async function publishUpdate() {
  // Always emit to local in-memory emitter for instant SSE sync
  localEmitter.emit('update');

  if (process.env.NODE_ENV === 'test' || !REDIS_URL || !redisAvailable) {
    return;
  }

  try {
    if (!pubClient) {
      pubClient = getRedisClient('pub');
      if (pubClient) {
        await pubClient.connect().catch(() => {
          redisAvailable = false;
        });
      }
    }

    if (pubClient && pubClient.status === 'ready') {
      await pubClient.publish('reserve_pay_updates', 'update');
    }
  } catch {
    redisAvailable = false;
  }
}

export function subscribeToUpdates(callback: () => void): () => void {
  if (process.env.NODE_ENV !== 'test' && REDIS_URL && redisAvailable && !isSubscribed) {
    try {
      if (!subClient) {
        subClient = getRedisClient('sub');
      }

      if (subClient) {
        subClient
          .connect()
          .then(() => {
            subClient?.subscribe('reserve_pay_updates', (err) => {
              if (err) {
                redisAvailable = false;
              }
            });

            subClient?.on('message', (channel, message) => {
              if (channel === 'reserve_pay_updates' && message === 'update') {
                localEmitter.emit('update');
              }
            });
            isSubscribed = true;
          })
          .catch(() => {
            redisAvailable = false;
          });
      }
    } catch {
      redisAvailable = false;
    }
  }

  localEmitter.on('update', callback);

  return () => {
    localEmitter.off('update', callback);
  };
}

