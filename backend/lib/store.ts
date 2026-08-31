import { 
  IReserveStore, Policy, ReserveState, Transaction, AttemptedPurchase, 
  GuardCheckResult, SettleResult, ReleaseResult, RefundResult, DisputeResult, 
  SecurityAuditEvent, LedgerIntegrityResult 
} from './types';
import { PostgresReserveStore } from './postgresStore';
import { SqliteReserveStore } from './sqliteStore';
import { publishUpdate } from './events';

export { GENESIS_PREV_HASH, calculateTransactionHash } from './crypto';
export { setTokenBucket, getTokenBucket, InMemoryTokenBucket, RedisTokenBucket } from './tokenBucket';
export { PostgresReserveStore } from './postgresStore';
export { SqliteReserveStore } from './sqliteStore';

let activeStoreInstance: IReserveStore | null = null;

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

export function getReserveStore(): IReserveStore {
  return getStore();
}

export function setStoreInstance(store: IReserveStore): void {
  activeStoreInstance = store;
}

export async function getLastTransactionHash(agentId = 'default_agent'): Promise<string> {
  const store = getStore();
  if (store.getLastTransactionHash) {
    return await store.getLastTransactionHash(agentId);
  }
  return '0000000000000000000000000000000000000000000000000000000000000000';
}

export async function getActivePolicy(agentId = 'default_agent'): Promise<Policy> {
  return await getStore().getActivePolicy(agentId);
}

export async function getPolicy(agentId = 'default_agent'): Promise<Policy> {
  return await getStore().getPolicy(agentId);
}

export async function setActivePolicy(policy: Policy, agentId = 'default_agent'): Promise<Policy> {
  return await getStore().setActivePolicy(policy, agentId);
}

export async function setPolicy(policy: Policy, agentId = 'default_agent'): Promise<Policy> {
  return await getStore().setPolicy(policy, agentId);
}

export async function getReserveState(agentId = 'default_agent', filterSessionId?: string): Promise<ReserveState> {
  return await getStore().getReserveState(agentId, filterSessionId);
}

export async function setReserveState(
  state: ReserveState | { totalPaise?: number; heldPaise?: number; settledPaise?: number; total?: number; remaining?: number; transactions?: Transaction[] },
  agentId = 'default_agent'
): Promise<ReserveState> {
  const res = await getStore().setReserveState(state, agentId);
  await publishUpdate();
  return res;
}

export async function recordTransaction(transaction: Transaction): Promise<Transaction> {
  const res = await getStore().recordTransaction(transaction);
  await publishUpdate();
  return res;
}

export async function processPurchaseAtomic(
  purchase: AttemptedPurchase & { override?: boolean }
): Promise<GuardCheckResult> {
  const res = await getStore().processPurchaseAtomic(purchase);
  await publishUpdate();
  return res;
}

export async function settleTransaction(
  txIdOrOrderId: string,
  razorpayPaymentId?: string,
  agentId = 'default_agent'
): Promise<SettleResult> {
  const res = await getStore().settleTransaction(txIdOrOrderId, razorpayPaymentId, agentId);
  await publishUpdate();
  return res;
}

export async function releaseReservation(
  txIdOrOrderId: string,
  reason = 'Reservation released/expired',
  agentId = 'default_agent'
): Promise<ReleaseResult> {
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
  const res = await getStore().processRefund(orderIdOrPaymentId, refundAmountPaise, refundId, reason, agentId);
  await publishUpdate();
  return res;
}

export async function disputeTransaction(
  orderIdOrPaymentId: string,
  disputeReason?: string,
  agentId = 'default_agent'
): Promise<DisputeResult> {
  const res = await getStore().disputeTransaction(orderIdOrPaymentId, disputeReason, agentId);
  await publishUpdate();
  return res;
}

export async function verifyLedgerIntegrity(agentId = 'default_agent'): Promise<LedgerIntegrityResult> {
  return await getStore().verifyLedgerIntegrity(agentId);
}

export async function resetStore(agentId?: string): Promise<void> {
  await getStore().resetStore(agentId);
  await publishUpdate();
}

export async function recordSecurityAudit(event: SecurityAuditEvent): Promise<SecurityAuditEvent> {
  return await getStore().recordSecurityAudit(event);
}

export async function getSecurityAuditLogs(limit = 50): Promise<SecurityAuditEvent[]> {
  return await getStore().getSecurityAuditLogs(limit);
}

export async function rebuildHashChainForAgent(agentId = 'default_agent'): Promise<void> {
  const store = getStore();
  if (store.rebuildHashChainForAgent) {
    await store.rebuildHashChainForAgent(agentId);
  }
}

export async function expireStaleTransactions(agentId = 'default_agent'): Promise<number> {
  const store = getStore();
  if (store.expireStaleTransactions) {
    const res = await store.expireStaleTransactions(agentId);
    if (res > 0) await publishUpdate();
    return res;
  }
  return 0;
}
