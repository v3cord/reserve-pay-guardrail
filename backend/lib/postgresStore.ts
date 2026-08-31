import { getPgPool } from './db';
import { Pool } from 'pg';
import {
  Policy, ReserveState, Transaction, AttemptedPurchase, GuardCheckResult,
  TransactionStatus, SecurityAuditEvent, IReserveStore, ReserveStoreType,
  SettleResult, ReleaseResult, RefundResult, DisputeResult, LedgerIntegrityResult,
  IRedisTokenBucket
} from './types';
import { guardCheck } from './guardCheck';
import { calculateTransactionHash, GENESIS_PREV_HASH } from './crypto';
import { getTokenBucket } from './tokenBucket';

export class PostgresReserveStore implements IReserveStore {
  readonly storeType: ReserveStoreType = 'postgres';
  private pool: Pool;
  private tokenBucket: IRedisTokenBucket;

  constructor(pool?: Pool, tokenBucket?: IRedisTokenBucket) {
    this.pool = pool || getPgPool();
    this.tokenBucket = tokenBucket || getTokenBucket();
    console.log('UPDATED TO SUPABASE');
  }

  async getLastTransactionHash(agentId = 'default_agent'): Promise<string> {
    const res = await this.pool.query(
      'SELECT hash FROM transactions WHERE agent_id = $1 ORDER BY sequence_num DESC LIMIT 1',
      [agentId]
    );
    return res.rows.length > 0 && res.rows[0].hash ? res.rows[0].hash : GENESIS_PREV_HASH;
  }

  async getActivePolicy(agentId = 'default_agent'): Promise<Policy> {
    const res = await this.pool.query(
      'SELECT * FROM policies WHERE agent_id = $1 LIMIT 1',
      [agentId]
    );
    if (res.rows.length === 0) {
      return {
        amountCeiling: 50000,
        category: 'Electronics',
        allowedMerchants: ['Amazon', 'BestBuy'],
        sessionCap: 100000,
      };
    }
    const row = res.rows[0];
    const allowedMerchants = typeof row.allowed_merchants === 'string' 
      ? JSON.parse(row.allowed_merchants) 
      : (row.allowed_merchants || ['Amazon', 'BestBuy']);

    const allowedMccCodes = row.allowed_mcc_codes
      ? (typeof row.allowed_mcc_codes === 'string' ? JSON.parse(row.allowed_mcc_codes) : row.allowed_mcc_codes)
      : undefined;

    return {
      amountCeiling: row.amount_ceiling ? parseInt(row.amount_ceiling, 10) : undefined,
      category: row.category || undefined,
      allowedMerchants,
      sessionCap: row.session_cap ? parseInt(row.session_cap, 10) : undefined,
      reasonableQuantity: row.reasonable_quantity ? parseFloat(row.reasonable_quantity) : undefined,
      allowedMccCodes,
      sessionId: row.session_id || undefined,
    };
  }

  async getPolicy(agentId = 'default_agent'): Promise<Policy> {
    return this.getActivePolicy(agentId);
  }

  async setActivePolicy(policy: Policy, agentId = 'default_agent'): Promise<Policy> {
    const allowedMerchantsJson = JSON.stringify(policy.allowedMerchants || []);
    const allowedMccCodesJson = policy.allowedMccCodes ? JSON.stringify(policy.allowedMccCodes) : null;

    await this.pool.query(`
      INSERT INTO policies (agent_id, tenant_id, amount_ceiling, category, allowed_merchants, session_cap, reasonable_quantity, allowed_mcc_codes, session_id)
      VALUES ($1, 'default_tenant', $2, $3, $4::jsonb, $5, $6, $7::jsonb, $8)
      ON CONFLICT (agent_id) DO UPDATE SET
        amount_ceiling = EXCLUDED.amount_ceiling,
        category = EXCLUDED.category,
        allowed_merchants = EXCLUDED.allowed_merchants,
        session_cap = EXCLUDED.session_cap,
        reasonable_quantity = EXCLUDED.reasonable_quantity,
        allowed_mcc_codes = EXCLUDED.allowed_mcc_codes,
        session_id = EXCLUDED.session_id,
        updated_at = NOW()
    `, [
      agentId,
      policy.amountCeiling ?? null,
      policy.category ?? null,
      allowedMerchantsJson,
      policy.sessionCap ?? null,
      policy.reasonableQuantity ?? null,
      allowedMccCodesJson,
      policy.sessionId ?? null,
    ]);

    return this.getActivePolicy(agentId);
  }

  async setPolicy(policy: Policy, agentId = 'default_agent'): Promise<Policy> {
    return this.setActivePolicy(policy, agentId);
  }

  async getReserveState(agentId = 'default_agent', filterSessionId?: string): Promise<ReserveState> {
    const res = await this.pool.query(
      'SELECT * FROM reserve_state WHERE agent_id = $1 LIMIT 1',
      [agentId]
    );

    let totalPaise = 200000;
    let heldPaise = 0;
    let settledPaise = 0;

    if (res.rows.length > 0) {
      totalPaise = parseInt(res.rows[0].total_paise, 10);
      heldPaise = parseInt(res.rows[0].held_paise, 10);
      settledPaise = parseInt(res.rows[0].settled_paise, 10);
    }

    let txQuery = 'SELECT * FROM (SELECT * FROM transactions WHERE agent_id = $1';
    const params: unknown[] = [agentId];
    if (filterSessionId) {
      txQuery += ' AND session_id = $2';
      params.push(filterSessionId);
    }
    txQuery += ' ORDER BY sequence_num DESC LIMIT 100) sub ORDER BY sequence_num ASC';

    const txRes = await this.pool.query(txQuery, params);

    const transactions: Transaction[] = txRes.rows.map((row) => ({
      id: row.id,
      merchant: row.merchant,
      amount: parseInt(row.amount, 10),
      category: row.category,
      quantity: row.quantity ? parseFloat(row.quantity) : undefined,
      status: row.status as TransactionStatus,
      reason: row.reason || undefined,
      timestamp: row.timestamp ? new Date(row.timestamp).toISOString() : new Date().toISOString(),
      mccCode: row.mcc_code || undefined,
      hash: row.hash || '',
      prevHash: row.prev_hash || '',
      razorpayOrderId: row.razorpay_order_id || undefined,
      razorpayPaymentId: row.razorpay_payment_id || undefined,
      agentId: row.agent_id || undefined,
      policyId: row.policy_id || undefined,
      sessionId: row.session_id || undefined,
      expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : undefined,
    }));

    return {
      totalPaise,
      heldPaise,
      settledPaise,
      availablePaise: totalPaise - heldPaise - settledPaise,
      transactions,
    };
  }

  async setReserveState(
    state: ReserveState | { totalPaise?: number; heldPaise?: number; settledPaise?: number },
    agentId = 'default_agent'
  ): Promise<ReserveState> {
    const totalPaise = state.totalPaise ?? 200000;
    const heldPaise = state.heldPaise ?? 0;
    const settledPaise = state.settledPaise ?? 0;

    await this.pool.query(`
      INSERT INTO reserve_state (agent_id, tenant_id, total_paise, held_paise, settled_paise)
      VALUES ($1, 'default_tenant', $2, $3, $4)
      ON CONFLICT (agent_id) DO UPDATE SET
        total_paise = EXCLUDED.total_paise,
        held_paise = EXCLUDED.held_paise,
        settled_paise = EXCLUDED.settled_paise,
        updated_at = NOW()
    `, [agentId, totalPaise, heldPaise, settledPaise]);

    return this.getReserveState(agentId);
  }

  async recordTransaction(transaction: Transaction): Promise<Transaction> {
    const agentId = transaction.agentId || 'default_agent';
    const prevHash = transaction.prevHash || await this.getLastTransactionHash(agentId);
    const hash = transaction.hash || calculateTransactionHash({ ...transaction, prevHash });

    await this.pool.query(`
      INSERT INTO transactions (
        id, agent_id, tenant_id, merchant, amount, category, quantity, status, reason,
        timestamp, mcc_code, hash, prev_hash, razorpay_order_id, razorpay_payment_id,
        policy_id, session_id, expires_at
      ) VALUES ($1, $2, 'default_tenant', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
      ON CONFLICT (id) DO UPDATE SET
        status = EXCLUDED.status,
        reason = EXCLUDED.reason,
        razorpay_payment_id = EXCLUDED.razorpay_payment_id,
        hash = EXCLUDED.hash
    `, [
      transaction.id,
      agentId,
      transaction.merchant,
      transaction.amount,
      transaction.category,
      transaction.quantity ?? null,
      transaction.status,
      transaction.reason ?? null,
      transaction.timestamp || new Date().toISOString(),
      transaction.mccCode ?? null,
      hash,
      prevHash,
      transaction.razorpayOrderId ?? null,
      transaction.razorpayPaymentId ?? null,
      transaction.policyId ?? null,
      transaction.sessionId ?? null,
      transaction.expiresAt ?? null,
    ]);

    return { ...transaction, prevHash, hash };
  }

  async processPurchaseAtomic(
    purchase: AttemptedPurchase & { override?: boolean }
  ): Promise<GuardCheckResult> {
    const agentId = purchase.agentId || 'default_agent';

    if (!purchase.override) {
      const tokenResult = await this.tokenBucket.acquireReserve(agentId, purchase.amount);
      if (!tokenResult.allowed) {
        const currentState = await this.getReserveState(agentId, purchase.sessionId);
        return {
          decision: 'freeze',
          reason: tokenResult.reason || `Token bucket budget pool exceeded for agent ${agentId}`,
          updatedReserveState: currentState,
        };
      }
    }

    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      // Acquire row lock on reserve state
      let lockRes = await client.query('SELECT * FROM reserve_state WHERE agent_id = $1 FOR UPDATE', [agentId]);
      if (lockRes.rows.length === 0) {
        await client.query(
          "INSERT INTO reserve_state (agent_id, tenant_id, total_paise, held_paise, settled_paise) VALUES ($1, 'default_tenant', 200000, 0, 0) ON CONFLICT (agent_id) DO NOTHING",
          [agentId]
        );
        lockRes = await client.query('SELECT * FROM reserve_state WHERE agent_id = $1 FOR UPDATE', [agentId]);
      }

      const activePolicy = await this.getActivePolicy(agentId);
      const currentState = await this.getReserveState(agentId, purchase.sessionId);

      const result = guardCheck(purchase, activePolicy, currentState);

      if (result.decision === 'approve') {
        const tx = result.updatedReserveState.transactions[result.updatedReserveState.transactions.length - 1];
        if (tx) {
          const prevHash = await this.getLastTransactionHash(agentId);
          tx.prevHash = prevHash;
          tx.hash = calculateTransactionHash({ ...tx, prevHash });

          await client.query(`
            INSERT INTO transactions (
              id, agent_id, tenant_id, merchant, amount, category, quantity, status, reason,
              timestamp, mcc_code, hash, prev_hash, razorpay_order_id, policy_id, session_id, expires_at
            ) VALUES ($1, $2, 'default_tenant', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
          `, [
            tx.id, agentId, tx.merchant, tx.amount, tx.category, tx.quantity ?? null,
            tx.status, tx.reason ?? null, tx.timestamp, tx.mccCode ?? null,
            tx.hash, tx.prevHash, tx.razorpayOrderId ?? null, tx.policyId ?? null,
            tx.sessionId ?? null, tx.expiresAt ?? null
          ]);

          if (tx.status === 'reserved') {
            await client.query(
              'UPDATE reserve_state SET held_paise = held_paise + $1, updated_at = NOW() WHERE agent_id = $2',
              [tx.amount, agentId]
            );
          }
        }
      }

      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async settleTransaction(
    txIdOrOrderId: string,
    razorpayPaymentId?: string,
    agentId = 'default_agent'
  ): Promise<SettleResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const txRes = await client.query(
        'SELECT * FROM transactions WHERE (id = $1 OR razorpay_order_id = $1) AND agent_id = $2 FOR UPDATE',
        [txIdOrOrderId, agentId]
      );

      if (txRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return { success: false, error: 'Transaction not found' };
      }

      const tx = txRes.rows[0];
      const amount = parseInt(tx.amount, 10);

      await client.query(
        "UPDATE transactions SET status = 'captured', razorpay_payment_id = $1 WHERE id = $2",
        [razorpayPaymentId || null, tx.id]
      );

      if (tx.status === 'reserved') {
        await client.query(
          'UPDATE reserve_state SET held_paise = GREATEST(0, held_paise - $1), settled_paise = settled_paise + $1, updated_at = NOW() WHERE agent_id = $2',
          [amount, agentId]
        );
      }

      await client.query('COMMIT');
      return { success: true, transactionId: tx.id };
    } catch (err: unknown) {
      await client.query('ROLLBACK');
      const errorMsg = err instanceof Error ? err.message : String(err);
      return { success: false, error: errorMsg };
    } finally {
      client.release();
    }
  }

  async releaseReservation(
    txIdOrOrderId: string,
    reason = 'Reservation released/expired',
    agentId = 'default_agent'
  ): Promise<ReleaseResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const txRes = await client.query(
        'SELECT * FROM transactions WHERE (id = $1 OR razorpay_order_id = $1) AND agent_id = $2 FOR UPDATE',
        [txIdOrOrderId, agentId]
      );

      if (txRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return { success: false, error: 'Transaction not found' };
      }

      const tx = txRes.rows[0];
      const amount = parseInt(tx.amount, 10);

      if (tx.status === 'reserved' || tx.status === 'frozen') {
        await client.query(
          "UPDATE transactions SET status = 'skipped', reason = $1 WHERE id = $2",
          [reason, tx.id]
        );

        if (tx.status === 'reserved') {
          await client.query(
            'UPDATE reserve_state SET held_paise = GREATEST(0, held_paise - $1), updated_at = NOW() WHERE agent_id = $2',
            [amount, agentId]
          );
        }
      }

      await client.query('COMMIT');
      return { success: true, transactionId: tx.id, releasedAmountPaise: amount };
    } catch (err: unknown) {
      await client.query('ROLLBACK');
      const errorMsg = err instanceof Error ? err.message : String(err);
      return { success: false, error: errorMsg };
    } finally {
      client.release();
    }
  }

  async processRefund(
    orderIdOrPaymentId: string,
    refundAmountPaise: number,
    refundId?: string,
    reason?: string,
    agentId = 'default_agent'
  ): Promise<RefundResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const txRes = await client.query(
        'SELECT * FROM transactions WHERE (razorpay_order_id = $1 OR razorpay_payment_id = $1 OR id = $1) AND agent_id = $2 FOR UPDATE',
        [orderIdOrPaymentId, agentId]
      );

      if (txRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return { success: false, error: 'Target transaction for refund not found' };
      }

      const originalTx = txRes.rows[0];

      await client.query(
        'UPDATE reserve_state SET settled_paise = GREATEST(0, settled_paise - $1), updated_at = NOW() WHERE agent_id = $2',
        [refundAmountPaise, agentId]
      );

      const prevHash = await this.getLastTransactionHash(agentId);
      const refundTxId = refundId || `ref_${Date.now()}`;
      const timestamp = new Date().toISOString();
      const hash = calculateTransactionHash({
        id: refundTxId,
        timestamp,
        amount: refundAmountPaise,
        merchant: originalTx.merchant,
        status: 'refunded',
        prevHash,
      });

      await client.query(`
        INSERT INTO transactions (
          id, agent_id, tenant_id, merchant, amount, category, status, reason,
          timestamp, hash, prev_hash, razorpay_order_id, razorpay_payment_id
        ) VALUES ($1, $2, 'default_tenant', $3, $4, $5, 'refunded', $6, $7, $8, $9, $10, $11)
      `, [
        refundTxId, agentId, originalTx.merchant, refundAmountPaise, originalTx.category,
        reason || 'Refund processed', timestamp, hash, prevHash, originalTx.razorpay_order_id, originalTx.razorpay_payment_id
      ]);

      await client.query('COMMIT');
      return { success: true, refundId: refundTxId, refundedAmountPaise: refundAmountPaise };
    } catch (err: unknown) {
      await client.query('ROLLBACK');
      const errorMsg = err instanceof Error ? err.message : String(err);
      return { success: false, error: errorMsg };
    } finally {
      client.release();
    }
  }

  async disputeTransaction(
    orderIdOrPaymentId: string,
    disputeReason?: string,
    agentId = 'default_agent'
  ): Promise<DisputeResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const txRes = await client.query(
        'SELECT * FROM transactions WHERE (razorpay_order_id = $1 OR razorpay_payment_id = $1 OR id = $1) AND agent_id = $2 FOR UPDATE',
        [orderIdOrPaymentId, agentId]
      );

      if (txRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return { success: false, error: 'Transaction not found for dispute' };
      }

      const tx = txRes.rows[0];

      await client.query(
        "UPDATE transactions SET status = 'disputed', reason = $1 WHERE id = $2",
        [disputeReason || 'Payment dispute filed', tx.id]
      );

      await client.query('COMMIT');
      return { success: true, transactionId: tx.id, status: 'disputed' };
    } catch (err: unknown) {
      await client.query('ROLLBACK');
      const errorMsg = err instanceof Error ? err.message : String(err);
      return { success: false, error: errorMsg };
    } finally {
      client.release();
    }
  }

  async verifyLedgerIntegrity(agentId = 'default_agent', batchSize = 1000): Promise<LedgerIntegrityResult> {
    let offset = 0;
    let expectedPrevHash = GENESIS_PREV_HASH;
    let currentIndex = 0;

    while (true) {
      const res = await this.pool.query(
        'SELECT * FROM transactions WHERE agent_id = $1 ORDER BY sequence_num ASC LIMIT $2 OFFSET $3',
        [agentId, batchSize, offset]
      );

      if (res.rows.length === 0) break;

      for (let i = 0; i < res.rows.length; i++) {
        const row = res.rows[i];
        if (row.prev_hash !== expectedPrevHash) {
          return { isValid: false, corruptedIndex: currentIndex, reason: `Previous hash mismatch at index ${currentIndex}` };
        }
        const calculated = calculateTransactionHash({
          id: row.id,
          timestamp: new Date(row.timestamp).toISOString(),
          amount: parseInt(row.amount, 10),
          merchant: row.merchant,
          status: row.status,
          prevHash: row.prev_hash,
        });

        if (row.hash !== calculated) {
          return { isValid: false, corruptedIndex: currentIndex, reason: `Hash mismatch at index ${currentIndex}` };
        }

        expectedPrevHash = row.hash;
        currentIndex++;
      }

      if (res.rows.length < batchSize) break;
      offset += batchSize;
    }

    return { isValid: true };
  }

  async resetStore(agentId?: string): Promise<void> {
    if (agentId) {
      await this.pool.query('DELETE FROM transactions WHERE agent_id = $1', [agentId]);
      await this.pool.query('DELETE FROM policies WHERE agent_id = $1', [agentId]);
      await this.pool.query('DELETE FROM reserve_state WHERE agent_id = $1', [agentId]);
    } else {
      await this.pool.query('DELETE FROM transactions');
      await this.pool.query('DELETE FROM policies');
      await this.pool.query('DELETE FROM reserve_state');
    }
  }

  async recordSecurityAudit(event: SecurityAuditEvent): Promise<SecurityAuditEvent> {
    const id = event.id || `audit_${Date.now()}`;
    const timestamp = event.timestamp || new Date().toISOString();

    await this.pool.query(`
      INSERT INTO security_audit_logs (id, timestamp, event_type, role, identity, endpoint, method, details, ip)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `, [
      id, timestamp, event.eventType, event.role || null, event.identity || null,
      event.endpoint, event.method, event.details, event.ip || null
    ]);

    return { ...event, id, timestamp };
  }

  async getSecurityAuditLogs(limit = 50): Promise<SecurityAuditEvent[]> {
    const res = await this.pool.query(
      'SELECT * FROM security_audit_logs ORDER BY created_at DESC LIMIT $1',
      [limit]
    );

    return res.rows.map((row) => ({
      id: row.id,
      timestamp: new Date(row.timestamp).toISOString(),
      eventType: row.event_type,
      role: row.role || undefined,
      identity: row.identity || undefined,
      endpoint: row.endpoint,
      method: row.method,
      details: row.details,
      ip: row.ip || undefined,
    }));
  }
}
