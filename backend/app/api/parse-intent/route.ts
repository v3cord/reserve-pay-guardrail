import { NextResponse } from 'next/server';
import { parseIntent } from '@/lib/parseIntent';
import { setActivePolicy } from '@/lib/store';
import { authenticateRequest } from '@/lib/auth';

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
    const intentText = body.intent || body.prompt || body.text;

    if (!intentText || typeof intentText !== 'string') {
      return NextResponse.json(
        { error: 'Invalid payload: "intent" string field is required.' },
        { status: 400 }
      );
    }

    const policy = await parseIntent(intentText);

    // Optionally set as active policy if requested or return the extracted policy
    if (body.setActive) {
      const agentId = body.agentId || 'default_agent';
      await setActivePolicy(policy, agentId);
    }

    return NextResponse.json({
      intent: intentText,
      policy,
    });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json(
      { error: 'Failed to parse intent', details: errorMsg },
      { status: 500 }
    );
  }
}

