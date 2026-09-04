import { NextResponse } from 'next/server';
import { getStore } from '../../../lib/store';
import { authenticateRequest } from '../../../lib/auth';

export async function POST(request: Request) {
  const auth = await authenticateRequest(request, {
    allowedRoles: ['admin', 'service', 'demo_user'],
  });
  if (!auth.authenticated) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const store = getStore();
  const testAgentId = `demo_idem_${Date.now()}`;
  
  await store.setReserveState(
    { totalPaise: 100000, heldPaise: 0, settledPaise: 0 },
    testAgentId
  );

  await store.setActivePolicy({
    amountCeiling: 100000,
    category: 'Food & Dining',
    merchantMode: 'unrestricted',
    allowedMerchants: [],
    sessionCap: 100000,
  }, testAgentId);

  const idempotencyKey = `idemp_${Date.now()}`;
  const purchaseParams = {
    agentId: testAgentId,
    merchant: 'TestMerchant',
    amount: 500, // INR
    category: 'Food & Dining',
    quantity: 1,
  };

  // Helper to call our own purchase API
  const callPurchase = async () => {
    const origin = new URL(request.url).origin;
    const res = await fetch(`${origin}/api/purchase`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-idempotency-key': idempotencyKey,
        'Authorization': `Bearer ${process.env.TEST_API_KEY || 'demo_mode_bypass'}`, 
        // Or if auth requires something else, we use the cookie from the current request
        'cookie': request.headers.get('cookie') || '',
      },
      body: JSON.stringify(purchaseParams)
    });
    return { status: res.status, data: await res.json() };
  };

  // FIRST REQUEST
  const firstRes = await callPurchase();
  const stateAfterFirst = await store.getReserveState(testAgentId);

  // SECOND REQUEST (REPLAY)
  const replayRes = await callPurchase();
  const stateAfterReplay = await store.getReserveState(testAgentId);

  const additionalCharge = (stateAfterReplay.heldPaise + stateAfterReplay.settledPaise) - (stateAfterFirst.heldPaise + stateAfterFirst.settledPaise);

  let firstStatus = 'ERROR';
  if (firstRes.status === 200) firstStatus = 'CREATED';
  else if (firstRes.status === 202) firstStatus = 'REVIEW';

  let replayStatus = 'ERROR';
  // If it's a 200/202 AND we didn't add to the reserve state, it successfully deduplicated.
  if ((replayRes.status === 200 || replayRes.status === 202) && additionalCharge === 0) {
    replayStatus = 'DEDUPLICATED';
  } else if (replayRes.status === 200 || replayRes.status === 202) {
    replayStatus = 'CREATED_DUPLICATE';
  }

  return NextResponse.json({
    firstRequestStatus: firstStatus,
    replayRequestStatus: replayStatus,
    additionalCharge,
    idempotencyKey
  });
}
