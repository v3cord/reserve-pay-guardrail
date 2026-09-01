import { getPgPool } from './db';
import { Pool } from 'pg';
import {
  Policy, ReserveState, Transaction, AttemptedPurchase, GuardCheckResult,
  SecurityAuditEvent, IReserveStore, ReserveStoreType,
  SettleResult, ReleaseResult, RefundResult, DisputeResult, LedgerIntegrityResult,
  IRedisTokenBucket, LedgerEvent
} from './types';
import { guardCheck } from './guardCheck';
import { calculateTransactionHash, calculateLedgerEventHash, calculatePayloadHash, GENESIS_PREV_HASH } from './crypto';
import { getTokenBucket } from './tokenBucket';

export class PostgresReserveStore implements IReserveStore {
  readonly storeType: ReserveStoreType = 'postgres';
  private pool: Pool;
  private tokenBucket: IRedisTokenBucket;

  constructor(pool?: Pool, tokenBucket?: IRedisTokenBucket) {
    this.pool = pool || getPgPool();
    this.tokenBucket = tokenBucket || getTokenBucket();
  }

  async getLastTransactionHash(agentId = 'default_agent'): Promise<string> {
    const res = await this.pool.query(
      'SELECT hash FROM transactions WHERE agent_id = $1 ORDER BY sequence_num DESC LIMIT 1',
      [agentId]
    );
    return res.rows.length > 0 && res.rows[0].hash ? res.rows[0].hash : GENESIS_PREV_HASH;
  }

  async getLastLedgerEventHash(agentId = 'default_agent'): Promise<string> {
    const res = await this.pool.query(
      'SELECT hash FROM ledger_events WHERE agent_id = $1 ORDER BY sequence_num DESC LIMIT 1',
      [agentId]
    );
    return res.rows.length > 0 && res.rows[0].hash ? res.rows[0].hash : GENESIS_PREV_HASH;
  }

  async appendLedgerEvent(
    event: Omit<LedgerEvent, 'id' | 'sequenceNum' | 'prevHash' | 'hash'>
  ): Promise<LedgerEvent> {
    const eventId = `evt_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
    const timestamp = event.timestamp || new Date().toISOString();
    const prevHash = await this.getLastLedgerEventHash(event.agentId);

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const seqRes = await client.query(
        'SELECT COALESCE(MAX(sequence_num), 0) + 1 AS next_seq FROM ledger_events WHERE transaction_id = $1',
        [event.transactionId]
      );
      const sequenceNum = parseInt(seqRes.rows[0].next_seq, 10);

      const payloadHash = calculatePayloadHash(event.payload);
      const hash = calculateLedgerEventHash({
        id: eventId,
        transactionId: event.transactionId,
        eventType: event.eventType,
        timestamp,
        payloadHash,
        sequenceNum,
        prevHash,
      });

      await client.query(`
        INSERT INTO ledger_events (
          id, transaction_id, tenant_id, agent_id, event_type, payload,
          sequence_num, prev_hash, hash, policy_id, policy_version, timestamp
        ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12)
      `, [
        eventId,
        event.transactionId,
        event.tenantId || 'default_tenant',
        event.agentId || 'default_agent',
        event.eventType,
        JSON.stringify(event.payload || {}),
        sequenceNum,
        prevHash,
        hash,
        event.policyId || null,
        event.policyVersion || 1,
        timestamp,
      ]);

      await client.query('COMMIT');

      return {
        id: eventId,
        transactionId: event.transactionId,
        tenantId: event.tenantId || 'default_tenant',
        agentId: event.agentId || 'default_agent',
        eventType: event.eventType,
        payload: event.payload || {},
        sequenceNum,
        prevHash,
        hash,
        timestamp,
        policyId: event.policyId,
        policyVersion: event.policyVersion,
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async getLedgerEvents(agentId = 'default_agent', limit = 50): Promise<LedgerEvent[]> {
    const res = await this.pool.query(
      'SELECT * FROM ledger_events WHERE agent_id = $1 ORDER BY sequence_num DESC LIMIT $2',
      [agentId, limit]
    );

    return res.rows.map((r) => ({
      id: r.id,
      transactionId: r.transaction_id,
      tenantId: r.tenant_id,
      agentId: r.agent_id,
      eventType: r.event_type,
      payload: typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload,
      sequenceNum: parseInt(r.sequence_num, 10),
      prevHash: r.prev_hash,
      hash: r.hash,
      timestamp: new Date(r.timestamp).toISOString(),
      policyId: r.policy_id || undefined,
      policyVersion: r.policy_version || undefined,
    }));
  }

  async claimIdempotencyKey(
    tenantId: string,
    agentId: string,
    key: string,
    requestHash: string
  ): Promise<{ status: 'CLAIMED' | 'CACHED' | 'MISMATCH' | 'PROCESSING'; cachedResponse?: Record<string, unknown> }> {
    const res = await this.pool.query(
      'SELECT * FROM idempotency_keys WHERE tenant_id = $1 AND agent_id = $2 AND key = $3',
      [tenantId, agentId, key]
    );

    if (res.rows.length > 0) {
      const existing = res.rows[0];
      if (existing.request_hash !== requestHash) {
        return { status: 'MISMATCH' };
      }
      if (existing.status === 'COMPLETED' && existing.response) {
        const cached = typeof existing.response === 'string' ? JSON.parse(existing.response) : existing.response;
        return { status: 'CACHED', cachedResponse: cached };
      }
      if (existing.status === 'PROCESSING') {
        const ageMs = Date.now() - new Date(existing.created_at).getTime();
        if (ageMs > 300000) {
          await this.pool.query(
            "UPDATE idempotency_keys SET status = 'PROCESSING', updated_at = NOW() WHERE tenant_id = $1 AND agent_id = $2 AND key = $3",
            [tenantId, agentId, key]
          );
          return { status: 'CLAIMED' };
        }
        return { status: 'PROCESSING' };
      }
      return { status: 'PROCESSING' };
    }

    await this.pool.query(`
      INSERT INTO idempotency_keys (tenant_id, agent_id, key, request_hash, status, response, created_at, updated_at)
      VALUES ($1, $2, $3, $4, 'PROCESSING', NULL, NOW(), NOW())
      ON CONFLICT (tenant_id, agent_id, key) DO NOTHING
    `, [tenantId, agentId, key, requestHash]);

    return { status: 'CLAIMED' };
  }

  async completeIdempotencyKey(
    tenantId: string,
    agentId: string,
    key: string,
    response: Record<string, unknown>
  ): Promise<void> {
    await this.pool.query(`
      UPDATE idempotency_keys
      SET status = 'COMPLETED', response = $1::jsonb, updated_at = NOW()
      WHERE tenant_id = $2 AND agent_id = $3 AND key = $4
    `, [JSON.stringify(response), tenantId, agentId, key]);
  }

  async failIdempotencyKey(tenantId: string, agentId: string, key: string): Promise<void> {
    await this.pool.query(`
      UPDATE idempotency_keys
      SET status = 'FAILED', updated_at = NOW()
      WHERE tenant_id = $1 AND agent_id = $2 AND key = $3
    `, [tenantId, agentId, key]);
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
        version: 1,
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
      id: row.id ? String(row.id) : 'default_policy',
      version: row.version ? parseInt(row.version, 10) : 1,
      amountCeiling: row.amount_ceiling ? parseInt(row.amount_ceiling, 10) : undefined,
      category: row.category || undefined,
      allowedMerchants,
      sessionCap: row.session_cap ? parseInt(row.session_cap, 10) : undefined,
      reasonableQuantity: row.reasonable_quantity ? parseFloat(row.reasonable_quantity) : undefined,
      allowedMccCodes,
      sessionId: row.session_id || undefined,
      tenantId: row.tenant_id || undefined,
    };
  }

  async getPolicy(agentId = 'default_agent'): Promise<Policy> {
    return this.getActivePolicy(agentId);
  }

  async setActivePolicy(policy: Policy, agentId = 'default_agent'): Promise<Policy> {
    const allowedMerchantsJson = JSON.stringify(policy.allowedMerchants || []);
    const allowedMccCodesJson = policy.allowedMccCodes ? JSON.stringify(policy.allowedMccCodes) : null;
    const version = (policy.version ?? 1) + 1;

    await this.pool.query(`
      INSERT INTO policies (agent_id, tenant_id, amount_ceiling, category, allowed_merchants, session_cap, reasonable_quantity, allowed_mcc_codes, session_id, version)
      VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8::jsonb, $9, $10)
      ON CONFLICT (agent_id) DO UPDATE SET
        amount_ceiling = EXCLUDED.amount_ceiling,
        category = EXCLUDED.category,
        allowed_merchants = EXCLUDED.allowed_merchants,
        session_cap = EXCLUDED.session_cap,
        reasonable_quantity = EXCLUDED.reasonable_quantity,
        allowed_mcc_codes = EXCLUDED.allowed_mcc_codes,
        session_id = EXCLUDED.session_id,
        version = EXCLUDED.version,
        updated_at = NOW()
    `, [
      agentId,
      policy.tenantId || 'default_tenant',
      policy.amountCeiling ?? null,
      policy.category ?? null,
      allowedMerchantsJson,
      policy.sessionCap ?? null,
      policy.reasonableQuantity ?? null,
      allowedMccCodesJson,
      policy.sessionId ?? null,
      version,
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
      status: row.status,
      decisionStatus: row.decision_status || undefined,
      paymentStatus: row.payment_status || undefined,
      decision: row.decision_status || undefined,
      reason: row.reason || undefined,
      timestamp: row.timestamp ? new Date(row.timestamp).toISOString() : new Date().toISOString(),
      mccCode: row.mcc_code || undefined,
      productId: row.product_id || undefined,
      catalogVersion: row.catalog_version || undefined,
      hash: row.hash || '',
      prevHash: row.prev_hash || '',
      razorpayOrderId: row.razorpay_order_id || undefined,
      razorpayPaymentId: row.razorpay_payment_id || undefined,
      agentId: row.agent_id || undefined,
      policyId: row.policy_id || undefined,
      policyVersion: row.policy_version || undefined,
      sessionId: row.session_id || undefined,
      tenantId: row.tenant_id || undefined,
      capturedPaise: row.captured_paise ? parseInt(row.captured_paise, 10) : 0,
      refundedPaise: row.refunded_paise ? parseInt(row.refunded_paise, 10) : 0,
      remainingRefundablePaise: Math.max(0, (row.captured_paise ? parseInt(row.captured_paise, 10) : 0) - (row.refunded_paise ? parseInt(row.refunded_paise, 10) : 0)),
      expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : undefined,
    }));

    const events = await this.getLedgerEvents(agentId, 50);

    return {
      totalPaise,
      heldPaise,
      settledPaise,
      availablePaise: totalPaise - heldPaise - settledPaise,
      total: totalPaise,
      remaining: totalPaise - heldPaise - settledPaise,
      transactions,
      ledgerEvents: events,
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
        id, agent_id, tenant_id, merchant, amount, category, quantity, status, decision_status, payment_status,
        reason, timestamp, mcc_code, product_id, catalog_version, hash, prev_hash, razorpay_order_id, razorpay_payment_id,
        policy_id, policy_version, session_id, captured_paise, refunded_paise, expires_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25)
      ON CONFLICT (id) DO UPDATE SET
        status = EXCLUDED.status,
        decision_status = EXCLUDED.decision_status,
        payment_status = EXCLUDED.payment_status,
        reason = EXCLUDED.reason,
        razorpay_payment_id = EXCLUDED.razorpay_payment_id,
        hash = EXCLUDED.hash,
        captured_paise = EXCLUDED.captured_paise,
        refunded_paise = EXCLUDED.refunded_paise
    `, [
      transaction.id,
      agentId,
      transaction.tenantId || 'default_tenant',
      transaction.merchant,
      transaction.amount,
      transaction.category,
      transaction.quantity ?? null,
      transaction.status,
      transaction.decisionStatus ?? 'allowed',
      transaction.paymentStatus ?? 'requested',
      transaction.reason ?? null,
      transaction.timestamp || new Date().toISOString(),
      transaction.mccCode ?? null,
      transaction.productId ?? null,
      transaction.catalogVersion ?? null,
      hash,
      prevHash,
      transaction.razorpayOrderId ?? null,
      transaction.razorpayPaymentId ?? null,
      transaction.policyId ?? null,
      transaction.policyVersion ?? 1,
      transaction.sessionId ?? null,
      transaction.capturedPaise ?? 0,
      transaction.refundedPaise ?? 0,
      transaction.expiresAt ?? null,
    ]);

    return { ...transaction, prevHash, hash };
  }

  async processPurchaseAtomic(
    purchase: AttemptedPurchase & { override?: boolean }
  ): Promise<GuardCheckResult> {
    const agentId = purchase.agentId || 'default_agent';

    if (!purchase.override) {
      const activePolicy = await this.getActivePolicy(agentId);
      const capPaise = activePolicy.sessionCap || 200000;
      const tokenResult = await this.tokenBucket.acquireReserve(agentId, purchase.amount ?? 0, capPaise);
      if (!tokenResult.allowed) {
        const currentState = await this.getReserveState(agentId, purchase.sessionId);
        return {
          decision: 'denied',
          decisionStatus: 'denied',
          paymentStatus: 'failed',
          reason: tokenResult.reason || `Rate limit budget pool exceeded for agent ${agentId}`,
          ruleViolated: 'RATE_LIMIT_EXCEEDED',
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

      if (result.decision === 'allowed') {
        const tx = result.transaction!;
        const prevHash = await this.getLastTransactionHash(agentId);
        tx.prevHash = prevHash;
        tx.hash = calculateTransactionHash({ ...tx, prevHash });

        await client.query(`
          INSERT INTO transactions (
            id, agent_id, tenant_id, merchant, amount, category, quantity, status, decision_status, payment_status,
            reason, timestamp, mcc_code, product_id, catalog_version, hash, prev_hash, razorpay_order_id, policy_id, policy_version, session_id, expires_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)
        `, [
          tx.id, agentId, tx.tenantId || 'default_tenant', tx.merchant, tx.amount, tx.category, tx.quantity ?? null,
          'reserved', 'allowed', 'reserved', tx.reason ?? null, tx.timestamp, tx.mccCode ?? null,
          tx.productId ?? null, tx.catalogVersion ?? null, tx.hash, tx.prevHash, tx.razorpayOrderId ?? null,
          tx.policyId ?? null, tx.policyVersion ?? 1, tx.sessionId ?? null, tx.expiresAt ?? null
        ]);

        await client.query(
          'UPDATE reserve_state SET held_paise = held_paise + $1, updated_at = NOW() WHERE agent_id = $2',
          [tx.amount, agentId]
        );

        // Append ledger event
        const eventId = `evt_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
        const prevEvtHash = await this.getLastLedgerEventHash(agentId);
        const payloadHash = calculatePayloadHash({ amount: tx.amount, merchant: tx.merchant, productId: tx.productId });
        const evtHash = calculateLedgerEventHash({
          id: eventId,
          transactionId: tx.id,
          eventType: 'RESERVATION_CREATED',
          timestamp: tx.timestamp,
          payloadHash,
          sequenceNum: 1,
          prevHash: prevEvtHash,
        });

        await client.query(`
          INSERT INTO ledger_events (
            id, transaction_id, tenant_id, agent_id, event_type, payload, sequence_num, prev_hash, hash, policy_id, policy_version, timestamp
          ) VALUES ($1, $2, $3, $4, 'RESERVATION_CREATED', $5::jsonb, 1, $6, $7, $8, $9, $10)
        `, [
          eventId, tx.id, tx.tenantId || 'default_tenant', agentId,
          JSON.stringify({ amount: tx.amount, merchant: tx.merchant, productId: tx.productId }),
          prevEvtHash, evtHash, tx.policyId || null, tx.policyVersion || 1, tx.timestamp
        ]);
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
        "UPDATE transactions SET status = 'captured', decision_status = 'allowed', payment_status = 'captured', razorpay_payment_id = $1, captured_paise = $2 WHERE id = $3",
        [razorpayPaymentId || null, amount, tx.id]
      );

      if (tx.status === 'reserved' || tx.payment_status === 'reserved' || tx.payment_status === 'order_created' || tx.payment_status === 'authorized') {
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

      await client.query(
        "UPDATE transactions SET status = 'expired', payment_status = 'released', reason = $1 WHERE id = $2",
        [reason, tx.id]
      );

      if (tx.status === 'reserved' || tx.payment_status === 'reserved' || tx.payment_status === 'order_creation_unknown' || tx.payment_status === 'order_created') {
        await client.query(
          'UPDATE reserve_state SET held_paise = GREATEST(0, held_paise - $1), updated_at = NOW() WHERE agent_id = $2',
          [amount, agentId]
        );
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

  async flagOrderCreationUnknown(txId: string, agentId = 'default_agent'): Promise<void> {
    await this.pool.query(
      "UPDATE transactions SET payment_status = 'order_creation_unknown', reason = 'Razorpay order creation timed out — queued for reconciliation' WHERE id = $1 AND agent_id = $2",
      [txId, agentId]
    );
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
      const capturedPaise = parseInt(originalTx.captured_paise || originalTx.amount, 10);
      const refundedPaise = parseInt(originalTx.refunded_paise || '0', 10);
      const remainingRefundable = capturedPaise - refundedPaise;

      if (refundAmountPaise > remainingRefundable) {
        await client.query('ROLLBACK');
        return {
          success: false,
          error: `Refund rejected: Requested refund amount (₹${(refundAmountPaise / 100).toFixed(2)}) exceeds remaining refundable balance (₹${(remainingRefundable / 100).toFixed(2)}).`,
        };
      }

      const newRefundedTotal = refundedPaise + refundAmountPaise;
      const newStatus = newRefundedTotal >= capturedPaise ? 'refunded' : 'partially_refunded';

      await client.query(
        'UPDATE transactions SET refunded_paise = $1, payment_status = $2, status = $2 WHERE id = $3',
        [newRefundedTotal, newStatus, originalTx.id]
      );

      await client.query(
        'UPDATE reserve_state SET settled_paise = GREATEST(0, settled_paise - $1), updated_at = NOW() WHERE agent_id = $2',
        [refundAmountPaise, agentId]
      );

      const refundTxId = refundId || `ref_${Date.now()}`;

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
        "UPDATE transactions SET status = 'disputed', payment_status = 'disputed', reason = $1 WHERE id = $2",
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
        'SELECT * FROM ledger_events WHERE agent_id = $1 ORDER BY sequence_num ASC LIMIT $2 OFFSET $3',
        [agentId, batchSize, offset]
      );

      if (res.rows.length === 0) break;

      for (let i = 0; i < res.rows.length; i++) {
        const row = res.rows[i];
        if (row.prev_hash !== expectedPrevHash) {
          return { isValid: false, corruptedIndex: currentIndex, reason: `Previous hash mismatch at index ${currentIndex}` };
        }
        const payloadObj = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
        const payloadHash = calculatePayloadHash(payloadObj);
        const calculated = calculateLedgerEventHash({
          id: row.id,
          transactionId: row.transaction_id,
          eventType: row.event_type,
          timestamp: new Date(row.timestamp).toISOString(),
          payloadHash,
          sequenceNum: parseInt(row.sequence_num, 10),
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

    return { isValid: true, totalEventsVerified: currentIndex };
  }

  async resetStore(agentId?: string): Promise<void> {
    if (agentId) {
      await this.pool.query('DELETE FROM transactions WHERE agent_id = $1', [agentId]);
      await this.pool.query('DELETE FROM ledger_events WHERE agent_id = $1', [agentId]);
      await this.pool.query('DELETE FROM idempotency_keys WHERE agent_id = $1', [agentId]);
      await this.pool.query('DELETE FROM policies WHERE agent_id = $1', [agentId]);
      await this.pool.query('DELETE FROM reserve_state WHERE agent_id = $1', [agentId]);
    } else {
      await this.pool.query('DELETE FROM transactions');
      await this.pool.query('DELETE FROM ledger_events');
      await this.pool.query('DELETE FROM idempotency_keys');
      await this.pool.query('DELETE FROM webhook_events');
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

  async expireStaleTransactions(agentId = 'default_agent'): Promise<number> {
    const res = await this.pool.query(
      "UPDATE transactions SET status = 'expired', payment_status = 'expired', reason = 'Reservation TTL expired' WHERE agent_id = $1 AND (status = 'reserved' OR payment_status = 'reserved') AND expires_at IS NOT NULL AND expires_at < NOW() RETURNING id",
      [agentId]
    );
    return res.rowCount || 0;
  }
}

