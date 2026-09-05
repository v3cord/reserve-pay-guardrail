import { describe, it, expect, beforeEach } from 'vitest';
import { SqliteReserveStore } from '../lib/sqliteStore';

function agentId() {
  return `conc_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

describe('Concurrency – 1000 concurrent requests against bounded reserve', () => {
  let store: SqliteReserveStore;
  let aid: string;

  beforeEach(async () => {
    aid = agentId();
    store = new SqliteReserveStore();
    await store.resetStore(aid);
    await store.setReserveState({ totalPaise: 200000, heldPaise: 0, settledPaise: 0 }, aid);
    await store.setActivePolicy({
      amountCeiling: 30000,
      category: 'Food & Dining',
      merchantMode: 'allowlist', allowedMerchants: ['Swiggy'],
      sessionCap: 200000,
      reasonableQuantity: 10,
    }, aid);
  });

  it('zero overspend: heldPaise + settledPaise <= totalPaise always', async () => {
    const N = 1000;
    const amount = 500; // ₹5 each — 200000 / 500 = 400 should succeed

    const promises = Array.from({ length: N }, (_, i) =>
      store.processPurchaseAtomic({
        id: `conc_tx_${i}_${Date.now()}`,
        agentId: aid,
        merchant: 'Swiggy',
        amount,
        category: 'Food & Dining',
      })
    );

    const results = await Promise.all(promises);
    const approved = results.filter((r) => r.decision === 'allowed').length;
    const denied = results.filter((r) => r.decision === 'denied').length;

    const finalState = await store.getReserveState(aid);

    // Core invariant: never overspend
    expect(finalState.heldPaise + finalState.settledPaise).toBeLessThanOrEqual(finalState.totalPaise);
    expect(finalState.availablePaise).toBeGreaterThanOrEqual(0);

    // Math: 200000 / 500 = 400 max approvals
    expect(approved).toBeLessThanOrEqual(400);
    expect(approved + denied).toBe(N);

    // Held paise must equal sum of approved amounts
    expect(finalState.heldPaise).toBe(approved * amount);
  }, 120000);

  it('exactly right number succeed when budget is tight', async () => {
    // Reset with budget for exactly 3 purchases of 60000 each
    await store.resetStore(aid);
    await store.setReserveState({ totalPaise: 180000, heldPaise: 0, settledPaise: 0 }, aid);
    await store.setActivePolicy({
      amountCeiling: 60000,
      category: 'Food & Dining',
      merchantMode: 'allowlist', allowedMerchants: ['Swiggy'],
      sessionCap: 200000,
    }, aid);

    const N = 20;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        store.processPurchaseAtomic({
          id: `exact_conc_${i}_${Date.now()}`,
          agentId: aid,
          merchant: 'Swiggy',
          amount: 60000,
          category: 'Food & Dining',
        })
      )
    );

    const approved = results.filter((r) => r.decision === 'allowed').length;
    const state = await store.getReserveState(aid);

    expect(approved).toBeLessThanOrEqual(3);
    expect(state.heldPaise).toBeLessThanOrEqual(180000);
    expect(state.availablePaise).toBeGreaterThanOrEqual(0);
  });
});

describe('Concurrency – ledger chain integrity after concurrent appends', () => {
  let store: SqliteReserveStore;
  let aid: string;

  beforeEach(async () => {
    aid = agentId();
    store = new SqliteReserveStore();
    await store.resetStore(aid);
    await store.setReserveState({ totalPaise: 1000000, heldPaise: 0, settledPaise: 0 }, aid);
    await store.setActivePolicy({
      amountCeiling: 10000,
      category: 'Food & Dining',
      merchantMode: 'allowlist', allowedMerchants: ['Swiggy'],
      sessionCap: 1000000,
    }, aid);
  });

  it('ledger chain remains valid after 50 concurrent purchases', async () => {
    const N = 50;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        store.processPurchaseAtomic({
          id: `ledger_conc_${i}_${Date.now()}_${Math.random().toString(36).slice(2)}`,
          agentId: aid,
          merchant: 'Swiggy',
          amount: 5000,
          category: 'Food & Dining',
        })
      )
    );

    const integrity = await store.verifyLedgerIntegrity(aid);
    expect(integrity.isValid).toBe(true);
    expect(integrity.totalEventsVerified).toBeGreaterThan(0);
  });

  it('global sequence numbers are unique (no duplicates from concurrent writes)', async () => {
    const N = 30;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        store.processPurchaseAtomic({
          id: `seq_uniq_${i}_${Date.now()}_${Math.random().toString(36).slice(2)}`,
          agentId: aid,
          merchant: 'Swiggy',
          amount: 1000,
          category: 'Food & Dining',
        })
      )
    );

    const events = await store.getLedgerEvents(aid, 200);
    const seqs = events.map((e) => e.sequenceNum);
    const uniqueSeqs = new Set(seqs);
    expect(uniqueSeqs.size).toBe(seqs.length); // no duplicates
  });
});
