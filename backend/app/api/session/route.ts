import { NextRequest, NextResponse } from 'next/server';
import { createDemoSessionToken, authenticateRequest } from '../../../lib/auth';

export async function POST(req: NextRequest) {
  try {
    const token = createDemoSessionToken('default_agent', 'demo_user');

    const res = NextResponse.json({
      success: true,
      role: 'demo_user',
      identity: 'demo_user',
      agentId: 'default_agent',
      tenantId: 'demo_tenant',
      expiresIn: 1800,
    });

    const isSecure = process.env.NODE_ENV === 'production';

    res.cookies.set('reservepay_demo_session', token, {
      httpOnly: true,
      secure: isSecure,
      sameSite: 'lax',
      path: '/',
      maxAge: 1800,
    });

    return res;
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: 'Failed to create demo session', details: errorMsg }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  const auth = await authenticateRequest(req);
  if (!auth.authenticated || !auth.context) {
    return NextResponse.json({ authenticated: false }, { status: 401 });
  }

  return NextResponse.json({
    authenticated: true,
    identity: auth.context.identity,
    role: auth.context.role,
    agentId: auth.context.agentId || 'default_agent',
    authMethod: auth.context.authMethod,
  });
}

export async function DELETE() {
  const res = NextResponse.json({ success: true, message: 'Logged out of demo session' });
  res.cookies.set('reservepay_demo_session', '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
  return res;
}
