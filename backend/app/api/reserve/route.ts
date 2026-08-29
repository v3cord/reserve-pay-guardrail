import { NextResponse } from 'next/server';
import { getReserveState, setReserveState, verifyLedgerIntegrity } from '@/lib/store';
import { authenticateRequest } from '@/lib/auth';

export async function GET(request: Request) {
  const auth = await authenticateRequest(request, {
    allowedRoles: ['ADMIN_ROLE', 'AGENT_ROLE'],
  });

  if (!auth.authenticated) {
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

  return NextResponse.json({
    ...state,
    ledgerIntegrity,
  });
}

export async function POST(request: Request) {
  try {
    const rawBody = await request.text();
    const auth = await authenticateRequest(request, {
      allowedRoles: ['ADMIN_ROLE'],
      rawBody,
    });

    if (!auth.authenticated) {
      return NextResponse.json(
        { error: auth.error || 'Unauthorized' },
        { status: auth.statusCode || 401 }
      );
    }

    const body = JSON.parse(rawBody);
    const agentId = body.agentId || 'default_agent';

    if (typeof body.totalPaise === 'number' || typeof body.total === 'number') {
      const totalPaise = typeof body.totalPaise === 'number' ? body.totalPaise : body.total;
      const heldPaise = typeof body.heldPaise === 'number' ? body.heldPaise : 0;
      const settledPaise = typeof body.settledPaise === 'number'
        ? body.settledPaise
        : (typeof body.remaining === 'number' && typeof body.totalPaise !== 'number'
            ? Math.max(0, totalPaise - body.remaining - heldPaise)
            : 0);

      const currentState = await getReserveState(agentId);
      const newState = await setReserveState(
        {
          totalPaise,
          heldPaise,
          settledPaise,
          transactions: body.resetTransactions ? [] : currentState.transactions,
        },
        agentId
      );
      return NextResponse.json({
        message: 'Reserve state updated',
        reserveState: {
          ...newState,
          ledgerIntegrity: await verifyLedgerIntegrity(agentId),
        },
      });
    }
    return NextResponse.json({ error: 'Invalid body: totalPaise or total (number) required.' }, { status: 400 });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json(
      { error: 'Failed to update reserve state', details: errorMsg },
      { status: 400 }
    );
  }
}

