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

    const client = await this.pool.connect();
    try {
      // Use SERIALIZABLE isolation to serialize all ledger appends for this agent.
      // This prevents two concurrent writers from computing the same prevHash.
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');

      // Global prev hash: last event for this agent (not per-transaction)
      const prevHashRes = await client.query(
        'SELECT hash FROM ledger_events WHERE agent_id = $1 ORDER BY sequence_num DESC LIMIT 1 FOR UPDATE',
        [event.agentId || 'default_agent']
      );
      const prevHash = prevHashRes.rows.length > 0 && prevHashRes.rows[0].hash
        ? prevHashRes.rows[0].hash
        : GENESIS_PREV_HASH;

      // Global sequence: per-agent across all transactions
      const seqRes = await client.query(
        'SELECT COALESCE(MAX(sequence_num), 0) + 1 AS next_seq FROM ledger_events WHERE agent_id = $1',
        [event.agentId || 'default_agent']
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
  ): Promise<{ status: 'CLAIMED' | 'CACHED' | 'MISMATCH' | 'PROCESSING'; cachedResponse?: Record<string, unknown>; ownerToken?: string }> {
    const ownerToken = `owner_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const leaseSeconds = 30;

    // Single atomic INSERT ... ON CONFLICT ... RETURNING — zero TOCTOU window
    const result = await this.pool.query(`
      INSERT INTO idempotency_keys (tenant_id, agent_id, key, request_hash, status, owner_token, lease_expires_at, created_at, updated_at)
      VALUES ($1, $2, $3, $4, 'PROCESSING', $5, NOW() + INTERVAL '${leaseSeconds} seconds', NOW(), NOW())
      ON CONFLICT (tenant_id, agent_id, key) DO UPDATE SET
        -- Only reclaim if FAILED or lease expired; otherwise leave unchanged
        status = CASE
          WHEN idempotency_keys.status = 'FAILED' OR idempotency_keys.lease_expires_at < NOW() OR idempotency_keys.lease_expires_at IS NULL
          THEN 'PROCESSING'
          ELSE idempotency_keys.status
        END,
        owner_token = CASE
          WHEN idempotency_keys.status = 'FAILED' OR idempotency_keys.lease_expires_at < NOW() OR idempotency_keys.lease_expires_at IS NULL
          THEN $5
          ELSE idempotency_keys.owner_token
        END,
        lease_expires_at = CASE
          WHEN idempotency_keys.status = 'FAILED' OR idempotency_keys.lease_expires_at < NOW() OR idempotency_keys.lease_expires_at IS NULL
          THEN NOW() + INTERVAL '${leaseSeconds} seconds'
          ELSE idempotency_keys.lease_expires_at
        END,
        updated_at = NOW()
      RETURNING *, (xmax = 0) AS was_inserted
    `, [tenantId, agentId, key, requestHash, ownerToken]);

    const row = result.rows[0];
    if (!row) {
      // Should never happen with INSERT...ON CONFLICT...RETURNING, but handle defensively
      return { status: 'CLAIMED', ownerToken };
    }

    // Fresh insert — we own the claim
    if (row.was_inserted) {
      return { status: 'CLAIMED', ownerToken };
    }

    // Existing row — check hash match first
    if (row.request_hash !== requestHash) {
      return { status: 'MISMATCH' };
    }

    // Completed with cached response
    if (row.status === 'COMPLETED' && row.response) {
      const cached = typeof row.response === 'string' ? JSON.parse(row.response) : row.response;
      return { status: 'CACHED', cachedResponse: cached };
    }

    // We reclaimed a FAILED/expired lease
    if (row.owner_token === ownerToken) {
      return { status: 'CLAIMED', ownerToken };
    }

    // Another worker is currently processing
    return { status: 'PROCESSING' };
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

  async claimWebhookEvent(eventId: string, eventType: string, payloadHash: string): Promise<boolean> {
    const res = await this.pool.query(`
      INSERT INTO webhook_events (event_id, event_type, payload_hash, received_at, processed_at)
      VALUES ($1, $2, $3, NOW(), NOW())
      ON CONFLICT (event_id) DO NOTHING
      RETURNING event_id
    `, [eventId, eventType, payloadHash]);
    return (res.rowCount ?? 0) > 0;
  }

  async attachRazorpayOrder(txId: string, razorpayOrderId: string, agentId = 'default_agent'): Promise<void> {
    const timestamp = new Date().toISOString();
    await this.pool.query(`
      UPDATE transactions
      SET razorpay_order_id = $1, payment_status = 'order_created', status = 'reserved'
      WHERE id = $2 AND agent_id = $3
    `, [razorpayOrderId, txId, agentId]);

    await this.appendLedgerEvent({
      transactionId: txId,
      tenantId: 'default_tenant',
      agentId,
      eventType: 'ORDER_ATTACHED',
      payload: { razorpayOrderId },
      timestamp,
    });
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

      // Authoritative session spend calculation via SQL aggregate under lock (NO LIMIT 100 bug)
      const activeSessionId = purchase.sessionId || activePolicy.sessionId || 'default_session';
      const sessionAggRes = await client.query(`
        SELECT COALESCE(SUM(amount), 0) AS total
        FROM transactions
        WHERE agent_id = $1 AND (session_id = $2 OR session_id IS NULL) AND payment_status IN ('reserved', 'order_creation_unknown', 'order_created', 'authorized', 'captured')
      `, [agentId, activeSessionId]);
      const sessionSpentPaise = parseInt(sessionAggRes.rows[0]?.total ?? '0', 10);

      const result = guardCheck(activePolicy, currentState, purchase, sessionSpentPaise);

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

      // Release Redis budget if guard denied — Redis is ephemeral, not source of truth
      if (result.decision !== 'allowed' && !purchase.override) {
        await this.tokenBucket.releaseReserve(agentId, purchase.amount ?? 0);
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

  async getTransactionByIdOrOrderId(identifier: string, agentId?: string): Promise<Transaction | null> {
    let query = 'SELECT * FROM transactions WHERE (id = $1 OR razorpay_order_id = $1 OR razorpay_payment_id = $1)';
    const params: unknown[] = [identifier];
    if (agentId) {
      query += ' AND agent_id = $2';
      params.push(agentId);
    }
    query += ' LIMIT 1';
    const res = await this.pool.query(query, params);
    if (res.rows.length === 0) return null;
    const row = res.rows[0];
    return {
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
    };
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
      const currentPaymentStatus = tx.payment_status;

      // Idempotent: already captured
      if (currentPaymentStatus === 'captured' || currentPaymentStatus === 'partially_refunded' || currentPaymentStatus === 'refunded') {
        await client.query('ROLLBACK');
        return { success: true, transactionId: tx.id };
      }

      // Validate state transition: only reserved/order_created/authorized/order_creation_unknown can become captured
      const captureableStatuses = ['reserved', 'order_creation_unknown', 'order_created', 'authorized'];
      if (!captureableStatuses.includes(currentPaymentStatus)) {
        await client.query('ROLLBACK');
        return { success: false, error: `Invalid state transition: cannot capture from '${currentPaymentStatus}'` };
      }

      await client.query(`
        UPDATE transactions
        SET status = 'captured',
            payment_status = 'captured',
            captured_paise = $1,
            razorpay_payment_id = COALESCE($2, razorpay_payment_id)
        WHERE id = $3
      `, [amount, razorpayPaymentId ?? null, tx.id]);

      // Lock reserve_state and move from held to settled
      await client.query('SELECT * FROM reserve_state WHERE agent_id = $1 FOR UPDATE', [agentId]);
      await client.query(
        'UPDATE reserve_state SET held_paise = GREATEST(0, held_paise - $1), settled_paise = settled_paise + $1, updated_at = NOW() WHERE agent_id = $2',
        [amount, agentId]
      );

      // Append PAYMENT_CAPTURED ledger event
      const eventId = `evt_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
      const timestamp = new Date().toISOString();
      const prevEvtHash = await this.getLastLedgerEventHash(tx.agent_id || agentId);
      const payloadHash = calculatePayloadHash({ amount, razorpayPaymentId, razorpayOrderId: tx.razorpay_order_id });
      const seqRes = await client.query(
        'SELECT COALESCE(MAX(sequence_num), 0) + 1 AS next_seq FROM ledger_events WHERE transaction_id = $1',
        [tx.id]
      );
      const sequenceNum = parseInt(seqRes.rows[0].next_seq, 10);
      const evtHash = calculateLedgerEventHash({
        id: eventId, transactionId: tx.id, eventType: 'PAYMENT_CAPTURED',
        timestamp, payloadHash, sequenceNum, prevHash: prevEvtHash,
      });

      await client.query(`
        INSERT INTO ledger_events (
          id, transaction_id, tenant_id, agent_id, event_type, payload, sequence_num, prev_hash, hash, policy_id, policy_version, timestamp
        ) VALUES ($1, $2, $3, $4, 'PAYMENT_CAPTURED', $5::jsonb, $6, $7, $8, $9, $10, $11)
      `, [
        eventId, tx.id, tx.tenant_id || 'default_tenant', agentId,
        JSON.stringify({ amount, razorpayPaymentId, razorpayOrderId: tx.razorpay_order_id }),
        sequenceNum, prevEvtHash, evtHash, tx.policy_id || null, tx.policy_version || 1, timestamp
      ]);

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

  async authorizeTransaction(
    txIdOrOrderId: string,
    razorpayPaymentId?: string,
    agentId = 'default_agent'
  ): Promise<{ success: boolean; error?: string }> {
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
      const currentStatus = tx.payment_status;

      // Idempotent: already authorized or further along
      if (['authorized', 'captured', 'partially_refunded', 'refunded'].includes(currentStatus)) {
        await client.query('ROLLBACK');
        return { success: true };
      }

      // Only transition from reserved/order_created states
      const authorizableStatuses = ['reserved', 'order_creation_unknown', 'order_created'];
      if (!authorizableStatuses.includes(currentStatus)) {
        await client.query('ROLLBACK');
        return { success: false, error: `Invalid state transition: cannot authorize from '${currentStatus}'` };
      }

      await client.query(`
        UPDATE transactions
        SET status = 'authorized',
            payment_status = 'authorized',
            razorpay_payment_id = COALESCE($1, razorpay_payment_id)
        WHERE id = $2
      `, [razorpayPaymentId ?? null, tx.id]);

      // Append ledger event — funds remain in heldPaise
      const eventId = `evt_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
      const timestamp = new Date().toISOString();
      const prevEvtHash = await this.getLastLedgerEventHash(tx.agent_id || agentId);
      const payloadHash = calculatePayloadHash({ razorpayPaymentId, razorpayOrderId: tx.razorpay_order_id, status: 'authorized' });
      const seqRes = await client.query(
        'SELECT COALESCE(MAX(sequence_num), 0) + 1 AS next_seq FROM ledger_events WHERE transaction_id = $1',
        [tx.id]
      );
      const sequenceNum = parseInt(seqRes.rows[0].next_seq, 10);
      const evtHash = calculateLedgerEventHash({
        id: eventId, transactionId: tx.id, eventType: 'ORDER_ATTACHED',
        timestamp, payloadHash, sequenceNum, prevHash: prevEvtHash,
      });

      await client.query(`
        INSERT INTO ledger_events (
          id, transaction_id, tenant_id, agent_id, event_type, payload, sequence_num, prev_hash, hash, policy_id, policy_version, timestamp
        ) VALUES ($1, $2, $3, $4, 'ORDER_ATTACHED', $5::jsonb, $6, $7, $8, $9, $10, $11)
      `, [
        eventId, tx.id, tx.tenant_id || 'default_tenant', agentId,
        JSON.stringify({ razorpayPaymentId, razorpayOrderId: tx.razorpay_order_id, status: 'authorized' }),
        sequenceNum, prevEvtHash, evtHash, tx.policy_id || null, tx.policy_version || 1, timestamp
      ]);

      await client.query('COMMIT');
      return { success: true };
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
      const currentPaymentStatus = tx.payment_status;

      // Idempotent: already released or expired
      if (currentPaymentStatus === 'released' || currentPaymentStatus === 'expired') {
        await client.query('ROLLBACK');
        return { success: true, transactionId: tx.id, releasedAmountPaise: 0 };
      }

      // Only release from held states
      const releaseableStatuses = ['reserved', 'order_creation_unknown', 'order_created'];
      if (!releaseableStatuses.includes(currentPaymentStatus)) {
        await client.query('ROLLBACK');
        return { success: false, error: `Invalid state transition: cannot release from '${currentPaymentStatus}'` };
      }

      await client.query(
        "UPDATE transactions SET status = 'released', payment_status = 'released', decision_status = 'allowed', reason = $1 WHERE id = $2",
        [reason, tx.id]
      );

      // Lock reserve_state and decrement held
      await client.query('SELECT * FROM reserve_state WHERE agent_id = $1 FOR UPDATE', [agentId]);
      await client.query(
        'UPDATE reserve_state SET held_paise = GREATEST(0, held_paise - $1), updated_at = NOW() WHERE agent_id = $2',
        [amount, agentId]
      );

      // Append RESERVATION_RELEASED ledger event
      const eventId = `evt_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
      const timestamp = new Date().toISOString();
      const prevEvtHash = await this.getLastLedgerEventHash(tx.agent_id || agentId);
      const payloadHash = calculatePayloadHash({ releasedAmount: amount, reason });
      const seqRes = await client.query(
        'SELECT COALESCE(MAX(sequence_num), 0) + 1 AS next_seq FROM ledger_events WHERE transaction_id = $1',
        [tx.id]
      );
      const sequenceNum = parseInt(seqRes.rows[0].next_seq, 10);
      const evtHash = calculateLedgerEventHash({
        id: eventId, transactionId: tx.id, eventType: 'RESERVATION_RELEASED',
        timestamp, payloadHash, sequenceNum, prevHash: prevEvtHash,
      });

      await client.query(`
        INSERT INTO ledger_events (
          id, transaction_id, tenant_id, agent_id, event_type, payload, sequence_num, prev_hash, hash, policy_id, policy_version, timestamp
        ) VALUES ($1, $2, $3, $4, 'RESERVATION_RELEASED', $5::jsonb, $6, $7, $8, $9, $10, $11)
      `, [
        eventId, tx.id, tx.tenant_id || 'default_tenant', agentId,
        JSON.stringify({ releasedAmount: amount, reason }),
        sequenceNum, prevEvtHash, evtHash, tx.policy_id || null, tx.policy_version || 1, timestamp
      ]);

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

    await this.appendLedgerEvent({
      transactionId: txId,
      tenantId: 'default_tenant',
      agentId,
      eventType: 'ORDER_UNKNOWN_FLAGGED',
      payload: { reason: 'Network drop/timeout during order creation' },
      timestamp: new Date().toISOString(),
    });
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
      const currentPaymentStatus = originalTx.payment_status;

      // Only captured/partially_refunded transactions can be refunded
      if (!['captured', 'partially_refunded'].includes(currentPaymentStatus)) {
        await client.query('ROLLBACK');
        return { success: false, error: `Cannot refund transaction in '${currentPaymentStatus}' state` };
      }

      // Idempotent refund check: if same refundId was already processed, return success
      if (refundId) {
        const existingRefund = await client.query(
          "SELECT id FROM ledger_events WHERE transaction_id = $1 AND event_type = 'PAYMENT_REFUNDED' AND payload->>'refundId' = $2",
          [originalTx.id, refundId]
        );
        if (existingRefund.rows.length > 0) {
          await client.query('ROLLBACK');
          return { success: true, refundId, refundedAmountPaise: refundAmountPaise };
        }
      }

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

      // Lock reserve_state and decrement settled
      await client.query('SELECT * FROM reserve_state WHERE agent_id = $1 FOR UPDATE', [agentId]);
      await client.query(
        'UPDATE reserve_state SET settled_paise = GREATEST(0, settled_paise - $1), updated_at = NOW() WHERE agent_id = $2',
        [refundAmountPaise, agentId]
      );

      const refundTxId = refundId || `ref_${Date.now()}`;

      // Append PAYMENT_REFUNDED ledger event
      const eventId = `evt_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
      const timestamp = new Date().toISOString();
      const prevEvtHash = await this.getLastLedgerEventHash(originalTx.agent_id || agentId);
      const payloadHash = calculatePayloadHash({ refundId: refundTxId, refundAmountPaise, totalRefundedPaise: newRefundedTotal, reason: reason || 'Refund processed' });
      const seqRes = await client.query(
        'SELECT COALESCE(MAX(sequence_num), 0) + 1 AS next_seq FROM ledger_events WHERE transaction_id = $1',
        [originalTx.id]
      );
      const sequenceNum = parseInt(seqRes.rows[0].next_seq, 10);
      const evtHash = calculateLedgerEventHash({
        id: eventId, transactionId: originalTx.id, eventType: 'PAYMENT_REFUNDED',
        timestamp, payloadHash, sequenceNum, prevHash: prevEvtHash,
      });

      await client.query(`
        INSERT INTO ledger_events (
          id, transaction_id, tenant_id, agent_id, event_type, payload, sequence_num, prev_hash, hash, policy_id, policy_version, timestamp
        ) VALUES ($1, $2, $3, $4, 'PAYMENT_REFUNDED', $5::jsonb, $6, $7, $8, $9, $10, $11)
      `, [
        eventId, originalTx.id, originalTx.tenant_id || 'default_tenant', agentId,
        JSON.stringify({ refundId: refundTxId, refundAmountPaise, totalRefundedPaise: newRefundedTotal, reason: reason || 'Refund processed' }),
        sequenceNum, prevEvtHash, evtHash, originalTx.policy_id || null, originalTx.policy_version || 1, timestamp
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
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const staleRes = await client.query(
        "SELECT id, amount FROM transactions WHERE agent_id = $1 AND payment_status IN ('reserved', 'order_creation_unknown') AND expires_at IS NOT NULL AND expires_at < NOW()",
        [agentId]
      );

      if (staleRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return 0;
      }

      // Lock reserve_state
      await client.query('SELECT * FROM reserve_state WHERE agent_id = $1 FOR UPDATE', [agentId]);

      let totalExpiredAmount = 0;
      for (const row of staleRes.rows) {
        const amount = parseInt(row.amount, 10);
        totalExpiredAmount += amount;

        await client.query(
          "UPDATE transactions SET status = 'expired', payment_status = 'expired', reason = 'Reservation TTL expired' WHERE id = $1",
          [row.id]
        );

        // Append RESERVATION_EXPIRED ledger event
        await this.appendLedgerEvent({
          transactionId: row.id,
          tenantId: 'default_tenant',
          agentId,
          eventType: 'RESERVATION_EXPIRED',
          payload: { expiredAmount: amount, reason: 'TTL elapsed' },
          timestamp: new Date().toISOString(),
        });
      }

      await client.query(
        'UPDATE reserve_state SET held_paise = GREATEST(0, held_paise - $1), updated_at = NOW() WHERE agent_id = $2',
        [totalExpiredAmount, agentId]
      );

      await client.query('COMMIT');
      return staleRes.rows.length;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}

