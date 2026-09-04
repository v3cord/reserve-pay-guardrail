import { NextResponse } from 'next/server';
import { getActivePolicy, setActivePolicy } from '../../../lib/store';
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
  const policy = await getActivePolicy(agentId);
  return NextResponse.json({ policy });
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
    const agentId = auth.context?.agentId || 'default_agent';
    const policy = await setActivePolicy(body.policy || body, agentId);
    return NextResponse.json({ message: 'Policy updated successfully', policy });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: 'Failed to set policy', details: errorMsg }, { status: 400 });
  }
}
