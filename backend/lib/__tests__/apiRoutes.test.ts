import { describe, it, expect, beforeEach, vi } from 'vitest';
import crypto from 'crypto';
import { GET as getPolicy, POST as postPolicy } from '../../app/api/policy/route';
import { POST as postPurchase } from '../../app/api/purchase/route';
import { GET as getReserve } from '../../app/api/reserve/route';
import { POST as postParseIntent } from '../../app/api/parse-intent/route';
import { resetStore, getSecurityAuditLogs } from '../store';
import { signJwt } from '../auth';

const mockCreateOrder = vi.fn().mockImplementation(async (params) => ({
  id: `order_test_mock_${Date.now()}`,
  entity: 'order',
  amount: params.amount,
  currency: params.currency,
  notes: params.notes,
  status: 'created',
}));

vi.mock('../razorpayClient', () => ({
  validateRazorpayConfig: vi.fn(),
  getRazorpayClient: () => ({
    orders: {
      create: mockCreateOrder,
    },
  }),
}));

const ADMIN_HEADERS = {
  'Content-Type': 'application/json',
  'X-API-Key': 'admin_api_key_default',
};

const AGENT_HEADERS = {
  'Content-Type': 'application/json',
  'X-API-Key': 'agent_api_key_default',
};

describe('API Routes Integration & RBAC Enforcement', () => {
  beforeEach(async () => {
    await resetStore();
    mockCreateOrder.mockClear();
  });

  describe('Authentication Enforcement (401 Unauthorized)', () => {
    it('rejects GET /api/policy without auth headers', async () => {
      const req = new Request('http://localhost/api/policy');
      const res = await getPolicy(req);
      const data = await res.json();
      expect(res.status).toBe(401);
      expect(data.error).toContain('Unauthorized');
    });

    it('rejects POST /api/purchase without auth headers', async () => {
      const req = new Request('http://localhost/api/purchase', {
        method: 'POST',
        body: JSON.stringify({ merchant: 'Amazon', amount: 1000, category: 'Electronics' }),
        headers: { 'Content-Type': 'application/json' },
      });
      const res = await postPurchase(req);
      expect(res.status).toBe(401);
    });

    it('rejects GET /api/reserve without auth headers', async () => {
      const req = new Request('http://localhost/api/reserve');
      const res = await getReserve(req);
      expect(res.status).toBe(401);
    });
  });

  describe('Role-Based Access Control (RBAC) Permissions', () => {
    it('allows AGENT_ROLE to GET /api/policy and GET /api/reserve', async () => {
      const policyReq = new Request('http://localhost/api/policy', { headers: AGENT_HEADERS });
      const policyRes = await getPolicy(policyReq);
      expect(policyRes.status).toBe(200);

      const reserveReq = new Request('http://localhost/api/reserve', { headers: AGENT_HEADERS });
      const reserveRes = await getReserve(reserveReq);
      expect(reserveRes.status).toBe(200);
    });

    it('denies AGENT_ROLE from calling POST /api/policy (403 Forbidden)', async () => {
      const req = new Request('http://localhost/api/policy', {
        method: 'POST',
        body: JSON.stringify({ amountCeiling: 100000 }),
        headers: AGENT_HEADERS,
      });
      const res = await postPolicy(req);
      const data = await res.json();
      expect(res.status).toBe(403);
      expect(data.error).toContain('Forbidden');

      const logs = await getSecurityAuditLogs(5);
      expect(logs.some((l) => l.eventType === 'FORBIDDEN_PRIVILEGE_ESCALATION')).toBe(true);
    });

    it('denies AGENT_ROLE from calling POST /api/parse-intent (403 Forbidden)', async () => {
      const req = new Request('http://localhost/api/parse-intent', {
        method: 'POST',
        body: JSON.stringify({ intent: 'Buy anything up to 500000' }),
        headers: AGENT_HEADERS,
      });
      const res = await postParseIntent(req);
      expect(res.status).toBe(403);
    });

    it('denies AGENT_ROLE from executing purchase override (403 Forbidden)', async () => {
      const overridePurchase = {
        merchant: 'UnapprovedStore',
        amount: 200000,
        category: 'ForbiddenCategory',
        override: true, // Agent attempts bypass!
      };

      const req = new Request('http://localhost/api/purchase', {
        method: 'POST',
        body: JSON.stringify(overridePurchase),
        headers: AGENT_HEADERS,
      });

      const res = await postPurchase(req);
      const data = await res.json();

      expect(res.status).toBe(403);
      expect(data.error).toContain('Manual override requires ADMIN_ROLE privilege');

      const logs = await getSecurityAuditLogs(5);
      expect(logs.some((l) => l.eventType === 'FORBIDDEN_PRIVILEGE_ESCALATION')).toBe(true);
    });

    it('allows ADMIN_ROLE (API Key) to update active policy', async () => {
      const policyReq = new Request('http://localhost/api/policy', {
        method: 'POST',
        body: JSON.stringify({ amountCeiling: 75000, category: 'Electronics', allowedMerchants: ['Amazon'] }),
        headers: ADMIN_HEADERS,
      });
      const policyRes = await postPolicy(policyReq);
      expect(policyRes.status).toBe(200);
    });

    it('allows ADMIN_ROLE (Bearer JWT) to execute manual override and policy update', async () => {
      const adminToken = signJwt({ role: 'ADMIN_ROLE', sub: 'head_of_security' });
      const jwtHeaders = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      };

      // 1. Admin updates policy
      const policyReq = new Request('http://localhost/api/policy', {
        method: 'POST',
        body: JSON.stringify({ amountCeiling: 90000, category: 'Electronics', allowedMerchants: ['Amazon'] }),
        headers: jwtHeaders,
      });
      const policyRes = await postPolicy(policyReq);
      expect(policyRes.status).toBe(200);

      // 2. Admin executes manual override
      const overrideReq = new Request('http://localhost/api/purchase', {
        method: 'POST',
        body: JSON.stringify({
          merchant: 'DirectSupplier',
          amount: 60000,
          category: 'Hardware',
          override: true,
        }),
        headers: jwtHeaders,
      });
      const overrideRes = await postPurchase(overrideReq);
      const overrideData = await overrideRes.json();

      expect(overrideRes.status).toBe(200);
      expect(overrideData.decision).toBe('approve');
      expect(overrideData.updatedReserveState.heldPaise).toBe(60000);

      const logs = await getSecurityAuditLogs(5);
      expect(logs.some((l) => l.eventType === 'MANUAL_OVERRIDE_EXECUTED')).toBe(true);
    });
  });

  describe('HMAC-SHA256 Payload Signature Verification (X-Signature)', () => {
    it('accepts purchase with valid HMAC X-Signature header', async () => {
      const bodyStr = JSON.stringify({
        merchant: 'Amazon',
        amount: 15000,
        category: 'Electronics',
        quantity: 1,
        agentId: 'agent_007',
      });

      const signature = crypto
        .createHmac('sha256', 'agent_hmac_secret_default')
        .update(bodyStr)
        .digest('hex');

      const req = new Request('http://localhost/api/purchase', {
        method: 'POST',
        body: bodyStr,
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': 'agent_api_key_default',
          'X-Signature': signature,
        },
      });

      const res = await postPurchase(req);
      const data = await res.json();
      expect(res.status).toBe(200);
      expect(data.decision).toBe('approve');
    });

    it('rejects purchase with tampered body or invalid X-Signature (401)', async () => {
      const originalBody = JSON.stringify({
        merchant: 'Amazon',
        amount: 15000,
        category: 'Electronics',
      });

      const signature = crypto
        .createHmac('sha256', 'agent_hmac_secret_default')
        .update(originalBody)
        .digest('hex');

      // Attacker intercepts and tampers with amount
      const tamperedBody = JSON.stringify({
        merchant: 'Amazon',
        amount: 150000,
        category: 'Electronics',
      });

      const req = new Request('http://localhost/api/purchase', {
        method: 'POST',
        body: tamperedBody,
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': 'agent_api_key_default',
          'X-Signature': signature,
        },
      });

      const res = await postPurchase(req);
      const data = await res.json();
      expect(res.status).toBe(401);
      expect(data.error).toContain('Invalid request signature');

      const logs = await getSecurityAuditLogs(5);
      expect(logs.some((l) => l.eventType === 'SIGNATURE_VERIFICATION_FAILED')).toBe(true);
    });
  });

  describe('Standard Guardrail Safety Enforcement', () => {
    it('POST /api/purchase blocks order creation and returns 403 Guardrail Rejected on policy violation', async () => {
      const disallowedPurchase = {
        merchant: 'Walmart',
        amount: 20000,
        category: 'Electronics',
        agentId: 'agent_007',
      };

      const req = new Request('http://localhost/api/purchase', {
        method: 'POST',
        body: JSON.stringify(disallowedPurchase),
        headers: AGENT_HEADERS,
      });

      const res = await postPurchase(req);
      const data = await res.json();

      expect(res.status).toBe(403);
      expect(data.decision).toBe('freeze');
      expect(data.error).toBe('Guardrail Rejected');
      expect(data.reason.toLowerCase()).toContain('merchant mismatch');
      expect(data.razorpayOrderId).toBeUndefined();
      expect(mockCreateOrder).not.toHaveBeenCalled();
    });
  });
});
