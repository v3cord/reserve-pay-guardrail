import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  InMemoryTokenBucket,
  PostgresReserveStore,
  resetStore,
  getReserveState,
  setReserveState,
  setActivePolicy,
  processPurchaseAtomic,
  verifyLedgerIntegrity,
  GENESIS_PREV_HASH,
} from '../store';
import { POST as postPurchase } from '../../app/api/purchase/route';
import { AttemptedPurchase } from '../types';
import { Pool } from 'pg';

vi.mock('../razorpayClient', () => ({
  validateRazorpayConfig: vi.fn(),
  getRazorpayClient: () => ({
    orders: {
      create: vi.fn().mockImplementation(async (params) => ({
        id: `order_concur_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        entity: 'order',
        amount: params.amount,
        currency: params.currency,
        notes: params.notes,
        status: 'created',
      })),
    },
  }),
}));

describe('Distributed Concurrency & Redis Token-Bucket Double-Spending Prevention', () => {
  beforeEach(async () => {
    await resetStore();
  });

  describe('Redis / In-Memory Atomic Token Bucket Lua Engine', () => {
    it('handles 50 simultaneous parallel token requests with atomic test-and-decrement', async () => {
      const bucket = new InMemoryTokenBucket();
      const agentId = 'agent_concurrency_1';
      const initialBudget = 100000; // ₹1,000.00 (100,000 paise)
      const requestAmount = 5000; // ₹50.00 each -> Exactly 20 should succeed, 30 rejected

      // Fire 50 simultaneous parallel requests
      const promises = Array.from({ length: 50 }, () =>
        bucket.acquireReserve(agentId, requestAmount, initialBudget)
      );

      const results = await Promise.all(promises);

      const approved = results.filter((r) => r.allowed);
      const rejected = results.filter((r) => !r.allowed);

      expect(approved.length).toBe(20);
      expect(rejected.length).toBe(30);

      const finalRemaining = await bucket.getRemainingBudget(agentId);
      expect(finalRemaining).toBe(0);

      const totalApprovedPaise = approved.length * requestAmount;
      expect(totalApprovedPaise).toBe(initialBudget);
    });

    it('accurately releases and refunds token bucket budget back into pool', async () => {
      const bucket = new InMemoryTokenBucket();
      const agentId = 'agent_concurrency_refund';
      await bucket.setRemainingBudget(agentId, 50000);

      // Acquire 20000
      const acq = await bucket.acquireReserve(agentId, 20000);
      expect(acq.allowed).toBe(true);
      expect(await bucket.getRemainingBudget(agentId)).toBe(30000);

      // Release 10000
      await bucket.releaseReserve(agentId, 10000);
      expect(await bucket.getRemainingBudget(agentId)).toBe(40000);

      // Refund 10000
      await bucket.refundReserve(agentId, 10000);
      expect(await bucket.getRemainingBudget(agentId)).toBe(50000);
    });
  });

  describe('50 Simultaneous Parallel Purchase Requests via processPurchaseAtomic (Zero Overspending)', () => {
    it('simulates 50 parallel purchase requests competing for single reserve budget without exceeding by a single paise', async () => {
      const agentId = 'agent_50_concurrency';

      // Set policy: ceiling = ₹100.00 (10000 paise), sessionCap = ₹1,500.00 (150000 paise)
      await setActivePolicy(
        {
          amountCeiling: 10000,
          category: 'Electronics',
          allowedMerchants: ['Amazon', 'BestBuy', 'AppleStore'],
          sessionCap: 150000,
          tenantId: 'tenant_enterprise_1',
        },
        agentId
      );

      // Total Reserve available: ₹1,500.00 (150000 paise)
      await setReserveState(
        {
          totalPaise: 150000,
          heldPaise: 0,
          settledPaise: 0,
          transactions: [],
        },
        agentId
      );

      // 50 parallel purchase requests of ₹60.00 (6000 paise) each.
      // Total potential demand = 50 * 6000 = 300,000 paise.
      // Maximum allowed under ₹1,500 cap = floor(150,000 / 6,000) = 25 purchases!
      const requests: AttemptedPurchase[] = Array.from({ length: 50 }, (_, i) => ({
        id: `concur_tx_${i}`,
        merchant: 'Amazon',
        amount: 6000, // ₹60.00
        category: 'Electronics',
        quantity: 1,
        agentId,
      }));

      // Fire 50 simultaneous parallel purchase requests
      const results = await Promise.all(
        requests.map((req) => Promise.resolve().then(async () => await processPurchaseAtomic(req)))
      );

      const approved = results.filter((r) => r.decision === 'approve');
      const frozen = results.filter((r) => r.decision === 'freeze');

      expect(approved.length).toBe(25);
      expect(frozen.length).toBe(25);

      // Verify that total approved budget does not exceed reserve cap by a single paise
      const sumApprovedPaise = approved.length * 6000;
      expect(sumApprovedPaise).toBe(150000);
      expect(sumApprovedPaise).toBeLessThanOrEqual(150000);

      const finalState = await getReserveState(agentId);
      expect(finalState.heldPaise).toBe(150000);
      expect(finalState.availablePaise).toBe(0);
      expect(finalState.transactions.length).toBe(50);

      // Verify cryptographic ledger hash integrity across all 50 transactions
      const integrity = await verifyLedgerIntegrity(agentId);
      expect(integrity.isValid).toBe(true);
      expect(integrity.corruptedIndex).toBeUndefined();
    });

    it('50 parallel HTTP requests to /api/purchase enforce strict budget isolation and role headers', async () => {
      const agentId = 'agent_http_50_concurrency';

      await setActivePolicy(
        {
          amountCeiling: 10000,
          category: 'Electronics',
          allowedMerchants: ['Amazon'],
          sessionCap: 100000, // ₹1,000.00
        },
        agentId
      );

      await setReserveState(
        {
          totalPaise: 100000,
          heldPaise: 0,
          settledPaise: 0,
          transactions: [],
        },
        agentId
      );

      // 50 requests of ₹40.00 (4000 paise). Cap = 100,000 -> Max 25 approved, 25 frozen
      const requests = Array.from({ length: 50 }, (_, i) => ({
        id: `http_50_tx_${i}`,
        merchant: 'Amazon',
        amount: 4000,
        category: 'Electronics',
        quantity: 1,
        agentId,
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

      expect(approved.length).toBe(25);
      expect(frozen.length).toBe(25);

      const finalState = await getReserveState(agentId);
      expect(finalState.heldPaise).toBe(100000);
      expect(finalState.availablePaise).toBe(0);
      expect((await verifyLedgerIntegrity(agentId)).isValid).toBe(true);
    });
  });

  describe('PostgreSQL Adapter & Row-Level Locking Architecture Unit Tests', () => {
    it('PostgresReserveStore exposes IReserveStore contract with correct storeType', async () => {
      const mockPool = {
        query: vi.fn(),
        connect: vi.fn(),
      } as unknown as Pool;

      const pgStore = new PostgresReserveStore(mockPool);
      expect(pgStore.storeType).toBe('postgres');
      expect(typeof pgStore.getActivePolicy).toBe('function');
      expect(typeof pgStore.setActivePolicy).toBe('function');
      expect(typeof pgStore.getReserveState).toBe('function');
      expect(typeof pgStore.setReserveState).toBe('function');
      expect(typeof pgStore.processPurchaseAtomic).toBe('function');
      expect(typeof pgStore.settleTransaction).toBe('function');
      expect(typeof pgStore.releaseReservation).toBe('function');
      expect(typeof pgStore.processRefund).toBe('function');
      expect(typeof pgStore.disputeTransaction).toBe('function');
      expect(typeof pgStore.verifyLedgerIntegrity).toBe('function');
    });

    it('PostgresReserveStore executes row-level locking (SELECT ... FOR UPDATE) inside transactions', async () => {
      const mockClient = {
        query: vi.fn().mockImplementation((queryText: string) => {
          if (queryText === 'BEGIN' || queryText === 'COMMIT' || queryText === 'ROLLBACK') {
            return Promise.resolve({ rows: [] });
          }
          if (queryText.includes('SELECT * FROM reserve_state WHERE agent_id = $1 FOR UPDATE')) {
            return Promise.resolve({
              rows: [{
                agent_id: 'test_agent',
                tenant_id: 'default_tenant',
                total_paise: '200000',
                held_paise: '0',
                settled_paise: '0',
                version: '1',
              }],
            });
          }
          if (queryText.includes('SELECT hash FROM transactions WHERE agent_id = $1 ORDER BY sequence_num DESC LIMIT 1 FOR UPDATE')) {
            return Promise.resolve({
              rows: [{ hash: GENESIS_PREV_HASH }],
            });
          }
          if (queryText.includes('SELECT * FROM policies WHERE agent_id = $1 LIMIT 1')) {
            return Promise.resolve({
              rows: [{
                agent_id: 'test_agent',
                tenant_id: 'default_tenant',
                amount_ceiling: '50000',
                category: 'Electronics',
                allowed_merchants: ['Amazon'],
                session_cap: '100000',
              }],
            });
          }
          if (queryText.includes('SELECT * FROM reserve_state WHERE agent_id = $1 LIMIT 1')) {
            return Promise.resolve({
              rows: [{
                total_paise: '200000',
                held_paise: '25000',
                settled_paise: '0',
              }],
            });
          }
          if (queryText.includes('SELECT * FROM transactions WHERE agent_id = $1')) {
            return Promise.resolve({
              rows: [{
                id: 'tx_pg_1',
                agent_id: 'test_agent',
                merchant: 'Amazon',
                amount: '25000',
                category: 'Electronics',
                status: 'reserved',
                timestamp: new Date().toISOString(),
                hash: 'hash_123',
                prev_hash: GENESIS_PREV_HASH,
              }],
            });
          }
          return Promise.resolve({ rows: [] });
        }),
        release: vi.fn(),
      };

      const mockPool = {
        connect: vi.fn().mockResolvedValue(mockClient),
        query: vi.fn().mockImplementation((q: string) => {
          if (q.includes('SELECT * FROM reserve_state WHERE agent_id = $1 LIMIT 1')) {
            return Promise.resolve({
              rows: [{ total_paise: '200000', held_paise: '25000', settled_paise: '0' }],
            });
          }
          if (q.includes('SELECT * FROM transactions WHERE agent_id = $1')) {
            return Promise.resolve({
              rows: [{
                id: 'tx_pg_1',
                merchant: 'Amazon',
                amount: '25000',
                category: 'Electronics',
                status: 'reserved',
                timestamp: new Date().toISOString(),
                hash: 'hash_123',
                prev_hash: GENESIS_PREV_HASH,
              }],
            });
          }
          if (q.includes('SELECT * FROM policies WHERE agent_id = $1 LIMIT 1')) {
            return Promise.resolve({
              rows: [{
                agent_id: 'test_agent',
                tenant_id: 'default_tenant',
                amount_ceiling: '50000',
                category: 'Electronics',
                allowed_merchants: ['Amazon'],
                session_cap: '100000',
              }],
            });
          }
          return Promise.resolve({ rows: [] });
        }),
      } as unknown as Pool;

      const tokenBucket = new InMemoryTokenBucket();
      const pgStore = new PostgresReserveStore(mockPool, tokenBucket);

      const result = await pgStore.processPurchaseAtomic({
        id: 'tx_pg_1',
        merchant: 'Amazon',
        amount: 25000,
        category: 'Electronics',
        agentId: 'test_agent',
      });

      expect(result.decision).toBe('approve');
      expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
      expect(mockClient.query).toHaveBeenCalledWith(
        'SELECT * FROM reserve_state WHERE agent_id = $1 FOR UPDATE',
        ['test_agent']
      );
      expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
    });
  });
});
