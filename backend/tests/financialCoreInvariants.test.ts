import { describe, it, expect, beforeEach } from 'vitest';
import { SqliteReserveStore } from '../lib/sqliteStore';
import { Transaction } from '../lib/types';

describe('Financial Core Invariants — 8 Required Proofs', () => {
  let store: SqliteReserveStore;
  let testAgent: string;

  beforeEach(async () => {
    testAgent = `fin_inv_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    store = new SqliteReserveStore();
    await store.resetStore(testAgent);
    await store.setReserveState(
      { totalPaise: 200000, heldPaise: 0, settledPaise: 0 },
      testAgent
    );
    await store.setActivePolicy(
      {
        amountCeiling: 200000,
        category: 'Food & Dining',
        allowedMerchants: ['Swiggy', 'Zomato', 'Blinkit'],
        sessionCap: 200000,
        reasonableQuantity: 3,
        allowedMccCodes: ['5812', '5814'],
      },
      testAgent
    );
  });

  // ============================================================================
  // INVARIANT 1: Available balance never becomes negative
  // ============================================================================
  it('Invariant 1: available balance never becomes negative', async () => {
    // Fill up the reserve completely
    for (let i = 0; i < 2; i++) {
      const res = await store.processPurchaseAtomic({
        id: `tx_avail_${i}_${Date.now()}`,
        agentId: testAgent,
        merchant: 'Swiggy',
        amount: 80000,
        category: 'Food & Dining',
        mccCode: '5812',
      });
      expect(res.decision).toBe('allowed');
    }

    // Third purchase should be denied (160000 + 80000 > 200000)
    const denied = await store.processPurchaseAtomic({
      id: `tx_avail_denied_${Date.now()}`,
      agentId: testAgent,
      merchant: 'Swiggy',
      amount: 80000,
      category: 'Food & Dining',
      mccCode: '5812',
    });
    expect(denied.decision).toBe('denied');

    const state = await store.getReserveState(testAgent);
    expect(state.availablePaise).toBeGreaterThanOrEqual(0);
    expect(state.totalPaise).toBe(state.heldPaise + state.settledPaise + state.availablePaise);
  });

  // ============================================================================
  // INVARIANT 2: Held balance never becomes negative
  // ============================================================================
  it('Invariant 2: held balance never becomes negative', async () => {
    const txId = `tx_held_${Date.now()}`;
    await store.processPurchaseAtomic({
      id: txId,
      agentId: testAgent,
      merchant: 'Swiggy',
      amount: 50000,
      category: 'Food & Dining',
      mccCode: '5812',
    });

    let state = await store.getReserveState(testAgent);
    expect(state.heldPaise).toBe(50000);

    // Release the reservation
    await store.releaseReservation(txId, 'test release', testAgent);
    state = await store.getReserveState(testAgent);
    expect(state.heldPaise).toBe(0);
    expect(state.heldPaise).toBeGreaterThanOrEqual(0);

    // Releasing again should be idempotent, not make held negative
    await store.releaseReservation(txId, 'double release', testAgent);
    state = await store.getReserveState(testAgent);
    expect(state.heldPaise).toBe(0);
    expect(state.heldPaise).toBeGreaterThanOrEqual(0);
  });

  // ============================================================================
  // INVARIANT 3: held <= reserve (heldPaise <= totalPaise)
  // ============================================================================
  it('Invariant 3: held <= reserve (heldPaise <= totalPaise)', async () => {
    // Make several purchases
    for (let i = 0; i < 2; i++) {
      await store.processPurchaseAtomic({
        id: `tx_held_reserve_${i}_${Date.now()}`,
        agentId: testAgent,
        merchant: 'Swiggy',
        amount: 70000,
        category: 'Food & Dining',
        mccCode: '5812',
      });
    }

    const state = await store.getReserveState(testAgent);
    expect(state.heldPaise).toBeLessThanOrEqual(state.totalPaise);
    expect(state.heldPaise + state.settledPaise).toBeLessThanOrEqual(state.totalPaise);
  });

  // ============================================================================
  // INVARIANT 4: refunded <= captured (prevents over-refund)
  // ============================================================================
  it('Invariant 4: refunded <= captured (over-refund prevented)', async () => {
    const txId = `tx_refund_inv_${Date.now()}`;

    // Reserve -> Capture
    await store.processPurchaseAtomic({
      id: txId,
      agentId: testAgent,
      merchant: 'Swiggy',
      amount: 60000,
      category: 'Food & Dining',
      mccCode: '5812',
    });
    await store.settleTransaction(txId, 'pay_refund_inv', testAgent);

    // Partial refund
    const r1 = await store.processRefund(txId, 30000, 'ref_1', 'partial', testAgent);
    expect(r1.success).toBe(true);

    let state = await store.getReserveState(testAgent);
    expect(state.settledPaise).toBe(30000);

    // Second partial refund
    const r2 = await store.processRefund(txId, 25000, 'ref_2', 'another partial', testAgent);
    expect(r2.success).toBe(true);

    state = await store.getReserveState(testAgent);
    expect(state.settledPaise).toBe(5000);

    // Over-refund attempt (30000 + 25000 + 10000 = 65000 > 60000)
    const r3 = await store.processRefund(txId, 10000, 'ref_3', 'over-refund', testAgent);
    expect(r3.success).toBe(false);
    expect(r3.error).toContain('exceeds remaining refundable balance');

    // Exactly the remainder should work (60000 - 55000 = 5000)
    const r4 = await store.processRefund(txId, 5000, 'ref_4', 'exact remainder', testAgent);
    expect(r4.success).toBe(true);

    // Now fully refunded, any further refund must fail
    const r5 = await store.processRefund(txId, 1, 'ref_5', 'one more paise', testAgent);
    expect(r5.success).toBe(false);

    const stateEnd = await store.getReserveState(testAgent);
    const tx = stateEnd.transactions.find(t => t.id === txId);
    expect(tx!.refundedPaise).toBeLessThanOrEqual(tx!.capturedPaise!);
    expect(tx!.refundedPaise).toBe(60000);
  });

  // ============================================================================
  // INVARIANT 5: settled amount never exceeds captured amount
  // ============================================================================
  it('Invariant 5: settled amount never exceeds captured amount', async () => {
    const txId = `tx_settled_inv_${Date.now()}`;

    await store.processPurchaseAtomic({
      id: txId,
      agentId: testAgent,
      merchant: 'Swiggy',
      amount: 50000,
      category: 'Food & Dining',
      mccCode: '5812',
    });

    // Settle
    await store.settleTransaction(txId, 'pay_settled_inv', testAgent);

    let state = await store.getReserveState(testAgent);
    expect(state.settledPaise).toBe(50000);

    // Double-settle should be idempotent
    await store.settleTransaction(txId, 'pay_settled_inv', testAgent);
    state = await store.getReserveState(testAgent);
    expect(state.settledPaise).toBe(50000); // Unchanged

    const tx = state.transactions.find(t => t.id === txId);
    expect(tx!.capturedPaise).toBe(50000);
    expect(state.settledPaise).toBeLessThanOrEqual(tx!.capturedPaise!);
  });

  // ============================================================================
  // INVARIANT 6: Denied requests cause zero financial side effects
  // ============================================================================
  it('Invariant 6: denied requests cause zero financial side effects', async () => {
    const stateBefore = await store.getReserveState(testAgent);
    const heldBefore = stateBefore.heldPaise;
    const settledBefore = stateBefore.settledPaise;

    // Deny: unallowed merchant
    const denied1 = await store.processPurchaseAtomic({
      id: `tx_denied_merchant_${Date.now()}`,
      agentId: testAgent,
      merchant: 'Uber',
      amount: 30000,
      category: 'Food & Dining',
      mccCode: '5812',
    });
    expect(denied1.decision).toBe('denied');

    // Deny: amount ceiling
    const denied2 = await store.processPurchaseAtomic({
      id: `tx_denied_ceiling_${Date.now()}`,
      agentId: testAgent,
      merchant: 'Swiggy',
      amount: 250000, // > 200000 ceiling
      category: 'Food & Dining',
      mccCode: '5812',
    });
    expect(denied2.decision).toBe('denied');

    const stateAfter = await store.getReserveState(testAgent);
    expect(stateAfter.heldPaise).toBe(heldBefore);
    expect(stateAfter.settledPaise).toBe(settledBefore);
    expect(stateAfter.availablePaise).toBe(stateBefore.availablePaise);
  });

  // ============================================================================
  // INVARIANT 7: Released reservations no longer count as active spend
  // ============================================================================
  it('Invariant 7: released reservations no longer count as active spend', async () => {
    // Use a tighter session cap to test
    await store.setActivePolicy(
      {
        amountCeiling: 100000,
        category: 'Food & Dining',
        allowedMerchants: ['Swiggy'],
        sessionCap: 100000, // session cap
        reasonableQuantity: 3,
        allowedMccCodes: ['5812'],
      },
      testAgent
    );

    const tx1Id = `tx_release_spend_1_${Date.now()}`;
    const tx2Id = `tx_release_spend_2_${Date.now()}`;
    const tx3Id = `tx_release_spend_3_${Date.now()}`;

    // Reserve 70000
    const r1 = await store.processPurchaseAtomic({
      id: tx1Id,
      agentId: testAgent,
      merchant: 'Swiggy',
      amount: 70000,
      category: 'Food & Dining',
      mccCode: '5812',
    });
    expect(r1.decision).toBe('allowed');

    // This would exceed session cap if tx1 still counted (70000+40000 = 110000 > 100000)
    const r2Denied = await store.processPurchaseAtomic({
      id: tx2Id,
      agentId: testAgent,
      merchant: 'Swiggy',
      amount: 40000,
      category: 'Food & Dining',
      mccCode: '5812',
    });
    expect(r2Denied.decision).toBe('denied');

    // Release tx1
    await store.releaseReservation(tx1Id, 'abandoned', testAgent);

    const stateAfterRelease = await store.getReserveState(testAgent);
    expect(stateAfterRelease.heldPaise).toBe(0);

    // Now tx3 should succeed since tx1 no longer counts toward session spend
    const r3 = await store.processPurchaseAtomic({
      id: tx3Id,
      agentId: testAgent,
      merchant: 'Swiggy',
      amount: 40000,
      category: 'Food & Dining',
      mccCode: '5812',
    });
    expect(r3.decision).toBe('allowed');
  });

  // ============================================================================
  // INVARIANT 8: 1,000 concurrent requests cannot overspend the reserve
  // ============================================================================
  it('Invariant 8: 1,000 concurrent requests cannot overspend the reserve (SQLite serialized)', async () => {
    // Set small reserve: 100000 total with 10000 per item = max 10 allowed
    await store.setReserveState(
      { totalPaise: 100000, heldPaise: 0, settledPaise: 0 },
      testAgent
    );
    await store.setActivePolicy(
      {
        amountCeiling: 15000,
        category: 'Food & Dining',
        allowedMerchants: ['Swiggy'],
        sessionCap: 100000,
        reasonableQuantity: 3,
        allowedMccCodes: ['5812'],
      },
      testAgent
    );

    const TOTAL_REQUESTS = 1000;
    const AMOUNT_PER = 10000;
    const MAX_ALLOWED = 10; // 100000 / 10000 = 10

    // Fire 1,000 requests concurrently
    const promises = Array.from({ length: TOTAL_REQUESTS }, (_, i) =>
      store.processPurchaseAtomic({
        id: `tx_conc_${i}_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
        agentId: testAgent,
        merchant: 'Swiggy',
        amount: AMOUNT_PER,
        category: 'Food & Dining',
        mccCode: '5812',
      })
    );

    const results = await Promise.all(promises);
    const allowed = results.filter(r => r.decision === 'allowed');
    const denied = results.filter(r => r.decision === 'denied');

    // Exactly 10 should be allowed, the rest denied
    expect(allowed.length).toBe(MAX_ALLOWED);
    expect(denied.length).toBe(TOTAL_REQUESTS - MAX_ALLOWED);

    // Verify final state
    const finalState = await store.getReserveState(testAgent);
    expect(finalState.heldPaise).toBe(MAX_ALLOWED * AMOUNT_PER);
    expect(finalState.availablePaise).toBe(0);
    expect(finalState.heldPaise).toBeGreaterThanOrEqual(0);
    expect(finalState.settledPaise).toBeGreaterThanOrEqual(0);
    expect(finalState.heldPaise + finalState.settledPaise).toBeLessThanOrEqual(finalState.totalPaise);

    // Verify ledger integrity
    const integrity = await store.verifyLedgerIntegrity(testAgent);
    expect(integrity.isValid).toBe(true);
  }, 30000);

  // ============================================================================
  // Additional: State transition enforcement
  // ============================================================================
  it('settleTransaction rejects invalid state transitions', async () => {
    const txId = `tx_invalid_settle_${Date.now()}`;
    await store.processPurchaseAtomic({
      id: txId,
      agentId: testAgent,
      merchant: 'Swiggy',
      amount: 30000,
      category: 'Food & Dining',
      mccCode: '5812',
    });

    // Release it first
    await store.releaseReservation(txId, 'test', testAgent);

    // Attempt to settle a released transaction
    const result = await store.settleTransaction(txId, 'pay_invalid', testAgent);
    expect(result.success).toBe(false);
    expect(result.error).toContain('cannot capture');
  });

  it('releaseReservation rejects invalid state transitions', async () => {
    const txId = `tx_invalid_release_${Date.now()}`;
    await store.processPurchaseAtomic({
      id: txId,
      agentId: testAgent,
      merchant: 'Swiggy',
      amount: 30000,
      category: 'Food & Dining',
      mccCode: '5812',
    });

    // Settle it first
    await store.settleTransaction(txId, 'pay_test', testAgent);

    // Attempt to release a captured transaction
    const result = await store.releaseReservation(txId, 'test', testAgent);
    expect(result.success).toBe(false);
    expect(result.error).toContain('cannot release');
  });

  it('processRefund rejects refunds on non-captured transactions', async () => {
    const txId = `tx_refund_noncap_${Date.now()}`;
    await store.processPurchaseAtomic({
      id: txId,
      agentId: testAgent,
      merchant: 'Swiggy',
      amount: 30000,
      category: 'Food & Dining',
      mccCode: '5812',
    });

    // Attempt to refund a reserved (not captured) transaction
    const result = await store.processRefund(txId, 10000, 'ref_bad', 'test', testAgent);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Cannot refund');
  });

  it('idempotent refund: same refundId does not double-decrement', async () => {
    const txId = `tx_idem_refund_${Date.now()}`;
    await store.processPurchaseAtomic({
      id: txId,
      agentId: testAgent,
      merchant: 'Swiggy',
      amount: 50000,
      category: 'Food & Dining',
      mccCode: '5812',
    });
    await store.settleTransaction(txId, 'pay_idem', testAgent);

    const refundId = `ref_idem_${Date.now()}`;

    // First refund
    const r1 = await store.processRefund(txId, 20000, refundId, 'test', testAgent);
    expect(r1.success).toBe(true);

    let state = await store.getReserveState(testAgent);
    expect(state.settledPaise).toBe(30000); // 50000 - 20000

    // Same refundId again — should be idempotent
    const r2 = await store.processRefund(txId, 20000, refundId, 'test', testAgent);
    expect(r2.success).toBe(true);

    state = await store.getReserveState(testAgent);
    expect(state.settledPaise).toBe(30000); // Unchanged, not 10000
  });

  it('getTransactionByIdOrOrderId finds transactions by ID and order ID', async () => {
    const txId = `tx_lookup_${Date.now()}`;
    await store.processPurchaseAtomic({
      id: txId,
      agentId: testAgent,
      merchant: 'Swiggy',
      amount: 30000,
      category: 'Food & Dining',
      mccCode: '5812',
    });

    const orderId = `order_mock_lookup_${Date.now()}`;
    await store.attachRazorpayOrder(txId, orderId, testAgent);

    // Lookup by txId
    const byTxId = await store.getTransactionByIdOrOrderId(txId, testAgent);
    expect(byTxId).not.toBeNull();
    expect(byTxId!.id).toBe(txId);

    // Lookup by orderId
    const byOrderId = await store.getTransactionByIdOrOrderId(orderId, testAgent);
    expect(byOrderId).not.toBeNull();
    expect(byOrderId!.id).toBe(txId);
    expect(byOrderId!.razorpayOrderId).toBe(orderId);
  });
});
