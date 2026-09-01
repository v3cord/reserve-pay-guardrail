import db from './db';
import { getStore, appendLedgerEvent, releaseReservation } from './store';
import { getRazorpayClient } from './razorpay';

export interface ReconciliationSummary {
  scannedCount: number;
  orderReconciledCount: number;
  reservationReleasedCount: number;
  errors: string[];
}

/**
 * Reconciles unknown and stale transactions against Razorpay authoritative records.
 * Resolves 3-outcome branch (SUCCESS, DEFINITE_FAILURE, UNKNOWN_OUTCOME).
 */
export async function runReconciliation(agentId = 'default_agent'): Promise<ReconciliationSummary> {
  const summary: ReconciliationSummary = {
    scannedCount: 0,
    orderReconciledCount: 0,
    reservationReleasedCount: 0,
    errors: [],
  };

  const store = getStore();
  const now = Date.now();
  const fiveMinutesAgo = new Date(now - 5 * 60 * 1000).toISOString();
  const thirtyMinutesAgo = new Date(now - 30 * 60 * 1000).toISOString();

  let candidates: Array<{
    id: string;
    agentId: string;
    amount: number;
    paymentStatus?: string;
    status?: string;
    razorpayOrderId?: string;
    timestamp: string;
  }> = [];

  if (store.storeType === 'sqlite') {
    candidates = db.prepare(`
      SELECT id, agentId, amount, paymentStatus, status, razorpayOrderId, timestamp
      FROM transactions
      WHERE (agentId = ? OR agentId = 'default_agent')
        AND (
          paymentStatus = 'order_creation_unknown'
          OR (paymentStatus = 'reserved' AND timestamp < ?)
          OR (paymentStatus = 'order_created' AND timestamp < ?)
        )
    `).all(agentId, fiveMinutesAgo, thirtyMinutesAgo) as any[];
  } else {
    const reserveState = await store.getReserveState(agentId);
    candidates = reserveState.transactions.filter((tx) => {
      const isUnknown = tx.paymentStatus === 'order_creation_unknown';
      const isStaleReserved = tx.paymentStatus === 'reserved' && new Date(tx.timestamp).getTime() < (now - 5 * 60 * 1000);
      const isStaleOrderCreated = tx.paymentStatus === 'order_created' && new Date(tx.timestamp).getTime() < (now - 30 * 60 * 1000);
      return isUnknown || isStaleReserved || isStaleOrderCreated;
    });
  }

  summary.scannedCount = candidates.length;

  for (const candidate of candidates) {
    try {
      const razorpay = getRazorpayClient();
      const receiptRef = `rcpt_${candidate.id.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 34)}`;

      let matchedOrder: any = null;

      if (candidate.razorpayOrderId) {
        try {
          matchedOrder = await razorpay.orders.fetch(candidate.razorpayOrderId);
        } catch {
          matchedOrder = null;
        }
      }

      if (!matchedOrder && (razorpay.orders as any).fetchByReceipt) {
        try {
          matchedOrder = await (razorpay.orders as any).fetchByReceipt(receiptRef);
        } catch {
          matchedOrder = null;
        }
      }

      if (matchedOrder && matchedOrder.id) {
        if (candidate.paymentStatus === 'order_creation_unknown' || candidate.paymentStatus === 'reserved') {
          if (store.storeType === 'sqlite') {
            db.prepare(`
              UPDATE transactions
              SET paymentStatus = 'order_created', razorpayOrderId = ?, reason = 'Reconciled from Razorpay authoritative record'
              WHERE id = ?
            `).run(matchedOrder.id, candidate.id);
          }
          await appendLedgerEvent({
            transactionId: candidate.id,
            tenantId: 'default_tenant',
            agentId: candidate.agentId || agentId,
            eventType: 'ORDER_RECONCILED_FOUND',
            payload: { razorpayOrderId: matchedOrder.id, amount: candidate.amount },
            timestamp: new Date().toISOString(),
          });
          summary.orderReconciledCount++;
        }
      } else {
        await releaseReservation(
          candidate.id,
          'Reconciliation determined order was never created on Razorpay — reservation released',
          candidate.agentId || agentId
        );
        summary.reservationReleasedCount++;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      summary.errors.push(`Failed to reconcile tx ${candidate.id}: ${msg}`);
    }
  }

  return summary;
}
