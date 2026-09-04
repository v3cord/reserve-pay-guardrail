import { describe, it, expect, beforeEach } from 'vitest';
import { SqliteReserveStore } from '../lib/sqliteStore';

function agentId() {
  return `idem_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

describe('Idempotency – 100 identical requests → one financial effect', () => {
  let store: SqliteReserveStore;
  let aid: string;

  beforeEach(async () => {
    aid = agentId();
    store = new SqliteReserveStore();
    await store.resetStore(aid);
    await store.setReserveState({ totalPaise: 200000, heldPaise: 0, settledPaise: 0 }, aid);
    await store.setActivePolicy({
      amountCeiling: 80000,
      category: 'Food & Dining',
      allowedMerchants: ['Swiggy'],
      sessionCap: 200000,
    }, aid);
  });

  it('100 concurrent claim attempts on same key → exactly 1 CLAIMED, rest PROCESSING/CACHED', async () => {
    const key = `idem_mass_${Date.now()}`;
    const hash = 'payload_hash_consistent';

    const results = await Promise.all(
      Array.from({ length: 100 }, () =>
        store.claimIdempotencyKey('default_tenant', aid, key, hash)
      )
    );

    const claimed = results.filter((r) => r.status === 'CLAIMED').length;
    const others = results.filter((r) => r.status === 'PROCESSING' || r.status === 'CACHED').length;

    // Exactly one should claim; the rest should see PROCESSING (still in flight)
    expect(claimed).toBe(1);
    expect(claimed + others).toBe(100);
  });

  it('completing idempotency key caches response for subsequent calls', async () => {
    const key = `idem_cache_${Date.now()}`;
    const hash = 'hash_xyz';
    const cachedPayload = { decision: 'allowed', razorpayOrderId: 'order_cache_test', amount: 65000 };

    await store.claimIdempotencyKey('default_tenant', aid, key, hash);
    await store.completeIdempotencyKey('default_tenant', aid, key, cachedPayload);

    // Any subsequent caller gets CACHED
    for (let i = 0; i < 5; i++) {
      const r = await store.claimIdempotencyKey('default_tenant', aid, key, hash);
      expect(r.status).toBe('CACHED');
      expect(r.cachedResponse?.razorpayOrderId).toBe('order_cache_test');
    }
  });

  it('zero duplicate reservations for 100 calls with same payload', async () => {
    const key = `idem_dup_${Date.now()}`;
    const hash = 'purchase_hash_dup';

    // First: claim and execute purchase
    const claim = await store.claimIdempotencyKey('default_tenant', aid, key, hash);
    expect(claim.status).toBe('CLAIMED');

    const purchaseResult = await store.processPurchaseAtomic({
      id: `tx_idem_${Date.now()}`,
      agentId: aid,
      merchant: 'Swiggy',
      amount: 65000,
      category: 'Food & Dining',
      idempotencyKey: key,
    });
    expect(purchaseResult.decision).toBe('allowed');
    await store.completeIdempotencyKey('default_tenant', aid, key, { decision: 'allowed' });

    // Simulate 99 more identical requests — all should see CACHED, not create new purchases
    const duplicates = await Promise.all(
      Array.from({ length: 99 }, () =>
        store.claimIdempotencyKey('default_tenant', aid, key, hash)
      )
    );

    expect(duplicates.every((r) => r.status === 'CACHED')).toBe(true);

    // Only 1 reservation should exist
    const state = await store.getReserveState(aid);
    const reserved = state.transactions.filter((t) => t.paymentStatus === 'reserved' || t.status === 'reserved');
    expect(reserved.length).toBe(1);
    expect(state.heldPaise).toBe(65000);
  });

  it('MISMATCH prevents processing when hash differs', async () => {
    const key = `idem_mismatch_${Date.now()}`;
    await store.claimIdempotencyKey('default_tenant', aid, key, 'original_hash');
    await store.completeIdempotencyKey('default_tenant', aid, key, { ok: true });

    const r = await store.claimIdempotencyKey('default_tenant', aid, key, 'different_hash');
    expect(r.status).toBe('MISMATCH');
  });

  it('failIdempotencyKey allows reclaim on retry', async () => {
    const key = `idem_fail_retry_${Date.now()}`;
    const hash = 'hash_retry';
    await store.claimIdempotencyKey('default_tenant', aid, key, hash);
    await store.failIdempotencyKey('default_tenant', aid, key);

    // Can reclaim after failure
    const retry = await store.claimIdempotencyKey('default_tenant', aid, key, hash);
    expect(retry.status).toBe('CLAIMED');
  });
});
