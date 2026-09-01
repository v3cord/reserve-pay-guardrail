import crypto from 'crypto';
import { AuthRole, AuthContext, AuthenticateRequestOptions, AuthResult } from './types';
import { recordSecurityAudit } from './store';

export const DUMMY_VALUES_SET = new Set([
  'rzp_test_dummy_key',
  'dummy_secret',
  'whsec_test_secret',
  'dummy_key',
  'your_key_id',
  'your_key_secret',
  'placeholder',
  'agent_key_placeholder',
  'admin_key_placeholder',
  'jwt_secret_placeholder',
]);

const DEV_DEFAULT_AGENT_KEY = 'agent_api_key_default';
const DEV_DEFAULT_ADMIN_KEY = 'admin_api_key_default';
const DEV_DEFAULT_AGENT_SECRET = 'agent_hmac_secret_default';
const DEV_DEFAULT_JWT_SECRET = 'guardrail_jwt_secret_default_key_12345';

export function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('Fatal Security Error: Missing JWT_SECRET in production environment.');
    }
    return DEV_DEFAULT_JWT_SECRET;
  }
  return secret;
}

export function getAgentSecret(): string {
  const secret = process.env.AGENT_HMAC_SECRET || process.env.AGENT_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('Fatal Security Error: Missing AGENT_HMAC_SECRET in production environment.');
    }
    return DEV_DEFAULT_AGENT_SECRET;
  }
  return secret;
}

export function getAgentApiKey(): string {
  const key = process.env.AGENT_API_KEY;
  if (!key) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('Fatal Security Error: Missing AGENT_API_KEY in production environment.');
    }
    return DEV_DEFAULT_AGENT_KEY;
  }
  return key;
}

export function getAdminApiKey(): string {
  const key = process.env.ADMIN_API_KEY;
  if (!key) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('Fatal Security Error: Missing ADMIN_API_KEY in production environment.');
    }
    return DEV_DEFAULT_ADMIN_KEY;
  }
  return key;
}

export function validateServerBootstrap(forceCheckProduction?: boolean): void {
  const isProduction = forceCheckProduction !== undefined ? forceCheckProduction : process.env.NODE_ENV === 'production';
  if (isProduction) {
    getAdminApiKey();
    getJwtSecret();
  }
}

export function generateJwt(payload: Record<string, unknown>, expiresInSeconds = 1800): string {
  const secret = getJwtSecret();
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const fullPayload = {
    ...payload,
    iat: now,
    exp: now + expiresInSeconds,
  };

  const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify(fullPayload)).toString('base64url');
  const data = `${headerB64}.${payloadB64}`;
  const signature = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${signature}`;
}

export const signJwt = generateJwt;

export function verifyJwt(token: string): Record<string, any> | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [headerB64, payloadB64, signatureB64] = parts;
    const secret = getJwtSecret();
    const expectedSig = crypto.createHmac('sha256', secret).update(`${headerB64}.${payloadB64}`).digest('base64url');

    if (
      signatureB64.length !== expectedSig.length ||
      !crypto.timingSafeEqual(Buffer.from(signatureB64, 'utf8'), Buffer.from(expectedSig, 'utf8'))
    ) {
      return null;
    }

    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

export function validateApiKey(apiKey: string): AuthContext | null {
  if (!apiKey || typeof apiKey !== 'string') return null;

  const cleanKey = apiKey.trim();
  const adminKey = getAdminApiKey();
  const agentKey = getAgentApiKey();

  if (
    cleanKey.length === adminKey.length &&
    crypto.timingSafeEqual(Buffer.from(cleanKey, 'utf8'), Buffer.from(adminKey, 'utf8'))
  ) {
    return {
      role: 'admin',
      identity: 'admin_apikey_client',
      authMethod: 'api_key',
    };
  }

  if (
    cleanKey.length === agentKey.length &&
    crypto.timingSafeEqual(Buffer.from(cleanKey, 'utf8'), Buffer.from(agentKey, 'utf8'))
  ) {
    return {
      role: 'agent',
      identity: 'agent_apikey_client',
      agentId: 'default_agent',
      authMethod: 'api_key',
    };
  }

  return null;
}

export function verifyPayloadSignature(
  rawBody: string,
  signatureHeader: string,
  secret?: string
): boolean {
  if (!signatureHeader) return false;
  const hmacSecret = secret || getAgentSecret();

  const expectedSignatureHex = crypto
    .createHmac('sha256', hmacSecret)
    .update(rawBody, 'utf8')
    .digest('hex');

  const cleanSig = signatureHeader.trim().toLowerCase();
  const cleanExpected = expectedSignatureHex.trim().toLowerCase();

  if (cleanSig.length !== cleanExpected.length) return false;

  return crypto.timingSafeEqual(
    Buffer.from(cleanSig, 'utf8'),
    Buffer.from(cleanExpected, 'utf8')
  );
}

export function getClientIp(request: Request): string {
  return (
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip') ||
    '127.0.0.1'
  );
}

export function createDemoSessionToken(agentId = 'default_agent', role: AuthRole = 'admin'): string {
  return generateJwt({
    sub: 'demo_user',
    role,
    agentId,
  }, 1800);
}

export function getCookieValue(request: Request, name: string): string | null {
  const cookieHeader = request.headers.get('cookie');
  if (!cookieHeader) return null;
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

export async function authenticateRequest(
  request: Request,
  optionsInput: AuthenticateRequestOptions | AuthRole[] = {}
): Promise<AuthResult> {
  const options: AuthenticateRequestOptions = Array.isArray(optionsInput)
    ? { allowedRoles: optionsInput }
    : optionsInput;

  const url = new URL(request.url);
  const endpoint = url.pathname;
  const method = request.method;
  const ip = getClientIp(request);

  const apiKeyHeader = request.headers.get('x-api-key');
  const authHeader = request.headers.get('authorization');
  const signatureHeader = request.headers.get('x-signature');
  const sessionCookie = getCookieValue(request, 'reservepay_demo_session') || getCookieValue(request, 'admin_demo_session');

  let authContext: AuthContext | null = null;

  if (apiKeyHeader) {
    authContext = validateApiKey(apiKeyHeader);
    if (!authContext) {
      await recordSecurityAudit({
        eventType: 'UNAUTHORIZED_ACCESS',
        endpoint,
        method,
        details: 'Invalid X-API-Key provided.',
        ip,
      });
      return {
        authenticated: false,
        error: 'Unauthorized: Invalid API Key',
        statusCode: 401,
      };
    }
  } else if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7).trim();
    const payload = verifyJwt(token);
    if (!payload) {
      await recordSecurityAudit({
        eventType: 'UNAUTHORIZED_ACCESS',
        endpoint,
        method,
        details: 'Invalid or expired Bearer JWT token.',
        ip,
      });
      return {
        authenticated: false,
        error: 'Unauthorized: Invalid or expired Bearer token',
        statusCode: 401,
      };
    }
    authContext = {
      role: payload.role as AuthRole,
      identity: payload.sub as string,
      agentId: payload.agentId as string | undefined,
      authMethod: 'jwt',
    };
  } else if (sessionCookie) {
    const payload = verifyJwt(sessionCookie);
    if (payload) {
      authContext = {
        role: payload.role as AuthRole,
        identity: payload.sub as string,
        agentId: payload.agentId as string | undefined,
        authMethod: 'demo_session',
      };
    }
  }

  if (!authContext) {
    await recordSecurityAudit({
      eventType: 'UNAUTHORIZED_ACCESS',
      endpoint,
      method,
      details: 'Missing authentication credentials.',
      ip,
    });
    return {
      authenticated: false,
      error: 'Unauthorized: Authentication required via API key, Bearer token, or session cookie',
      statusCode: 401,
    };
  }

  if (signatureHeader || options.requireSignature) {
    if (!signatureHeader) {
      await recordSecurityAudit({
        eventType: 'SIGNATURE_VERIFICATION_FAILED',
        role: authContext.role,
        identity: authContext.identity,
        endpoint,
        method,
        details: 'Required X-Signature header is missing.',
        ip,
      });
      return {
        authenticated: false,
        error: 'Unauthorized: Missing required X-Signature header',
        statusCode: 401,
      };
    }

    const bodyToVerify = options.rawBody ?? '';
    const isSignatureValid = verifyPayloadSignature(bodyToVerify, signatureHeader);

    if (!isSignatureValid) {
      await recordSecurityAudit({
        eventType: 'SIGNATURE_VERIFICATION_FAILED',
        role: authContext.role,
        identity: authContext.identity,
        endpoint,
        method,
        details: 'HMAC-SHA256 signature verification failed for payload.',
        ip,
      });
      return {
        authenticated: false,
        error: 'Unauthorized: Invalid request signature (X-Signature)',
        statusCode: 401,
      };
    }
  }

  if (options.allowedRoles && options.allowedRoles.length > 0) {
    if (!options.allowedRoles.includes(authContext.role)) {
      await recordSecurityAudit({
        eventType: 'FORBIDDEN_PRIVILEGE_ESCALATION',
        role: authContext.role,
        identity: authContext.identity,
        endpoint,
        method,
        details: `Role '${authContext.role}' is not authorized.`,
        ip,
      });
      return {
        authenticated: false,
        context: authContext,
        error: `Forbidden: Role '${authContext.role}' does not have permission.`,
        statusCode: 403,
      };
    }
  }

  return {
    authenticated: true,
    context: authContext,
  };
}
