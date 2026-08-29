import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { processPurchaseAtomic, recordTransaction, getReserveState, recordSecurityAudit } from '@/lib/store';
import { AttemptedPurchase } from '@/lib/types';
import { getRazorpayClient } from '@/lib/razorpayClient';
import { authenticateRequest, getClientIp } from '@/lib/auth';

export interface PurchaseRequestBody extends AttemptedPurchase {
  override?: boolean;
}

export async function POST(request: Request) {
  try {
    const rawBody = await request.text();
    const auth = await authenticateRequest(request, {
      allowedRoles: ['ADMIN_ROLE', 'AGENT_ROLE'],
      rawBody,
    });

    if (!auth.authenticated) {
      return NextResponse.json(
        { error: auth.error || 'Unauthorized' },
        { status: auth.statusCode || 401 }
      );
    }

    const purchase: PurchaseRequestBody = JSON.parse(rawBody);

    if (
      !purchase ||
      !purchase.merchant ||
      typeof purchase.merchant !== 'string' ||
      purchase.amount === undefined ||
      purchase.amount === null ||
      typeof purchase.amount !== 'number' ||
      isNaN(purchase.amount) ||
      purchase.amount <= 0 ||
      !purchase.category ||
      typeof purchase.category !== 'string'
    ) {
      return NextResponse.json(
        { error: 'Invalid payload: merchant (string), positive amount (integer paise), and category (string) are required.' },
        { status: 400 }
      );
    }

    // Role-Based Privilege Enforcement for Manual Overrides
    if (purchase.override) {
      if (auth.context?.role !== 'ADMIN_ROLE') {
        await recordSecurityAudit({
          eventType: 'FORBIDDEN_PRIVILEGE_ESCALATION',
          role: auth.context?.role,
          identity: auth.context?.identity,
          endpoint: '/api/purchase',
          method: 'POST',
          details: 'Client with AGENT_ROLE attempted unauthorized manual override on purchase.',
          ip: getClientIp(request),
        });

        return NextResponse.json(
          {
            error: 'Forbidden: Manual override requires ADMIN_ROLE privilege.',
            decision: 'freeze',
            reason: 'Unauthorized override attempt by AGENT_ROLE',
          },
          { status: 403 }
        );
      }

      await recordSecurityAudit({
        eventType: 'MANUAL_OVERRIDE_EXECUTED',
        role: auth.context?.role,
        identity: auth.context?.identity,
        endpoint: '/api/purchase',
        method: 'POST',
        details: `ADMIN override executed for merchant=${purchase.merchant}, amount=${purchase.amount}`,
        ip: getClientIp(request),
      });
    }

    const agentId = purchase.agentId || auth.context?.agentId || 'default_agent';

    // Step 1: Run attempted transaction through guardCheck via atomic store transaction
    const result = await processPurchaseAtomic({
      ...purchase,
      agentId,
    });

    // Step 3: If Blocked/Frozen: Do NOT issue Razorpay order; return 403 Guardrail Rejected
    if (result.decision === 'freeze') {
      return NextResponse.json(
        {
          decision: 'freeze',
          reason: result.reason,
          error: 'Guardrail Rejected',
          updatedReserveState: result.updatedReserveState,
        },
        { status: 403 }
      );
    }

    // Step 2: If Approved: Call razorpay.orders.create with deterministic receipt & capture settings
    let razorpayOrderId: string | undefined;

    const receipt =
      purchase.receipt ||
      `rcpt_${agentId}_${purchase.id || crypto.createHash('sha256').update(`${purchase.merchant}_${purchase.amount}_${purchase.category}`).digest('hex').slice(0, 10)}`;
    const payment_capture = purchase.payment_capture !== undefined ? purchase.payment_capture : 1;

    try {
      const razorpay = getRazorpayClient();
      const orderParams: {
        amount: number;
        currency: string;
        receipt: string;
        payment_capture: number;
        notes: Record<string, string>;
      } = {
        amount: Math.round(purchase.amount), // amount in integer paise
        currency: 'INR',
        receipt,
        payment_capture,
        notes: {
          agentId,
          policyId: purchase.policyId || 'default_policy',
          idempotencyKey: purchase.idempotencyKey || receipt,
        },
      };

      const order = await razorpay.orders.create(orderParams as Parameters<typeof razorpay.orders.create>[0]);
      razorpayOrderId = order.id;

      // Update reserved transaction record in ledger with razorpayOrderId
      if (razorpayOrderId && result.updatedReserveState.transactions.length > 0) {
        const lastTx = result.updatedReserveState.transactions[result.updatedReserveState.transactions.length - 1];
        if (lastTx && (lastTx.status === 'reserved' || (lastTx.status as string) === 'approved')) {
          lastTx.razorpayOrderId = razorpayOrderId;
          await recordTransaction(lastTx);
        }
      }
    } catch (razorpayErr) {
      if (process.env.NODE_ENV === 'production') {
        throw razorpayErr;
      }
      console.warn('Razorpay SDK order creation fallback in dev mode:', razorpayErr);
      razorpayOrderId = `order_test_mock_${Date.now()}`;
      if (result.updatedReserveState.transactions.length > 0) {
        const lastTx = result.updatedReserveState.transactions[result.updatedReserveState.transactions.length - 1];
        if (lastTx && (lastTx.status === 'reserved' || (lastTx.status as string) === 'approved')) {
          lastTx.razorpayOrderId = razorpayOrderId;
          await recordTransaction(lastTx);
        }
      }
    }

    const finalReserveState = await getReserveState(agentId);

    return NextResponse.json({
      decision: 'approve',
      reason: result.reason,
      razorpayOrderId,
      updatedReserveState: finalReserveState,
    });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : 'Unknown error';
    console.error('[API /api/purchase Error]:', err);
    return NextResponse.json(
      { error: 'Failed to process purchase', details: errorMsg },
      { status: 400 }
    );
  }
}

