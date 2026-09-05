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
  
  // Create an isolated demo agent for this test
  const testAgentId = `demo_conc_${Date.now()}`;
  
  // Isolated budget: ₹1,000 (100,000 paise)
  const budgetPaise = 100000;
  await store.setReserveState(
    {
      totalPaise: budgetPaise,
      heldPaise: 0,
      settledPaise: 0,
    },
    testAgentId
  );

  await store.setActivePolicy({
    amountCeiling: 100000,
    category: 'Food & Dining',
    merchantMode: 'unrestricted',
    allowedMerchants: [], // unrestricted mode ignores this
    sessionCap: budgetPaise,
  }, testAgentId);

  let N = 1000;
  try {
    const rawBody = await request.text();
    if (rawBody) {
      const body = JSON.parse(rawBody);
      if (typeof body.count === 'number' && body.count > 0) {
        N = Math.min(Math.floor(body.count), 1000);
      }
    }
  } catch (err) {}
  
  const unitAmount = 60000; // ₹600 (within single item ceiling & reserve cap)

  // N requests concurrently
  const promises = Array.from({ length: N }, (_, i) =>
    store.processPurchaseAtomic({
      id: `attack_conc_${i}_${Date.now()}`,
      merchant: 'TestMerchant',
      amount: unitAmount,
      category: 'Food & Dining',
      quantity: 1,
      agentId: testAgentId,
    })
  );

  const results = await Promise.all(promises);
  
  const allowed = results.filter(r => r.decision === 'allowed').length;
  const blocked = results.filter(r => r.decision === 'denied' || r.decision === 'review').length;

  const finalState = await store.getReserveState(testAgentId);
  const totalFinancialEffect = finalState.heldPaise + finalState.settledPaise;
  const overspend = Math.max(0, totalFinancialEffect - budgetPaise);

  const items = results.map((r, i) => ({
    index: i + 1,
    id: r.transaction?.id || `attack_conc_${i + 1}_${testAgentId}`,
    decision: r.decision,
    amount: unitAmount,
    reason: r.reason || (r.decision === 'allowed' ? 'Authorized & Atomic Reserve Lock Acquired' : 'Token Bucket Rate Limit / Reserve Exhausted')
  }));

  return NextResponse.json({
    requestsCount: N,
    allowed,
    blocked,
    totalReserved: finalState.heldPaise,
    totalFinancialEffect,
    overspend,
    testAgentId,
    items
  });
}
