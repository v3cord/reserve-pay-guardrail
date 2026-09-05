import { 
  IReserveStore, Policy, ReserveState, Transaction, AttemptedPurchase, 
  GuardCheckResult, SettleResult, ReleaseResult, RefundResult, DisputeResult, 
  SecurityAuditEvent, LedgerIntegrityResult, LedgerEvent 
} from './types';
import { PostgresReserveStore } from './postgresStore';
import { SqliteReserveStore } from './sqliteStore';
import { publishUpdate } from './events';

export { GENESIS_PREV_HASH, calculateTransactionHash } from './crypto';
export { setTokenBucket, getTokenBucket, InMemoryTokenBucket, RedisTokenBucket, UpstashTokenBucket } from './tokenBucket';
export { PostgresReserveStore } from './postgresStore';
export { SqliteReserveStore } from './sqliteStore';

let activeStoreInstance: IReserveStore | null = null;
let postgresInitialized = false;

export function getStore(): IReserveStore {
  if (!activeStoreInstance) {
    if (process.env.DATABASE_URL && process.env.NODE_ENV !== 'test') {
      console.log('UPDATED TO SUPABASE');
      activeStoreInstance = new PostgresReserveStore();
    } else {
      activeStoreInstance = new SqliteReserveStore();
    }
  }
  return activeStoreInstance;
}

async function ensureInitialized() {
  if (activeStoreInstance?.storeType === 'postgres' && !postgresInitialized) {
    const { initPostgresDatabase } = await import('./db');
    await initPostgresDatabase();
    postgresInitialized = true;
  }
}

export function getReserveStore(): IReserveStore {
  return getStore();
}

export function setStoreInstance(store: IReserveStore): void {
  activeStoreInstance = store;
}

export async function getLastTransactionHash(agentId = 'default_agent'): Promise<string> {
  await ensureInitialized();
  const store = getStore();
  if (store.getLastTransactionHash) {
    return await store.getLastTransactionHash(agentId);
  }
  return '0000000000000000000000000000000000000000000000000000000000000000';
}

export async function getActivePolicy(agentId = 'default_agent'): Promise<Policy> {
  await ensureInitialized();
  return await getStore().getActivePolicy(agentId);
}

export async function getPolicy(agentId = 'default_agent'): Promise<Policy> {
  await ensureInitialized();
  return await getStore().getPolicy(agentId);
}

export async function setActivePolicy(policy: Policy, agentId = 'default_agent'): Promise<Policy> {
  await ensureInitialized();
  return await getStore().setActivePolicy(policy, agentId);
}

export async function setPolicy(policy: Policy, agentId = 'default_agent'): Promise<Policy> {
  await ensureInitialized();
  return await getStore().setPolicy(policy, agentId);
}

export async function getReserveState(agentId = 'default_agent', filterSessionId?: string): Promise<ReserveState> {
  await ensureInitialized();
  return await getStore().getReserveState(agentId, filterSessionId);
}

export async function setReserveState(
  state: ReserveState | { totalPaise?: number; heldPaise?: number; settledPaise?: number; total?: number; remaining?: number; transactions?: Transaction[] },
  agentId = 'default_agent'
): Promise<ReserveState> {
  await ensureInitialized();
  const res = await getStore().setReserveState(state, agentId);
  await publishUpdate();
  return res;
}

export async function recordTransaction(transaction: Transaction): Promise<Transaction> {
  await ensureInitialized();
  const store = getStore() as unknown as { recordTransaction?: (tx: Transaction) => Promise<Transaction> };
  const res = store.recordTransaction ? await store.recordTransaction(transaction) : transaction;
  await publishUpdate();
  return res;
}

export async function processPurchaseAtomic(
  purchase: AttemptedPurchase & { override?: boolean }
): Promise<GuardCheckResult> {
  await ensureInitialized();
  const res = await getStore().processPurchaseAtomic(purchase);
  await publishUpdate();
  return res;
}

export async function settleTransaction(
  txIdOrOrderId: string,
  razorpayPaymentId?: string,
  agentId = 'default_agent'
): Promise<SettleResult> {
  await ensureInitialized();
  const res = await getStore().settleTransaction(txIdOrOrderId, razorpayPaymentId, agentId);
  await publishUpdate();
  return res;
}

export async function releaseReservation(
  txIdOrOrderId: string,
  reason = 'Reservation released/expired',
  agentId = 'default_agent'
): Promise<ReleaseResult> {
  await ensureInitialized();
  const res = await getStore().releaseReservation(txIdOrOrderId, reason, agentId);
  await publishUpdate();
  return res;
}

export async function processRefund(
  orderIdOrPaymentId: string,
  refundAmountPaise: number,
  refundId?: string,
  reason?: string,
  agentId = 'default_agent'
): Promise<RefundResult> {
  await ensureInitialized();
  const res = await getStore().processRefund(orderIdOrPaymentId, refundAmountPaise, refundId, reason, agentId);
  await publishUpdate();
  return res;
}

export async function disputeTransaction(
  orderIdOrPaymentId: string,
  disputeReason?: string,
  disputeId?: string | null,
  agentId = 'default_agent'
): Promise<DisputeResult> {
  await ensureInitialized();
  const res = await getStore().disputeTransaction(orderIdOrPaymentId, disputeReason, disputeId, agentId);
  await publishUpdate();
  return res;
}

export async function verifyLedgerIntegrity(agentId = 'default_agent'): Promise<LedgerIntegrityResult> {
  await ensureInitialized();
  return await getStore().verifyLedgerIntegrity(agentId);
}

export async function resetStore(agentId?: string): Promise<void> {
  await ensureInitialized();
  await getStore().resetStore(agentId);
  await publishUpdate();
}

export async function recordSecurityAudit(event: SecurityAuditEvent): Promise<SecurityAuditEvent> {
  await ensureInitialized();
  return await getStore().recordSecurityAudit(event);
}

export async function getSecurityAuditLogs(limit = 50): Promise<SecurityAuditEvent[]> {
  await ensureInitialized();
  return await getStore().getSecurityAuditLogs(limit);
}

export async function getLastLedgerEventHash(agentId = 'default_agent'): Promise<string> {
  await ensureInitialized();
  const store = getStore();
  if (store.getLastLedgerEventHash) {
    return await store.getLastLedgerEventHash(agentId);
  }
  return '0000000000000000000000000000000000000000000000000000000000000000';
}

export async function appendLedgerEvent(
  event: Omit<LedgerEvent, 'id' | 'sequenceNum' | 'prevHash' | 'hash'>
): Promise<LedgerEvent> {
  await ensureInitialized();
  const res = await getStore().appendLedgerEvent(event);
  await publishUpdate();
  return res;
}

export async function getLedgerEvents(agentId = 'default_agent', limit = 50): Promise<LedgerEvent[]> {
  await ensureInitialized();
  return await getStore().getLedgerEvents(agentId, limit);
}

export async function claimIdempotencyKey(
  tenantId: string,
  agentId: string,
  key: string,
  requestHash: string
) {
  await ensureInitialized();
  return await getStore().claimIdempotencyKey(tenantId, agentId, key, requestHash);
}

export async function completeIdempotencyKey(
  tenantId: string,
  agentId: string,
  key: string,
  response: Record<string, unknown>
): Promise<void> {
  await ensureInitialized();
  await getStore().completeIdempotencyKey(tenantId, agentId, key, response);
}

export async function failIdempotencyKey(
  tenantId: string,
  agentId: string,
  key: string
): Promise<void> {
  await ensureInitialized();
  await getStore().failIdempotencyKey(tenantId, agentId, key);
}

export async function flagOrderCreationUnknown(txId: string, agentId = 'default_agent'): Promise<void> {
  await ensureInitialized();
  await getStore().flagOrderCreationUnknown(txId, agentId);
  await publishUpdate();
}

export async function attachRazorpayOrder(
  txId: string,
  razorpayOrderId: string,
  agentId = 'default_agent'
): Promise<void> {
  await ensureInitialized();
  await getStore().attachRazorpayOrder(txId, razorpayOrderId, agentId);
  await publishUpdate();
}

export async function claimWebhookEvent(
  eventId: string,
  eventType: string,
  payloadHash: string
): Promise<boolean> {
  await ensureInitialized();
  return await getStore().claimWebhookEvent(eventId, eventType, payloadHash);
}

export async function rebuildHashChainForAgent(agentId = 'default_agent'): Promise<void> {
  await ensureInitialized();
  const store = getStore();
  if (store.rebuildHashChainForAgent) {
    await store.rebuildHashChainForAgent(agentId);
  }
}

export async function expireStaleTransactions(agentId = 'default_agent'): Promise<number> {
  await ensureInitialized();
  const store = getStore();
  if (store.expireStaleTransactions) {
    const res = await store.expireStaleTransactions(agentId);
    if (res > 0) await publishUpdate();
    return res;
  }
  return 0;
}

export async function getTransactionByIdOrOrderId(identifier: string, agentId?: string): Promise<import('./types').Transaction | null> {
  await ensureInitialized();
  const store = getStore();
  if (store.getTransactionByIdOrOrderId) {
    return await store.getTransactionByIdOrOrderId(identifier, agentId);
  }
  return null;
}

