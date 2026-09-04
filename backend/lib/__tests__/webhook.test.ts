import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'crypto';
import { POST as postWebhook } from '../../app/api/webhook/route';
import { resetStore, getReserveState, setReserveState, getActivePolicy, verifyLedgerIntegrity } from '../store';
import { validateRazorpayConfig } from '../razorpayClient';
import { Transaction } from '../types';

describe('Razorpay Webhook Handler (/api/webhook) & Gateway Reconciliation', () => {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET || 'dev_webhook_secret';

  beforeEach(async () => {
    await resetStore();
  });

  describe('Security & HMAC Verification', () => {
    it('returns 401 and logs security alert when x-razorpay-signature header is missing', async () => {
      const req = new Request('http://localhost/api/webhook', {
        method: 'POST',
        body: JSON.stringify({ event: 'payment.authorized' }),
        headers: { 'Content-Type': 'application/json' },
      });

      const res = await postWebhook(req);
      const data = await res.json();

      expect(res.status).toBe(401);
      expect(data.error).toContain('Unauthorized');
    });

    it('returns 401 and logs security alert when x-razorpay-signature is invalid', async () => {
      const req = new Request('http://localhost/api/webhook', {
        method: 'POST',
        body: JSON.stringify({ event: 'payment.authorized' }),
        headers: {
          'Content-Type': 'application/json',
          'x-razorpay-signature': 'invalid_signature_hash_123',
        },
      });

      const res = await postWebhook(req);
      const data = await res.json();

      expect(res.status).toBe(401);
      expect(data.error).toContain('Unauthorized');
    });
  });

  describe('Bidirectional Webhook Events Reconciliation', () => {
    it('returns 200 and settles Atomic Reservation transaction on payment.captured / order.paid', async () => {
      const orderId = 'order_test_webhook_123';

      // Seed reserved transaction with held funds in store
      const initialTx: Transaction = {
        id: 'tx_wh_1',
        merchant: 'Amazon',
        amount: 45000, // ₹450.00
        category: 'Electronics',
        status: 'reserved',
        reason: 'Transaction reserved',
        timestamp: new Date().toISOString(),
        razorpayOrderId: orderId,
        hash: '',
        prevHash: '',
      };
      await setReserveState({
        totalPaise: 200000,
        heldPaise: 45000,
        settledPaise: 0,
        transactions: [initialTx],
      });

      const payloadObj = {
        event: 'payment.captured',
        payload: {
          payment: {
            entity: {
              id: 'pay_123456',
              order_id: orderId,
              amount: 45000,
              status: 'captured',
            },
          },
        },
      };

      const payloadString = JSON.stringify(payloadObj);
      const validSignature = crypto
        .createHmac('sha256', secret)
        .update(payloadString)
        .digest('hex');

      const req = new Request('http://localhost/api/webhook', {
        method: 'POST',
        body: payloadString,
        headers: {
          'Content-Type': 'application/json',
          'x-razorpay-signature': validSignature,
        },
      });

      const res = await postWebhook(req);
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.status).toBe('ok');
      expect(data.received).toBe(true);
      expect(data.event).toBe('payment.captured');

      // Verify Atomic Reservation settlement in store
      const state = await getReserveState();
      const updatedTx = state.transactions.find((t) => t.id === 'tx_wh_1');
      expect(updatedTx).toBeDefined();
      expect(updatedTx?.status).toBe('captured');
      expect(state.heldPaise).toBe(0);
      expect(state.settledPaise).toBe(45000);
      expect((await verifyLedgerIntegrity()).isValid).toBe(true);
    });

    it('releases Atomic Reservation reservation on payment.failed webhook event', async () => {
      const orderId = 'order_test_webhook_fail';

      const initialTx: Transaction = {
        id: 'tx_wh_fail',
        merchant: 'Amazon',
        amount: 30000, // ₹300.00
        category: 'Electronics',
        status: 'reserved',
        reason: 'Transaction reserved',
        timestamp: new Date().toISOString(),
        razorpayOrderId: orderId,
        hash: '',
        prevHash: '',
      };
      await setReserveState({
        totalPaise: 200000,
        heldPaise: 30000,
        settledPaise: 0,
        transactions: [initialTx],
      });

      const payloadObj = {
        event: 'payment.failed',
        payload: {
          payment: {
            entity: {
              id: 'pay_fail_789',
              order_id: orderId,
              amount: 30000,
              status: 'failed',
              error_description: 'Payment failed due to card timeout',
            },
          },
        },
      };

      const payloadString = JSON.stringify(payloadObj);
      const validSignature = crypto
        .createHmac('sha256', secret)
        .update(payloadString)
        .digest('hex');

      const req = new Request('http://localhost/api/webhook', {
        method: 'POST',
        body: payloadString,
        headers: {
          'Content-Type': 'application/json',
          'x-razorpay-signature': validSignature,
        },
      });

      const res = await postWebhook(req);
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.status).toBe('ok');

      // Verify reservation released back to available funds
      const state = await getReserveState();
      const updatedTx = state.transactions.find((t) => t.id === 'tx_wh_fail');
      expect(updatedTx?.status).toBe('expired');
      expect(state.heldPaise).toBe(0);
      expect(state.availablePaise).toBe(200000);
      expect((await verifyLedgerIntegrity()).isValid).toBe(true);
    });

    it('handles refund.processed: atomic credit back to availablePaise and records immutable refund transaction', async () => {
      const orderId = 'order_test_refund_888';

      // Seed captured transaction with settled funds
      const capturedTx: Transaction = {
        id: 'tx_captured_orig',
        merchant: 'Amazon',
        amount: 50000, // ₹500.00
        category: 'Electronics',
        status: 'captured',
        reason: 'Payment captured',
        timestamp: new Date().toISOString(),
        razorpayOrderId: orderId,
        razorpayPaymentId: 'pay_orig_555',
        hash: '',
        prevHash: '',
      };

      await setReserveState({
        totalPaise: 200000,
        heldPaise: 0,
        settledPaise: 50000,
        transactions: [capturedTx],
      });

      const payloadObj = {
        event: 'refund.processed',
        payload: {
          refund: {
            entity: {
              id: 'rfnd_razorpay_999',
              payment_id: 'pay_orig_555',
              order_id: orderId,
              amount: 50000, // full refund
              status: 'processed',
            },
          },
        },
      };

      const payloadString = JSON.stringify(payloadObj);
      const validSignature = crypto
        .createHmac('sha256', secret)
        .update(payloadString)
        .digest('hex');

      const req = new Request('http://localhost/api/webhook', {
        method: 'POST',
        body: payloadString,
        headers: {
          'Content-Type': 'application/json',
          'x-razorpay-signature': validSignature,
        },
      });

      const res = await postWebhook(req);
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.status).toBe('ok');

      // Verify settled funds decremented and credited back to availablePaise
      const state = await getReserveState();
      expect(state.settledPaise).toBe(0);
      expect(state.availablePaise).toBe(200000);

      // Verify immutable refund transaction appended
      const refundTx = state.transactions.find((t) => t.status === 'refunded');
      expect(refundTx).toBeDefined();
      expect(refundTx?.amount).toBe(50000);
      expect(refundTx?.razorpayPaymentId).toBe('rfnd_razorpay_999');

      // Verify cryptographic ledger integrity
      expect((await verifyLedgerIntegrity()).isValid).toBe(true);
    });

    it('handles payment.dispute.created: flags transaction as disputed and freezes agent policy', async () => {
      const orderId = 'order_test_dispute_444';

      const capturedTx: Transaction = {
        id: 'tx_disputed_orig',
        merchant: 'Amazon',
        amount: 25000,
        category: 'Electronics',
        status: 'captured',
        reason: 'Payment captured',
        timestamp: new Date().toISOString(),
        razorpayOrderId: orderId,
        razorpayPaymentId: 'pay_disp_333',
        hash: '',
        prevHash: '',
      };

      await setReserveState({
        totalPaise: 200000,
        heldPaise: 0,
        settledPaise: 25000,
        transactions: [capturedTx],
      });

      const payloadObj = {
        event: 'payment.dispute.created',
        payload: {
          dispute: {
            entity: {
              id: 'disp_rzp_111',
              payment_id: 'pay_disp_333',
              reason_code: 'fraudulent',
              description: 'Customer reported unauthorized transaction',
            },
          },
        },
      };

      const payloadString = JSON.stringify(payloadObj);
      const validSignature = crypto
        .createHmac('sha256', secret)
        .update(payloadString)
        .digest('hex');

      const req = new Request('http://localhost/api/webhook', {
        method: 'POST',
        body: payloadString,
        headers: {
          'Content-Type': 'application/json',
          'x-razorpay-signature': validSignature,
        },
      });

      const res = await postWebhook(req);
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.status).toBe('ok');

      // Verify transaction flagged as disputed
      const state = await getReserveState();
      const tx = state.transactions.find((t) => t.id === 'tx_disputed_orig');
      expect(tx?.status).toBe('disputed');
      expect(tx?.reason).toContain('fraudulent');

      // Verify policy frozen
      const policy = await getActivePolicy();
      expect(policy.category).toBe('FROZEN_DUE_TO_DISPUTE');
      expect((await verifyLedgerIntegrity()).isValid).toBe(true);
    });
  });

  describe('Fail-Closed Secret Configuration', () => {
    it('throws fatal error in production environment when credentials are dummy or missing', async () => {
      const originalEnv = process.env.NODE_ENV;
      const origKeyId = process.env.RAZORPAY_KEY_ID;
      try {
        (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
        process.env.RAZORPAY_KEY_ID = 'rzp_test_dummy_key';

        expect(() => validateRazorpayConfig()).toThrow(/Fatal Security Error/);
      } finally {
        (process.env as Record<string, string | undefined>).NODE_ENV = originalEnv;
        process.env.RAZORPAY_KEY_ID = origKeyId;
      }
    });
  });
});

