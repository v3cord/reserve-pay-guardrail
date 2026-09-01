import { NextResponse } from 'next/server';
import crypto from 'crypto';
import db from '../../../lib/db';
import {
  settleTransaction,
  releaseReservation,
  processRefund,
  disputeTransaction,
  recordSecurityAudit,
  appendLedgerEvent,
  claimWebhookEvent,
  getStore,
} from '../../../lib/store';
import { calculatePayloadHash } from '../../../lib/crypto';
import { validateRazorpayConfig } from '../../../lib/razorpay';
import { getClientIp } from '../../../lib/auth';

export async function POST(request: Request) {
  try {
    validateRazorpayConfig();

    const rawBody = await request.text();
    const signature = request.headers.get('x-razorpay-signature');
    const eventIdHeader = request.headers.get('x-razorpay-event-id');
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET || (process.env.NODE_ENV === 'test' ? 'dev_webhook_secret' : null);

    if (!secret) {
      throw new Error('Fatal Security Error: RAZORPAY_WEBHOOK_SECRET is missing.');
    }

    if (!signature) {
      recordSecurityAudit({
        eventType: 'UNAUTHORIZED_ACCESS',
        endpoint: '/api/webhook',
        method: 'POST',
        details: 'SECURITY ALERT: Webhook request received without x-razorpay-signature header.',
        ip: getClientIp(request),
      });

      return NextResponse.json(
        { error: 'Unauthorized: Missing x-razorpay-signature header' },
        { status: 401 }
      );
    }

    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(rawBody)
      .digest('hex');

    const signaturesMatch =
      signature.length === expectedSignature.length &&
      crypto.timingSafeEqual(Buffer.from(signature, 'utf8'), Buffer.from(expectedSignature, 'utf8'));

    if (!signaturesMatch) {
      recordSecurityAudit({
        eventType: 'SIGNATURE_VERIFICATION_FAILED',
        endpoint: '/api/webhook',
        method: 'POST',
        details: 'SECURITY ALERT: Invalid Razorpay webhook HMAC signature detected.',
        ip: getClientIp(request),
      });

      return NextResponse.json(
        { error: 'Unauthorized: Invalid webhook signature' },
        { status: 401 }
      );
    }

    const payload = JSON.parse(rawBody);
    const event: string = payload.event;
    const eventId = eventIdHeader || payload.event_id || payload.id || `evt_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
    const payloadHash = calculatePayloadHash(payload);

    // 1. Webhook Deduplication Claim (PostgreSQL & SQLite)
    const isNewEvent = await claimWebhookEvent(eventId, event, payloadHash);
    if (!isNewEvent) {
      return NextResponse.json({ status: 'already_processed', eventId }, { status: 200 });
    }

    // Extract entities from payload
    const paymentEntity = payload.payload?.payment?.entity;
    const orderEntity = payload.payload?.order?.entity;
    const refundEntity = payload.payload?.refund?.entity;
    const disputeEntity = payload.payload?.dispute?.entity;

    const orderId: string | undefined = paymentEntity?.order_id || orderEntity?.id || refundEntity?.order_id;
    const paymentId: string | undefined = paymentEntity?.id || refundEntity?.payment_id || disputeEntity?.payment_id;
    const identifier = orderId || paymentId;

    if (identifier) {
      const state = await getStore().getReserveState();
      const matchedTx = state.transactions.find(
        (t) => (orderId && (t.razorpayOrderId === orderId || t.id === orderId)) ||
               (paymentId && t.razorpayPaymentId === paymentId)
      );

      if (event === 'payment.authorized') {
        // Payment authorized: funds remain heldPaise, not moved to settledPaise
        if (matchedTx) {
          await appendLedgerEvent({
            transactionId: matchedTx.id,
            tenantId: matchedTx.tenantId || 'default_tenant',
            agentId: matchedTx.agentId || 'default_agent',
            eventType: 'ORDER_ATTACHED',
            payload: { status: 'authorized', razorpayPaymentId: paymentId, razorpayOrderId: orderId },
            timestamp: new Date().toISOString(),
          });
        }
      } else if (event === 'payment.captured' || event === 'order.paid') {
        const capturedAmount = paymentEntity?.amount || orderEntity?.amount;
        const currency = paymentEntity?.currency || orderEntity?.currency || 'INR';

        // Strict Triple-Binding Validation
        if (currency !== 'INR') {
          recordSecurityAudit({
            eventType: 'SECRET_VALIDATION_FAILURE',
            endpoint: '/api/webhook',
            method: 'POST',
            details: `Non-INR currency rejected: ${currency}`,
            ip: getClientIp(request),
          });
          return NextResponse.json({ error: `Unsupported currency: ${currency}` }, { status: 400 });
        }

        if (matchedTx && capturedAmount && matchedTx.amount !== capturedAmount) {
          recordSecurityAudit({
            eventType: 'SECRET_VALIDATION_FAILURE',
            endpoint: '/api/webhook',
            method: 'POST',
            details: `Triple-binding mismatch: captured amount ₹${(capturedAmount / 100).toFixed(2)} does not match reservation ₹${(matchedTx.amount / 100).toFixed(2)}`,
            ip: getClientIp(request),
          });

          await appendLedgerEvent({
            transactionId: matchedTx.id,
            tenantId: 'default_tenant',
            agentId: matchedTx.agentId || 'default_agent',
            eventType: 'PAYMENT_AMOUNT_MISMATCH',
            payload: { reservedPaise: matchedTx.amount, capturedPaise: capturedAmount },
            timestamp: new Date().toISOString(),
          });
          return NextResponse.json({ error: 'Triple-binding mismatch: captured amount does not match reservation' }, { status: 400 });
        }

        await settleTransaction(identifier, paymentId, matchedTx?.agentId);
      } else if (event === 'payment.failed') {
        const failureReason =
          paymentEntity?.error_description ||
          paymentEntity?.error_reason ||
          `Payment failed via Razorpay Webhook (${event})`;
        await releaseReservation(identifier, failureReason, matchedTx?.agentId);
      } else if (event === 'refund.processed' || event === 'refund.created' || event === 'payment.refunded') {
        const refundAmountPaise = refundEntity?.amount || paymentEntity?.amount_refunded || 0;
        const refundId = refundEntity?.id;
        const refundReason = `Refund processed via Razorpay Webhook (${event})`;
        if (refundAmountPaise > 0) {
          await processRefund(identifier, refundAmountPaise, refundId, refundReason, matchedTx?.agentId);
        }
      } else if (event === 'payment.dispute.created' || event === 'payment.dispute.won' || event === 'payment.dispute.lost') {
        const disputeReason = `Payment dispute event: ${event} (Dispute ID: ${disputeEntity?.id || 'N/A'})`;
        await disputeTransaction(identifier, disputeReason, matchedTx?.agentId);
      }
    }

    return NextResponse.json({ status: 'ok', event, eventId }, { status: 200 });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : 'Unknown webhook processing error';
    console.error('[API /api/webhook Error]:', err);
    return NextResponse.json(
      { error: 'Webhook processing error', details: errorMsg },
      { status: 500 }
    );
  }
}
