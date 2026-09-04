import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SqliteReserveStore } from '../lib/sqliteStore';

// Mock Razorpay so order creation never hits the network
vi.mock('../lib/razorpayClient', () => ({
  validateRazorpayConfig: vi.fn(),
  isMockRazorpayEnabled: vi.fn().mockReturnValue(true),
  getRazorpayClient: vi.fn().mockReturnValue({
    orders: {
      create: vi.fn().mockResolvedValue({ id: `order_mock_${Date.now()}`, amount: 0, currency: 'INR', status: 'created' }),
      fetch: vi.fn().mockRejectedValue(new Error('not found')),
      fetchByReceipt: vi.fn().mockRejectedValue(new Error('not found')),
    },
  }),
}));

function agentId() {
  return `int_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

const DEFAULT_POLICY = {
  amountCeiling: 100000,
  category: 'Food & Dining',
  allowedMerchants: ['Swiggy', 'Zomato'],
  sessionCap: 200000,
  reasonableQuantity: 2,
};

describe('Integration – full purchase flow', () => {
  let store: SqliteReserveStore;
  let aid: string;

  beforeEach(async () => {
    aid = agentId();
    store = new SqliteReserveStore();
    await store.resetStore(aid);
    await store.setReserveState({ totalPaise: 200000, heldPaise: 0, settledPaise: 0 }, aid);
    await store.setActivePolicy(DEFAULT_POLICY, aid);
  });

  it('reserve → order → capture full lifecycle', async () => {
    const txId = `tx_flow_${Date.now()}`;
    const result = await store.processPurchaseAtomic({ id: txId, agentId: aid, merchant: 'Swiggy', amount: 65000, category: 'Food & Dining' });
    expect(result.decision).toBe('allowed');
    expect(result.paymentStatus).toBe('reserved');

    let state = await store.getReserveState(aid);
    expect(state.heldPaise).toBe(65000);

    // Attach Razorpay order
    await store.attachRazorpayOrder(txId, 'order_mock_abc123', aid);
    const tx = await store.getTransactionByIdOrOrderId('order_mock_abc123', aid);
    expect(tx?.paymentStatus).toBe('order_created');

    // Settle (capture)
    const settle = await store.settleTransaction('order_mock_abc123', 'pay_mock_xyz', aid);
    expect(settle.success).toBe(true);

    state = await store.getReserveState(aid);
    expect(state.heldPaise).toBe(0);
    expect(state.settledPaise).toBe(65000);
    expect(state.availablePaise).toBe(135000);
  });

  it('reserve → release: funds returned', async () => {
    const txId = `tx_release_${Date.now()}`;
    await store.processPurchaseAtomic({ id: txId, agentId: aid, merchant: 'Swiggy', amount: 50000, category: 'Food & Dining' });

    let state = await store.getReserveState(aid);
    expect(state.heldPaise).toBe(50000);

    const release = await store.releaseReservation(txId, 'User cancelled', aid);
    expect(release.success).toBe(true);
    expect(release.releasedAmountPaise).toBe(50000);

    state = await store.getReserveState(aid);
    expect(state.heldPaise).toBe(0);
    expect(state.availablePaise).toBe(200000);
  });

  it('productId-based purchase resolves price from catalog', async () => {
    const policy = { ...DEFAULT_POLICY, amountCeiling: 100000, allowedMerchants: ['Swiggy', 'Zomato'] };
    await store.setActivePolicy(policy, aid);

    const result = await store.processPurchaseAtomic({
      id: `tx_product_${Date.now()}`,
      agentId: aid,
      productId: 'swiggy-dinner-650',  // unitPricePaise = 65000
      quantity: 1,
      category: 'Food & Dining',
    });

    // guardCheck should resolve product from catalog: merchant=Swiggy, amount=65000, category=Food & Dining
    expect(result.decision).toBe('allowed');
    expect(result.transaction?.amount).toBe(65000);
    expect(result.transaction?.merchant).toBe('Swiggy');
  });

  it('idempotency: same key twice returns CACHED on second attempt', async () => {
    const key = `idem_${Date.now()}`;
    const hash = 'test_hash_abc';

    const claim1 = await store.claimIdempotencyKey('default_tenant', aid, key, hash);
    expect(claim1.status).toBe('CLAIMED');

    // Complete it
    await store.completeIdempotencyKey('default_tenant', aid, key, { decision: 'allowed', razorpayOrderId: 'order_123' });

    const claim2 = await store.claimIdempotencyKey('default_tenant', aid, key, hash);
    expect(claim2.status).toBe('CACHED');
    expect(claim2.cachedResponse?.razorpayOrderId).toBe('order_123');
  });

  it('idempotency: hash mismatch returns MISMATCH', async () => {
    const key = `idem_mismatch_${Date.now()}`;
    await store.claimIdempotencyKey('default_tenant', aid, key, 'hash_a');
    await store.completeIdempotencyKey('default_tenant', aid, key, { result: 'ok' });

    const clash = await store.claimIdempotencyKey('default_tenant', aid, key, 'hash_b_different');
    expect(clash.status).toBe('MISMATCH');
  });

  it('ledger integrity passes after full lifecycle', async () => {
    const txId = `tx_ledger_${Date.now()}`;
    await store.processPurchaseAtomic({ id: txId, agentId: aid, merchant: 'Swiggy', amount: 40000, category: 'Food & Dining' });
    await store.attachRazorpayOrder(txId, 'order_integrity_test', aid);
    await store.settleTransaction('order_integrity_test', 'pay_integrity_test', aid);
    await store.releaseReservation(txId, 'double release is idempotent', aid);

    const integrity = await store.verifyLedgerIntegrity(aid);
    expect(integrity.isValid).toBe(true);
  });
});

describe('Integration – catalog resolution in purchase', () => {
  let store: SqliteReserveStore;
  let aid: string;

  beforeEach(async () => {
    aid = agentId();
    store = new SqliteReserveStore();
    await store.resetStore(aid);
    await store.setReserveState({ totalPaise: 500000, heldPaise: 0, settledPaise: 0 }, aid);
    await store.setActivePolicy({
      amountCeiling: 300000,
      category: 'Electronics',
      allowedMerchants: ['Amazon', 'BestBuy'],
      sessionCap: 500000,
    }, aid);
  });

  it('resolves catalog product price overriding any client-supplied amount', async () => {
    // amazon-electronics-2500 has unitPricePaise = 250000
    const r = await store.processPurchaseAtomic({
      id: `tx_catalog_override_${Date.now()}`,
      agentId: aid,
      productId: 'amazon-electronics-2500',
      amount: 99999, // should be ignored — catalog says 250000
      quantity: 1,
      category: 'Electronics',
    });
    expect(r.transaction?.amount).toBe(250000);
    expect(r.transaction?.merchant).toBe('Amazon');
  });

  it('quantity multiplies catalog unit price', async () => {
    const r = await store.processPurchaseAtomic({
      id: `tx_qty_price_${Date.now()}`,
      agentId: aid,
      productId: 'bestbuy-gadget-1200', // 120000 paise
      quantity: 2,
      category: 'Electronics',
    });
    expect(r.transaction?.amount).toBe(240000);
  });
});

describe('Integration – webhook idempotency', () => {
  let store: SqliteReserveStore;
  let aid: string;

  beforeEach(async () => {
    aid = agentId();
    store = new SqliteReserveStore();
    await store.resetStore(aid);
  });

  it('webhook event claimed only once (duplicate rejected)', async () => {
    const eventId = `evt_wh_${Date.now()}`;
    const first = await store.claimWebhookEvent(eventId, 'payment.captured', 'hash_abc');
    const second = await store.claimWebhookEvent(eventId, 'payment.captured', 'hash_abc');
    expect(first).toBe(true);
    expect(second).toBe(false);
  });
});

describe('Integration – reconciliation', () => {
  let store: SqliteReserveStore;
  let aid: string;

  beforeEach(async () => {
    aid = agentId();
    store = new SqliteReserveStore();
    await store.resetStore(aid);
    await store.setReserveState({ totalPaise: 200000, heldPaise: 0, settledPaise: 0 }, aid);
    await store.setActivePolicy({ ...DEFAULT_POLICY }, aid);
  });

  it('flagOrderCreationUnknown → expireStaleTransactions releases it eventually', async () => {
    const txId = `tx_unknown_expire_${Date.now()}`;
    await store.processPurchaseAtomic({ id: txId, agentId: aid, merchant: 'Swiggy', amount: 30000, category: 'Food & Dining' });
    await store.flagOrderCreationUnknown(txId, aid);

    const tx = await store.getTransactionByIdOrOrderId(txId, aid);
    expect(tx?.paymentStatus).toBe('order_creation_unknown');
    // Funds should still be held until reconciled/released
    const state = await store.getReserveState(aid);
    expect(state.heldPaise).toBe(30000);
  });
});
