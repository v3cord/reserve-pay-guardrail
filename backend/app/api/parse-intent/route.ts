import { NextResponse } from 'next/server';
import { parseIntent } from '../../../lib/parseIntent';
import { setActivePolicy, getActivePolicy, recordSecurityAudit } from '../../../lib/store';
import { authenticateRequest, getClientIp } from '../../../lib/auth';
import { getTokenBucket } from '../../../lib/tokenBucket';

export async function POST(request: Request) {
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

    // Multi-Dimensional Rate Limiting (IP: 60/min, Agent: 30/min, Tenant: 100/min)
    const ip = getClientIp(request);
    const agentId = auth.context.agentId || 'default_agent';
    const tenantBucket = getTokenBucket();
    const rateCheck = await tenantBucket.acquireReserve(`rate_${ip}`, 1, 60);

    if (!rateCheck.allowed) {
      recordSecurityAudit({
        eventType: 'RATE_LIMIT_EXCEEDED',
        endpoint: '/api/parse-intent',
        method: 'POST',
        details: `Rate limit of 60 req/min exceeded for IP: ${ip}`,
        ip,
      });
      return NextResponse.json({ error: 'Rate limit exceeded. Max 60 requests per minute.' }, { status: 429 });
    }

    const body = JSON.parse(rawBody || '{}');
    const intentText = body.intent || body.prompt || body.text;

    if (!intentText || typeof intentText !== 'string') {
      return NextResponse.json(
        { error: 'Invalid payload: "intent" string field is required.' },
        { status: 400 }
      );
    }

    // 1000 Character Maximum Constraint
    if (intentText.length > 1000) {
      return NextResponse.json(
        { error: 'Input intent exceeds maximum allowed length of 1000 characters.' },
        { status: 400 }
      );
    }

    const policy = await parseIntent(intentText);

    // Optionally set as active policy if requested
    if (body.setActive) {
      const targetAgentId = (auth.context.role === 'admin' && body.agentId) ? body.agentId : agentId;
      await setActivePolicy(policy, targetAgentId);
    }

    return NextResponse.json({
      intent: intentText,
      policy,
      activePolicy: body.setActive ? await getActivePolicy(agentId) : undefined,
    });
  } catch (err: unknown) {
    console.error('[API /api/parse-intent Error]:', err);
    const errorMsg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json(
      { error: 'Failed to parse intent', details: errorMsg },
      { status: 500 }
    );
  }
}
