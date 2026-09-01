import { NextResponse } from 'next/server';
import { getReserveState, setReserveState, verifyLedgerIntegrity, getLedgerEvents } from '../../../lib/store';
import { authenticateRequest } from '../../../lib/auth';

export async function GET(request: Request) {
  const auth = await authenticateRequest(request, {
    allowedRoles: ['admin', 'service', 'agent', 'demo_user'],
  });

  if (!auth.authenticated || !auth.context) {
    return NextResponse.json(
      { error: auth.error || 'Unauthorized' },
      { status: auth.statusCode || 401 }
    );
  }

  const url = request?.url ? new URL(request.url) : null;
  const agentId = url?.searchParams.get('agentId') || auth.context?.agentId || 'default_agent';
  const sessionId = url?.searchParams.get('sessionId') || undefined;

  const state = await getReserveState(agentId, sessionId);
  const ledgerIntegrity = await verifyLedgerIntegrity(agentId);
  const ledgerEvents = await getLedgerEvents(agentId, 50);

  return NextResponse.json({
    ...state,
    ledgerEvents,
    ledgerIntegrity,
  });
}

export async function POST(request: Request) {
  try {
    const rawBody = await request.text();
    const auth = await authenticateRequest(request, {
      allowedRoles: ['admin', 'service', 'demo_user'],
      rawBody,
    });

    if (!auth.authenticated || !auth.context) {
      return NextResponse.json(
        { error: auth.error || 'Unauthorized' },
        { status: auth.statusCode || 401 }
      );
    }

    const body = JSON.parse(rawBody || '{}');
    const agentId = body.agentId || auth.context?.agentId || 'default_agent';

    if (typeof body.totalPaise === 'number' || typeof body.total === 'number') {
      const totalPaise = typeof body.totalPaise === 'number' ? body.totalPaise : Math.round(body.total * 100);
      const heldPaise = typeof body.heldPaise === 'number' ? body.heldPaise : 0;
      const settledPaise = typeof body.settledPaise === 'number' ? body.settledPaise : 0;

      const newState = await setReserveState(
        {
          totalPaise,
          heldPaise,
          settledPaise,
        },
        agentId
      );

      return NextResponse.json({
        message: 'Reserve updated successfully',
        ...newState,
      });
    }

    return NextResponse.json({ error: 'Invalid payload: totalPaise or total is required.' }, { status: 400 });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: 'Failed to update reserve', details: errorMsg }, { status: 400 });
  }
}
