import { describe, it, expect, beforeEach } from 'vitest';
import { SqliteReserveStore } from '../lib/sqliteStore';
import { calculateTransactionHash, calculateLedgerEventHash, calculatePayloadHash, GENESIS_PREV_HASH } from '../lib/crypto';
import { guardCheck } from '../lib/guardCheck';
import { Policy, ReserveState, AttemptedPurchase } from '../lib/types';
import { resolveCatalogProduct, CURRENT_CATALOG_VERSION } from '../lib/merchantCatalog';

describe('Reserve Pay Guardrail — 9 Financial System Invariants', () => {
  let store: SqliteReserveStore;
  let testAgent: string;

  beforeEach(async () => {
    testAgent = `test_agent_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    store = new SqliteReserveStore();
    await store.resetStore(testAgent);
    await store.setReserveState(
      { totalPaise: 200000, heldPaise: 0, settledPaise: 0 },
      testAgent
    );
    await store.setActivePolicy(
      {
        amountCeiling: 100000, // ₹1000
        category: 'Food & Dining',
        merchantMode: 'allowlist', allowedMerchants: ['Swiggy', 'Zomato', 'Blinkit'],
        sessionCap: 150000, // ₹1,500
        reasonableQuantity: 3,
        allowedMccCodes: ['5812', '5814'],
      },
      testAgent
    );
  });

  // Invariant 1: Zero-Overspend Invariant
  it('Invariant 1: Zero-Overspend — availablePaise >= 0 and totalPaise == heldPaise + settledPaise + availablePaise', async () => {
    const p1 = await store.processPurchaseAtomic({
      id: `tx_${testAgent}_1`,
      agentId: testAgent,
      merchant: 'Swiggy',
      amount: 70000, // ₹700
      category: 'Food & Dining',
      mccCode: '5812',
    });
    expect(p1.decision).toBe('allowed');

    const stateAfterP1 = await store.getReserveState(testAgent);
    expect(stateAfterP1.heldPaise).toBe(70000);
    expect(stateAfterP1.availablePaise).toBe(130000);
    expect(stateAfterP1.totalPaise).toBe(stateAfterP1.heldPaise + stateAfterP1.settledPaise + stateAfterP1.availablePaise);
    expect(stateAfterP1.availablePaise).toBeGreaterThanOrEqual(0);

    // Attempt second purchase within session cap (700 + 700 = 1400 <= 1500)
    const p2 = await store.processPurchaseAtomic({
      id: `tx_${testAgent}_2`,
      agentId: testAgent,
      merchant: 'Zomato',
      amount: 70000, // ₹700
      category: 'Food & Dining',
      mccCode: '5812',
    });
    expect(p2.decision).toBe('allowed');

    // Attempt third purchase that would exceed session cap (1400 + 200 = 1600 > 1500)
    const p3 = await store.processPurchaseAtomic({
      id: `tx_${testAgent}_3`,
      agentId: testAgent,
      merchant: 'Blinkit',
      amount: 20000, // ₹200
      category: 'Food & Dining',
      mccCode: '5814',
    });
    expect(p3.decision).toBe('denied');
    expect(p3.ruleViolated).toBe('SESSION_CAP_EXCEEDED');

    const stateFinal = await store.getReserveState(testAgent);
    expect(stateFinal.heldPaise).toBe(140000);
    expect(stateFinal.availablePaise).toBe(60000);
    expect(stateFinal.totalPaise).toBe(stateFinal.heldPaise + stateFinal.settledPaise + stateFinal.availablePaise);
    expect(stateFinal.availablePaise).toBeGreaterThanOrEqual(0);
  });

  // Invariant 2: Durable Idempotency Invariant
  it('Invariant 2: Durable Idempotency — Scoped by (tenant, agent, key), returns cached on match, 409 on payload mismatch', async () => {
    const key = `idem_${Date.now()}`;
    const hash1 = 'hash_payload_alpha';
    const hash2 = 'hash_payload_beta';

    const claim1 = await store.claimIdempotencyKey('default_tenant', testAgent, key, hash1);
    expect(claim1.status).toBe('CLAIMED');

    const mockResponse = { decision: 'allowed', paymentStatus: 'order_created', orderId: 'order_123' };
    await store.completeIdempotencyKey('default_tenant', testAgent, key, mockResponse);

    const claim2 = await store.claimIdempotencyKey('default_tenant', testAgent, key, hash1);
    expect(claim2.status).toBe('CACHED');
    expect(claim2.cachedResponse).toEqual(mockResponse);

    const claim3 = await store.claimIdempotencyKey('default_tenant', testAgent, key, hash2);
    expect(claim3.status).toBe('MISMATCH');
  });

  // Invariant 3: Atomic Reservation Invariant
  it('Invariant 3: Atomic Reservation — heldPaise increments on reserve, transitions to settled or released, never double decremented', async () => {
    const txId = `tx_inv3_${Date.now()}`;
    const res = await store.processPurchaseAtomic({
      id: txId,
      agentId: testAgent,
      merchant: 'Swiggy',
      amount: 50000,
      category: 'Food & Dining',
    });
    expect(res.decision).toBe('allowed');

    let state = await store.getReserveState(testAgent);
    expect(state.heldPaise).toBe(50000);
    expect(state.settledPaise).toBe(0);

    const settleRes = await store.settleTransaction(txId, 'pay_123456', testAgent);
    expect(settleRes.success).toBe(true);

    state = await store.getReserveState(testAgent);
    expect(state.heldPaise).toBe(0);
    expect(state.settledPaise).toBe(50000);

    await store.settleTransaction(txId, 'pay_123456', testAgent);
    state = await store.getReserveState(testAgent);
    expect(state.heldPaise).toBe(0);
    expect(state.settledPaise).toBe(50000);
  });

  // Invariant 4: Strict Refund Accounting Invariant
  it('Invariant 4: Strict Refund Accounting — refundAmount <= (capturedPaise - refundedPaise)', async () => {
    const txId = `tx_inv4_${Date.now()}`;
    await store.processPurchaseAtomic({
      id: txId,
      agentId: testAgent,
      merchant: 'Swiggy',
      amount: 60000,
      category: 'Food & Dining',
    });
    await store.settleTransaction(txId, 'pay_inv4', testAgent);

    const r1 = await store.processRefund(txId, 20000, 'ref_1', 'Customer item return', testAgent);
    expect(r1.success).toBe(true);

    let state = await store.getReserveState(testAgent);
    expect(state.settledPaise).toBe(40000);

    const r2 = await store.processRefund(txId, 40000, 'ref_2', 'Remaining balance return', testAgent);
    expect(r2.success).toBe(true);

    state = await store.getReserveState(testAgent);
    expect(state.settledPaise).toBe(0);

    const r3 = await store.processRefund(txId, 10000, 'ref_3', 'Excess refund', testAgent);
    expect(r3.success).toBe(false);
  });

  // Invariant 5: Cryptographic Ledger Chain Invariant
  it('Invariant 5: Cryptographic Ledger Chain — Append-only SHA-256 event chain verifies cleanly, state updates do not trigger false tamper alerts', async () => {
    const txId = `tx_inv5_${Date.now()}`;
    await store.processPurchaseAtomic({
      id: txId,
      agentId: testAgent,
      merchant: 'Swiggy',
      amount: 45000,
      category: 'Food & Dining',
    });

    await store.settleTransaction(txId, 'pay_inv5', testAgent);

    const integrity = await store.verifyLedgerIntegrity(testAgent);
    expect(integrity.isValid).toBe(true);
    expect(integrity.totalEventsVerified).toBeGreaterThanOrEqual(2);
  });

  // Invariant 6: Multi-Factor Decision Invariant
  it('Invariant 6: Multi-Factor Deterministic Guardrail — Evaluates amount, merchant, category, quantity, and MCC codes', () => {
    const policy: Policy = {
      amountCeiling: 50000, // ₹500
      category: 'Groceries',
      merchantMode: 'allowlist', allowedMerchants: ['Swiggy', 'Blinkit'],
      sessionCap: 100000, // ₹1,000
      reasonableQuantity: 3,
      allowedMccCodes: ['5411'],
    };

    const currentState: ReserveState = {
      totalPaise: 200000,
      heldPaise: 0,
      settledPaise: 0,
      availablePaise: 200000,
      total: 200000,
      remaining: 200000,
      transactions: [],
    };

    // Case A: Exceeding amount ceiling -> DENIED
    const r1 = guardCheck(policy, currentState, { amount: 60000, merchant: 'Swiggy', category: 'Groceries', mccCode: '5411' });
    expect(r1.decision).toBe('denied');
    expect(r1.ruleViolated).toBe('AMOUNT_CEILING_EXCEEDED');

    // Case B: Unallowed Merchant -> DENIED
    const r2 = guardCheck(policy, currentState, { amount: 30000, merchant: 'Uber', category: 'Groceries', mccCode: '5411' });
    expect(r2.decision).toBe('denied');
    expect(r2.ruleViolated).toBe('MERCHANT_NOT_ALLOWED');

    // Case C: Unallowed Category and MCC -> DENIED
    const r3 = guardCheck(policy, currentState, { amount: 30000, merchant: 'Swiggy', category: 'Electronics', mccCode: '5732' });
    expect(r3.decision).toBe('denied');
    expect(r3.ruleViolated).toBe('CATEGORY_NOT_ALLOWED');

    // Case D: Quantity Anomaly (> reasonableQuantity) -> REVIEW
    const r4 = guardCheck(policy, currentState, { amount: 30000, merchant: 'Swiggy', category: 'Groceries', quantity: 5, mccCode: '5411' });
    expect(r4.decision).toBe('review');
    expect(r4.ruleViolated).toBe('QUANTITY_ANOMALY');

    // Case E: Extreme Quantity Anomaly (> 2 * reasonableQuantity) -> DENIED
    const r5 = guardCheck(policy, currentState, { amount: 30000, merchant: 'Swiggy', category: 'Groceries', quantity: 10, mccCode: '5411' });
    expect(r5.decision).toBe('denied');
    expect(r5.ruleViolated).toBe('QUANTITY_ANOMALY');

    // Case F: Valid Transaction -> ALLOWED
    const r6 = guardCheck(policy, currentState, { amount: 30000, merchant: 'Swiggy', category: 'Groceries', quantity: 2, mccCode: '5411' });
    expect(r6.decision).toBe('allowed');
  });

  // Invariant 7: Decoupled Decision & Payment States
  it('Invariant 7: State Decoupling — DecisionStatus and PaymentStatus operate independently', async () => {
    const txId = `tx_inv7_${Date.now()}`;
    const result = await store.processPurchaseAtomic({
      id: txId,
      agentId: testAgent,
      merchant: 'Swiggy',
      amount: 40000,
      category: 'Food & Dining',
    });

    expect(result.decisionStatus).toBe('allowed');
    expect(result.paymentStatus).toBe('reserved');

    await store.settleTransaction(txId, 'pay_inv7', testAgent);
    const state = await store.getReserveState(testAgent);
    const tx = state.transactions.find(t => t.id === txId);
    expect(tx?.decisionStatus).toBe('allowed');
    expect(tx?.paymentStatus).toBe('captured');
  });

  // Invariant 8: 3-Outcome Failure Handling
  it('Invariant 8: 3-Outcome Failure Handling — flagOrderCreationUnknown queues for reconciliation, releaseReservation frees funds', async () => {
    const txId = `tx_inv8_${Date.now()}`;
    await store.processPurchaseAtomic({
      id: txId,
      agentId: testAgent,
      merchant: 'Swiggy',
      amount: 45000,
      category: 'Food & Dining',
    });

    await store.flagOrderCreationUnknown(txId, testAgent);

    let state = await store.getReserveState(testAgent);
    let tx = state.transactions.find(t => t.id === txId);
    expect(tx?.paymentStatus).toBe('order_creation_unknown');
    expect(state.heldPaise).toBe(45000);

    await store.releaseReservation(txId, 'Reconciled: order not found on Razorpay', testAgent);

    state = await store.getReserveState(testAgent);
    tx = state.transactions.find(t => t.id === txId);
    expect(tx?.paymentStatus).toBe('released');
    expect(state.heldPaise).toBe(0);
  });

  // Invariant 9: Fail-Closed Authoritative Catalog Resolution
  it('Invariant 9: Authoritative Mock Merchant Catalog — Resolves trusted prices, MCCs, and catalog version', () => {
    const product = resolveCatalogProduct('swiggy-dinner-650');
    expect(product).toBeDefined();
    expect(product?.unitPricePaise || product?.pricePaise).toBe(65000);
    expect(product?.merchantName || product?.merchant).toBe('Swiggy');
    expect(product?.category).toBe('Food & Dining');
    expect(CURRENT_CATALOG_VERSION).toBe('2026.09.v1');

    const invalid = resolveCatalogProduct('fake-product-999');
    expect(invalid).toBeNull();
  });
});
