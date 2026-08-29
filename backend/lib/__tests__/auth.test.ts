import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'crypto';
import {
  validateApiKey,
  signJwt,
  verifyJwt,
  verifyPayloadSignature,
  authenticateRequest,
  validateServerBootstrap,
} from '../auth';
import { resetStore, getSecurityAuditLogs } from '../store';

describe('Application Security & Authentication Module (lib/auth.ts)', () => {
  beforeEach(async () => {
    await resetStore();
  });

  describe('API Key Authentication', () => {
    it('authenticates valid ADMIN_API_KEY as ADMIN_ROLE', async () => {
      const auth = validateApiKey('admin_api_key_default');
      expect(auth).not.toBeNull();
      expect(auth?.role).toBe('ADMIN_ROLE');
      expect(auth?.identity).toBe('admin_apikey_client');
    });

    it('authenticates valid AGENT_API_KEY as AGENT_ROLE', async () => {
      const auth = validateApiKey('agent_api_key_default');
      expect(auth).not.toBeNull();
      expect(auth?.role).toBe('AGENT_ROLE');
      expect(auth?.identity).toBe('agent_apikey_client');
    });

    it('rejects invalid or unrecognized API keys', async () => {
      expect(validateApiKey('invalid_key_12345')).toBeNull();
      expect(validateApiKey('')).toBeNull();
    });
  });

  describe('JWT Token Lifecycle & RBAC', () => {
    it('generates and verifies valid ADMIN_ROLE token', async () => {
      const token = signJwt({ role: 'ADMIN_ROLE', sub: 'security_admin' });
      expect(typeof token).toBe('string');
      expect(token.split('.').length).toBe(3);

      const decoded = verifyJwt(token);
      expect(decoded).not.toBeNull();
      expect(decoded?.role).toBe('ADMIN_ROLE');
      expect(decoded?.sub).toBe('security_admin');
    });

    it('generates and verifies valid AGENT_ROLE token', async () => {
      const token = signJwt({ role: 'AGENT_ROLE', agentId: 'procurement_agent_42' });
      const decoded = verifyJwt(token);
      expect(decoded).not.toBeNull();
      expect(decoded?.role).toBe('AGENT_ROLE');
      expect(decoded?.agentId).toBe('procurement_agent_42');
    });

    it('rejects expired JWT tokens', async () => {
      // Create token expired 10 seconds ago
      const expiredToken = signJwt({ role: 'ADMIN_ROLE' }, -10);
      const decoded = verifyJwt(expiredToken);
      expect(decoded).toBeNull();
    });

    it('rejects tampered JWT tokens', async () => {
      const token = signJwt({ role: 'AGENT_ROLE', sub: 'agent_user' });
      const parts = token.split('.');
      // Tamper with payload by changing base64 string
      const tamperedPayload = Buffer.from(JSON.stringify({ role: 'ADMIN_ROLE', sub: 'agent_user' })).toString('base64');
      const tamperedToken = `${parts[0]}.${tamperedPayload}.${parts[2]}`;

      const decoded = verifyJwt(tamperedToken);
      expect(decoded).toBeNull();
    });
  });

  describe('HMAC-SHA256 Payload Signature Verification', () => {
    const rawBody = JSON.stringify({ merchant: 'Amazon', amount: 5000 });
    const secret = 'agent_hmac_secret_default';

    it('successfully verifies valid HMAC signature', async () => {
      const signature = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
      const isValid = verifyPayloadSignature(rawBody, signature, secret);
      expect(isValid).toBe(true);
    });

    it('rejects tampered body or invalid signature', async () => {
      const validSignature = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
      const tamperedBody = JSON.stringify({ merchant: 'Amazon', amount: 500000 }); // Amount inflated!

      const isValid = verifyPayloadSignature(tamperedBody, validSignature, secret);
      expect(isValid).toBe(false);
    });
  });

  describe('Request Authentication Middleware & RBAC', () => {
    it('authenticates request with valid X-API-Key', async () => {
      const req = new Request('http://localhost/api/reserve', {
        headers: { 'x-api-key': 'agent_api_key_default' },
      });

      const res = await authenticateRequest(req, { allowedRoles: ['AGENT_ROLE', 'ADMIN_ROLE'] });
      expect(res.authenticated).toBe(true);
      expect(res.context?.role).toBe('AGENT_ROLE');
    });

    it('rejects request with 401 when no credentials provided', async () => {
      const req = new Request('http://localhost/api/policy');
      const res = await authenticateRequest(req);

      expect(res.authenticated).toBe(false);
      expect(res.statusCode).toBe(401);
      expect(res.error).toContain('Authentication required');

      const logs = await getSecurityAuditLogs(5);
      expect(logs.some((l) => l.eventType === 'UNAUTHORIZED_ACCESS')).toBe(true);
    });

    it('rejects request with 403 when role is not authorized', async () => {
      const req = new Request('http://localhost/api/policy', {
        headers: { 'x-api-key': 'agent_api_key_default' }, // AGENT_ROLE
      });

      // Endpoint strictly requires ADMIN_ROLE
      const res = await authenticateRequest(req, { allowedRoles: ['ADMIN_ROLE'] });
      expect(res.authenticated).toBe(false);
      expect(res.statusCode).toBe(403);
      expect(res.error).toContain('Forbidden');

      const logs = await getSecurityAuditLogs(5);
      expect(logs.some((l) => l.eventType === 'FORBIDDEN_PRIVILEGE_ESCALATION')).toBe(true);
    });
  });

  describe('Fail-Closed Production Bootstrap Security', () => {
    it('throws fatal security error in production if required keys are missing or dummy', async () => {
      const oldEnv = { ...process.env };
      try {
        process.env.NODE_ENV = 'production';
        process.env.RAZORPAY_KEY_ID = 'rzp_test_dummy_key'; // Dummy value!
        process.env.RAZORPAY_KEY_SECRET = 'dummy_secret';

        expect(() => validateServerBootstrap(true)).toThrow(/Fatal Security Error/);
      } finally {
        process.env = oldEnv;
      }
    });

    it('passes validation when all required production keys are securely defined', async () => {
      const oldEnv = { ...process.env };
      try {
        process.env.NODE_ENV = 'production';
        process.env.RAZORPAY_KEY_ID = 'rzp_live_real_prod_key_9988';
        process.env.RAZORPAY_KEY_SECRET = 'live_secret_prod_88997766';
        process.env.RAZORPAY_WEBHOOK_SECRET = 'whsec_live_prod_55443322';
        process.env.ADMIN_API_KEY = 'adm_key_super_secret_production_xyz';
        process.env.AGENT_API_KEY = 'agt_key_agent_production_abc';
        process.env.JWT_SECRET = 'jwt_prod_secret_signing_key_robust_123';
        process.env.AGENT_HMAC_SECRET = 'agent_hmac_secret_production_secure';

        expect(() => validateServerBootstrap(true)).not.toThrow();
      } finally {
        process.env = oldEnv;
      }
    });
  });
});
