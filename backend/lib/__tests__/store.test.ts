import { describe, it, expect, beforeEach } from 'vitest';
import {
  getActivePolicy,
  getPolicy,
  setActivePolicy,
  setPolicy,
  getReserveState,
  setReserveState,
  recordTransaction,
  processPurchaseAtomic,
  settleTransaction,
  releaseReservation,
  verifyLedgerIntegrity,
  calculateTransactionHash,
  GENESIS_PREV_HASH,
  resetStore,
} from '../store';
import db from '../db';
import { POST as postPurchase } from '../../app/api/purchase/route';
import { Policy, Transaction } from '../types';
import { vi } from 'vitest';

vi.mock('../razorpayClient', () => ({
  validateRazorpayConfig: vi.fn(),
  getRazorpayClient: () => ({
    orders: {
      create: vi.fn().mockImplementation(async (params) => ({
        id: `order_mock_${Date.now()}`,
        entity: 'order',
        amount: params.amount,
        currency: params.currency,
        notes: params.notes,
        status: 'created',
      })),
    },
  }),
}));

describe('Persistent SQLite Store & Atomic Reservation State Machine', () => {
  beforeEach(async () => {
    await resetStore();
  });

  describe('Store API Signatures & Minor Unit Paise Representation', () => {
    it('getActivePolicy and getPolicy return default seeded policy in integer Paise', async () => {
      const p1 = await getActivePolicy();
      const p2 = await getPolicy();

      expect(p1).toEqual(p2);
      expect(p1.amountCeiling).toBe(50000); // ₹500.00
      expect(p1.category).toBe('Electronics');
      expect(p1.allowedMerchants).toEqual(['Amazon', 'BestBuy']);
      expect(p1.sessionCap).toBe(100000); // ₹1000.00
    });

    it('setActivePolicy and setPolicy persist policy changes in database', async () => {
      const updatedPolicy: Policy = {
        amountCeiling: 80000, // ₹800.00
        category: 'Gadgets',
        merchantMode: 'allowlist', allowedMerchants: ['AppleStore'],
        sessionCap: 150000, // ₹1500.00
        reasonableQuantity: 3,
      };

      const result = await setPolicy(updatedPolicy);
      expect(result.amountCeiling).toBe(80000);
      expect(result.category).toBe('Gadgets');
      expect(result.allowedMerchants).toEqual(['AppleStore']);
      expect(result.sessionCap).toBe(150000);
      expect(result.reasonableQuantity).toBe(3);

      const fetched = await getActivePolicy();
      expect(fetched).toEqual(result);
    });

    it('getReserveState returns initial totalPaise, heldPaise, settledPaise, and availablePaise', async () => {
      const state = await getReserveState();
      expect(state.totalPaise).toBe(200000);
      expect(state.heldPaise).toBe(0);
      expect(state.settledPaise).toBe(0);
      expect(state.availablePaise).toBe(200000);
      expect(state.total).toBe(200000);
      expect(state.remaining).toBe(200000);
      expect(state.transactions).toEqual([]);
    });

    it('setReserveState updates Atomic Reservation reserve amounts and syncs transactions', async () => {
      const tx: Transaction = {
        id: 'tx_manual_1',
        merchant: 'Amazon',
        amount: 25000,
        category: 'Electronics',
        quantity: 1,
        status: 'reserved',
        reason: 'Manual test insertion',
        timestamp: new Date().toISOString(),
        hash: '',
        prevHash: '',
      };

      const newState = await setReserveState({
        totalPaise: 300000,
        heldPaise: 25000,
        settledPaise: 0,
        transactions: [tx],
      });

      expect(newState.totalPaise).toBe(300000);
      expect(newState.heldPaise).toBe(25000);
      expect(newState.settledPaise).toBe(0);
      expect(newState.availablePaise).toBe(275000);
      expect(newState.transactions.length).toBe(1);
      expect(newState.transactions[0].id).toBe('tx_manual_1');

      const fetched = await getReserveState();
      expect(fetched.availablePaise).toBe(275000);
    });

    it('recordTransaction inserts a new transaction', async () => {
      const tx: Transaction = {
        id: 'tx_rec_1',
        merchant: 'BestBuy',
        amount: 10000,
        category: 'Electronics',
        status: 'reserved',
        timestamp: new Date().toISOString(),
        hash: '',
        prevHash: '',
      };

      await recordTransaction(tx);
      const state = await getReserveState();
      expect(state.transactions.some((t) => t.id === 'tx_rec_1')).toBe(true);
    });

    it('resetStore clears transactions and restores default policy and reserve state', async () => {
      await setActivePolicy({
        amountCeiling: 10000,
        category: 'Toys',
        merchantMode: 'allowlist', allowedMerchants: ['LegoStore'],
      });

      await setReserveState({
        totalPaise: 50000,
        heldPaise: 10000,
        settledPaise: 0,
        transactions: [],
      });

      await resetStore();

      const policy = await getActivePolicy();
      const reserve = await getReserveState();

      expect(policy.amountCeiling).toBe(50000);
      expect(policy.category).toBe('Electronics');
      expect(reserve.totalPaise).toBe(200000);
      expect(reserve.heldPaise).toBe(0);
      expect(reserve.settledPaise).toBe(0);
      expect(reserve.availablePaise).toBe(200000);
      expect(reserve.transactions).toEqual([]);
    });
  });

  describe('Atomic Reservation State Machine Transitions (settle & release)', () => {
    it('transitions reserved transaction to captured via await settleTransaction()', async () => {
      // 1. Process purchase -> transaction reserved, heldPaise incremented
      const purchaseResult = await processPurchaseAtomic({
        id: 'tx_Atomic Reservation_capture',
        merchant: 'Amazon',
        amount: 35000, // ₹350.00
        category: 'Electronics',
      });

      expect(purchaseResult.decision).toBe('approve');
      const stateAfterReserve = await getReserveState();
      expect(stateAfterReserve.heldPaise).toBe(35000);
      expect(stateAfterReserve.settledPaise).toBe(0);
      expect(stateAfterReserve.availablePaise).toBe(165000);
      expect(stateAfterReserve.transactions[0].status).toBe('reserved');

      // 2. Settle transaction -> shifts heldPaise to settledPaise, marks captured
      const settleResult = await settleTransaction('tx_Atomic Reservation_capture', 'pay_mock_capture_123');
      expect(settleResult.success).toBe(true);
      expect(settleResult.transaction?.status).toBe('captured');
      expect(settleResult.transaction?.razorpayPaymentId).toBe('pay_mock_capture_123');

      const stateAfterSettle = await getReserveState();
      expect(stateAfterSettle.heldPaise).toBe(0);
      expect(stateAfterSettle.settledPaise).toBe(35000);
      expect(stateAfterSettle.availablePaise).toBe(165000);

      // 3. Cryptographic ledger integrity verification continues to pass
      expect((await verifyLedgerIntegrity()).isValid).toBe(true);
    });

    it('transitions reserved transaction to expired via await releaseReservation() and restores funds', async () => {
      // 1. Process purchase -> transaction reserved, heldPaise incremented
      const purchaseResult = await processPurchaseAtomic({
        id: 'tx_Atomic Reservation_release',
        merchant: 'Amazon',
        amount: 40000, // ₹400.00
        category: 'Electronics',
      });

      expect(purchaseResult.decision).toBe('approve');
      expect((await getReserveState()).heldPaise).toBe(40000);
      expect((await getReserveState()).availablePaise).toBe(160000);

      // 2. User abandons checkout / cancels modal -> release reservation
      const releaseResult = await releaseReservation('tx_Atomic Reservation_release', 'Checkout modal cancelled by user');
      expect(releaseResult.success).toBe(true);
      expect(releaseResult.transaction?.status).toBe('expired');

      // 3. Held funds restored back to availablePaise with zero Phantom Ledger Drain
      const stateAfterRelease = await getReserveState();
      expect(stateAfterRelease.heldPaise).toBe(0);
      expect(stateAfterRelease.settledPaise).toBe(0);
      expect(stateAfterRelease.availablePaise).toBe(200000);

      // 4. Cryptographic ledger integrity verification continues to pass
      expect((await verifyLedgerIntegrity()).isValid).toBe(true);
    });
  });

  describe('Atomic Concurrency Control (TOCTOU Safety)', () => {
    it('handles 10 concurrent HTTP purchase requests without balance drift or session cap overspending', async () => {
      const requests = Array.from({ length: 10 }, (_, i) => ({
        id: `concurrent_http_tx_${i}`,
        merchant: 'Amazon',
        amount: 30000, // ₹300.00
        category: 'Electronics',
        quantity: 1,
      }));

      const responses = await Promise.all(
        requests.map((req) =>
          postPurchase(
            new Request('http://localhost/api/purchase', {
              method: 'POST',
              body: JSON.stringify(req),
              headers: {
                'Content-Type': 'application/json',
                'X-API-Key': 'agent_api_key_default',
              },
            })
          ).then((res) => res.json())
        )
      );

      const approved = responses.filter((r) => r.decision === 'approve');
      const frozen = responses.filter((r) => r.decision === 'freeze');

      expect(approved.length).toBe(3);
      expect(frozen.length).toBe(7);

      const finalState = await getReserveState();
      expect(finalState.heldPaise).toBe(90000);
      expect(finalState.availablePaise).toBe(110000);
      expect(finalState.transactions.length).toBe(10);

      const reservedAmountTotal = finalState.transactions
        .filter((t) => t.status === 'reserved')
        .reduce((sum, t) => sum + t.amount, 0);

      expect(reservedAmountTotal).toBe(90000);
      expect(finalState.availablePaise + reservedAmountTotal + finalState.settledPaise).toBe(finalState.totalPaise);
    });

    it('handles 10 concurrent direct atomic purchase calls preventing remaining balance overspending', async () => {
      await setReserveState({
        totalPaise: 200000,
        heldPaise: 0,
        settledPaise: 150000, // availablePaise = 50000
        transactions: [],
      });

      const requests = Array.from({ length: 10 }, (_, i) => ({
        id: `concurrent_direct_tx_${i}`,
        merchant: 'Amazon',
        amount: 20000, // ₹200.00 each
        category: 'Electronics',
        quantity: 1,
      }));

      const results = await Promise.all(
        requests.map((req) => Promise.resolve().then(async () => await processPurchaseAtomic(req)))
      );

      const approved = results.filter((r) => r.decision === 'approve');
      const frozen = results.filter((r) => r.decision === 'freeze');

      expect(approved.length).toBe(2);
      expect(frozen.length).toBe(8);

      const finalState = await getReserveState();
      expect(finalState.availablePaise).toBe(10000);
      expect(finalState.availablePaise).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Cryptographic Audit Trail & Ledger Verification', () => {
    it('sets genesis prevHash on the first recorded transaction', async () => {
      await processPurchaseAtomic({
        id: 'tx_genesis',
        merchant: 'Amazon',
        amount: 15000,
        category: 'Electronics',
      });

      const state = await getReserveState();
      expect(state.transactions.length).toBe(1);

      const genesisTx = state.transactions[0];
      expect(genesisTx.prevHash).toBe(GENESIS_PREV_HASH);
      expect(genesisTx.hash).toBe(
        calculateTransactionHash({
          id: genesisTx.id,
          timestamp: genesisTx.timestamp,
          amount: genesisTx.amount,
          merchant: genesisTx.merchant,
          status: genesisTx.status,
          prevHash: GENESIS_PREV_HASH,
        })
      );
    });

    it('chains hashes sequentially across multiple transactions', async () => {
      await processPurchaseAtomic({
        id: 'tx_chain_1',
        merchant: 'Amazon',
        amount: 10000,
        category: 'Electronics',
      });

      await processPurchaseAtomic({
        id: 'tx_chain_2',
        merchant: 'BestBuy',
        amount: 20000,
        category: 'Electronics',
      });

      await processPurchaseAtomic({
        id: 'tx_chain_3',
        merchant: 'Amazon',
        amount: 15000,
        category: 'Electronics',
      });

      const state = await getReserveState();
      expect(state.transactions.length).toBe(3);

      const [tx1, tx2, tx3] = state.transactions;

      expect(tx1.prevHash).toBe(GENESIS_PREV_HASH);
      expect(tx2.prevHash).toBe(tx1.hash);
      expect(tx3.prevHash).toBe(tx2.hash);

      const verification = await verifyLedgerIntegrity();
      expect(verification.isValid).toBe(true);
      expect(verification.corruptedIndex).toBeUndefined();
    });

    it('detects tampered transactions in SQLite database and reports corrupted index', async () => {
      await processPurchaseAtomic({
        id: 'tx_tamp_1',
        merchant: 'Amazon',
        amount: 10000,
        category: 'Electronics',
      });

      await processPurchaseAtomic({
        id: 'tx_tamp_2',
        merchant: 'BestBuy',
        amount: 20000,
        category: 'Electronics',
      });

      expect((await verifyLedgerIntegrity()).isValid).toBe(true);

      // Tamper with transaction 2 directly in SQLite database
      db.prepare("UPDATE transactions SET amount = 999900 WHERE id = 'tx_tamp_2'").run();

      const verification = await verifyLedgerIntegrity();
      expect(verification.isValid).toBe(false);
      expect(verification.corruptedIndex).toBe(1);
    });
  });

  describe('Server-Side TTL & Stale Frozen Transaction Expiry State Machine', () => {
    it('automatically transitions past-TTL frozen transactions to skipped upon getReserveState', async () => {
      // Create a frozen transaction with an expired TTL (e.g. 30 seconds ago)
      const pastTime = new Date(Date.now() - 30000);
      const expiredTtl = new Date(pastTime.getTime() + 20000).toISOString(); // Expired 10s ago

      await processPurchaseAtomic({
        id: 'tx_stale_freeze_1',
        merchant: 'UnallowedVendor',
        amount: 10000,
        category: 'Electronics',
        timestamp: pastTime.toISOString(),
      });

      // Manually ensure expiresAt is set in the past for testing
      db.prepare("UPDATE transactions SET expiresAt = ? WHERE id = 'tx_stale_freeze_1'").run(expiredTtl);

      // Calling getReserveState triggers the server-side TTL sweep
      const state = await getReserveState();
      const tx = state.transactions.find((t) => t.id === 'tx_stale_freeze_1');

      expect(tx).toBeDefined();
      expect(tx?.status).toBe('frozen');
      expect(tx?.reason).toBe('skipped — agent moved on');
    });

    it('does NOT expire active frozen transactions whose TTL is still in the future', async () => {
      const futureExpiry = new Date(Date.now() + 15000).toISOString();

      await processPurchaseAtomic({
        id: 'tx_active_freeze_1',
        merchant: 'UnallowedVendor',
        amount: 10000,
        category: 'Electronics',
      });

      db.prepare("UPDATE transactions SET expiresAt = ? WHERE id = 'tx_active_freeze_1'").run(futureExpiry);

      const state = await getReserveState();
      const tx = state.transactions.find((t) => t.id === 'tx_active_freeze_1');

      expect(tx).toBeDefined();
      expect(tx?.status).toBe('frozen');
      expect(tx?.reason).not.toBe('skipped — agent moved on');
    });
  });
});

