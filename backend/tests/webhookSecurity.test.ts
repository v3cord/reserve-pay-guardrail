import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'crypto';
import { POST as postWebhook } from '../app/api/webhook/route';
import { SqliteReserveStore } from '../lib/sqliteStore';
import { setStoreInstance } from '../lib/store';
import { Transaction } from '../lib/types';

const SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || 'dev_webhook_secret';

function sign(body: string) {
  return crypto.createHmac('sha256', SECRET).update(body).digest('hex');
}

function makeReq(body: object, sig?: string) {
  const raw = JSON.stringify(body);
  return new Request('http://localhost/api/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': sig ?? sign(raw) },
    body: raw,
  });
}

function agentId() {
  return `wh_sec_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

describe('Webhook Security – signature enforcement', () => {
  it('401 when signature header is missing', async () => {
    const raw = JSON.stringify({ event: 'payment.captured' });
    const res = await postWebhook(new Request('http://localhost/api/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: raw }));
    expect(res.status).toBe(401);
  });

  it('401 for forged signature', async () => {
    const res = await postWebhook(makeReq({ event: 'payment.captured' }, 'forged_signature_bad'));
    expect(res.status).toBe(401);
  });

  it('200 for valid HMAC signature', async () => {
    const body = { event: 'non.financial', payload: {} };
    const res = await postWebhook(makeReq(body));
    expect(res.status).toBe(200);
  });
});

describe('Webhook Security – order binding validation', () => {
  let store: SqliteReserveStore;
  let aid: string;

  beforeEach(async () => {
    aid = agentId();
    store = new SqliteReserveStore();
    setStoreInstance(store);
    await store.resetStore(aid);
    await store.setReserveState({ totalPaise: 200000, heldPaise: 0, settledPaise: 0 }, aid);

    // Seed a transaction with razorpayOrderId
    const tx: Transaction = {
      id: 'tx_binding_test',
      merchant: 'Swiggy',
      amount: 65000,
      category: 'Food & Dining',
      status: 'reserved',
      paymentStatus: 'order_created',
      timestamp: new Date().toISOString(),
      razorpayOrderId: 'order_correct_binding',
      agentId: aid,
      hash: '',
      prevHash: '',
    };
    await store.setReserveState({ totalPaise: 200000, heldPaise: 65000, settledPaise: 0, transactions: [tx] }, aid);
    await store.attachRazorpayOrder('tx_binding_test', 'order_correct_binding', aid);
  });

  it('400 when payment.order_id does not match transaction.razorpayOrderId', async () => {
    const body = {
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: 'pay_mismatch_999',
            order_id: 'order_WRONG_BINDING', // wrong order
            amount: 65000,
            currency: 'INR',
            status: 'captured',
          },
        },
      },
    };
    const res = await postWebhook(makeReq(body));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/binding/i);
  });

  it('400 for non-INR currency in capture event', async () => {
    const body = {
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: 'pay_usd_999',
            order_id: 'order_correct_binding',
            amount: 65000,
            currency: 'USD', // wrong currency
            status: 'captured',
          },
        },
      },
    };
    const res = await postWebhook(makeReq(body));
    expect(res.status).toBe(400);
  });

  it('400 for amount mismatch in capture event', async () => {
    const body = {
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: 'pay_amount_wrong',
            order_id: 'order_correct_binding',
            amount: 99999, // wrong amount (tx has 65000)
            currency: 'INR',
            status: 'captured',
          },
        },
      },
    };
    const res = await postWebhook(makeReq(body));
    expect(res.status).toBe(400);
  });
});

describe('Webhook Security – duplicate event deduplication', () => {
  let store: SqliteReserveStore;
  let aid: string;

  beforeEach(async () => {
    aid = agentId();
    store = new SqliteReserveStore();
    setStoreInstance(store);
    await store.resetStore(aid);
  });

  it('duplicate webhook with same event-id returns already_processed', async () => {
    // Two identical payloads — second should be deduplicated
    const eventId = `evt_dup_${Date.now()}`;
    const body1 = { event: 'non.financial', event_id: eventId };
    const body2 = { event: 'non.financial', event_id: eventId };

    const res1 = await postWebhook(makeReq(body1));
    const res2 = await postWebhook(makeReq(body2));

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);

    const data2 = await res2.json();
    expect(data2.status).toBe('already_processed');
  });
});

describe('Webhook Security – financial event without known transaction', () => {
  let store: SqliteReserveStore;

  beforeEach(async () => {
    const aid = agentId();
    store = new SqliteReserveStore();
    setStoreInstance(store);
    await store.resetStore(aid);
  });

  it('400 for payment.captured referencing unknown order', async () => {
    const body = {
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: 'pay_unknown',
            order_id: 'order_does_not_exist',
            amount: 10000,
            currency: 'INR',
            status: 'captured',
          },
        },
      },
    };
    const res = await postWebhook(makeReq(body));
    expect(res.status).toBe(400);
  });
});
