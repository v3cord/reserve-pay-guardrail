import { NextRequest, NextResponse } from 'next/server';
import { runReconciliation } from '../../../lib/reconciler';
import { authenticateRequest } from '../../../lib/auth';

export async function POST(req: NextRequest) {
  const auth = await authenticateRequest(req, ['admin', 'service']);
  if (!auth.authenticated) {
    return NextResponse.json({ error: auth.error || 'Unauthorized' }, { status: 401 });
  }

  try {
    const url = new URL(req.url);
    const agentId = url.searchParams.get('agentId') || auth.identity || 'default_agent';
    const summary = await runReconciliation(agentId);

    return NextResponse.json({
      success: true,
      timestamp: new Date().toISOString(),
      summary,
    });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: 'Reconciliation failed', details: errorMsg }, { status: 500 });
  }
}
