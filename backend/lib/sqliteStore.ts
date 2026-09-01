/* eslint-disable @typescript-eslint/no-explicit-any */
import db, { initDatabase } from './db';
import {
  Policy, ReserveState, Transaction, AttemptedPurchase, GuardCheckResult,
  SecurityAuditEvent, IReserveStore, ReserveStoreType,
  SettleResult, ReleaseResult, RefundResult, DisputeResult, LedgerIntegrityResult,
  IRedisTokenBucket, LedgerEvent
} from './types';
import { guardCheck } from './guardCheck';
import { calculateTransactionHash, calculateLedgerEventHash, calculatePayloadHash, GENESIS_PREV_HASH } from './crypto';
import { getTokenBucket } from './tokenBucket';

export class SqliteReserveStore implements IReserveStore {
  readonly storeType: ReserveStoreType = 'sqlite';
  private tokenBucket: IRedisTokenBucket;

  constructor(tokenBucket?: IRedisTokenBucket) {
    this.tokenBucket = tokenBucket || getTokenBucket();
    initDatabase();
  }

  async getLastTransactionHash(agentId = 'default_agent'): Promise<string> {
    const lastTx = db
      .prepare("SELECT hash FROM transactions WHERE agentId = ? ORDER BY rowid DESC LIMIT 1")
      .get(agentId) as { hash: string } | undefined;
    return lastTx && lastTx.hash ? lastTx.hash : GENESIS_PREV_HASH;
  }

  async getLastLedgerEventHash(agentId = 'default_agent'): Promise<string> {
    const lastEvt = db
      .prepare("SELECT hash FROM ledger_events WHERE agentId = ? ORDER BY rowid DESC LIMIT 1")
      .get(agentId) as { hash: string } | undefined;
    return lastEvt && lastEvt.hash ? lastEvt.hash : GENESIS_PREV_HASH;
  }

  private getLastLedgerEventHashSync(agentId = 'default_agent'): string {
    const lastEvt = db
      .prepare("SELECT hash FROM ledger_events WHERE agentId = ? ORDER BY rowid DESC LIMIT 1")
      .get(agentId) as { hash: string } | undefined;
    return lastEvt && lastEvt.hash ? lastEvt.hash : GENESIS_PREV_HASH;
  }

  private getNextLedgerSequenceSync(transactionId: string): number {
    const row = db
      .prepare('SELECT MAX(sequenceNum) as maxSeq FROM ledger_events WHERE transactionId = ?')
      .get(transactionId) as { maxSeq: number | null } | undefined;
    return (row?.maxSeq ?? 0) + 1;
  }

  async appendLedgerEvent(
    event: Omit<LedgerEvent, 'id' | 'sequenceNum' | 'prevHash' | 'hash'>
  ): Promise<LedgerEvent> {
    const eventId = `evt_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
    const timestamp = event.timestamp || new Date().toISOString();
    const prevHash = await this.getLastLedgerEventHash(event.agentId);
    
    let sequenceNum = 1;
    const seqRow = db
      .prepare('SELECT MAX(sequenceNum) as maxSeq FROM ledger_events WHERE transactionId = ?')
      .get(event.transactionId) as { maxSeq: number | null } | undefined;
    if (seqRow && seqRow.maxSeq !== null) {
      sequenceNum = seqRow.maxSeq + 1;
    }

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

    const fullEvent: LedgerEvent = {
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

    db.prepare(`
      INSERT INTO ledger_events (id, transactionId, tenantId, agentId, eventType, payload, sequenceNum, prevHash, hash, policyId, policyVersion, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      fullEvent.id,
      fullEvent.transactionId,
      fullEvent.tenantId,
      fullEvent.agentId,
      fullEvent.eventType,
      JSON.stringify(fullEvent.payload),
      fullEvent.sequenceNum,
      fullEvent.prevHash,
      fullEvent.hash,
      fullEvent.policyId ?? null,
      fullEvent.policyVersion ?? 1,
      fullEvent.timestamp
    );

    return fullEvent;
  }

  private appendLedgerEventSync(
    event: Omit<LedgerEvent, 'id' | 'sequenceNum' | 'prevHash' | 'hash'>
  ): LedgerEvent {
    const eventId = `evt_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
    const timestamp = event.timestamp || new Date().toISOString();
    const prevHash = this.getLastLedgerEventHashSync(event.agentId);
    const sequenceNum = this.getNextLedgerSequenceSync(event.transactionId);

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

    const fullEvent: LedgerEvent = {
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

    db.prepare(`
      INSERT INTO ledger_events (id, transactionId, tenantId, agentId, eventType, payload, sequenceNum, prevHash, hash, policyId, policyVersion, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      fullEvent.id,
      fullEvent.transactionId,
      fullEvent.tenantId,
      fullEvent.agentId,
      fullEvent.eventType,
      JSON.stringify(fullEvent.payload),
      fullEvent.sequenceNum,
      fullEvent.prevHash,
      fullEvent.hash,
      fullEvent.policyId ?? null,
      fullEvent.policyVersion ?? 1,
      fullEvent.timestamp
    );

    return fullEvent;
  }

  async getLedgerEvents(agentId = 'default_agent', limit = 50): Promise<LedgerEvent[]> {
    const rows = db
      .prepare("SELECT * FROM ledger_events WHERE agentId = ? ORDER BY rowid DESC LIMIT ?")
      .all(agentId, limit) as any[];

    return rows.map((r) => ({
      id: r.id,
      transactionId: r.transactionId,
      tenantId: r.tenantId,
      agentId: r.agentId,
      eventType: r.eventType,
      payload: typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload,
      sequenceNum: r.sequenceNum,
      prevHash: r.prevHash,
      hash: r.hash,
      timestamp: r.timestamp,
      policyId: r.policyId || undefined,
      policyVersion: r.policyVersion || undefined,
    }));
  }

  async claimIdempotencyKey(
    tenantId: string,
    agentId: string,
    key: string,
    requestHash: string
  ): Promise<{ status: 'CLAIMED' | 'CACHED' | 'MISMATCH' | 'PROCESSING'; cachedResponse?: Record<string, unknown> }> {
    const now = new Date().toISOString();
    const existing = db
      .prepare('SELECT * FROM idempotency_keys WHERE tenantId = ? AND agentId = ? AND key = ?')
      .get(tenantId, agentId, key) as any;

    if (existing) {
      if (existing.requestHash !== requestHash) {
        return { status: 'MISMATCH' };
      }
      if (existing.status === 'COMPLETED' && existing.response) {
        const cached = typeof existing.response === 'string' ? JSON.parse(existing.response) : existing.response;
        return { status: 'CACHED', cachedResponse: cached };
      }
      if (existing.status === 'PROCESSING') {
        const ageMs = Date.now() - new Date(existing.createdAt).getTime();
        if (ageMs > 300000) {
          // Stale processing (> 5 min) -> reclaim
          db.prepare('UPDATE idempotency_keys SET status = "PROCESSING", updatedAt = ? WHERE tenantId = ? AND agentId = ? AND key = ?')
            .run(now, tenantId, agentId, key);
          return { status: 'CLAIMED' };
        }
        return { status: 'PROCESSING' };
      }
      return { status: 'PROCESSING' };
    }

    db.prepare(`
      INSERT INTO idempotency_keys (tenantId, agentId, key, requestHash, status, response, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, 'PROCESSING', NULL, ?, ?)
    `).run(tenantId, agentId, key, requestHash, now, now);

    return { status: 'CLAIMED' };
  }

  async completeIdempotencyKey(
    tenantId: string,
    agentId: string,
    key: string,
    response: Record<string, unknown>
  ): Promise<void> {
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE idempotency_keys
      SET status = 'COMPLETED', response = ?, updatedAt = ?
      WHERE tenantId = ? AND agentId = ? AND key = ?
    `).run(JSON.stringify(response), now, tenantId, agentId, key);
  }

  async failIdempotencyKey(tenantId: string, agentId: string, key: string): Promise<void> {
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE idempotency_keys
      SET status = 'FAILED', updatedAt = ?
      WHERE tenantId = ? AND agentId = ? AND key = ?
    `).run(now, tenantId, agentId, key);
  }

  async getActivePolicy(agentId = 'default_agent'): Promise<Policy> {
    const row = db
      .prepare("SELECT * FROM policies WHERE agentId = ? LIMIT 1")
      .get(agentId) as any;

    if (!row) {
      return {
        amountCeiling: 50000,
        category: 'Electronics',
        allowedMerchants: ['Amazon', 'BestBuy'],
        sessionCap: 100000,
        version: 1,
      };
    }

    return {
      id: row.id ? String(row.id) : 'default_policy',
      version: row.version ?? 1,
      amountCeiling: row.amountCeiling !== null ? row.amountCeiling : undefined,
      category: row.category !== null ? row.category : undefined,
      allowedMerchants: JSON.parse(row.allowedMerchants),
      sessionCap: row.sessionCap !== null ? row.sessionCap : undefined,
      reasonableQuantity: row.reasonableQuantity !== null ? row.reasonableQuantity : undefined,
      allowedMccCodes: row.allowedMccCodes !== null ? JSON.parse(row.allowedMccCodes) : undefined,
      sessionId: row.sessionId !== null ? row.sessionId : undefined,
      tenantId: row.tenantId !== null ? row.tenantId : undefined,
    };
  }

  async getPolicy(agentId = 'default_agent'): Promise<Policy> {
    return this.getActivePolicy(agentId);
  }

  async setActivePolicy(policy: Policy, agentId = 'default_agent'): Promise<Policy> {
    const allowedMerchantsJson = JSON.stringify(policy.allowedMerchants || []);
    const amountCeiling = policy.amountCeiling ?? null;
    const category = policy.category ?? null;
    const sessionCap = policy.sessionCap ?? null;
    const reasonableQuantity = policy.reasonableQuantity ?? null;
    const allowedMccCodesJson = policy.allowedMccCodes ? JSON.stringify(policy.allowedMccCodes) : null;
    const sessionId = policy.sessionId ?? null;
    const tenantId = policy.tenantId ?? 'default_tenant';
    const version = (policy.version ?? 1) + 1;

    db.prepare(`
      INSERT INTO policies (agentId, amountCeiling, category, allowedMerchants, sessionCap, reasonableQuantity, allowedMccCodes, sessionId, tenantId, version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(agentId) DO UPDATE SET
        amountCeiling = excluded.amountCeiling,
        category = excluded.category,
        allowedMerchants = excluded.allowedMerchants,
        sessionCap = excluded.sessionCap,
        reasonableQuantity = excluded.reasonableQuantity,
        allowedMccCodes = excluded.allowedMccCodes,
        sessionId = excluded.sessionId,
        tenantId = excluded.tenantId,
        version = excluded.version
    `).run(agentId, amountCeiling, category, allowedMerchantsJson, sessionCap, reasonableQuantity, allowedMccCodesJson, sessionId, tenantId, version);

    return this.getActivePolicy(agentId);
  }

  async setPolicy(policy: Policy, agentId = 'default_agent'): Promise<Policy> {
    return this.setActivePolicy(policy, agentId);
  }

  async getReserveState(agentId = 'default_agent', filterSessionId?: string): Promise<ReserveState> {
    // Expire stale frozen or reserved transactions past TTL
    await this.expireStaleTransactions(agentId);

    const reserveRow = db
      .prepare("SELECT * FROM reserve_state WHERE agentId = ? LIMIT 1")
      .get(agentId) as any;

    const totalPaise = reserveRow?.totalPaise ?? (reserveRow?.total ? Math.round(reserveRow.total * 100) : 200000);
    const heldPaise = reserveRow?.heldPaise ?? 0;
    const settledPaise = reserveRow?.settledPaise ?? 0;

    let txQuery = "SELECT * FROM (SELECT rowid as r_id, * FROM transactions WHERE agentId = ?";
    const params: (string | number)[] = [agentId];
    if (filterSessionId) {
      txQuery += ' AND sessionId = ?';
      params.push(filterSessionId);
    }
    txQuery += ' ORDER BY r_id DESC LIMIT 100) ORDER BY r_id ASC';

    const txRows = db.prepare(txQuery).all(...params) as any[];

    const transactions: Transaction[] = txRows.map((tx) => ({
      id: tx.id,
      merchant: tx.merchant,
      amount: tx.amount,
      category: tx.category,
      quantity: tx.quantity !== null ? tx.quantity : undefined,
      status: tx.status,
      decisionStatus: tx.decisionStatus || undefined,
      paymentStatus: tx.paymentStatus || undefined,
      decision: tx.decisionStatus || undefined,
      reason: tx.reason !== null ? tx.reason : undefined,
      timestamp: tx.timestamp,
      mccCode: tx.mccCode !== null ? tx.mccCode : undefined,
      productId: tx.productId !== null ? tx.productId : undefined,
      catalogVersion: tx.catalogVersion !== null ? tx.catalogVersion : undefined,
      hash: tx.hash || '',
      prevHash: tx.prevHash || '',
      razorpayOrderId: tx.razorpayOrderId !== null ? tx.razorpayOrderId : undefined,
      razorpayPaymentId: tx.razorpayPaymentId !== null ? tx.razorpayPaymentId : undefined,
      agentId: tx.agentId !== null ? tx.agentId : undefined,
      policyId: tx.policyId !== null ? tx.policyId : undefined,
      policyVersion: tx.policyVersion !== null ? tx.policyVersion : undefined,
      sessionId: tx.sessionId !== null ? tx.sessionId : undefined,
      tenantId: tx.tenantId !== null ? tx.tenantId : undefined,
      capturedPaise: tx.capturedPaise ?? 0,
      refundedPaise: tx.refundedPaise ?? 0,
      remainingRefundablePaise: Math.max(0, (tx.capturedPaise ?? 0) - (tx.refundedPaise ?? 0)),
      expiresAt: tx.expiresAt !== null ? tx.expiresAt : undefined,
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

    const total = Math.round(totalPaise / 100);
    const remaining = Math.round((totalPaise - heldPaise - settledPaise) / 100);

    db.prepare(`
      INSERT INTO reserve_state (agentId, totalPaise, heldPaise, settledPaise, total, remaining)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(agentId) DO UPDATE SET
        totalPaise = excluded.totalPaise,
        heldPaise = excluded.heldPaise,
        settledPaise = excluded.settledPaise,
        total = excluded.total,
        remaining = excluded.remaining
    `).run(agentId, totalPaise, heldPaise, settledPaise, total, remaining);

    if ('transactions' in state && Array.isArray(state.transactions)) {
      const existingIds = state.transactions.map((t) => t.id);
      if (existingIds.length === 0) {
        db.prepare("DELETE FROM transactions WHERE agentId = ?").run(agentId);
        db.prepare("DELETE FROM ledger_events WHERE agentId = ?").run(agentId);
      } else {
        const placeholders = existingIds.map(() => '?').join(',');
        db.prepare(`DELETE FROM transactions WHERE (agentId = ?) AND id NOT IN (${placeholders})`).run(agentId, ...existingIds);
      }
    }

    return this.getReserveState(agentId);
  }

  async recordTransaction(transaction: Transaction): Promise<Transaction> {
    const agentId = transaction.agentId || 'default_agent';
    const prevHash = transaction.prevHash || await this.getLastTransactionHash(agentId);
    const hash = transaction.hash || calculateTransactionHash({ ...transaction, prevHash });

    db.prepare(`
      INSERT INTO transactions (
        id, merchant, amount, category, quantity, status, decisionStatus, paymentStatus,
        reason, timestamp, mccCode, productId, catalogVersion, hash, prevHash,
        razorpayOrderId, razorpayPaymentId, agentId, policyId, policyVersion,
        sessionId, tenantId, capturedPaise, refundedPaise, expiresAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        merchant = excluded.merchant,
        amount = excluded.amount,
        category = excluded.category,
        quantity = excluded.quantity,
        status = excluded.status,
        decisionStatus = excluded.decisionStatus,
        paymentStatus = excluded.paymentStatus,
        reason = excluded.reason,
        timestamp = excluded.timestamp,
        mccCode = excluded.mccCode,
        productId = excluded.productId,
        catalogVersion = excluded.catalogVersion,
        hash = excluded.hash,
        prevHash = excluded.prevHash,
        razorpayOrderId = excluded.razorpayOrderId,
        razorpayPaymentId = excluded.razorpayPaymentId,
        agentId = excluded.agentId,
        policyId = excluded.policyId,
        policyVersion = excluded.policyVersion,
        sessionId = excluded.sessionId,
        tenantId = excluded.tenantId,
        capturedPaise = excluded.capturedPaise,
        refundedPaise = excluded.refundedPaise,
        expiresAt = excluded.expiresAt
    `).run(
      transaction.id,
      transaction.merchant,
      transaction.amount,
      transaction.category,
      transaction.quantity ?? null,
      transaction.status,
      transaction.decisionStatus ?? 'allowed',
      transaction.paymentStatus ?? 'requested',
      transaction.reason ?? null,
      transaction.timestamp,
      transaction.mccCode ?? null,
      transaction.productId ?? null,
      transaction.catalogVersion ?? null,
      hash,
      prevHash,
      transaction.razorpayOrderId ?? null,
      transaction.razorpayPaymentId ?? null,
      agentId,
      transaction.policyId ?? null,
      transaction.policyVersion ?? 1,
      transaction.sessionId ?? null,
      transaction.tenantId ?? 'default_tenant',
      transaction.capturedPaise ?? 0,
      transaction.refundedPaise ?? 0,
      transaction.expiresAt ?? null
    );

    return { ...transaction, prevHash, hash };
  }

  async processPurchaseAtomic(
    purchase: AttemptedPurchase & { override?: boolean }
  ): Promise<GuardCheckResult> {
    const agentId = purchase.agentId || 'default_agent';
    const purchaseAmount = purchase.amount ?? 0;

    // Rate-limiting coordination helper (does NOT decrement monetary source of truth)
    if (!purchase.override) {
      const activePolicy = await this.getActivePolicy(agentId);
      const capPaise = activePolicy.sessionCap || 200000;
      const tokenResult = await this.tokenBucket.acquireReserve(agentId, purchaseAmount, capPaise);
      if (!tokenResult.allowed) {
        const txId = purchase.id || `tx_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
        const timestamp = purchase.timestamp || new Date().toISOString();
        const reason = tokenResult.reason || `Rate limit / concurrency budget pool exceeded for agent ${agentId}`;
        const prevHash = this.getLastTransactionHashSync(agentId);
        const hash = calculateTransactionHash({ id: txId, timestamp, amount: purchaseAmount, merchant: purchase.merchant || 'Unknown', status: 'frozen', prevHash });

        db.prepare(`
          INSERT INTO transactions (id, merchant, amount, category, quantity, status, decisionStatus, paymentStatus, reason, timestamp, mccCode, hash, prevHash, agentId)
          VALUES (?, ?, ?, ?, ?, 'frozen', 'denied', 'failed', ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO NOTHING
        `).run(txId, purchase.merchant || 'Unknown', purchaseAmount, purchase.category || 'General', purchase.quantity ?? null, reason, timestamp, purchase.mccCode ?? null, hash, prevHash, agentId);

        this.appendLedgerEventSync({
          transactionId: txId,
          tenantId: purchase.tenantId || 'default_tenant',
          agentId,
          eventType: 'GUARD_REJECTED',
          payload: { reason, rule: 'RATE_LIMIT_EXCEEDED', amount: purchaseAmount },
          timestamp,
        });

        const currentState = await this.getReserveState(agentId, purchase.sessionId);
        return {
          decision: 'denied',
          decisionStatus: 'denied',
          paymentStatus: 'failed',
          reason,
          ruleViolated: 'SESSION_CAP_EXCEEDED',
          updatedReserveState: currentState,
        };
      }
    }

    const executeAtomic = db.transaction(() => {
      if (purchase.override) {
        const txId = purchase.id || `tx_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
        const timestamp = purchase.timestamp || new Date().toISOString();
        const prevHash = this.getLastTransactionHashSync(agentId);
        const hash = calculateTransactionHash({
          id: txId,
          timestamp,
          amount: purchaseAmount,
          merchant: purchase.merchant || 'Override Merchant',
          status: 'approved',
          prevHash,
        });

        const approvedTx: Transaction = {
          id: txId,
          merchant: purchase.merchant || 'Override Merchant',
          amount: purchaseAmount,
          category: purchase.category || 'General',
          quantity: purchase.quantity,
          status: 'approved',
          decisionStatus: 'allowed',
          paymentStatus: 'reserved',
          reason: 'Override approved by human authority',
          timestamp,
          mccCode: purchase.mccCode,
          agentId,
          policyId: purchase.policyId,
          policyVersion: purchase.policyVersion || 1,
          razorpayOrderId: purchase.razorpayOrderId,
          hash,
          prevHash,
        };

        db.prepare(`
          INSERT INTO transactions (
            id, merchant, amount, category, quantity, status, decisionStatus, paymentStatus,
            reason, timestamp, mccCode, hash, prevHash, razorpayOrderId, agentId, policyId, policyVersion, sessionId, expiresAt
          ) VALUES (?, ?, ?, ?, ?, 'approved', 'allowed', 'reserved', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            status = 'approved', decisionStatus = 'allowed', paymentStatus = 'reserved', reason = excluded.reason
        `).run(
          approvedTx.id, approvedTx.merchant, approvedTx.amount, approvedTx.category, approvedTx.quantity ?? null,
          approvedTx.reason, approvedTx.timestamp, approvedTx.mccCode ?? null, approvedTx.hash, approvedTx.prevHash,
          approvedTx.razorpayOrderId ?? null, agentId, approvedTx.policyId ?? null, approvedTx.policyVersion ?? 1,
          approvedTx.sessionId ?? null, approvedTx.expiresAt ?? null
        );

        db.prepare("UPDATE reserve_state SET heldPaise = heldPaise + ? WHERE agentId = ?").run(purchase.amount, agentId);

        const evt = this.appendLedgerEventSync({
          transactionId: txId,
          tenantId: purchase.tenantId || 'default_tenant',
          agentId,
          eventType: 'HUMAN_OVERRIDE_APPROVED',
          payload: { amount: purchase.amount, merchant: approvedTx.merchant, reason: approvedTx.reason },
          timestamp,
          policyId: approvedTx.policyId,
          policyVersion: approvedTx.policyVersion,
        });

        const updatedState = this.getReserveStateSync(agentId);

        return {
          decision: 'allowed' as const,
          decisionStatus: 'allowed' as const,
          paymentStatus: 'reserved' as const,
          reason: 'Override approved by human authority',
          transaction: approvedTx,
          ledgerEvent: evt,
          updatedReserveState: updatedState,
        };
      }

      // 1. Authoritative session spend calculation via SQL aggregate under transaction lock
      const activePolicy = this.getActivePolicySync(agentId);
      const currentState = this.getReserveStateSync(agentId, purchase.sessionId);

      // 2. Deterministic Guardrail Check
      const result = guardCheck(purchase, activePolicy, currentState);

      if (result.decision === 'allowed') {
        const tx = result.transaction!;
        const prevHash = this.getLastTransactionHashSync(agentId);
        tx.prevHash = prevHash;
        tx.hash = calculateTransactionHash({ ...tx, prevHash });

        db.prepare(`
          INSERT INTO transactions (
            id, merchant, amount, category, quantity, status, decisionStatus, paymentStatus,
            reason, timestamp, mccCode, productId, catalogVersion, hash, prevHash,
            razorpayOrderId, agentId, policyId, policyVersion, sessionId, tenantId, expiresAt
          ) VALUES (?, ?, ?, ?, ?, 'reserved', 'allowed', 'reserved', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            status = 'reserved', decisionStatus = 'allowed', paymentStatus = 'reserved',
            reason = excluded.reason, hash = excluded.hash
        `).run(
          tx.id, tx.merchant, tx.amount, tx.category, tx.quantity ?? null,
          tx.reason ?? null, tx.timestamp, tx.mccCode ?? null, tx.productId ?? null, tx.catalogVersion ?? null,
          tx.hash, tx.prevHash, tx.razorpayOrderId ?? null, agentId,
          tx.policyId ?? null, tx.policyVersion ?? 1, tx.sessionId ?? null,
          tx.tenantId ?? 'default_tenant', tx.expiresAt ?? null
        );

        db.prepare("UPDATE reserve_state SET heldPaise = heldPaise + ? WHERE agentId = ?").run(tx.amount, agentId);

        const evt = this.appendLedgerEventSync({
          transactionId: tx.id,
          tenantId: tx.tenantId || 'default_tenant',
          agentId,
          eventType: 'RESERVATION_CREATED',
          payload: {
            amount: tx.amount,
            merchant: tx.merchant,
            category: tx.category,
            productId: tx.productId,
            catalogVersion: tx.catalogVersion,
            policyId: tx.policyId,
            policyVersion: tx.policyVersion,
          },
          timestamp: tx.timestamp,
          policyId: tx.policyId,
          policyVersion: tx.policyVersion,
        });

        result.ledgerEvent = evt;
      } else {
        // Denied or Review -> record event with 0 funds held
        const tx = result.transaction!;
        const prevHash = this.getLastTransactionHashSync(agentId);
        tx.prevHash = prevHash;
        tx.hash = calculateTransactionHash({ ...tx, prevHash });

        db.prepare(`
          INSERT INTO transactions (
            id, merchant, amount, category, quantity, status, decisionStatus, paymentStatus,
            reason, timestamp, mccCode, productId, catalogVersion, hash, prevHash,
            agentId, policyId, policyVersion, sessionId, tenantId, expiresAt
          ) VALUES (?, ?, ?, ?, ?, 'frozen', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            status = 'frozen', decisionStatus = excluded.decisionStatus,
            paymentStatus = excluded.paymentStatus, reason = excluded.reason
        `).run(
          tx.id, tx.merchant, tx.amount, tx.category, tx.quantity ?? null,
          result.decisionStatus, result.paymentStatus, tx.reason ?? null,
          tx.timestamp, tx.mccCode ?? null, tx.productId ?? null, tx.catalogVersion ?? null,
          tx.hash, tx.prevHash, agentId, tx.policyId ?? null, tx.policyVersion ?? 1,
          tx.sessionId ?? null, tx.tenantId ?? 'default_tenant', tx.expiresAt ?? null
        );

        const evt = this.appendLedgerEventSync({
          transactionId: tx.id,
          tenantId: tx.tenantId || 'default_tenant',
          agentId,
          eventType: result.decision === 'review' ? 'REVIEW_REQUIRED' : 'GUARD_REJECTED',
          payload: {
            amount: tx.amount,
            merchant: tx.merchant,
            category: tx.category,
            ruleViolated: result.ruleViolated,
            reason: result.reason,
            limitPaise: result.limitPaise,
            requestedPaise: result.requestedPaise,
          },
          timestamp: tx.timestamp,
          policyId: tx.policyId,
          policyVersion: tx.policyVersion,
        });

        result.ledgerEvent = evt;
      }

      return result;
    });

    return executeAtomic();
  }

  private getActivePolicySync(agentId: string): Policy {
    const row = db.prepare("SELECT * FROM policies WHERE agentId = ? LIMIT 1").get(agentId) as any;
    if (!row) return { amountCeiling: 50000, category: 'Electronics', allowedMerchants: ['Amazon', 'BestBuy'], sessionCap: 100000, version: 1 };
    return {
      id: row.id ? String(row.id) : 'default_policy',
      version: row.version ?? 1,
      amountCeiling: row.amountCeiling ?? undefined,
      category: row.category ?? undefined,
      allowedMerchants: JSON.parse(row.allowedMerchants),
      sessionCap: row.sessionCap ?? undefined,
      reasonableQuantity: row.reasonableQuantity ?? undefined,
      allowedMccCodes: row.allowedMccCodes ? JSON.parse(row.allowedMccCodes) : undefined,
      sessionId: row.sessionId ?? undefined,
      tenantId: row.tenantId ?? 'default_tenant',
    };
  }

  private getReserveStateSync(agentId: string, filterSessionId?: string): ReserveState {
    const reserveRow = db.prepare("SELECT * FROM reserve_state WHERE agentId = ? LIMIT 1").get(agentId) as any;
    const totalPaise = reserveRow?.totalPaise ?? 200000;
    const heldPaise = reserveRow?.heldPaise ?? 0;
    const settledPaise = reserveRow?.settledPaise ?? 0;

    let query = "SELECT * FROM transactions WHERE agentId = ?";
    const params: any[] = [agentId];
    if (filterSessionId) {
      query += ' AND sessionId = ?';
      params.push(filterSessionId);
    }
    query += ' ORDER BY rowid ASC';

    const txRows = db.prepare(query).all(...params) as any[];
    const transactions: Transaction[] = txRows.map((tx) => ({
      id: tx.id,
      merchant: tx.merchant,
      amount: tx.amount,
      category: tx.category,
      quantity: tx.quantity ?? undefined,
      status: tx.status,
      decisionStatus: tx.decisionStatus || undefined,
      paymentStatus: tx.paymentStatus || undefined,
      decision: tx.decisionStatus || undefined,
      reason: tx.reason ?? undefined,
      timestamp: tx.timestamp,
      mccCode: tx.mccCode ?? undefined,
      productId: tx.productId ?? undefined,
      catalogVersion: tx.catalogVersion ?? undefined,
      hash: tx.hash || '',
      prevHash: tx.prevHash || '',
      razorpayOrderId: tx.razorpayOrderId ?? undefined,
      razorpayPaymentId: tx.razorpayPaymentId ?? undefined,
      agentId: tx.agentId ?? undefined,
      policyId: tx.policyId ?? undefined,
      policyVersion: tx.policyVersion ?? undefined,
      sessionId: tx.sessionId ?? undefined,
      tenantId: tx.tenantId ?? undefined,
      capturedPaise: tx.capturedPaise ?? 0,
      refundedPaise: tx.refundedPaise ?? 0,
      remainingRefundablePaise: Math.max(0, (tx.capturedPaise ?? 0) - (tx.refundedPaise ?? 0)),
      expiresAt: tx.expiresAt ?? undefined,
    }));

    return {
      totalPaise,
      heldPaise,
      settledPaise,
      availablePaise: totalPaise - heldPaise - settledPaise,
      total: totalPaise,
      remaining: totalPaise - heldPaise - settledPaise,
      transactions,
    };
  }

  private getLastTransactionHashSync(agentId: string): string {
    const lastTx = db.prepare("SELECT hash FROM transactions WHERE agentId = ? ORDER BY rowid DESC LIMIT 1").get(agentId) as any;
    return lastTx && lastTx.hash ? lastTx.hash : GENESIS_PREV_HASH;
  }

  async settleTransaction(txIdOrOrderId: string, razorpayPaymentId?: string, agentId = 'default_agent'): Promise<SettleResult> {
    const tx = db.prepare("SELECT * FROM transactions WHERE (id = ? OR razorpayOrderId = ?) AND (agentId = ?)").get(txIdOrOrderId, txIdOrOrderId, agentId) as any;
    if (!tx) return { success: false, error: 'Transaction not found' };

    const amount = tx.amount;
    const now = new Date().toISOString();

    db.prepare(`
      UPDATE transactions
      SET status = 'captured', decisionStatus = 'allowed', paymentStatus = 'captured',
          razorpayPaymentId = ?, capturedPaise = ?
      WHERE id = ?
    `).run(razorpayPaymentId || null, amount, tx.id);

    if (tx.status === 'reserved' || tx.paymentStatus === 'reserved' || tx.paymentStatus === 'order_created' || tx.paymentStatus === 'authorized') {
      db.prepare("UPDATE reserve_state SET heldPaise = MAX(0, heldPaise - ?), settledPaise = settledPaise + ? WHERE agentId = ?").run(amount, amount, agentId);
    }

    // Append immutable ledger event
    await this.appendLedgerEvent({
      transactionId: tx.id,
      tenantId: tx.tenantId || 'default_tenant',
      agentId,
      eventType: 'PAYMENT_CAPTURED',
      payload: {
        amount,
        razorpayPaymentId,
        razorpayOrderId: tx.razorpayOrderId,
      },
      timestamp: now,
      policyId: tx.policyId,
      policyVersion: tx.policyVersion,
    });

    const updatedRow = db.prepare("SELECT * FROM transactions WHERE id = ?").get(tx.id) as any;
    return { success: true, transactionId: tx.id, transaction: updatedRow };
  }

  async releaseReservation(txIdOrOrderId: string, reason = 'Reservation released/expired', agentId = 'default_agent'): Promise<ReleaseResult> {
    const tx = db.prepare("SELECT * FROM transactions WHERE (id = ? OR razorpayOrderId = ?) AND (agentId = ?)").get(txIdOrOrderId, txIdOrOrderId, agentId) as any;
    if (!tx) return { success: false, error: 'Transaction not found' };

    const amount = tx.amount;
    const now = new Date().toISOString();

    if (tx.status === 'reserved' || tx.paymentStatus === 'reserved' || tx.paymentStatus === 'order_creation_unknown' || tx.paymentStatus === 'order_created') {
      db.prepare(`
        UPDATE transactions
        SET status = 'expired', paymentStatus = 'released', reason = ?
        WHERE id = ?
      `).run(reason, tx.id);

      db.prepare("UPDATE reserve_state SET heldPaise = MAX(0, heldPaise - ?) WHERE agentId = ?").run(amount, agentId);

      await this.appendLedgerEvent({
        transactionId: tx.id,
        tenantId: tx.tenantId || 'default_tenant',
        agentId,
        eventType: 'RESERVATION_RELEASED',
        payload: { releasedAmount: amount, reason },
        timestamp: now,
        policyId: tx.policyId,
        policyVersion: tx.policyVersion,
      });
    }

    const updatedRow = db.prepare("SELECT * FROM transactions WHERE id = ?").get(tx.id) as any;
    return { success: true, transactionId: tx.id, releasedAmountPaise: amount, transaction: updatedRow };
  }

  async flagOrderCreationUnknown(txId: string, agentId = 'default_agent'): Promise<void> {
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE transactions
      SET paymentStatus = 'order_creation_unknown', reason = 'Razorpay order creation timed out — queued for reconciliation'
      WHERE id = ? AND (agentId = ?)
    `).run(txId, agentId);

    await this.appendLedgerEvent({
      transactionId: txId,
      tenantId: 'default_tenant',
      agentId,
      eventType: 'ORDER_UNKNOWN_FLAGGED',
      payload: { reason: 'Network drop/timeout during order creation' },
      timestamp: now,
    });
  }

  async processRefund(orderIdOrPaymentId: string, refundAmountPaise: number, refundId?: string, reason?: string, agentId = 'default_agent'): Promise<RefundResult> {
    const tx = db.prepare("SELECT * FROM transactions WHERE (razorpayOrderId = ? OR razorpayPaymentId = ? OR id = ?) AND (agentId = ?)").get(orderIdOrPaymentId, orderIdOrPaymentId, orderIdOrPaymentId, agentId) as any;
    if (!tx) return { success: false, error: 'Target transaction for refund not found' };

    const capturedPaise = tx.capturedPaise || tx.amount || 0;
    const currentRefundedPaise = tx.refundedPaise || 0;
    const remainingRefundable = capturedPaise - currentRefundedPaise;

    // Strict Refund Accounting Invariant: refund <= remaining refundable
    if (refundAmountPaise > remainingRefundable) {
      return {
        success: false,
        error: `Refund rejected: Requested refund amount (₹${(refundAmountPaise / 100).toFixed(2)}) exceeds remaining refundable balance (₹${(remainingRefundable / 100).toFixed(2)}).`,
      };
    }

    const newRefundedTotal = currentRefundedPaise + refundAmountPaise;
    const newStatus = newRefundedTotal >= capturedPaise ? 'refunded' : 'partially_refunded';
    const now = new Date().toISOString();
    const refundTxId = refundId || `ref_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;

    db.prepare(`
      UPDATE transactions
      SET refundedPaise = ?, paymentStatus = ?, status = ?
      WHERE id = ?
    `).run(newRefundedTotal, newStatus, newStatus, tx.id);

    db.prepare("UPDATE reserve_state SET settledPaise = MAX(0, settledPaise - ?) WHERE agentId = ?").run(refundAmountPaise, agentId);

    await this.appendLedgerEvent({
      transactionId: tx.id,
      tenantId: tx.tenantId || 'default_tenant',
      agentId,
      eventType: 'PAYMENT_REFUNDED',
      payload: {
        refundId: refundTxId,
        refundAmountPaise,
        totalRefundedPaise: newRefundedTotal,
        reason: reason || 'Refund processed',
      },
      timestamp: now,
      policyId: tx.policyId,
      policyVersion: tx.policyVersion,
    });

    return { success: true, refundId: refundTxId, refundedAmountPaise: refundAmountPaise };
  }

  async disputeTransaction(orderIdOrPaymentId: string, disputeReason?: string, agentId = 'default_agent'): Promise<DisputeResult> {
    const tx = db.prepare("SELECT * FROM transactions WHERE (razorpayOrderId = ? OR razorpayPaymentId = ? OR id = ?) AND (agentId = ?)").get(orderIdOrPaymentId, orderIdOrPaymentId, orderIdOrPaymentId, agentId) as any;
    if (!tx) return { success: false, error: 'Transaction not found for dispute' };

    const now = new Date().toISOString();
    db.prepare("UPDATE transactions SET status = 'disputed', paymentStatus = 'disputed', reason = ? WHERE id = ?").run(disputeReason || 'Payment dispute filed', tx.id);
    db.prepare("UPDATE policies SET category = 'FROZEN_DUE_TO_DISPUTE' WHERE agentId = ?").run(agentId);

    await this.appendLedgerEvent({
      transactionId: tx.id,
      tenantId: tx.tenantId || 'default_tenant',
      agentId,
      eventType: 'TRANSACTION_DISPUTED',
      payload: { disputeReason },
      timestamp: now,
    });

    return { success: true, transactionId: tx.id, status: 'disputed' };
  }

  async verifyLedgerIntegrity(agentId = 'default_agent', batchSize = 1000): Promise<LedgerIntegrityResult> {
    let offset = 0;
    let expectedPrevHash = GENESIS_PREV_HASH;
    let currentIndex = 0;

    while (true) {
      const rows = db
        .prepare("SELECT * FROM ledger_events WHERE agentId = ? ORDER BY sequenceNum ASC LIMIT ? OFFSET ?")
        .all(agentId, batchSize, offset) as any[];
      if (rows.length === 0) break;

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (row.prevHash !== expectedPrevHash) {
          return { isValid: false, corruptedIndex: currentIndex, reason: `PrevHash mismatch at event index ${currentIndex}` };
        }

        const payloadObj = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
        const payloadHash = calculatePayloadHash(payloadObj);
        const calculated = calculateLedgerEventHash({
          id: row.id,
          transactionId: row.transactionId,
          eventType: row.eventType,
          timestamp: row.timestamp,
          payloadHash,
          sequenceNum: row.sequenceNum,
          prevHash: row.prevHash,
        });

        if (row.hash !== calculated) {
          return { isValid: false, corruptedIndex: currentIndex, reason: `Event hash mismatch at event index ${currentIndex}` };
        }

        expectedPrevHash = row.hash;
        currentIndex++;
      }

      if (rows.length < batchSize) break;
      offset += batchSize;
    }

    return { isValid: true, totalEventsVerified: currentIndex };
  }

  async expireStaleTransactions(agentId = 'default_agent'): Promise<number> {
    const now = new Date().toISOString();
    const staleReserved = db
      .prepare("SELECT * FROM transactions WHERE (agentId = ?) AND (status = 'reserved' OR paymentStatus = 'reserved') AND expiresAt IS NOT NULL AND expiresAt < ?")
      .all(agentId, now) as any[];

    let expiredCount = 0;
    for (const stale of staleReserved) {
      db.prepare("UPDATE transactions SET status = 'expired', paymentStatus = 'expired', reason = 'Reservation TTL expired' WHERE id = ?").run(stale.id);
      db.prepare("UPDATE reserve_state SET heldPaise = MAX(0, heldPaise - ?) WHERE agentId = ?").run(stale.amount, agentId);

      this.appendLedgerEventSync({
        transactionId: stale.id,
        tenantId: stale.tenantId || 'default_tenant',
        agentId,
        eventType: 'RESERVATION_EXPIRED',
        payload: { expiredAmount: stale.amount, reason: 'TTL elapsed' },
        timestamp: now,
      });

      expiredCount++;
    }

    return expiredCount;
  }

  async resetStore(agentId?: string): Promise<void> {
    await this.tokenBucket.reset(agentId);
    if (agentId) {
      db.prepare('DELETE FROM transactions WHERE agentId = ?').run(agentId);
      db.prepare('DELETE FROM ledger_events WHERE agentId = ?').run(agentId);
      db.prepare('DELETE FROM idempotency_keys WHERE agentId = ?').run(agentId);
      db.prepare('DELETE FROM policies WHERE agentId = ?').run(agentId);
      db.prepare('DELETE FROM reserve_state WHERE agentId = ?').run(agentId);
    } else {
      db.prepare('DELETE FROM transactions').run();
      db.prepare('DELETE FROM ledger_events').run();
      db.prepare('DELETE FROM idempotency_keys').run();
      db.prepare('DELETE FROM webhook_events').run();
      db.prepare('DELETE FROM policies').run();
      db.prepare('DELETE FROM reserve_state').run();
    }
    initDatabase();
  }

  async recordSecurityAudit(event: SecurityAuditEvent): Promise<SecurityAuditEvent> {
    const id = event.id || `audit_${Date.now()}`;
    const timestamp = event.timestamp || new Date().toISOString();
    db.prepare(`
      INSERT INTO security_audit_logs (id, timestamp, eventType, role, identity, endpoint, method, details, ip)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, timestamp, event.eventType, event.role ?? null, event.identity ?? null, event.endpoint, event.method, event.details, event.ip ?? null);
    return { ...event, id, timestamp };
  }

  async getSecurityAuditLogs(limit = 50): Promise<SecurityAuditEvent[]> {
    const rows = db.prepare('SELECT * FROM security_audit_logs ORDER BY timestamp DESC LIMIT ?').all(limit) as any[];
    return rows.map((row) => ({
      id: row.id,
      timestamp: row.timestamp,
      eventType: row.eventType,
      role: row.role || undefined,
      identity: row.identity || undefined,
      endpoint: row.endpoint,
      method: row.method,
      details: row.details,
      ip: row.ip || undefined,
    }));
  }
}

