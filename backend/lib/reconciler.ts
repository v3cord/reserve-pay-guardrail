import db, { getPgPool } from './db';
import { attachRazorpayOrder, appendLedgerEvent, releaseReservation } from './store';
import { getRazorpayClient } from './razorpayClient';

export interface ReconciliationSummary {
  scannedCount: number;
  orderReconciledCount: number;
  reservationReleasedCount: number;
  /** Transactions left in order_creation_unknown because gateway returned an error (not a definite miss). */
  keptUnknownCount: number;
  errors: string[];
}

interface ReconcileTxRecord {
  id: string;
  agentId: string;
  amount: number;
  paymentStatus?: string;
  status?: string;
  razorpayOrderId?: string;
  timestamp: string;
  /** How many reconciliation attempts have already been made (stored in DB). */
  reconcileAttempts: number;
}

/**
 * Maximum gateway-lookup attempts before we give up and release.
 * Keeps a temporary API outage from permanently stalling reservations,
 * while still not releasing on the first transient error.
 */
const MAX_RECONCILE_ATTEMPTS = 3;

export async function runReconciliation(agentId?: string): Promise<ReconciliationSummary> {
  const summary: ReconciliationSummary = {
    scannedCount: 0,
    orderReconciledCount: 0,
    reservationReleasedCount: 0,
    keptUnknownCount: 0,
    errors: [],
  };

  try {
    let unknownTxs: ReconcileTxRecord[] = [];

    if (process.env.STORAGE_TYPE === 'postgres' || process.env.POSTGRES_URL) {
      const pool = getPgPool();
      let query = `
        SELECT id, agent_id, amount, payment_status, status,
               razorpay_order_id, timestamp,
               COALESCE(reconcile_attempts, 0) AS reconcile_attempts
        FROM transactions
        WHERE payment_status = 'order_creation_unknown'
      `;
      const params: (string | number)[] = [];
      if (agentId) {
        query += ' AND agent_id = $1';
        params.push(agentId);
      }
      const res = await pool.query(query, params);
      unknownTxs = res.rows.map((r: {
        id: string;
        agent_id: string;
        amount: string | number;
        payment_status?: string;
        status?: string;
        razorpay_order_id?: string;
        timestamp: string;
        reconcile_attempts: string | number;
      }) => ({
        id: r.id,
        agentId: r.agent_id || 'default_agent',
        amount: typeof r.amount === 'string' ? parseInt(r.amount, 10) : r.amount,
        paymentStatus: r.payment_status,
        status: r.status,
        razorpayOrderId: r.razorpay_order_id,
        timestamp: new Date(r.timestamp).toISOString(),
        reconcileAttempts: typeof r.reconcile_attempts === 'string'
          ? parseInt(r.reconcile_attempts, 10)
          : (r.reconcile_attempts ?? 0),
      }));
    } else {
      // SQLite path — reconcile_attempts column may not exist; default to 0
      let query = `
        SELECT id, agentId, amount, paymentStatus, status,
               razorpayOrderId, timestamp,
               COALESCE(reconcileAttempts, 0) AS reconcileAttempts
        FROM transactions
        WHERE paymentStatus = 'order_creation_unknown'
      `;
      const params: (string | number)[] = [];
      if (agentId) {
        query += ' AND agentId = ?';
        params.push(agentId);
      }
      unknownTxs = (db.prepare(query).all(...params) as ReconcileTxRecord[]).map((r) => ({
        ...r,
        reconcileAttempts: (r.reconcileAttempts as unknown as number) ?? 0,
      }));
    }

    summary.scannedCount = unknownTxs.length;
    const rzp = getRazorpayClient();

    for (const tx of unknownTxs) {
      try {
        const receiptRef = tx.id.length > 40 ? tx.id.slice(0, 40) : tx.id;

        // ---------------------------------------------------------------
        // Three-way outcome classification for the gateway lookup:
        //
        //   FOUND       → order exists on Razorpay → attach & reconcile
        //   NOT_FOUND   → definite 404 / empty result → release after MAX_RECONCILE_ATTEMPTS
        //   API_ERROR   → network / 5xx / unexpected throw → keep UNKNOWN, increment counter
        // ---------------------------------------------------------------
        type GatewayOutcome =
          | { kind: 'FOUND'; order: { id: string; amount?: number; status?: string } }
          | { kind: 'NOT_FOUND' }
          | { kind: 'API_ERROR'; message: string };

        let outcome: GatewayOutcome = { kind: 'NOT_FOUND' };

        if (rzp && rzp.orders) {
          const ordersApi = rzp.orders as unknown as {
            fetchByReceipt?: (ref: string) => Promise<{ id?: string; amount?: number; status?: string } | null>;
            fetch?: (id: string) => Promise<{ id?: string; amount?: number; status?: string } | null>;
          };

          try {
            let result: { id?: string; amount?: number; status?: string } | null = null;

            if (typeof ordersApi.fetchByReceipt === 'function') {
              result = await ordersApi.fetchByReceipt(receiptRef);
            } else if (tx.razorpayOrderId && typeof ordersApi.fetch === 'function') {
              result = await ordersApi.fetch(tx.razorpayOrderId);
            }

            // A truthy id means Razorpay confirms the order exists
            if (result && result.id) {
              outcome = { kind: 'FOUND', order: { id: result.id, amount: result.amount, status: result.status } };
            } else {
              // Razorpay returned a response but no matching order — definite miss
              outcome = { kind: 'NOT_FOUND' };
            }
          } catch (gatewayErr: unknown) {
            // Any throw from the SDK is a transient API error, NOT a confirmed miss.
            // We must NOT release the reservation on a transient error.
            const msg = gatewayErr instanceof Error ? gatewayErr.message : String(gatewayErr);
            outcome = { kind: 'API_ERROR', message: msg };
          }
        }
        // If rzp client is unavailable, treat as API_ERROR so we don't release blindly
        else {
          outcome = { kind: 'API_ERROR', message: 'Razorpay client not initialised' };
        }

        // ---------------------------------------------------------------
        // Act on the outcome
        // ---------------------------------------------------------------
        if (outcome.kind === 'FOUND') {
          await attachRazorpayOrder(tx.id, outcome.order.id, tx.agentId);

          await appendLedgerEvent({
            transactionId: tx.id,
            tenantId: 'default_tenant',
            agentId: tx.agentId || 'default_agent',
            eventType: 'ORDER_RECONCILED_FOUND',
            payload: {
              reconciliationAction: 'ORDER_MATCHED',
              razorpayOrderId: outcome.order.id,
              amount: tx.amount,
            },
            timestamp: new Date().toISOString(),
          });

          summary.orderReconciledCount++;

        } else if (outcome.kind === 'NOT_FOUND') {
          const newAttempts = tx.reconcileAttempts + 1;

          if (newAttempts >= MAX_RECONCILE_ATTEMPTS) {
            // Razorpay has definitively not seen this order across multiple checks → safe to release
            await releaseReservation(
              tx.id,
              `Reconciliation: Razorpay order was never created on gateway (confirmed after ${newAttempts} attempt(s))`,
              tx.agentId
            );
            summary.reservationReleasedCount++;
          } else {
            // Still within grace period — increment counter and keep UNKNOWN for next run
            await incrementReconcileAttempts(tx.id, newAttempts);

            await appendLedgerEvent({
              transactionId: tx.id,
              tenantId: 'default_tenant',
              agentId: tx.agentId || 'default_agent',
              eventType: 'ORDER_RECONCILE_PENDING',
              payload: {
                reconciliationAction: 'NOT_FOUND_GRACE_PERIOD',
                attempt: newAttempts,
                maxAttempts: MAX_RECONCILE_ATTEMPTS,
              },
              timestamp: new Date().toISOString(),
            });

            summary.keptUnknownCount++;
          }

        } else {
          // API_ERROR — do NOT release; log and keep for next reconciliation run
          const newAttempts = tx.reconcileAttempts + 1;
          await incrementReconcileAttempts(tx.id, newAttempts);

          await appendLedgerEvent({
            transactionId: tx.id,
            tenantId: 'default_tenant',
            agentId: tx.agentId || 'default_agent',
            eventType: 'ORDER_RECONCILE_PENDING',
            payload: {
              reconciliationAction: 'API_ERROR_KEEP_UNKNOWN',
              attempt: newAttempts,
              errorMessage: outcome.message,
            },
            timestamp: new Date().toISOString(),
          });

          summary.keptUnknownCount++;
          summary.errors.push(`Gateway error reconciling tx ${tx.id} (attempt ${newAttempts}): ${outcome.message}`);
        }

      } catch (txErr: unknown) {
        const msg = txErr instanceof Error ? txErr.message : String(txErr);
        summary.errors.push(`Error reconciling tx ${tx.id}: ${msg}`);
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    summary.errors.push(`Reconciliation error: ${msg}`);
  }

  return summary;
}

/**
 * Increment the reconcile_attempts counter for a transaction row.
 * Works for both Postgres and SQLite; silently no-ops if the column
 * does not exist yet (older schema).
 */
async function incrementReconcileAttempts(txId: string, newCount: number): Promise<void> {
  try {
    if (process.env.STORAGE_TYPE === 'postgres' || process.env.POSTGRES_URL) {
      const pool = getPgPool();
      await pool.query(
        'UPDATE transactions SET reconcile_attempts = $1 WHERE id = $2',
        [newCount, txId]
      );
    } else {
      db.prepare('UPDATE transactions SET reconcileAttempts = ? WHERE id = ?').run(newCount, txId);
    }
  } catch {
    // Column might not exist on older schemas — fail silently so reconciler keeps running
  }
}
