import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SqliteReserveStore } from '../lib/sqliteStore';
import { runReconciliation } from '../lib/reconciler';
import * as razorpayModule from '../lib/razorpayClient';

function agentId() {
  return `fail_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

const DEFAULT_POLICY = {
  amountCeiling: 80000,
  category: 'Food & Dining',
  allowedMerchants: ['Swiggy'],
  sessionCap: 200000,
};

describe('Failure – Razorpay definite failure releases reservation', () => {
  let store: SqliteReserveStore;
  let aid: string;

  beforeEach(async () => {
    aid = agentId();
    store = new SqliteReserveStore();
    await store.resetStore(aid);
    await store.setReserveState({ totalPaise: 200000, heldPaise: 0, settledPaise: 0 }, aid);
    await store.setActivePolicy(DEFAULT_POLICY, aid);
  });

  it('reservation released when Razorpay order creation definitively fails', async () => {
    const txId = `tx_fail_${Date.now()}`;
    const purchaseRes = await store.processPurchaseAtomic({ id: txId, agentId: aid, merchant: 'Swiggy', amount: 65000, category: 'Food & Dining' });
    expect(purchaseRes.decision).toBe('allowed');

    let state = await store.getReserveState(aid);
    expect(state.heldPaise).toBe(65000);

    // Simulate: route handler calls releaseReservation on definite gateway failure
    const release = await store.releaseReservation(txId, 'Razorpay order creation rejected by gateway', aid);
    expect(release.success).toBe(true);

    state = await store.getReserveState(aid);
    expect(state.heldPaise).toBe(0);
    expect(state.availablePaise).toBe(200000);
    expect(state.transactions.find((t) => t.id === txId)?.paymentStatus).toBe('released');
  });

  it('ledger records RESERVATION_RELEASED event after gateway failure', async () => {
    const txId = `tx_fail_ledger_${Date.now()}`;
    await store.processPurchaseAtomic({ id: txId, agentId: aid, merchant: 'Swiggy', amount: 30000, category: 'Food & Dining' });
    await store.releaseReservation(txId, 'Gateway rejected', aid);

    const events = await store.getLedgerEvents(aid, 20);
    const releaseEvent = events.find((e) => e.eventType === 'RESERVATION_RELEASED');
    expect(releaseEvent).toBeDefined();
    expect(releaseEvent?.payload.releasedAmount).toBe(30000);
  });
});

describe('Failure – Razorpay timeout → unknown → reconciliation', () => {
  let store: SqliteReserveStore;
  let aid: string;

  beforeEach(async () => {
    aid = agentId();
    store = new SqliteReserveStore();
    await store.resetStore(aid);
    await store.setReserveState({ totalPaise: 200000, heldPaise: 0, settledPaise: 0 }, aid);
    await store.setActivePolicy(DEFAULT_POLICY, aid);
  });

  it('timeout: flags as order_creation_unknown, funds remain held', async () => {
    const txId = `tx_timeout_${Date.now()}`;
    await store.processPurchaseAtomic({ id: txId, agentId: aid, merchant: 'Swiggy', amount: 55000, category: 'Food & Dining' });
    await store.flagOrderCreationUnknown(txId, aid);

    const tx = await store.getTransactionByIdOrOrderId(txId, aid);
    expect(tx?.paymentStatus).toBe('order_creation_unknown');

    const state = await store.getReserveState(aid);
    expect(state.heldPaise).toBe(55000); // still held pending reconciliation
  });

  it('reconciliation: gateway found order → attaches and records ORDER_RECONCILED_FOUND', async () => {
    const txId = `tx_recon_found_${Date.now()}`;
    await store.processPurchaseAtomic({ id: txId, agentId: aid, merchant: 'Swiggy', amount: 45000, category: 'Food & Dining' });
    await store.flagOrderCreationUnknown(txId, aid);

    vi.spyOn(razorpayModule, 'getRazorpayClient').mockReturnValue({
      orders: {
        create: vi.fn(),
        fetch: vi.fn().mockResolvedValue({ id: 'order_rzp_found_999', amount: 45000, status: 'created' }),
        fetchByReceipt: vi.fn().mockResolvedValue({ id: 'order_rzp_found_999', amount: 45000, status: 'created' }),
      },
    } as any);

    const summary = await runReconciliation(aid);
    expect(summary.orderReconciledCount).toBe(1);
    expect(summary.errors).toHaveLength(0);

    const tx = await store.getTransactionByIdOrOrderId(txId, aid);
    expect(tx?.razorpayOrderId).toBe('order_rzp_found_999');
    expect(tx?.paymentStatus).toBe('order_created');

    const events = await store.getLedgerEvents(aid, 30);
    expect(events.some((e) => e.eventType === 'ORDER_RECONCILED_FOUND')).toBe(true);
  });

  it('reconciliation: order never created → reservation released', async () => {
    const txId = `tx_recon_release_${Date.now()}`;
    await store.processPurchaseAtomic({ id: txId, agentId: aid, merchant: 'Swiggy', amount: 40000, category: 'Food & Dining' });
    await store.flagOrderCreationUnknown(txId, aid);

    vi.spyOn(razorpayModule, 'getRazorpayClient').mockReturnValue({
      orders: {
        create: vi.fn(),
        fetch: vi.fn().mockRejectedValue(new Error('Order not found on gateway')),
        fetchByReceipt: vi.fn().mockRejectedValue(new Error('Order not found on gateway')),
      },
    } as any);

    const summary = await runReconciliation(aid);
    expect(summary.reservationReleasedCount).toBe(1);

    const state = await store.getReserveState(aid);
    expect(state.heldPaise).toBe(0);
    expect(state.availablePaise).toBe(200000);
  });
});

describe('Failure – double settle is idempotent', () => {
  let store: SqliteReserveStore;
  let aid: string;

  beforeEach(async () => {
    aid = agentId();
    store = new SqliteReserveStore();
    await store.resetStore(aid);
    await store.setReserveState({ totalPaise: 200000, heldPaise: 0, settledPaise: 0 }, aid);
    await store.setActivePolicy(DEFAULT_POLICY, aid);
  });

  it('settling twice does not double-count settledPaise', async () => {
    const txId = `tx_double_settle_${Date.now()}`;
    await store.processPurchaseAtomic({ id: txId, agentId: aid, merchant: 'Swiggy', amount: 50000, category: 'Food & Dining' });
    await store.attachRazorpayOrder(txId, 'order_double_test', aid);

    const s1 = await store.settleTransaction('order_double_test', 'pay_1', aid);
    expect(s1.success).toBe(true);

    const s2 = await store.settleTransaction('order_double_test', 'pay_1', aid);
    expect(s2.success).toBe(true); // idempotent

    const state = await store.getReserveState(aid);
    expect(state.settledPaise).toBe(50000); // not 100000
    expect(state.heldPaise).toBe(0);
  });
});

describe('Failure – double release is idempotent', () => {
  let store: SqliteReserveStore;
  let aid: string;

  beforeEach(async () => {
    aid = agentId();
    store = new SqliteReserveStore();
    await store.resetStore(aid);
    await store.setReserveState({ totalPaise: 200000, heldPaise: 0, settledPaise: 0 }, aid);
    await store.setActivePolicy(DEFAULT_POLICY, aid);
  });

  it('releasing twice does not over-restore heldPaise', async () => {
    const txId = `tx_double_release_${Date.now()}`;
    await store.processPurchaseAtomic({ id: txId, agentId: aid, merchant: 'Swiggy', amount: 40000, category: 'Food & Dining' });

    await store.releaseReservation(txId, 'First release', aid);
    await store.releaseReservation(txId, 'Second (duplicate) release', aid);

    const state = await store.getReserveState(aid);
    expect(state.heldPaise).toBe(0);
    expect(state.availablePaise).toBe(200000); // not 240000
  });
});
