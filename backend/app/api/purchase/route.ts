import { NextResponse } from 'next/server';
import {
  processPurchaseAtomic,
  getReserveState,
  recordSecurityAudit,
  appendLedgerEvent,
  attachRazorpayOrder,
  claimIdempotencyKey,
  completeIdempotencyKey,
  failIdempotencyKey,
  flagOrderCreationUnknown,
  releaseReservation,
} from '../../../lib/store';
import { calculatePayloadHash } from '../../../lib/crypto';
import { authenticateRequest, getClientIp } from '../../../lib/auth';
import { getRazorpayClient, isMockRazorpayEnabled } from '../../../lib/razorpayClient';
import { resolveCatalogProduct, CURRENT_CATALOG_VERSION } from '../../../lib/merchantCatalog';
import { PurchaseRequestBody } from '../../../lib/types';

export async function POST(request: Request) {
  try {
    const rawBody = await request.text();
    const auth = await authenticateRequest(request, {
      allowedRoles: ['admin', 'service', 'agent', 'demo_user', 'ADMIN_ROLE', 'AGENT_ROLE'],
      rawBody,
    });

    if (!auth.authenticated || !auth.context) {
      return NextResponse.json(
        { error: auth.error || 'Unauthorized' },
        { status: auth.statusCode || 401 }
      );
    }

    const body: PurchaseRequestBody = JSON.parse(rawBody || '{}');
    // SECURITY: Always derive identity from server-side auth context, never from body
    const tenantId = auth.context.tenantId || 'default_tenant';
    const agentId = auth.context.agentId || 'default_agent';
    const ip = getClientIp(request);
    const role = auth.context.role;

    // Audit log if client attempted identity spoofing
    if (body.tenantId && body.tenantId !== tenantId || body.agentId && body.agentId !== agentId) {
      await recordSecurityAudit({
        eventType: 'FORBIDDEN_PRIVILEGE_ESCALATION',
        role: auth.context.role,
        identity: auth.context.identity,
        endpoint: '/api/purchase',
        method: 'POST',
        details: `Client attempted identity override: body.tenantId=${body.tenantId || 'none'}, body.agentId=${body.agentId || 'none'} (server: tenant=${tenantId}, agent=${agentId})`,
        ip,
      });
    }

    // Phase 1: Agent-role purchases MUST use productId + quantity + idempotencyKey
    const isAgentRole = role === 'agent' || role === 'AGENT_ROLE';
    if (isAgentRole) {
      if (!body.productId) {
        return NextResponse.json(
          { error: 'Agent-role purchases require productId. Raw merchant/amount fields are not accepted from agent role. Use GET /api/catalog-search to find valid productIds.' },
          { status: 400 }
        );
      }
      const ikey = (request.headers.get('x-idempotency-key') || body.idempotencyKey || '').trim();
      if (!ikey) {
        return NextResponse.json(
          { error: 'Agent-role purchases require an idempotencyKey to prevent double-charging.' },
          { status: 400 }
        );
      }
    }

    // 1. Authoritative Catalog Lookup
    let resolvedMerchant = body.merchant;
    let resolvedCategory = body.category;
    let resolvedAmount = body.amount;
    let resolvedMcc = body.mccCode;
    let catalogVersion = body.catalogVersion;

    if (body.productId) {
      const catalogItem = resolveCatalogProduct(body.productId);
      if (!catalogItem) {
        return NextResponse.json(
          { error: `Invalid productId '${body.productId}'. Item not found in authoritative merchant catalog.` },
          { status: 400 }
        );
      }
      resolvedMerchant = catalogItem.merchantName || catalogItem.merchant;
      resolvedCategory = catalogItem.category;
      resolvedMcc = catalogItem.mcc;
      resolvedAmount = (catalogItem.unitPricePaise || catalogItem.pricePaise || 0) * (body.quantity || 1);
      catalogVersion = catalogItem.catalogVersion || CURRENT_CATALOG_VERSION;
    }

    if (!resolvedMerchant || resolvedAmount === undefined || resolvedAmount <= 0) {
      return NextResponse.json(
        { error: 'Invalid payload: merchant/productId and a valid positive amount are required.' },
        { status: 400 }
      );
    }

    // 2. Durable Idempotency Check
    const idempotencyKey =
      (request.headers.get('x-idempotency-key') || body.idempotencyKey || '').trim();
    const payloadHash = calculatePayloadHash({
      tenantId,
      agentId,
      productId: body.productId,
      merchant: resolvedMerchant,
      amount: resolvedAmount,
      category: resolvedCategory,
      quantity: body.quantity || 1,
    });

    if (idempotencyKey) {
      const claim = await claimIdempotencyKey(tenantId, agentId, idempotencyKey, payloadHash);
      if (claim.status === 'CACHED' && claim.cachedResponse) {
        return NextResponse.json(claim.cachedResponse);
      }
      if (claim.status === 'MISMATCH') {
        return NextResponse.json(
          { error: '409 Conflict: Idempotency key already used with different request parameters.' },
          { status: 409 }
        );
      }
      if (claim.status === 'PROCESSING') {
        // Another worker is currently processing this key — do NOT enter financial execution
        return NextResponse.json(
          { error: '409 Conflict: Request with this idempotency key is currently being processed. Retry after a short delay.' },
          { status: 409, headers: { 'Retry-After': '2' } }
        );
      }
    }

    // 3. Deterministic Local Reservation Engine
    const purchaseResult = await processPurchaseAtomic({
      ...body,
      merchant: resolvedMerchant,
      category: resolvedCategory || 'General',
      amount: resolvedAmount,
      mccCode: resolvedMcc,
      agentId,
      tenantId,
      catalogVersion,
    });

    if (purchaseResult.decision === 'denied') {
      if (idempotencyKey) {
        await failIdempotencyKey(tenantId, agentId, idempotencyKey);
      }
      return NextResponse.json(
        {
          decision: 'denied',
          decisionStatus: 'denied',
          paymentStatus: 'failed',
          reason: purchaseResult.reason,
          ruleViolated: purchaseResult.ruleViolated,
          limitPaise: purchaseResult.limitPaise,
          requestedPaise: purchaseResult.requestedPaise,
          policyExplanation: purchaseResult.policyExplanation,
          updatedReserveState: purchaseResult.updatedReserveState,
        },
        { status: 403 }
      );
    }

    if (purchaseResult.decision === 'review') {
      const responseData = {
        decision: 'review',
        decisionStatus: 'review',
        paymentStatus: 'requested',
        reason: purchaseResult.reason,
        ruleViolated: purchaseResult.ruleViolated,
        policyExplanation: purchaseResult.policyExplanation,
        transaction: purchaseResult.transaction,
        updatedReserveState: purchaseResult.updatedReserveState,
      };
      if (idempotencyKey) {
        await completeIdempotencyKey(tenantId, agentId, idempotencyKey, responseData);
      }
      return NextResponse.json(responseData, { status: 200 });
    }

    // 4. Initiating Razorpay Standard Order Side-Effect
    const txId = purchaseResult.transaction?.id || `tx_${Date.now()}`;
    let razorpayOrderId: string | undefined;
    const isMock = isMockRazorpayEnabled();

    if (isMock) {
      razorpayOrderId = `order_mock_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    } else {
      const rzp = getRazorpayClient();
      if (!rzp) {
        await releaseReservation(txId, 'Gateway unavailable', agentId);
        return NextResponse.json(
          { error: 'Payment gateway configuration error.' },
          { status: 500 }
        );
      }

      try {
        const receiptRef = txId.length > 40 ? txId.slice(0, 40) : txId;
        const order = await rzp.orders.create({
          amount: resolvedAmount,
          currency: 'INR',
          receipt: receiptRef,
          notes: {
            agentId,
            tenantId,
            txId,
            productId: body.productId || '',
            category: resolvedCategory || '',
          },
        });
        razorpayOrderId = order.id;
      } catch (gatewayErr: unknown) {
        const errorObj = gatewayErr as { code?: string; message?: string };
        const isTimeout =
          errorObj.code === 'ETIMEDOUT' ||
          errorObj.code === 'ECONNRESET' ||
          errorObj.message?.includes('timeout');

        if (isTimeout) {
          await flagOrderCreationUnknown(txId, agentId);
          return NextResponse.json(
            {
              decision: 'allowed',
              decisionStatus: 'allowed',
              paymentStatus: 'order_creation_unknown',
              reason: 'Payment order creation in indeterminate state. Queued for automatic reconciliation.',
              transactionId: txId,
            },
            { status: 202 }
          );
        } else {
          const detailMsg = errorObj.message || String(gatewayErr);
          await releaseReservation(txId, `Razorpay order creation failed: ${detailMsg}`, agentId);
          if (idempotencyKey) {
            await failIdempotencyKey(tenantId, agentId, idempotencyKey);
          }
          return NextResponse.json(
            { error: 'Razorpay order creation rejected by gateway.', details: detailMsg },
            { status: 502 }
          );
        }
      }
    }

    if (razorpayOrderId) {
      await attachRazorpayOrder(txId, razorpayOrderId, agentId);
    }

    const responsePayload = {
      decision: 'allowed',
      decisionStatus: 'allowed',
      paymentStatus: 'order_created',
      mode: isMock ? ('mock' as const) : ('live' as const),
      razorpayOrderId,
      amount: resolvedAmount,
      currency: 'INR',
      policyExplanation: purchaseResult.policyExplanation,
      transaction: {
        ...purchaseResult.transaction,
        razorpayOrderId,
        paymentStatus: 'order_created',
      },
      updatedReserveState: await getReserveState(agentId),
    };

    if (idempotencyKey) {
      await completeIdempotencyKey(tenantId, agentId, idempotencyKey, responsePayload);
    }

    return NextResponse.json(responsePayload, { status: 200 });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json(
      { error: 'Failed to process purchase', details: errorMsg },
      { status: 500 }
    );
  }
}
