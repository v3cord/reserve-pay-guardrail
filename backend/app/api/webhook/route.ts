import { NextResponse } from 'next/server';
import crypto from 'crypto';
import {
  recordTransaction,
  settleTransaction,
  releaseReservation,
  processRefund,
  disputeTransaction,
  recordSecurityAudit,
} from '@/lib/store';
import { validateRazorpayConfig } from '@/lib/razorpayClient';
import { getClientIp } from '@/lib/auth';

export async function POST(request: Request) {
  try {
    validateRazorpayConfig();

    const rawBody = await request.text();
    const signature = request.headers.get('x-razorpay-signature');
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET || (process.env.NODE_ENV === 'test' ? 'dev_webhook_secret' : null);

    if (!secret) {
      throw new Error('Fatal Security Error: RAZORPAY_WEBHOOK_SECRET is missing.');
    }

    const webhookSecret = secret;

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
      .createHmac('sha256', webhookSecret)
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

    // Extract entities from payload
    const paymentEntity = payload.payload?.payment?.entity;
    const orderEntity = payload.payload?.order?.entity;
    const refundEntity = payload.payload?.refund?.entity;
    const disputeEntity = payload.payload?.dispute?.entity;

    const orderId: string | undefined =
      paymentEntity?.order_id ||
      orderEntity?.id ||
      refundEntity?.order_id;
    const paymentId: string | undefined =
      paymentEntity?.id ||
      refundEntity?.payment_id ||
      disputeEntity?.payment_id;

    const identifier = orderId || paymentId;

    if (identifier) {
      if (event === 'payment.failed') {
        const failureReason =
          paymentEntity?.error_description ||
          paymentEntity?.error_reason ||
          `Payment failed via Razorpay Webhook (${event})`;
        await releaseReservation(identifier, failureReason);
      } else if (event === 'refund.processed' || event === 'refund.created' || event === 'payment.refunded') {
        const refundAmountPaise = refundEntity?.amount || paymentEntity?.amount_refunded || 0;
        const refundId = refundEntity?.id;
        const refundReason = `Refund processed via Razorpay Webhook (${event})`;
        if (refundAmountPaise > 0) {
          await processRefund(identifier, refundAmountPaise, refundId, refundReason);
        }
      } else if (event === 'payment.dispute.created' || event === 'dispute.created') {
        const disputeReason = disputeEntity?.reason_code
          ? `Dispute created (${disputeEntity.reason_code}): ${disputeEntity.description || 'Manual review required'}`
          : `Dispute created via Razorpay Webhook (${event})`;
        await disputeTransaction(identifier, disputeReason);
      } else if (event === 'payment.captured' || event === 'order.paid' || event === 'payment.authorized') {
        const settleResult = await settleTransaction(identifier, paymentId);
        if (settleResult.transaction) {
          settleResult.transaction.reason = `Verified via Razorpay Webhook (${event})`;
          await recordTransaction(settleResult.transaction);
        }
      }
    }

    return NextResponse.json({ status: 'ok', received: true, event });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: 'Failed to process webhook', details: errorMsg }, { status: 400 });
  }
}

