/* eslint-disable @typescript-eslint/no-explicit-any */
import db, { initDatabase } from './db';
import {
  Policy, ReserveState, Transaction, AttemptedPurchase, GuardCheckResult,
  TransactionStatus, SecurityAuditEvent, IReserveStore, ReserveStoreType,
  SettleResult, ReleaseResult, RefundResult, DisputeResult, LedgerIntegrityResult,
  IRedisTokenBucket
} from './types';
import { guardCheck } from './guardCheck';
import { calculateTransactionHash, GENESIS_PREV_HASH } from './crypto';
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
      .prepare("SELECT hash FROM transactions WHERE agentId = ? OR agentId = 'default_agent' ORDER BY rowid DESC LIMIT 1")
      .get(agentId) as { hash: string } | undefined;
    return lastTx && lastTx.hash ? lastTx.hash : GENESIS_PREV_HASH;
  }

  async getActivePolicy(agentId = 'default_agent'): Promise<Policy> {
    const row = db
      .prepare("SELECT * FROM policies WHERE agentId = ? OR agentId = 'default_agent' LIMIT 1")
      .get(agentId) as {
      amountCeiling: number | null;
      category: string | null;
      allowedMerchants: string;
      sessionCap: number | null;
      reasonableQuantity: number | null;
      allowedMccCodes: string | null;
      sessionId: string | null;
    } | undefined;

    if (!row) {
      return {
        amountCeiling: 50000,
        category: 'Electronics',
        allowedMerchants: ['Amazon', 'BestBuy'],
        sessionCap: 100000,
      };
    }

    const policy: Policy = {
      allowedMerchants: JSON.parse(row.allowedMerchants),
    };

    if (row.amountCeiling !== null) policy.amountCeiling = row.amountCeiling;
    if (row.category !== null) policy.category = row.category;
    if (row.sessionCap !== null) policy.sessionCap = row.sessionCap;
    if (row.reasonableQuantity !== null) policy.reasonableQuantity = row.reasonableQuantity;
    if (row.allowedMccCodes !== null) policy.allowedMccCodes = JSON.parse(row.allowedMccCodes);
    if (row.sessionId !== null) policy.sessionId = row.sessionId;

    return policy;
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

    db.prepare(`
      INSERT INTO policies (agentId, amountCeiling, category, allowedMerchants, sessionCap, reasonableQuantity, allowedMccCodes, sessionId)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(agentId) DO UPDATE SET
        amountCeiling = excluded.amountCeiling,
        category = excluded.category,
        allowedMerchants = excluded.allowedMerchants,
        sessionCap = excluded.sessionCap,
        reasonableQuantity = excluded.reasonableQuantity,
        allowedMccCodes = excluded.allowedMccCodes,
        sessionId = excluded.sessionId
    `).run(agentId, amountCeiling, category, allowedMerchantsJson, sessionCap, reasonableQuantity, allowedMccCodesJson, sessionId);

    return this.getActivePolicy(agentId);
  }

  async setPolicy(policy: Policy, agentId = 'default_agent'): Promise<Policy> {
    return this.setActivePolicy(policy, agentId);
  }

  async getReserveState(agentId = 'default_agent', filterSessionId?: string): Promise<ReserveState> {
    // Expire stale frozen transactions
    const now = new Date().toISOString();
    const staleTxs = db.prepare("SELECT * FROM transactions WHERE (agentId = ? OR agentId = 'default_agent') AND status = 'frozen' AND expiresAt IS NOT NULL AND expiresAt < ?").all(agentId, now) as any[];
    for (const staleTx of staleTxs) {
      const newHash = calculateTransactionHash({
        id: staleTx.id,
        timestamp: staleTx.timestamp,
        amount: staleTx.amount,
        merchant: staleTx.merchant,
        status: 'frozen',
        prevHash: staleTx.prevHash,
      });
      db.prepare("UPDATE transactions SET reason = 'skipped — agent moved on', hash = ? WHERE id = ?").run(newHash, staleTx.id);
    }

    const reserveRow = db
      .prepare("SELECT * FROM reserve_state WHERE agentId = ? OR agentId = 'default_agent' LIMIT 1")
      .get(agentId) as {
      totalPaise: number | null;
      heldPaise: number | null;
      settledPaise: number | null;
      total: number | null;
      remaining: number | null;
    } | undefined;

    const totalPaise = reserveRow?.totalPaise ?? (reserveRow?.total ? Math.round(reserveRow.total * 100) : 200000);
    const heldPaise = reserveRow?.heldPaise ?? 0;
    const settledPaise = reserveRow?.settledPaise ?? 0;

    let txQuery = "SELECT * FROM (SELECT rowid as r_id, * FROM transactions WHERE agentId = ? OR agentId = 'default_agent'";
    const params: (string | number)[] = [agentId];
    if (filterSessionId) {
      txQuery += ' AND sessionId = ?';
      params.push(filterSessionId);
    }
    txQuery += ' ORDER BY r_id DESC LIMIT 100) ORDER BY r_id ASC';

    const txRows = db.prepare(txQuery).all(...params) as Array<{
      id: string;
      merchant: string;
      amount: number;
      category: string;
      quantity: number | null;
      status: TransactionStatus;
      reason: string | null;
      timestamp: string;
      mccCode: string | null;
      hash: string | null;
      prevHash: string | null;
      razorpayOrderId: string | null;
      razorpayPaymentId: string | null;
      agentId: string | null;
      policyId: string | null;
      sessionId: string | null;
      expiresAt: string | null;
    }>;

    const transactions: Transaction[] = txRows.map((tx) => ({
      id: tx.id,
      merchant: tx.merchant,
      amount: tx.amount,
      category: tx.category,
      quantity: tx.quantity !== null ? tx.quantity : undefined,
      status: tx.status,
      reason: tx.reason !== null ? tx.reason : undefined,
      timestamp: tx.timestamp,
      mccCode: tx.mccCode !== null ? tx.mccCode : undefined,
      hash: tx.hash || '',
      prevHash: tx.prevHash || '',
      razorpayOrderId: tx.razorpayOrderId !== null ? tx.razorpayOrderId : undefined,
      razorpayPaymentId: tx.razorpayPaymentId !== null ? tx.razorpayPaymentId : undefined,
      agentId: tx.agentId !== null ? tx.agentId : undefined,
      policyId: tx.policyId !== null ? tx.policyId : undefined,
      sessionId: tx.sessionId !== null ? tx.sessionId : undefined,
      expiresAt: tx.expiresAt !== null ? tx.expiresAt : undefined,
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
        db.prepare("DELETE FROM transactions WHERE agentId = ? OR agentId = 'default_agent'").run(agentId);
      } else {
        const placeholders = existingIds.map(() => '?').join(',');
        db.prepare(`DELETE FROM transactions WHERE (agentId = ? OR agentId = 'default_agent') AND id NOT IN (${placeholders})`).run(agentId, ...existingIds);
        for (const tx of state.transactions) {
          await this.recordTransaction({ ...tx, agentId });
        }
      }
    }

    return this.getReserveState(agentId);
  }

  async recordTransaction(transaction: Transaction): Promise<Transaction> {
    const agentId = transaction.agentId || 'default_agent';
    const prevHash = transaction.prevHash || await this.getLastTransactionHash(agentId);
    const hash = transaction.hash || calculateTransactionHash({ ...transaction, prevHash });

    const tx: Transaction = {
      ...transaction,
      agentId,
      prevHash,
      hash,
    };

    db.prepare(`
      INSERT INTO transactions (id, merchant, amount, category, quantity, status, reason, timestamp, mccCode, hash, prevHash, razorpayOrderId, razorpayPaymentId, agentId, policyId, sessionId, expiresAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        merchant = excluded.merchant,
        amount = excluded.amount,
        category = excluded.category,
        quantity = excluded.quantity,
        status = excluded.status,
        reason = excluded.reason,
        timestamp = excluded.timestamp,
        mccCode = excluded.mccCode,
        hash = excluded.hash,
        prevHash = excluded.prevHash,
        razorpayOrderId = excluded.razorpayOrderId,
        razorpayPaymentId = excluded.razorpayPaymentId,
        agentId = excluded.agentId,
        policyId = excluded.policyId,
        sessionId = excluded.sessionId,
        expiresAt = excluded.expiresAt
    `).run(
      tx.id,
      tx.merchant,
      tx.amount,
      tx.category,
      tx.quantity ?? null,
      tx.status,
      tx.reason ?? null,
      tx.timestamp,
      tx.mccCode ?? null,
      tx.hash,
      tx.prevHash,
      tx.razorpayOrderId ?? null,
      tx.razorpayPaymentId ?? null,
      tx.agentId ?? null,
      tx.policyId ?? null,
      tx.sessionId ?? null,
      tx.expiresAt ?? null
    );

    return tx;
  }

  async processPurchaseAtomic(
    purchase: AttemptedPurchase & { override?: boolean }
  ): Promise<GuardCheckResult> {
    const agentId = purchase.agentId || 'default_agent';

    if (!purchase.override) {
      const activePolicy = await this.getActivePolicy(agentId);
      const capPaise = activePolicy.sessionCap || 200000;
      const tokenResult = await this.tokenBucket.acquireReserve(agentId, purchase.amount, capPaise);
      if (!tokenResult.allowed) {
        const txId = purchase.id || `tx_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
        const timestamp = purchase.timestamp || new Date().toISOString();
        const reason = tokenResult.reason || `Token bucket budget pool exceeded for agent ${agentId}`;
        const prevHash = this.getLastTransactionHashSync(agentId);
        const hash = calculateTransactionHash({ id: txId, timestamp, amount: purchase.amount, merchant: purchase.merchant, status: 'frozen', prevHash });
        db.prepare(`
          INSERT INTO transactions (id, merchant, amount, category, quantity, status, reason, timestamp, mccCode, hash, prevHash, agentId)
          VALUES (?, ?, ?, ?, ?, 'frozen', ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO NOTHING
        `).run(txId, purchase.merchant, purchase.amount, purchase.category, purchase.quantity ?? null, reason, timestamp, purchase.mccCode ?? null, hash, prevHash, agentId);

        const currentState = await this.getReserveState(agentId, purchase.sessionId);
        return {
          decision: 'freeze',
          reason,
          updatedReserveState: currentState,
        };
      }
    }

    const executeAtomic = db.transaction(() => {
      if (purchase.override) {
        const txId = purchase.id || `tx_${Date.now()}`;
        const timestamp = purchase.timestamp || new Date().toISOString();
        const status = 'approved' as const;
        const prevHash = this.getLastTransactionHashSync(agentId);

        const hash = calculateTransactionHash({
          id: txId,
          timestamp,
          amount: purchase.amount,
          merchant: purchase.merchant,
          status,
          prevHash,
        });

        const approvedTx: Transaction = {
          id: txId,
          merchant: purchase.merchant,
          amount: purchase.amount,
          category: purchase.category,
          quantity: purchase.quantity,
          status,
          reason: 'Override approved by user',
          timestamp,
          mccCode: purchase.mccCode,
          agentId,
          policyId: purchase.policyId,
          razorpayOrderId: purchase.razorpayOrderId,
          hash,
          prevHash,
        };

        db.prepare(`
          INSERT INTO transactions (id, merchant, amount, category, quantity, status, reason, timestamp, mccCode, hash, prevHash, razorpayOrderId, agentId, policyId, sessionId, expiresAt)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            merchant = excluded.merchant,
            amount = excluded.amount,
            category = excluded.category,
            quantity = excluded.quantity,
            status = excluded.status,
            reason = excluded.reason,
            timestamp = excluded.timestamp,
            mccCode = excluded.mccCode,
            hash = excluded.hash,
            prevHash = excluded.prevHash,
            razorpayOrderId = excluded.razorpayOrderId,
            agentId = excluded.agentId,
            policyId = excluded.policyId,
            sessionId = excluded.sessionId,
            expiresAt = excluded.expiresAt
        `).run(
          approvedTx.id, approvedTx.merchant, approvedTx.amount, approvedTx.category, approvedTx.quantity ?? null,
          approvedTx.status, approvedTx.reason ?? null, approvedTx.timestamp, approvedTx.mccCode ?? null,
          approvedTx.hash, approvedTx.prevHash, approvedTx.razorpayOrderId ?? null, agentId,
          approvedTx.policyId ?? null, approvedTx.sessionId ?? null, approvedTx.expiresAt ?? null
        );

        db.prepare("UPDATE reserve_state SET heldPaise = heldPaise + ? WHERE agentId = ? OR agentId = 'default_agent'").run(purchase.amount, agentId);

        const updatedState = this.getReserveStateSync(agentId);

        return {
          decision: 'approve' as const,
          reason: 'Override approved by user',
          updatedReserveState: updatedState,
        };
      }

      const activePolicy = this.getActivePolicySync(agentId);
      const currentState = this.getReserveStateSync(agentId, purchase.sessionId);

      const result = guardCheck(purchase, activePolicy, currentState);

      if (result.decision === 'approve' || result.decision === 'freeze') {
        const txList = result.updatedReserveState.transactions;
        if (txList.length > 0) {
          const tx = txList[txList.length - 1];
          const prevHash = this.getLastTransactionHashSync(agentId);
          tx.prevHash = prevHash;
          tx.hash = calculateTransactionHash({ ...tx, prevHash });

          db.prepare(`
            INSERT INTO transactions (id, merchant, amount, category, quantity, status, reason, timestamp, mccCode, hash, prevHash, razorpayOrderId, agentId, policyId, sessionId, expiresAt)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET status = excluded.status, reason = excluded.reason, hash = excluded.hash
          `).run(
            tx.id, tx.merchant, tx.amount, tx.category, tx.quantity ?? null,
            tx.status, tx.reason ?? null, tx.timestamp, tx.mccCode ?? null,
            tx.hash, tx.prevHash, tx.razorpayOrderId ?? null, agentId,
            tx.policyId ?? null, tx.sessionId ?? null, tx.expiresAt ?? null
          );

          if (tx.status === 'reserved') {
            db.prepare("UPDATE reserve_state SET heldPaise = heldPaise + ? WHERE agentId = ? OR agentId = 'default_agent'").run(tx.amount, agentId);
          }
        }
      }

      return result;
    });

    return executeAtomic();
  }

  private getActivePolicySync(agentId: string): Policy {
    const row = db.prepare("SELECT * FROM policies WHERE agentId = ? OR agentId = 'default_agent' LIMIT 1").get(agentId) as any;
    if (!row) return { amountCeiling: 50000, category: 'Electronics', allowedMerchants: ['Amazon', 'BestBuy'], sessionCap: 100000 };
    return {
      amountCeiling: row.amountCeiling ?? undefined,
      category: row.category ?? undefined,
      allowedMerchants: JSON.parse(row.allowedMerchants),
      sessionCap: row.sessionCap ?? undefined,
      reasonableQuantity: row.reasonableQuantity ?? undefined,
      allowedMccCodes: row.allowedMccCodes ? JSON.parse(row.allowedMccCodes) : undefined,
      sessionId: row.sessionId ?? undefined,
    };
  }

  private getReserveStateSync(agentId: string, filterSessionId?: string): ReserveState {
    const reserveRow = db.prepare("SELECT * FROM reserve_state WHERE agentId = ? OR agentId = 'default_agent' LIMIT 1").get(agentId) as any;
    const totalPaise = reserveRow?.totalPaise ?? 200000;
    const heldPaise = reserveRow?.heldPaise ?? 0;
    const settledPaise = reserveRow?.settledPaise ?? 0;

    let query = "SELECT * FROM transactions WHERE agentId = ? OR agentId = 'default_agent'";
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
      reason: tx.reason ?? undefined,
      timestamp: tx.timestamp,
      mccCode: tx.mccCode ?? undefined,
      hash: tx.hash || '',
      prevHash: tx.prevHash || '',
      razorpayOrderId: tx.razorpayOrderId ?? undefined,
      razorpayPaymentId: tx.razorpayPaymentId ?? undefined,
      agentId: tx.agentId ?? undefined,
      policyId: tx.policyId ?? undefined,
      sessionId: tx.sessionId ?? undefined,
      expiresAt: tx.expiresAt ?? undefined,
    }));

    return { totalPaise, heldPaise, settledPaise, availablePaise: totalPaise - heldPaise - settledPaise, total: totalPaise, remaining: totalPaise - heldPaise - settledPaise, transactions };
  }

  private getLastTransactionHashSync(agentId: string): string {
    const lastTx = db.prepare("SELECT hash FROM transactions WHERE agentId = ? OR agentId = 'default_agent' ORDER BY rowid DESC LIMIT 1").get(agentId) as any;
    return lastTx && lastTx.hash ? lastTx.hash : GENESIS_PREV_HASH;
  }

  async settleTransaction(txIdOrOrderId: string, razorpayPaymentId?: string, agentId = 'default_agent'): Promise<SettleResult> {
    const tx = db.prepare("SELECT * FROM transactions WHERE (id = ? OR razorpayOrderId = ?) AND (agentId = ? OR agentId = 'default_agent')").get(txIdOrOrderId, txIdOrOrderId, agentId) as any;
    if (!tx) return { success: false, error: 'Transaction not found' };

    const newHash = calculateTransactionHash({
      id: tx.id,
      timestamp: tx.timestamp,
      amount: tx.amount,
      merchant: tx.merchant,
      status: 'captured',
      prevHash: tx.prevHash || GENESIS_PREV_HASH,
    });

    db.prepare("UPDATE transactions SET status = 'captured', razorpayPaymentId = ?, hash = ? WHERE id = ?").run(razorpayPaymentId || null, newHash, tx.id);
    if (tx.status === 'reserved') {
      db.prepare("UPDATE reserve_state SET heldPaise = MAX(0, heldPaise - ?), settledPaise = settledPaise + ? WHERE agentId = ? OR agentId = 'default_agent'").run(tx.amount, tx.amount, agentId);
    }
    const updatedRow = db.prepare("SELECT * FROM transactions WHERE id = ?").get(tx.id) as any;
    const updatedTx: Transaction = {
      id: updatedRow.id,
      merchant: updatedRow.merchant,
      amount: updatedRow.amount,
      category: updatedRow.category,
      status: updatedRow.status,
      reason: updatedRow.reason || undefined,
      timestamp: updatedRow.timestamp,
      razorpayOrderId: updatedRow.razorpayOrderId || undefined,
      razorpayPaymentId: updatedRow.razorpayPaymentId || undefined,
      hash: updatedRow.hash || '',
      prevHash: updatedRow.prevHash || '',
    };
    return { success: true, transactionId: tx.id, transaction: updatedTx };
  }

  async releaseReservation(txIdOrOrderId: string, reason = 'Reservation released/expired', agentId = 'default_agent'): Promise<ReleaseResult> {
    const tx = db.prepare("SELECT * FROM transactions WHERE (id = ? OR razorpayOrderId = ?) AND (agentId = ? OR agentId = 'default_agent')").get(txIdOrOrderId, txIdOrOrderId, agentId) as any;
    if (!tx) return { success: false, error: 'Transaction not found' };

    if (tx.status === 'reserved' || tx.status === 'frozen') {
      const newHash = calculateTransactionHash({
        id: tx.id,
        timestamp: tx.timestamp,
        amount: tx.amount,
        merchant: tx.merchant,
        status: 'expired',
        prevHash: tx.prevHash || GENESIS_PREV_HASH,
      });

      db.prepare("UPDATE transactions SET status = 'expired', reason = ?, hash = ? WHERE id = ?").run(reason, newHash, tx.id);
      if (tx.status === 'reserved') {
        db.prepare("UPDATE reserve_state SET heldPaise = MAX(0, heldPaise - ?) WHERE agentId = ? OR agentId = 'default_agent'").run(tx.amount, agentId);
      }
    }
    const updatedRow = db.prepare("SELECT * FROM transactions WHERE id = ?").get(tx.id) as any;
    const updatedTx: Transaction = {
      id: updatedRow.id,
      merchant: updatedRow.merchant,
      amount: updatedRow.amount,
      category: updatedRow.category,
      status: updatedRow.status,
      reason: updatedRow.reason || undefined,
      timestamp: updatedRow.timestamp,
      razorpayOrderId: updatedRow.razorpayOrderId || undefined,
      razorpayPaymentId: updatedRow.razorpayPaymentId || undefined,
      hash: updatedRow.hash || '',
      prevHash: updatedRow.prevHash || '',
    };
    return { success: true, transactionId: tx.id, releasedAmountPaise: tx.amount, transaction: updatedTx };
  }

  async processRefund(orderIdOrPaymentId: string, refundAmountPaise: number, refundId?: string, reason?: string, agentId = 'default_agent'): Promise<RefundResult> {
    const tx = db.prepare("SELECT * FROM transactions WHERE (razorpayOrderId = ? OR razorpayPaymentId = ? OR id = ?) AND (agentId = ? OR agentId = 'default_agent')").get(orderIdOrPaymentId, orderIdOrPaymentId, orderIdOrPaymentId, agentId) as any;
    if (!tx) return { success: false, error: 'Target transaction for refund not found' };

    db.prepare("UPDATE reserve_state SET settledPaise = MAX(0, settledPaise - ?) WHERE agentId = ? OR agentId = 'default_agent'").run(refundAmountPaise, agentId);

    const prevHash = await this.getLastTransactionHash(agentId);
    const refundTxId = refundId || `ref_${Date.now()}`;
    const timestamp = new Date().toISOString();
    const razorpayPaymentId = refundId || tx.razorpayPaymentId || null;
    const hash = calculateTransactionHash({ id: refundTxId, timestamp, amount: refundAmountPaise, merchant: tx.merchant, status: 'refunded', prevHash });

    db.prepare(`
      INSERT INTO transactions (id, agentId, merchant, amount, category, status, reason, timestamp, hash, prevHash, razorpayOrderId, razorpayPaymentId)
      VALUES (?, ?, ?, ?, ?, 'refunded', ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = 'refunded',
        reason = excluded.reason,
        hash = excluded.hash,
        razorpayPaymentId = excluded.razorpayPaymentId
    `).run(refundTxId, agentId, tx.merchant, refundAmountPaise, tx.category, reason || 'Refund processed', timestamp, hash, prevHash, tx.razorpayOrderId, razorpayPaymentId);

    return { success: true, refundId: refundTxId, refundedAmountPaise: refundAmountPaise };
  }

  async disputeTransaction(orderIdOrPaymentId: string, disputeReason?: string, agentId = 'default_agent'): Promise<DisputeResult> {
    const tx = db.prepare("SELECT * FROM transactions WHERE (razorpayOrderId = ? OR razorpayPaymentId = ? OR id = ?) AND (agentId = ? OR agentId = 'default_agent')").get(orderIdOrPaymentId, orderIdOrPaymentId, orderIdOrPaymentId, agentId) as any;
    if (!tx) return { success: false, error: 'Transaction not found for dispute' };

    const newHash = calculateTransactionHash({
      id: tx.id,
      timestamp: tx.timestamp,
      amount: tx.amount,
      merchant: tx.merchant,
      status: 'disputed',
      prevHash: tx.prevHash || GENESIS_PREV_HASH,
    });

    db.prepare("UPDATE transactions SET status = 'disputed', reason = ?, hash = ? WHERE id = ?").run(disputeReason || 'Payment dispute filed', newHash, tx.id);
    db.prepare("UPDATE policies SET category = 'FROZEN_DUE_TO_DISPUTE' WHERE agentId = ? OR agentId = 'default_agent'").run(agentId);
    return { success: true, transactionId: tx.id, status: 'disputed' };
  }

  async verifyLedgerIntegrity(agentId = 'default_agent', batchSize = 1000): Promise<LedgerIntegrityResult> {
    let offset = 0;
    let expectedPrevHash = GENESIS_PREV_HASH;
    let currentIndex = 0;

    while (true) {
      const txRows = db.prepare("SELECT * FROM transactions WHERE agentId = ? OR agentId = 'default_agent' ORDER BY rowid ASC LIMIT ? OFFSET ?").all(agentId, batchSize, offset) as any[];
      if (txRows.length === 0) break;

      for (let i = 0; i < txRows.length; i++) {
        const row = txRows[i];
        if (row.prevHash !== expectedPrevHash) return { isValid: false, corruptedIndex: currentIndex };
        const calculated = calculateTransactionHash({ id: row.id, timestamp: row.timestamp, amount: row.amount, merchant: row.merchant, status: row.status, prevHash: row.prevHash });
        if (row.hash !== calculated) return { isValid: false, corruptedIndex: currentIndex };
        expectedPrevHash = row.hash;
        currentIndex++;
      }

      if (txRows.length < batchSize) break;
      offset += batchSize;
    }

    return { isValid: true };
  }

  async resetStore(agentId?: string): Promise<void> {
    await this.tokenBucket.reset(agentId);
    if (agentId) {
      db.prepare('DELETE FROM transactions WHERE agentId = ?').run(agentId);
      db.prepare('DELETE FROM policies WHERE agentId = ?').run(agentId);
      db.prepare('DELETE FROM reserve_state WHERE agentId = ?').run(agentId);
    } else {
      db.prepare('DELETE FROM transactions').run();
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
