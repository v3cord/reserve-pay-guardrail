import crypto from 'crypto';
import { AuthRole, AuthContext } from './types';
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

// Non-production test defaults (used only when NODE_ENV !== 'production')
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

/**
 * Fail-Closed Server Environment Validation.
 * Throws fatal errors in production if required security variables are missing or use dummy values.
 */
export function validateServerBootstrap(forceCheckProduction?: boolean): void {
  const isProduction = forceCheckProduction !== undefined ? forceCheckProduction : process.env.NODE_ENV === 'production';
  if (!isProduction) return;

  const requiredKeys: Array<{ name: string; val: string | undefined }> = [
    { name: 'RAZORPAY_KEY_ID', val: process.env.RAZORPAY_KEY_ID },
    { name: 'RAZORPAY_KEY_SECRET', val: process.env.RAZORPAY_KEY_SECRET },
    { name: 'RAZORPAY_WEBHOOK_SECRET', val: process.env.RAZORPAY_WEBHOOK_SECRET },
    { name: 'ADMIN_API_KEY', val: process.env.ADMIN_API_KEY },
    { name: 'AGENT_API_KEY', val: process.env.AGENT_API_KEY },
    { name: 'JWT_SECRET', val: process.env.JWT_SECRET },
    { name: 'AGENT_HMAC_SECRET', val: process.env.AGENT_HMAC_SECRET || process.env.AGENT_SECRET },
  ];

  for (const { name, val } of requiredKeys) {
    if (!val || val.trim().length === 0) {
      const msg = `Fatal Security Error: Missing required environment variable '${name}' in production.`;
      recordSecurityAudit({
        eventType: 'SECRET_VALIDATION_FAILURE',
        endpoint: 'SYSTEM_BOOTSTRAP',
        method: 'BOOTSTRAP',
        details: msg,
      });
      throw new Error(msg);
    }
    if (DUMMY_VALUES_SET.has(val.trim().toLowerCase())) {
      const msg = `Fatal Security Error: Insecure dummy secret detected for '${name}' in production.`;
      recordSecurityAudit({
        eventType: 'SECRET_VALIDATION_FAILURE',
        endpoint: 'SYSTEM_BOOTSTRAP',
        method: 'BOOTSTRAP',
        details: msg,
      });
      throw new Error(msg);
    }
  }
}

// Base64URL encoding/decoding utilities for JWT
function base64UrlEncode(str: string): string {
  return Buffer.from(str)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function base64UrlDecode(str: string): string {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) {
    base64 += '=';
  }
  return Buffer.from(base64, 'base64').toString('utf8');
}

/**
 * Signs a JWT token with HMAC-SHA256.
 */
export function signJwt(
  payload: { role: AuthRole; sub?: string; agentId?: string; [key: string]: unknown },
  expiresInSeconds = 3600
): string {
  const secret = getJwtSecret();
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const fullPayload = {
    ...payload,
    sub: payload.sub || (payload.role === 'ADMIN_ROLE' ? 'admin_user' : payload.agentId || 'agent_007'),
    iat: now,
    exp: now + expiresInSeconds,
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(fullPayload));
  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

/**
 * Verifies and decodes a JWT token. Returns null if invalid or expired.
 */
export function verifyJwt(token: string): { role: AuthRole; sub: string; agentId?: string; [key: string]: unknown } | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [headerB64, payloadB64, signatureB64] = parts;

    const secret = getJwtSecret();
    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(`${headerB64}.${payloadB64}`)
      .digest('base64')
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');

    if (signatureB64.length !== expectedSignature.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(signatureB64, 'utf8'), Buffer.from(expectedSignature, 'utf8'))) {
      return null;
    }

    const payloadJson = base64UrlDecode(payloadB64);
    const payload = JSON.parse(payloadJson);

    // Expiration check
    if (payload.exp && typeof payload.exp === 'number') {
      const now = Math.floor(Date.now() / 1000);
      if (now > payload.exp) return null;
    }

    if (!payload.role || (payload.role !== 'ADMIN_ROLE' && payload.role !== 'AGENT_ROLE' && payload.role !== 'WEBHOOK_ROLE')) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

/**
 * Validates an API key and maps to its role and identity.
 */
export function validateApiKey(apiKey: string): AuthContext | null {
  if (!apiKey || typeof apiKey !== 'string') return null;

  const cleanKey = apiKey.trim();
  const adminKey = getAdminApiKey();
  const agentKey = getAgentApiKey();

  // Admin Key check with timing safe equality
  if (
    cleanKey.length === adminKey.length &&
    crypto.timingSafeEqual(Buffer.from(cleanKey, 'utf8'), Buffer.from(adminKey, 'utf8'))
  ) {
    return {
      role: 'ADMIN_ROLE',
      identity: 'admin_apikey_client',
      authMethod: 'api_key',
    };
  }

  // Agent Key check with timing safe equality
  if (
    cleanKey.length === agentKey.length &&
    crypto.timingSafeEqual(Buffer.from(cleanKey, 'utf8'), Buffer.from(agentKey, 'utf8'))
  ) {
    return {
      role: 'AGENT_ROLE',
      identity: 'agent_apikey_client',
      agentId: 'default_agent',
      authMethod: 'api_key',
    };
  }

  return null;
}

/**
 * Verifies an HMAC-SHA256 payload signature for X-Signature header.
 */
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

/**
 * Helper to extract client IP for auditing.
 */
export function getClientIp(request: Request): string {
  return (
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip') ||
    '127.0.0.1'
  );
}

export interface AuthenticateRequestOptions {
  allowedRoles?: AuthRole[];
  rawBody?: string;
  requireSignature?: boolean;
}

export interface AuthResult {
  authenticated: boolean;
  context?: AuthContext;
  error?: string;
  statusCode?: number;
}

/**
 * Authenticates an incoming Next.js Request via X-API-Key or Bearer <JWT>,
 * optionally verifies HMAC payload signature (X-Signature), and validates RBAC permissions.
 */
export async function authenticateRequest(
  request: Request,
  options: AuthenticateRequestOptions = {}
): Promise<AuthResult> {
  const url = new URL(request.url);
  const endpoint = url.pathname;
  const method = request.method;
  const ip = getClientIp(request);

  const apiKeyHeader = request.headers.get('x-api-key');
  const authHeader = request.headers.get('authorization');
  const signatureHeader = request.headers.get('x-signature');

  let authContext: AuthContext | null = null;

  // 1. Check API Key
  if (apiKeyHeader) {
    authContext = validateApiKey(apiKeyHeader);
    if (!authContext) {
      recordSecurityAudit({
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
  }
  // 2. Check JWT Bearer Token
  else if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7).trim();
    const payload = verifyJwt(token);
    if (!payload) {
      recordSecurityAudit({
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
      role: payload.role,
      identity: payload.sub,
      agentId: payload.agentId,
      authMethod: 'jwt',
    };
  } else {
    // Missing credentials
    recordSecurityAudit({
      eventType: 'UNAUTHORIZED_ACCESS',
      endpoint,
      method,
      details: 'Missing authentication credentials (X-API-Key or Authorization: Bearer).',
      ip,
    });
    return {
      authenticated: false,
      error: 'Unauthorized: Authentication required via X-API-Key or Authorization Bearer header',
      statusCode: 401,
    };
  }

  // 3. Optional / Required HMAC-SHA256 Payload Signature Verification
  if (signatureHeader || options.requireSignature) {
    if (!signatureHeader) {
      recordSecurityAudit({
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
      recordSecurityAudit({
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

  // 4. Role-Based Access Control (RBAC) Check
  if (options.allowedRoles && options.allowedRoles.length > 0) {
    if (!options.allowedRoles.includes(authContext.role)) {
      recordSecurityAudit({
        eventType: 'FORBIDDEN_PRIVILEGE_ESCALATION',
        role: authContext.role,
        identity: authContext.identity,
        endpoint,
        method,
        details: `Role '${authContext.role}' is not authorized to access endpoint requiring [${options.allowedRoles.join(', ')}].`,
        ip,
      });
      return {
        authenticated: false,
        context: authContext,
        error: `Forbidden: Role '${authContext.role}' does not have permission to perform this action.`,
        statusCode: 403,
      };
    }
  }

  return {
    authenticated: true,
    context: authContext,
  };
}
