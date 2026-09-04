import { describe, it, expect } from 'vitest';
import { sanitizePolicy } from '../lib/parseIntent';

describe('Merchant Mode Validation', () => {
  it('accepts allowlist', () => {
    const policy = sanitizePolicy({ merchantMode: 'allowlist', merchantMode: 'allowlist', allowedMerchants: ['Swiggy'] });
    expect(policy.merchantMode).toBe('allowlist');
  });

  it('accepts unrestricted', () => {
    const policy = sanitizePolicy({ merchantMode: 'unrestricted', merchantMode: 'unrestricted', allowedMerchants: [] });
    expect(policy.merchantMode).toBe('unrestricted');
  });

  it('rejects random mode', () => {
    expect(() => sanitizePolicy({ merchantMode: 'random' })).toThrow(/INVALID POLICY/);
  });

  it('rejects ALLOWLIST (case sensitive)', () => {
    expect(() => sanitizePolicy({ merchantMode: 'ALLOWLIST' })).toThrow(/INVALID POLICY/);
  });

  it('rejects null mode', () => {
    expect(() => sanitizePolicy({ merchantMode: null })).toThrow(/INVALID POLICY/);
  });

  it('rejects number mode', () => {
    expect(() => sanitizePolicy({ merchantMode: 123 })).toThrow(/INVALID POLICY/);
  });

  it('rejects malformed object mode', () => {
    expect(() => sanitizePolicy({ merchantMode: { mode: 'allowlist' } })).toThrow(/INVALID POLICY/);
  });

  it('rejects missing merchantMode', () => {
    expect(() => sanitizePolicy({})).toThrow(/INVALID POLICY/);
  });
});
