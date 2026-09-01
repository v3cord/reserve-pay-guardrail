import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { settleTransaction, recordSecurityAudit } from '../../../lib/store';
import { authenticateRequest, getClientIp } from '../../../lib/auth';
import { validateRazorpayConfig } from '../../../lib/razorpay';

export async function POST(request: Request) {
  try {
    validateRazorpayConfig();

    const rawBody = await request.text();
    const auth = await authenticateRequest(request, {
      allowedRoles: ['admin', 'service', 'agent', 'demo_user'],
      rawBody,
    });

    if (!auth.authenticated || !auth.context) {
      return NextResponse.json(
        { error: auth.error || 'Unauthorized' },
        { status: auth.statusCode || 401 }
      );
    }

    const body = JSON.parse(rawBody || '{}');
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, agentId } = body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return NextResponse.json(
        { error: 'Invalid payload: razorpay_order_id, razorpay_payment_id, and razorpay_signature are required.' },
        { status: 400 }
      );
    }

    const secret = process.env.RAZORPAY_KEY_SECRET || (process.env.NODE_ENV === 'test' ? 'dev_key_secret' : null);
    if (!secret) {
      throw new Error('Fatal Security Error: RAZORPAY_KEY_SECRET is not configured.');
    }

    const generatedSignature = crypto
      .createHmac('sha256', secret)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');

    const isMockOrder = process.env.NODE_ENV !== 'production' && razorpay_order_id.startsWith('order_test_mock_');

    const isVerified = isMockOrder || (
      razorpay_signature.length === generatedSignature.length &&
      crypto.timingSafeEqual(Buffer.from(razorpay_signature, 'utf8'), Buffer.from(generatedSignature, 'utf8'))
    );

    if (!isVerified) {
      await recordSecurityAudit({
        eventType: 'SIGNATURE_VERIFICATION_FAILED',
        role: auth.context?.role,
        identity: auth.context?.identity,
        endpoint: '/api/verify-payment',
        method: 'POST',
        details: 'CRITICAL SECURITY: Invalid Razorpay checkout signature verification attempt detected.',
        ip: getClientIp(request),
      });

      return NextResponse.json(
        { error: 'Invalid payment signature verification failed.' },
        { status: 400 }
      );
    }

    const targetAgentId = agentId || auth.context?.agentId || 'default_agent';
    const settleResult = await settleTransaction(razorpay_order_id, razorpay_payment_id, targetAgentId);

    return NextResponse.json({
      status: settleResult.success ? 'captured' : 'error',
      ...settleResult,
    });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json(
      { error: 'Failed to verify payment', details: errorMsg },
      { status: 400 }
    );
  }
}
