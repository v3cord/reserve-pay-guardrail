import Redis from 'ioredis';
import { EventEmitter } from 'events';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

let pubClient: Redis | null = null;
let subClient: Redis | null = null;
const localEmitter = new EventEmitter();
let isSubscribed = false;

export async function publishUpdate() {
  // Only use Redis if we are not in a test environment to prevent vitest hanging
  if (process.env.NODE_ENV === 'test') {
    localEmitter.emit('update');
    return;
  }
  
  if (!pubClient) {
    pubClient = new Redis(REDIS_URL);
    pubClient.on('error', (err) => console.error('[Redis Pub Error]', err));
  }
  await pubClient.publish('reserve_pay_updates', 'update');
}

export function subscribeToUpdates(callback: () => void): () => void {
  if (process.env.NODE_ENV !== 'test') {
    if (!subClient) {
      subClient = new Redis(REDIS_URL);
      subClient.on('error', (err) => console.error('[Redis Sub Error]', err));
    }
    
    if (!isSubscribed) {
      subClient.subscribe('reserve_pay_updates', (err) => {
        if (err) console.error('Failed to subscribe to Redis updates:', err);
      });

      subClient.on('message', (channel, message) => {
        if (channel === 'reserve_pay_updates' && message === 'update') {
          localEmitter.emit('update');
        }
      });
      isSubscribed = true;
    }
  }

  localEmitter.on('update', callback);

  return () => {
    localEmitter.off('update', callback);
  };
}
