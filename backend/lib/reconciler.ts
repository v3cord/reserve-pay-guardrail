import db from './db';
import { getStore, appendLedgerEvent, releaseReservation } from './store';
import { getRazorpayClient } from './razorpayClient';
import { Transaction } from './types';

export interface ReconciliationSummary {
  scannedCount: number;
  orderReconciledCount: number;
  reservationReleasedCount: number;
  errors: string[];
}

export async function runReconciliation(agentId?: string): Promise<ReconciliationSummary> {
  const summary: ReconciliationSummary = {
    scannedCount: 0,
    orderReconciledCount: 0,
    reservationReleasedCount: 0,
    errors: [],
  };

  try {
    let unknownTxs: { id: string; agentId: string; amount: number; paymentStatus?: string; status?: string; razorpayOrderId?: string; timestamp: string }[] = [];

    if (process.env.STORAGE_TYPE === 'postgres' || process.env.POSTGRES_URL) {
      const store = getStore();
      const state = await store.getReserveState(agentId);
      unknownTxs = state.transactions
        .filter((t) => t.paymentStatus === 'order_creation_unknown')
        .map((t) => ({
          id: t.id,
          agentId: t.agentId || 'default_agent',
          amount: t.amount,
          paymentStatus: t.paymentStatus,
          status: t.status,
          razorpayOrderId: t.razorpayOrderId,
          timestamp: t.timestamp,
        }));
    } else {
      let query = "SELECT id, agentId, amount, paymentStatus, status, razorpayOrderId, timestamp FROM transactions WHERE paymentStatus = 'order_creation_unknown'";
      const params: any[] = [];
      if (agentId) {
        query += ' AND agentId = ?';
        params.push(agentId);
      }
      unknownTxs = db.prepare(query).all(...params) as any[];
    }

    summary.scannedCount = unknownTxs.length;
    const rzp = getRazorpayClient();

    for (const tx of unknownTxs) {
      try {
        const receiptRef = tx.id.length > 40 ? tx.id.slice(0, 40) : tx.id;
        let matchedOrder: any = null;

        if (rzp && rzp.orders) {
          try {
            if (typeof (rzp.orders as any).fetchByReceipt === 'function') {
              matchedOrder = await (rzp.orders as any).fetchByReceipt(receiptRef);
            } else if (tx.razorpayOrderId) {
              matchedOrder = await rzp.orders.fetch(tx.razorpayOrderId);
            }
          } catch {
            matchedOrder = null;
          }
        }

        if (matchedOrder && matchedOrder.id) {
          if (process.env.STORAGE_TYPE !== 'postgres' && !process.env.POSTGRES_URL) {
            db.prepare(`
              UPDATE transactions
              SET paymentStatus = 'order_created', razorpayOrderId = ?, reason = 'Reconciled: matched existing Razorpay order'
              WHERE id = ?
            `).run(matchedOrder.id, tx.id);
          }

          await appendLedgerEvent({
            transactionId: tx.id,
            tenantId: 'default_tenant',
            agentId: tx.agentId || 'default_agent',
            eventType: 'ORDER_RECONCILED',
            payload: {
              reconciliationAction: 'ORDER_MATCHED',
              razorpayOrderId: matchedOrder.id,
              amount: tx.amount,
            },
            timestamp: new Date().toISOString(),
          });

          summary.orderReconciledCount++;
        } else {
          await releaseReservation(tx.id, 'Reconciliation: Razorpay order was never created on gateway', tx.agentId);
          summary.reservationReleasedCount++;
        }
      } catch (txErr: any) {
        summary.errors.push(`Error reconciling tx ${tx.id}: ${txErr.message}`);
      }
    }
  } catch (err: any) {
    summary.errors.push(`Reconciliation error: ${err.message}`);
  }

  return summary;
}
