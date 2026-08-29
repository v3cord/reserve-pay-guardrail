import { NextResponse } from 'next/server';
import { releaseReservation } from '@/lib/store';
import { authenticateRequest } from '@/lib/auth';

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

    const body = JSON.parse(rawBody);
    const { txId, orderId, reason, agentId } = body;
    const identifier = txId || orderId;

    if (!identifier) {
      return NextResponse.json(
        { error: 'Invalid payload: txId or orderId is required.' },
        { status: 400 }
      );
    }

    const targetAgentId = agentId || auth.context?.agentId || 'default_agent';
    const result = await releaseReservation(identifier, reason || 'Checkout modal dismissed / payment abandoned', targetAgentId);

    return NextResponse.json({
      status: result.success ? 'success' : 'error',
      ...result,
    });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json(
      { error: 'Failed to release reservation', details: errorMsg },
      { status: 400 }
    );
  }
}

