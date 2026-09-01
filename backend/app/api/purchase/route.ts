import { NextResponse } from 'next/server';
import crypto from 'crypto';
import {
  processPurchaseAtomic,
  recordTransaction,
  getReserveState,
  recordSecurityAudit,
  claimIdempotencyKey,
  completeIdempotencyKey,
  failIdempotencyKey,
  releaseReservation,
  flagOrderCreationUnknown
} from '../../../lib/store';
import { AttemptedPurchase } from '../../../lib/types';
import { getRazorpayClient } from '../../../lib/razorpay';
import { authenticateRequest, getClientIp } from '../../../lib/auth';
import { resolveCatalogProduct, CURRENT_CATALOG_VERSION } from '../../../lib/merchantCatalog';

export interface PurchaseRequestBody extends AttemptedPurchase {
  override?: boolean;
}

export async function POST(request: Request) {
  const tenantId = 'default_tenant';
  let agentId = 'default_agent';
  let idempotencyKey: string | null = null;

  try {
    const rawBody = await request.text();
    const auth = await authenticateRequest(request, {
      allowedRoles: ['admin', 'agent', 'service', 'demo_user'],
      rawBody,
    });

    if (!auth.authenticated || !auth.context) {
      return NextResponse.json(
        { error: auth.error || 'Unauthorized' },
        { status: auth.statusCode || 401 }
      );
    }

    // Securely derive agentId: Ignore client override unless privileged admin
    if (auth.context.role === 'admin' || auth.context.role === 'service') {
      const parsedBody = JSON.parse(rawBody || '{}');
      agentId = parsedBody.agentId || auth.context.agentId || 'default_agent';
    } else {
      agentId = auth.context.agentId || 'default_agent';
    }

    const purchase: PurchaseRequestBody = JSON.parse(rawBody);

    // 1. Authoritative Catalog Product Resolution
    if (purchase.productId) {
      const product = resolveCatalogProduct(purchase.productId);
      if (!product) {
        return NextResponse.json(
          { error: `Invalid productId '${purchase.productId}'. Must exist in merchant catalog.` },
          { status: 400 }
        );
      }
      purchase.merchant = product.merchant;
      purchase.category = product.category;
      purchase.mccCode = product.mcc;
      purchase.quantity = purchase.quantity || 1;
      purchase.amount = product.pricePaise * purchase.quantity;
      purchase.catalogVersion = CURRENT_CATALOG_VERSION;
    }

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
        { error: 'Invalid payload: merchant, positive amount (integer paise), and category are required.' },
        { status: 400 }
      );
    }

    // 2. Durable Idempotency Key Scoping & Verification
    idempotencyKey = request.headers.get('x-idempotency-key') || purchase.idempotencyKey || null;
    if (idempotencyKey) {
      const requestHash = crypto.createHash('sha256').update(rawBody).digest('hex');
      const claimResult = await claimIdempotencyKey(tenantId, agentId, idempotencyKey, requestHash);

      if (claimResult.status === 'MISMATCH') {
        return NextResponse.json(
          { error: 'Conflict: Idempotency key reuse with different request payload.', code: 'IDEMPOTENCY_KEY_REUSE' },
          { status: 409 }
        );
      }
      if (claimResult.status === 'CACHED' && claimResult.cachedResponse) {
        return NextResponse.json(claimResult.cachedResponse, {
          status: 200,
          headers: { 'X-Cache': 'IDEMPOTENT_HIT' },
        });
      }
      if (claimResult.status === 'PROCESSING') {
        return NextResponse.json(
          { error: 'Conflict: A request with this idempotency key is currently processing.', code: 'CONCURRENT_REQUEST_PROCESSING' },
          { status: 409 }
        );
      }
    }

    // 3. Role-Based Privilege Enforcement for Manual Overrides
    if (purchase.override) {
      if (auth.context.role !== 'admin') {
        await recordSecurityAudit({
          eventType: 'FORBIDDEN_PRIVILEGE_ESCALATION',
          role: auth.context.role,
          identity: auth.context.identity,
          endpoint: '/api/purchase',
          method: 'POST',
          details: 'Client attempted unauthorized manual override on purchase.',
          ip: getClientIp(request),
        });

        return NextResponse.json(
          {
            error: 'Forbidden: Manual override requires admin privilege.',
            decision: 'denied',
            reason: 'Unauthorized override attempt',
          },
          { status: 403 }
        );
      }

      await recordSecurityAudit({
        eventType: 'MANUAL_OVERRIDE_EXECUTED',
        role: auth.context.role,
        identity: auth.context.identity,
        endpoint: '/api/purchase',
        method: 'POST',
        details: `ADMIN override executed for merchant=${purchase.merchant}, amount=${purchase.amount}`,
        ip: getClientIp(request),
      });
    }

    // Step 1: Run attempted transaction through guardCheck via atomic store reservation
    const result = await processPurchaseAtomic({
      ...purchase,
      agentId,
      tenantId,
    });

    // Step 2: If Blocked / Review: Do NOT issue Razorpay order; 0 funds held
    if (result.decision === 'denied' || result.decision === 'review') {
      const responsePayload = {
        decision: result.decision,
        decisionStatus: result.decisionStatus,
        paymentStatus: result.paymentStatus,
        reason: result.reason,
        ruleViolated: result.ruleViolated,
        limitPaise: result.limitPaise,
        requestedPaise: result.requestedPaise,
        policyId: result.policyId,
        policyVersion: result.policyVersion,
        error: result.decision === 'denied' ? 'Guardrail Rejected' : 'Human Review Required',
        fundsHeldPaise: 0,
        updatedReserveState: result.updatedReserveState,
      };

      if (idempotencyKey) {
        await completeIdempotencyKey(tenantId, agentId, idempotencyKey, responsePayload);
      }

      return NextResponse.json(responsePayload, { status: result.decision === 'denied' ? 403 : 200 });
    }

    // Step 3: If Allowed: local reservation created. Call Razorpay orders.create with 3-Outcome Failure Handling
    const tx = result.transaction!;
    const receipt = `rcpt_${tx.id.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 34)}`;
    let razorpayOrderId: string | undefined;

    try {
      const razorpay = getRazorpayClient();
      const order = await razorpay.orders.create({
        amount: Math.round(purchase.amount),
        currency: 'INR',
        receipt,
        payment_capture: purchase.payment_capture !== undefined ? purchase.payment_capture : 1,
        notes: {
          agentId,
          tenantId,
          transactionId: tx.id,
          productId: purchase.productId || 'custom',
          policyId: tx.policyId || 'default_policy',
          idempotencyKey: idempotencyKey || receipt,
        },
      });

      razorpayOrderId = order.id;

      // Update reserved transaction record with razorpayOrderId and paymentStatus = order_created
      tx.razorpayOrderId = razorpayOrderId;
      tx.paymentStatus = 'order_created';
      await recordTransaction(tx);

    } catch (razorpayErr: any) {
      const isDefiniteFailure = razorpayErr?.statusCode >= 400 && razorpayErr?.statusCode < 500;
      const isUnknownFailure = !isDefiniteFailure; // 5xx, network timeout, ECONNRESET

      if (isDefiniteFailure) {
        // Outcome B: Definite Failure -> Release Reservation Immediately
        await releaseReservation(tx.id, `Razorpay order creation rejected: ${razorpayErr.message || '4xx Client Error'}`, agentId);
        if (idempotencyKey) {
          await failIdempotencyKey(tenantId, agentId, idempotencyKey);
        }
        return NextResponse.json({
          error: 'Razorpay order creation rejected by payment gateway',
          details: razorpayErr.message,
          paymentStatus: 'released',
          reservationReleased: true,
        }, { status: 400 });
      }

      if (isUnknownFailure) {
        if (process.env.NODE_ENV !== 'production') {
          // Dev Mock Fallback
          razorpayOrderId = `order_mock_${Date.now()}`;
          tx.razorpayOrderId = razorpayOrderId;
          tx.paymentStatus = 'order_created';
          await recordTransaction(tx);
        } else {
          // Outcome C: Unknown Outcome (Timeout) -> Flag for Reconciliation
          await flagOrderCreationUnknown(tx.id, agentId);
          if (idempotencyKey) {
            await failIdempotencyKey(tenantId, agentId, idempotencyKey);
          }
          return NextResponse.json({
            error: 'Network timeout connecting to Razorpay — transaction queued for background reconciliation',
            transactionId: tx.id,
            paymentStatus: 'order_creation_unknown',
            receipt,
          }, { status: 202 });
        }
      }
    }

    const finalReserveState = await getReserveState(agentId);

    const successResponse = {
      decision: 'allowed',
      decisionStatus: 'allowed',
      paymentStatus: 'order_created',
      reason: result.reason,
      transactionId: tx.id,
      razorpayOrderId,
      receipt,
      productId: purchase.productId,
      catalogVersion: purchase.catalogVersion,
      updatedReserveState: finalReserveState,
    };

    if (idempotencyKey) {
      await completeIdempotencyKey(tenantId, agentId, idempotencyKey, successResponse);
    }

    return NextResponse.json(successResponse, { status: 200 });

  } catch (err: unknown) {
    if (idempotencyKey) {
      await failIdempotencyKey(tenantId, agentId, idempotencyKey).catch(() => {});
    }
    const errorMsg = err instanceof Error ? err.message : 'Unknown error';
    console.error('[API /api/purchase Error]:', err);
    return NextResponse.json(
      { error: 'Failed to process purchase', details: errorMsg },
      { status: 400 }
    );
  }
}
