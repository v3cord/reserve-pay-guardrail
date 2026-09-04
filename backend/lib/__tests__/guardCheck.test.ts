import { describe, it, expect } from 'vitest';
import { guardCheck } from '../guardCheck';
import { Policy, ReserveState, AttemptedPurchase } from '../types';

describe('guardCheck - Core Rule & Fail-Safe Tests', () => {
  const policy: Policy = {
    amountCeiling: 60000, // ₹600.00
    category: 'Electronics',
    allowedMerchants: ['Amazon', 'BestBuy'],
    sessionCap: 100000, // ₹1000.00
    reasonableQuantity: 2,
  };

  const initialReserveState: ReserveState = {
    totalPaise: 200000, // ₹2000.00
    heldPaise: 0,
    settledPaise: 0,
    availablePaise: 200000,
    total: 200000,
    remaining: 200000,
    transactions: [],
  };

  it('Rule 1: freezes when merchant is not in allowedMerchants', async () => {
    const purchase: AttemptedPurchase = {
      merchant: 'Walmart',
      amount: 20000, // ₹200.00
      category: 'Electronics',
      quantity: 1,
    };
    const result = guardCheck(purchase, policy, initialReserveState);
    expect(result.decision).toBe('freeze');
    expect(result.reason.toLowerCase()).toContain('merchant mismatch');
  });

  it('Rule 2: freezes when category does not match policy category', async () => {
    const purchase: AttemptedPurchase = {
      merchant: 'Amazon',
      amount: 20000,
      category: 'Clothing',
      quantity: 1,
    };
    const result = guardCheck(purchase, policy, initialReserveState);
    expect(result.decision).toBe('freeze');
    expect(result.reason.toLowerCase()).toContain('category mismatch');
  });

  it('Rule 3a: freezes on quantity inconsistency', async () => {
    const purchase: AttemptedPurchase = {
      merchant: 'Amazon',
      amount: 20000,
      category: 'Electronics',
      quantity: 10,
    };
    const result = guardCheck(purchase, policy, initialReserveState);
    expect(result.decision).toBe('freeze');
    expect(result.reason.toLowerCase()).toContain('quantity inconsistent');
  });

  it('Rule 3b: freezes when amount exceeds policy ceiling', async () => {
    const purchase: AttemptedPurchase = {
      merchant: 'Amazon',
      amount: 75000, // ₹750 > ₹600 ceiling
      category: 'Electronics',
      quantity: 1,
    };
    const result = guardCheck(purchase, policy, initialReserveState);
    expect(result.decision).toBe('freeze');
    expect(result.reason.toLowerCase()).toContain('amount ceiling exceeded');
  });

  it('Rule 3b Fail-Safe: freezes unbounded policy when amountCeiling is missing', async () => {
    const vaguePolicy: Policy = {
      category: 'Groceries',
      allowedMerchants: ['Swiggy'],
      sessionCap: 100000,
      // amountCeiling is intentionally undefined (vague intent)
    };
    const purchase: AttemptedPurchase = {
      merchant: 'Swiggy',
      amount: 20000,
      category: 'Groceries',
    };
    const result = guardCheck(purchase, vaguePolicy, initialReserveState);
    expect(result.decision).toBe('freeze');
    expect(result.reason.toLowerCase()).toContain('unbounded purchase risk');
  });

  it('Rule 4: freezes second purchase when cumulative spend exceeds sessionCap', async () => {
    const purchase1: AttemptedPurchase = {
      id: 'p1',
      merchant: 'Amazon',
      amount: 55000, // ₹550.00
      category: 'Electronics',
      quantity: 1,
    };

    const purchase2: AttemptedPurchase = {
      id: 'p2',
      merchant: 'BestBuy',
      amount: 50000, // ₹500.00 -> 55000 + 50000 = 105000 > 100000 sessionCap
      category: 'Electronics',
      quantity: 1,
    };

    const res1 = guardCheck(purchase1, policy, initialReserveState);
    expect(res1.decision).toBe('approve');
    expect(res1.updatedReserveState.heldPaise).toBe(55000);
    expect(res1.updatedReserveState.availablePaise).toBe(145000);
    expect(res1.updatedReserveState.transactions[0].status).toBe('reserved');

    const res2 = guardCheck(purchase2, policy, res1.updatedReserveState);
    expect(res2.decision).toBe('freeze');
    expect(res2.reason.toLowerCase()).toContain('combined orders exceeding session budget');
  });

  it('Rule 5: approves matching purchase and creates Atomic Reservation reservation', async () => {
    const purchase: AttemptedPurchase = {
      merchant: 'Amazon',
      amount: 40000, // ₹400.00
      category: 'Electronics',
      quantity: 1,
    };
    const result = guardCheck(purchase, policy, initialReserveState);
    expect(result.decision).toBe('approve');
    expect(result.updatedReserveState.heldPaise).toBe(40000);
    expect(result.updatedReserveState.settledPaise).toBe(0);
    expect(result.updatedReserveState.availablePaise).toBe(160000);
    expect(result.updatedReserveState.transactions[0].status).toBe('reserved');
  });
});

describe('guardCheck - Normalized & Fuzzy Merchant Matching', () => {
  const swiggyPolicy: Policy = {
    amountCeiling: 50000,
    category: 'Food & Dining',
    allowedMerchants: ['Swiggy'],
    sessionCap: 100000,
  };

  const reserveState: ReserveState = {
    totalPaise: 200000,
    heldPaise: 0,
    settledPaise: 0,
    availablePaise: 200000,
    total: 200000,
    remaining: 200000,
    transactions: [],
  };

  it('approves lowercase exact merchant string "swiggy"', async () => {
    const purchase: AttemptedPurchase = {
      merchant: 'swiggy',
      amount: 15000,
      category: 'Food & Dining',
    };
    const res = guardCheck(purchase, swiggyPolicy, reserveState);
    expect(res.decision).toBe('approve');
  });

  it('approves vendor sub-brand "Swiggy Instamart"', async () => {
    const purchase: AttemptedPurchase = {
      merchant: 'Swiggy Instamart',
      amount: 15000,
      category: 'Food & Dining',
    };
    const res = guardCheck(purchase, swiggyPolicy, reserveState);
    expect(res.decision).toBe('approve');
  });

  it('approves uppercase vendor sub-brand "SWIGGY STORES"', async () => {
    const purchase: AttemptedPurchase = {
      merchant: 'SWIGGY STORES',
      amount: 15000,
      category: 'Food & Dining',
    };
    const res = guardCheck(purchase, swiggyPolicy, reserveState);
    expect(res.decision).toBe('approve');
  });

  it('approves corporate suffix variation "Amazon India Private Limited" for allowed merchant "Amazon"', async () => {
    const amazonPolicy: Policy = {
      amountCeiling: 50000,
      category: 'Electronics',
      allowedMerchants: ['Amazon'],
      sessionCap: 100000,
    };
    const purchase: AttemptedPurchase = {
      merchant: 'Amazon India Private Limited',
      amount: 25000,
      category: 'Electronics',
    };
    const res = guardCheck(purchase, amazonPolicy, reserveState);
    expect(res.decision).toBe('approve');
  });
});

describe('guardCheck - MCC & Category Aliasing Support', () => {
  const foodPolicy: Policy = {
    amountCeiling: 50000,
    category: 'Food & Dining',
    allowedMerchants: ['Swiggy', 'Zomato'],
    sessionCap: 100000,
  };

  const reserveState: ReserveState = {
    totalPaise: 200000,
    heldPaise: 0,
    settledPaise: 0,
    availablePaise: 200000,
    total: 200000,
    remaining: 200000,
    transactions: [],
  };

  it('approves alias "Dining" for policy category "Food & Dining"', async () => {
    const purchase: AttemptedPurchase = {
      merchant: 'Swiggy',
      amount: 10000,
      category: 'Dining',
    };
    const res = guardCheck(purchase, foodPolicy, reserveState);
    expect(res.decision).toBe('approve');
  });

  it('approves alias "Restaurants" for policy category "Food & Dining"', async () => {
    const purchase: AttemptedPurchase = {
      merchant: 'Zomato',
      amount: 20000,
      category: 'Restaurants',
    };
    const res = guardCheck(purchase, foodPolicy, reserveState);
    expect(res.decision).toBe('approve');
  });

  it('approves alias "Food & Beverage" for policy category "Food & Dining"', async () => {
    const purchase: AttemptedPurchase = {
      merchant: 'Swiggy',
      amount: 12000,
      category: 'Food & Beverage',
    };
    const res = guardCheck(purchase, foodPolicy, reserveState);
    expect(res.decision).toBe('approve');
  });

  it('approves purchase with MCC 5812 matching policy category "Food & Dining"', async () => {
    const purchase: AttemptedPurchase = {
      merchant: 'Swiggy',
      amount: 15000,
      category: 'Eatery',
      mccCode: '5812',
    };
    const res = guardCheck(purchase, foodPolicy, reserveState);
    expect(res.decision).toBe('approve');
  });

  it('approves purchase when policy specifies allowedMccCodes matching purchase mccCode', async () => {
    const mccPolicy: Policy = {
      amountCeiling: 50000,
      allowedMerchants: ['Swiggy'],
      allowedMccCodes: ['5812', '5814'],
      sessionCap: 100000,
    };
    const purchase: AttemptedPurchase = {
      merchant: 'Swiggy',
      amount: 18000,
      category: 'Fast Food',
      mccCode: '5814',
    };
    const res = guardCheck(purchase, mccPolicy, reserveState);
    expect(res.decision).toBe('approve');
  });
});

describe('guardCheck - Asymmetric Sub-Brand Matching (Least Privilege)', () => {
  const reserveState: ReserveState = {
    totalPaise: 200000,
    heldPaise: 0,
    settledPaise: 0,
    availablePaise: 200000,
    total: 200000,
    remaining: 200000,
    transactions: [],
  };

  it('allows specific sub-brand "Swiggy Instamart" when allowed general brand is "Swiggy"', async () => {
    const policy: Policy = {
      amountCeiling: 50000,
      category: 'Groceries',
      allowedMerchants: ['Swiggy'],
      sessionCap: 100000,
    };
    const purchase: AttemptedPurchase = {
      merchant: 'Swiggy Instamart',
      amount: 15000,
      category: 'Groceries',
    };
    const res = guardCheck(purchase, policy, reserveState);
    expect(res.decision).toBe('approve');
  });

  it('FREEZES attempted general brand "Swiggy" when allowed merchant is restricted to sub-brand "Swiggy Instamart"', async () => {
    const restrictedPolicy: Policy = {
      amountCeiling: 50000,
      category: 'Food & Dining',
      allowedMerchants: ['Swiggy Instamart'],
      sessionCap: 100000,
    };
    const purchase: AttemptedPurchase = {
      merchant: 'Swiggy',
      amount: 15000,
      category: 'Food & Dining',
    };
    const res = guardCheck(purchase, restrictedPolicy, reserveState);
    expect(res.decision).toBe('freeze');
    expect(res.reason.toLowerCase()).toContain('merchant mismatch');
  });

  it('prevents substring collision exploits: allowed "Pay" does NOT match "PayPal" or "PayTM"', async () => {
    const payPolicy: Policy = {
      amountCeiling: 50000,
      category: 'Electronics',
      allowedMerchants: ['Pay'],
      sessionCap: 100000,
    };

    const res1 = guardCheck({ merchant: 'PayPal', amount: 10000, category: 'Electronics' }, payPolicy, reserveState);
    expect(res1.decision).toBe('freeze');

    const res2 = guardCheck({ merchant: 'PayTM', amount: 10000, category: 'Electronics' }, payPolicy, reserveState);
    expect(res2.decision).toBe('freeze');
  });
});

describe('guardCheck - Multi-Dimensional Quantity & Unit-Price Check', () => {
  const stationeryPolicy: Policy = {
    amountCeiling: 50000, // ₹500.00 (50,000 paise)
    category: 'Stationery',
    allowedMerchants: ['StationeryHub'],
    sessionCap: 100000,
    reasonableQuantity: 2, // 2x limit = 4
  };

  const reserveState: ReserveState = {
    totalPaise: 200000,
    heldPaise: 0,
    settledPaise: 0,
    availablePaise: 200000,
    total: 200000,
    remaining: 200000,
    transactions: [],
  };

  it('APPROVES inexpensive micro-purchases (e.g. 5 pencil sharpeners at ₹2 each = ₹10 total <= 5% of ceiling) despite high raw quantity', async () => {
    const microPurchase: AttemptedPurchase = {
      merchant: 'StationeryHub',
      amount: 1000, // ₹10.00 total (<= 5% of ₹500 ceiling = ₹25.00 / 2500 paise)
      category: 'Stationery',
      quantity: 5, // 5 > 2 * 2 (4), but unit price is ₹2.00
    };

    const res = guardCheck(microPurchase, stationeryPolicy, reserveState);
    expect(res.decision).toBe('approve');
    expect(res.updatedReserveState.heldPaise).toBe(1000);
  });

  it('FREEZES non-micro purchases when quantity exceeds reasonable limits at high unit prices', async () => {
    const bulkPurchase: AttemptedPurchase = {
      merchant: 'StationeryHub',
      amount: 40000, // ₹400.00 total (> 5% of ₹500 ceiling)
      category: 'Stationery',
      quantity: 8, // 8 > 2 * 2 (4) at unit price ₹50.00
    };

    const res = guardCheck(bulkPurchase, stationeryPolicy, reserveState);
    expect(res.decision).toBe('freeze');
    expect(res.reason.toLowerCase()).toContain('quantity inconsistent');
  });
});

describe('guardCheck - Server-Side TTL & Expiry Timestamps', () => {
  const policy: Policy = {
    amountCeiling: 50000,
    category: 'Electronics',
    allowedMerchants: ['Amazon'],
    sessionCap: 100000,
  };

  const reserveState: ReserveState = {
    totalPaise: 200000,
    heldPaise: 0,
    settledPaise: 0,
    availablePaise: 200000,
    total: 200000,
    remaining: 200000,
    transactions: [],
  };

  it('sets expiresAt timestamp on frozen transactions 20 seconds into the future', async () => {
    const fixedNow = new Date('2026-08-22T01:30:00.000Z');
    const purchase: AttemptedPurchase = {
      id: 'tx_frozen_ttl_test',
      merchant: 'UnallowedVendor',
      amount: 20000,
      category: 'Electronics',
      timestamp: fixedNow.toISOString(),
    };

    const res = guardCheck(purchase, policy, reserveState);
    expect(res.decision).toBe('freeze');

    const frozenTx = res.updatedReserveState.transactions.find((t) => t.id === 'tx_frozen_ttl_test');
    expect(frozenTx).toBeDefined();
    expect(frozenTx?.status).toBe('frozen');
    expect(frozenTx?.expiresAt).toBeDefined();

    const expectedExpiry = new Date('2026-08-22T01:30:20.000Z').toISOString();
    expect(frozenTx?.expiresAt).toBe(expectedExpiry);
  });
});

