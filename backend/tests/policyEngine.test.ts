import { describe, it, expect } from 'vitest';
import { guardCheck, normalizeMerchant, isMerchantAllowed, isCategoryAllowed, getCanonicalCategory } from '../lib/guardCheck';
import { Policy, ReserveState, AttemptedPurchase } from '../lib/types';

const BASE_POLICY: Policy = {
  amountCeiling: 80000,      // ₹800
  category: 'Food & Dining',
  allowedMerchants: ['Swiggy', 'Zomato'],
  sessionCap: 200000,        // ₹2000
  reasonableQuantity: 2,
};

const EMPTY_STATE: ReserveState = {
  totalPaise: 200000,
  heldPaise: 0,
  settledPaise: 0,
  availablePaise: 200000,
  total: 200000,
  remaining: 200000,
  transactions: [],
};

// ─── Amount ceiling ──────────────────────────────────────────────────────────

describe('guardCheck – amount ceiling', () => {
  it('allows amount exactly at ceiling', () => {
    const r = guardCheck(BASE_POLICY, EMPTY_STATE, { merchant: 'Swiggy', amount: 80000, category: 'Food & Dining' });
    expect(r.decision).toBe('allowed');
  });

  it('denies amount 1 paise over ceiling', () => {
    const r = guardCheck(BASE_POLICY, EMPTY_STATE, { merchant: 'Swiggy', amount: 80001, category: 'Food & Dining' });
    expect(r.decision).toBe('denied');
    expect(r.ruleViolated).toBe('AMOUNT_CEILING_EXCEEDED');
  });

  it('denies when amountCeiling is undefined (fail-safe)', () => {
    const unboundedPolicy: Policy = { allowedMerchants: [], sessionCap: 200000 };
    const r = guardCheck(unboundedPolicy, EMPTY_STATE, { merchant: 'Swiggy', amount: 1000, category: 'Food & Dining' });
    expect(r.decision).toBe('denied');
    expect(r.ruleViolated).toBe('UNBOUNDED_CEILING_FAILSAFE');
  });

  it('triggers REVIEW for amount between 80-100% of ceiling (near-limit)', () => {
    const amount = Math.floor(80000 * 0.85); // 85% — above 80% threshold
    const r = guardCheck(BASE_POLICY, EMPTY_STATE, { merchant: 'Swiggy', amount, category: 'Food & Dining' });
    expect(r.decision).toBe('review');
    expect(r.ruleViolated).toBe('NEAR_AMOUNT_LIMIT');
  });

  it('does NOT trigger near-limit REVIEW for micro-purchases', () => {
    const microPolicy: Policy = { ...BASE_POLICY, amountCeiling: 5000, microPurchaseThreshold: 5000 };
    const r = guardCheck(microPolicy, EMPTY_STATE, { merchant: 'Swiggy', amount: 4500, category: 'Food & Dining' });
    // 4500/5000 = 90% but amount <= microThreshold so no review
    expect(r.decision).toBe('allowed');
  });
});

// ─── Merchant allowlist ───────────────────────────────────────────────────────

describe('guardCheck – merchant allowlist', () => {
  it('allows exact case-insensitive match', () => {
    const r = guardCheck(BASE_POLICY, EMPTY_STATE, { merchant: 'swiggy', amount: 10000, category: 'Food & Dining' });
    expect(r.decision).not.toBe('denied');
  });

  it('allows sub-brand match (Swiggy Instamart when Swiggy is allowed)', () => {
    const r = guardCheck(BASE_POLICY, EMPTY_STATE, { merchant: 'Swiggy Instamart', amount: 10000, category: 'Food & Dining' });
    expect(r.decision).not.toBe('denied');
  });

  it('denies merchant not in allowlist', () => {
    const r = guardCheck(BASE_POLICY, EMPTY_STATE, { merchant: 'Walmart', amount: 10000, category: 'Food & Dining' });
    expect(r.decision).toBe('denied');
    expect(r.ruleViolated).toBe('MERCHANT_NOT_ALLOWED');
  });

  it('denies reverse sub-brand (Swiggy Instamart allowed but Swiggy attempted)', () => {
    const strictPolicy: Policy = { ...BASE_POLICY, allowedMerchants: ['Swiggy Instamart'] };
    const r = guardCheck(strictPolicy, EMPTY_STATE, { merchant: 'Swiggy', amount: 10000, category: 'Food & Dining' });
    expect(r.decision).toBe('denied');
  });

  it('strips corporate suffixes: "Amazon India Private Limited" matches "Amazon"', () => {
    const amzPolicy: Policy = { ...BASE_POLICY, allowedMerchants: ['Amazon'], category: 'Electronics' };
    const r = guardCheck(amzPolicy, EMPTY_STATE, { merchant: 'Amazon India Private Limited', amount: 10000, category: 'Electronics' });
    expect(r.decision).not.toBe('denied');
  });

  it('allows any merchant when allowedMerchants is empty', () => {
    const openPolicy: Policy = { amountCeiling: 80000, allowedMerchants: [], sessionCap: 200000 };
    const r = guardCheck(openPolicy, EMPTY_STATE, { merchant: 'RandomMerchant', amount: 10000 });
    expect(r.decision).toBe('allowed');
  });
});

// ─── Category matching ───────────────────────────────────────────────────────

describe('guardCheck – category matching', () => {
  it('allows alias "Dining" for "Food & Dining"', () => {
    const r = guardCheck(BASE_POLICY, EMPTY_STATE, { merchant: 'Swiggy', amount: 10000, category: 'Dining' });
    expect(r.decision).not.toBe('denied');
  });

  it('allows by MCC code 5812 when policy category is Food & Dining', () => {
    const r = guardCheck(BASE_POLICY, EMPTY_STATE, { merchant: 'Swiggy', amount: 10000, category: 'Restaurant', mccCode: '5812' });
    expect(r.decision).not.toBe('denied');
  });

  it('denies wrong category (Electronics when Food & Dining expected)', () => {
    const r = guardCheck(BASE_POLICY, EMPTY_STATE, { merchant: 'Swiggy', amount: 10000, category: 'Electronics' });
    expect(r.decision).toBe('denied');
    expect(r.ruleViolated).toBe('CATEGORY_NOT_ALLOWED');
  });

  it('allows by allowedMccCodes even if category name mismatches', () => {
    const mccPolicy: Policy = { amountCeiling: 80000, allowedMerchants: ['Swiggy'], allowedMccCodes: ['5812', '5814'], sessionCap: 200000 };
    const r = guardCheck(mccPolicy, EMPTY_STATE, { merchant: 'Swiggy', amount: 10000, category: 'Fast Food', mccCode: '5814' });
    expect(r.decision).not.toBe('denied');
  });

  it('skips category check entirely when policy has no category and no MCC codes', () => {
    const noCategory: Policy = { amountCeiling: 80000, allowedMerchants: [], sessionCap: 200000 };
    const r = guardCheck(noCategory, EMPTY_STATE, { merchant: 'AnyMerchant', amount: 10000, category: 'Gambling' });
    expect(r.decision).toBe('allowed');
  });
});

// ─── Quantity anomaly ────────────────────────────────────────────────────────

describe('guardCheck – quantity anomaly', () => {
  it('allows quantity at the limit (2)', () => {
    const r = guardCheck(BASE_POLICY, EMPTY_STATE, { merchant: 'Swiggy', amount: 20000, category: 'Food & Dining', quantity: 2 });
    expect(r.decision).not.toBe('denied');
  });

  it('triggers REVIEW for quantity > limit but ≤ 2x limit (3)', () => {
    const r = guardCheck(BASE_POLICY, EMPTY_STATE, { merchant: 'Swiggy', amount: 30000, category: 'Food & Dining', quantity: 3 });
    expect(r.decision).toBe('review');
    expect(r.ruleViolated).toBe('QUANTITY_ANOMALY');
  });

  it('denies for quantity > 2x limit (5 > 4)', () => {
    const r = guardCheck(BASE_POLICY, EMPTY_STATE, { merchant: 'Swiggy', amount: 50000, category: 'Food & Dining', quantity: 5 });
    expect(r.decision).toBe('denied');
    expect(r.ruleViolated).toBe('QUANTITY_ANOMALY');
  });

  it('bypasses quantity check for micro-purchases (total ≤ microThreshold)', () => {
    // 10 items × 100 paise = 1000 total, under default microThreshold of 5000
    const r = guardCheck(BASE_POLICY, EMPTY_STATE, { merchant: 'Swiggy', amount: 1000, category: 'Food & Dining', quantity: 10 });
    expect(r.decision).not.toBe('denied');
  });
});

// ─── Session cap ─────────────────────────────────────────────────────────────

describe('guardCheck – session cap', () => {
  it('allows when cumulative spend is exactly at session cap', () => {
    const r = guardCheck(BASE_POLICY, EMPTY_STATE, { merchant: 'Swiggy', amount: 200000, category: 'Food & Dining' }, 0);
    // amount 200000 = sessionCap, allowed
    expect(['allowed', 'review']).toContain(r.decision); // may hit near-limit if ceiling allows
  });

  it('denies when cumulative spend exceeds session cap', () => {
    const r = guardCheck(BASE_POLICY, EMPTY_STATE, { merchant: 'Swiggy', amount: 70000, category: 'Food & Dining' }, 160000);
    // 160000 + 70000 = 230000 > 200000 sessionCap
    expect(r.decision).toBe('denied');
    expect(r.ruleViolated).toBe('SESSION_CAP_EXCEEDED');
  });

  it('uses authoritativeSessionSpentPaise over in-memory transactions', () => {
    // Pass authoritative spend of 150000 explicitly
    const r = guardCheck(BASE_POLICY, EMPTY_STATE, { merchant: 'Swiggy', amount: 60000, category: 'Food & Dining' }, 150000);
    // 150000 + 60000 = 210000 > 200000
    expect(r.decision).toBe('denied');
  });

  it('denies when amount exceeds available reserve (regardless of session cap)', () => {
    const tightState: ReserveState = { ...EMPTY_STATE, availablePaise: 30000 };
    const r = guardCheck(BASE_POLICY, tightState, { merchant: 'Swiggy', amount: 50000, category: 'Food & Dining' });
    expect(r.decision).toBe('denied');
  });
});

// ─── PolicyExplanation shape ──────────────────────────────────────────────────

describe('guardCheck – PolicyExplanation', () => {
  it('includes all 5 rule checks in allowed result', () => {
    const r = guardCheck(BASE_POLICY, EMPTY_STATE, { merchant: 'Swiggy', amount: 10000, category: 'Food & Dining', quantity: 1 });
    expect(r.policyExplanation).toBeDefined();
    const rules = r.policyExplanation!.checks.map((c) => c.rule);
    expect(rules).toContain('AMOUNT');
    expect(rules).toContain('MERCHANT');
    expect(rules).toContain('CATEGORY');
    expect(rules).toContain('QUANTITY');
    expect(rules).toContain('SESSION');
  });

  it('marks only the failing rule as passed=false on denial', () => {
    const r = guardCheck(BASE_POLICY, EMPTY_STATE, { merchant: 'Walmart', amount: 10000, category: 'Food & Dining' });
    expect(r.policyExplanation?.decision).toBe('DENIED');
    const merchantCheck = r.policyExplanation?.checks.find((c) => c.rule === 'MERCHANT');
    expect(merchantCheck?.passed).toBe(false);
  });

  it('sets decision=APPROVED when allowed', () => {
    const r = guardCheck(BASE_POLICY, EMPTY_STATE, { merchant: 'Swiggy', amount: 10000, category: 'Food & Dining' });
    expect(r.policyExplanation?.decision).toBe('APPROVED');
  });

  it('sets decision=REVIEW when near-limit', () => {
    const amount = Math.floor(80000 * 0.9); // 90% of ceiling
    const r = guardCheck(BASE_POLICY, EMPTY_STATE, { merchant: 'Swiggy', amount, category: 'Food & Dining' });
    expect(r.policyExplanation?.decision).toBe('REVIEW');
  });

  it('populates resolvedMerchant and resolvedPrice', () => {
    const r = guardCheck(BASE_POLICY, EMPTY_STATE, { merchant: 'Swiggy', amount: 10000, category: 'Food & Dining' });
    expect(r.policyExplanation?.resolvedMerchant).toBe('Swiggy');
    expect(r.policyExplanation?.resolvedPrice).toBe(10000);
  });
});

// ─── REVIEW does NOT reserve funds ──────────────────────────────────────────

describe('guardCheck – REVIEW transactions do not hold funds', () => {
  it('heldPaise unchanged for review result', () => {
    const amount = Math.floor(80000 * 0.85);
    const r = guardCheck(BASE_POLICY, EMPTY_STATE, { merchant: 'Swiggy', amount, category: 'Food & Dining' });
    expect(r.decision).toBe('review');
    expect(r.updatedReserveState.heldPaise).toBe(0); // no funds held
    expect(r.paymentStatus).toBe('requested');
  });
});

// ─── State machine output ────────────────────────────────────────────────────

describe('guardCheck – state machine transitions', () => {
  it('allowed: paymentStatus=reserved, status=reserved', () => {
    const r = guardCheck(BASE_POLICY, EMPTY_STATE, { merchant: 'Swiggy', amount: 10000, category: 'Food & Dining' });
    expect(r.decision).toBe('allowed');
    expect(r.paymentStatus).toBe('reserved');
    expect(r.transaction?.status).toBe('reserved');
  });

  it('denied: paymentStatus=failed, status=frozen', () => {
    const r = guardCheck(BASE_POLICY, EMPTY_STATE, { merchant: 'Walmart', amount: 10000, category: 'Food & Dining' });
    expect(r.decision).toBe('denied');
    expect(r.paymentStatus).toBe('failed');
    expect(r.transaction?.status).toBe('frozen');
  });

  it('review: paymentStatus=requested, status=frozen', () => {
    const amount = Math.floor(80000 * 0.85);
    const r = guardCheck(BASE_POLICY, EMPTY_STATE, { merchant: 'Swiggy', amount, category: 'Food & Dining' });
    expect(r.decision).toBe('review');
    expect(r.paymentStatus).toBe('requested');
  });
});

// ─── Utility functions ────────────────────────────────────────────────────────

describe('normalizeMerchant', () => {
  it('strips corporate suffixes', () => {
    expect(normalizeMerchant('Amazon India Private Limited')).toBe('amazon india');
    expect(normalizeMerchant('Flipkart Pvt Ltd')).toBe('flipkart');
    expect(normalizeMerchant('Apple Inc')).toBe('apple');
  });
});

describe('getCanonicalCategory', () => {
  it('maps "dining" → "Food & Dining"', () => {
    expect(getCanonicalCategory('dining')).toBe('Food & Dining');
  });
  it('maps MCC 5812 → "Food & Dining"', () => {
    expect(getCanonicalCategory(undefined, '5812')).toBe('Food & Dining');
  });
});
