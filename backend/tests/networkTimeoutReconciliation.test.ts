import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SqliteReserveStore } from '../lib/sqliteStore';
import { runReconciliation } from '../lib/reconciler';
import * as razorpayModule from '../lib/razorpay';

describe('Network Timeout & Background Reconciliation Workflow', () => {
  let store: SqliteReserveStore;
  const testAgent = `recon_agent_${Date.now()}`;

  beforeEach(async () => {
    store = new SqliteReserveStore();
    await store.resetStore(testAgent);
    await store.setReserveState(
      { totalPaise: 200000, heldPaise: 0, settledPaise: 0 },
      testAgent
    );
    await store.setActivePolicy(
      {
        amountCeiling: 100000,
        category: 'Food & Dining',
        allowedMerchants: ['Swiggy'],
        sessionCap: 200000,
      },
      testAgent
    );
  });

  it('Reconciles order_creation_unknown when Razorpay order was created on gateway', async () => {
    const txId = `tx_recon_found_${Date.now()}`;
    const p = await store.processPurchaseAtomic({
      id: txId,
      agentId: testAgent,
      merchant: 'Swiggy',
      amount: 50000,
      category: 'Food & Dining',
    });
    expect(p.decision).toBe('allowed');

    // Flag transaction as order_creation_unknown (simulating client timeout)
    await store.flagOrderCreationUnknown(txId, testAgent);

    let state = await store.getReserveState(testAgent);
    let tx = state.transactions.find(t => t.id === txId);
    expect(tx?.paymentStatus).toBe('order_creation_unknown');
    expect(state.heldPaise).toBe(50000);

    // Mock Razorpay SDK returning the matched order
    vi.spyOn(razorpayModule, 'getRazorpayClient').mockReturnValue({
      orders: {
        create: vi.fn(),
        fetch: vi.fn().mockResolvedValue({ id: 'order_rzp_recon_123', amount: 50000, status: 'created' }),
        fetchByReceipt: vi.fn().mockResolvedValue({ id: 'order_rzp_recon_123', amount: 50000, status: 'created' }),
      },
      payments: { capture: vi.fn(), refund: vi.fn() },
    } as any);

    const summary = await runReconciliation(testAgent);
    expect(summary.scannedCount).toBeGreaterThanOrEqual(1);
    expect(summary.orderReconciledCount).toBe(1);

    state = await store.getReserveState(testAgent);
    tx = state.transactions.find(t => t.id === txId);
    expect(tx?.paymentStatus).toBe('order_created');
    expect(tx?.razorpayOrderId).toBe('order_rzp_recon_123');
    expect(state.heldPaise).toBe(50000); // Funds remain safely reserved for standard capture
  });

  it('Compensates and releases reservation when Razorpay order was never created', async () => {
    const txId = `tx_recon_missing_${Date.now()}`;
    await store.processPurchaseAtomic({
      id: txId,
      agentId: testAgent,
      merchant: 'Swiggy',
      amount: 40000,
      category: 'Food & Dining',
    });

    await store.flagOrderCreationUnknown(txId, testAgent);

    // Mock Razorpay SDK returning null (order never reached gateway)
    vi.spyOn(razorpayModule, 'getRazorpayClient').mockReturnValue({
      orders: {
        create: vi.fn(),
        fetch: vi.fn().mockRejectedValue(new Error('Order not found')),
        fetchByReceipt: vi.fn().mockResolvedValue(null),
      },
      payments: { capture: vi.fn(), refund: vi.fn() },
    } as any);

    const summary = await runReconciliation(testAgent);
    expect(summary.scannedCount).toBeGreaterThanOrEqual(1);
    expect(summary.reservationReleasedCount).toBe(1);

    const state = await store.getReserveState(testAgent);
    const tx = state.transactions.find(t => t.id === txId);
    expect(tx?.paymentStatus).toBe('released');
    expect(state.heldPaise).toBe(0); // Funds released back to available budget pool
  });
});
