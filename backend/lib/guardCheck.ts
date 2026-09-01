import { Policy, ReserveState, AttemptedPurchase, GuardCheckResult, Transaction, DecisionStatus, PaymentStatus } from './types';
import { resolveCatalogProduct } from './merchantCatalog';

// Legal corporate suffixes and entity qualifiers to strip for merchant normalization
const CORPORATE_SUFFIX_REGEX = /\b(india\s+private\s+limited|private\s+limited|pvt\.?\s+ltd\.?|pvt|ltd|inc|corp|llc|co)\b/gi;

export function normalizeMerchant(merchant: string): string {
  if (!merchant) return '';
  return merchant
    .toLowerCase()
    .replace(CORPORATE_SUFFIX_REGEX, '')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Validates whether an attempted merchant is allowed by the policy.
 *
 * Enforces the Principle of Least Privilege:
 * - An attempted specific sub-brand ("Swiggy Instamart") CAN match an allowed general brand ("Swiggy").
 * - An attempted general brand ("Swiggy") MUST NOT match a specifically restricted sub-brand ("Swiggy Instamart").
 * - Uses exact word-boundary token matching to prevent substring collision exploits (e.g. "Pay" does NOT match "PayPal").
 */
export function isMerchantAllowed(attemptedMerchant: string, allowedMerchants: string[]): boolean {
  if (!allowedMerchants || allowedMerchants.length === 0) return true;

  const attemptedLower = attemptedMerchant.toLowerCase().trim();
  const attemptedNorm = normalizeMerchant(attemptedMerchant);

  for (const allowed of allowedMerchants) {
    const allowedLower = allowed.toLowerCase().trim();
    const allowedNorm = normalizeMerchant(allowed);

    // 1. Exact case-insensitive match or normalized exact match
    if (attemptedLower === allowedLower || (attemptedNorm && attemptedNorm === allowedNorm)) {
      return true;
    }

    // 2. Asymmetric Sub-Brand Matching (Least Privilege)
    if (allowedNorm && attemptedNorm) {
      if (attemptedNorm.startsWith(`${allowedNorm} `)) {
        return true;
      }
    }
  }

  return false;
}

// Category Aliases mapping to Canonical Categories
const CATEGORY_ALIASES: Record<string, string> = {
  'food & dining': 'Food & Dining',
  'food and dining': 'Food & Dining',
  'dining': 'Food & Dining',
  'restaurants': 'Food & Dining',
  'restaurant': 'Food & Dining',
  'food & beverage': 'Food & Dining',
  'food and beverage': 'Food & Dining',
  'food': 'Food & Dining',
  'groceries': 'Groceries',
  'grocery': 'Groceries',
  'supermarket': 'Groceries',
  'supermarkets': 'Groceries',
  'electronics': 'Electronics',
  'gadgets': 'Electronics',
  'computers': 'Electronics',
  'tech': 'Electronics',
  'clothing': 'Clothing',
  'apparel': 'Clothing',
  'fashion': 'Clothing',
  'garments': 'Clothing',
  'travel': 'Travel',
  'transportation': 'Travel',
  'flight': 'Travel',
  'hotel': 'Travel',
  'lodging': 'Travel',
};

// Standard MCC to Canonical Category Map
const MCC_TO_CATEGORY: Record<string, string> = {
  '5812': 'Food & Dining', // Eating Places and Restaurants
  '5813': 'Food & Dining', // Drinking Places (Bars, Taverns)
  '5814': 'Food & Dining', // Fast Food Restaurants
  '5811': 'Food & Dining', // Caterers
  '5411': 'Groceries',    // Grocery Stores, Supermarkets
  '5499': 'Groceries',    // Misc Food Stores
  '5732': 'Electronics',  // Electronics Stores
  '5045': 'Electronics',  // Computers & Peripherals
  '5651': 'Clothing',     // Apparel & Accessories
  '5691': 'Clothing',     // Men and Women Clothing Stores
  '4511': 'Travel',       // Airlines
  '7011': 'Travel',       // Hotels, Motels
};

export function getCanonicalCategory(category?: string, mccCode?: string): string {
  if (category) {
    const key = category.trim().toLowerCase();
    if (CATEGORY_ALIASES[key]) {
      return CATEGORY_ALIASES[key];
    }
  }
  if (mccCode && MCC_TO_CATEGORY[mccCode]) {
    return MCC_TO_CATEGORY[mccCode];
  }
  return category ? category.trim() : '';
}

export function isCategoryAllowed(
  attempted: AttemptedPurchase,
  policy: Policy
): boolean {
  if (!policy.category && (!policy.allowedMccCodes || policy.allowedMccCodes.length === 0)) {
    return true;
  }

  if (policy.allowedMccCodes && policy.allowedMccCodes.length > 0) {
    if (attempted.mccCode && policy.allowedMccCodes.includes(attempted.mccCode)) {
      return true;
    }
  }

  if (policy.mccCode && attempted.mccCode && policy.mccCode === attempted.mccCode) {
    return true;
  }

  if (policy.category) {
    const attemptedCatLower = (attempted.category || '').trim().toLowerCase();
    const policyCatLower = policy.category.trim().toLowerCase();

    if (attemptedCatLower === policyCatLower) return true;

    const canonicalAttempted = getCanonicalCategory(attempted.category, attempted.mccCode);
    const canonicalPolicy = getCanonicalCategory(policy.category, policy.mccCode);

    if (
      canonicalAttempted &&
      canonicalPolicy &&
      canonicalAttempted.toLowerCase() === canonicalPolicy.toLowerCase()
    ) {
      return true;
    }
  }

  return false;
}

export function guardCheck(
  attemptedPurchase: AttemptedPurchase,
  policy: Policy,
  reserveState: ReserveState
): GuardCheckResult {
  const txId = attemptedPurchase.id || `tx_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
  const timestamp = attemptedPurchase.timestamp || new Date().toISOString();

  // Authoritative catalog resolution if productId provided
  let merchant = attemptedPurchase.merchant || '';
  let category = attemptedPurchase.category || '';
  let amount = attemptedPurchase.amount ?? 0;
  let mccCode = attemptedPurchase.mccCode;
  let catalogVersion = attemptedPurchase.productId ? '2026.09.v1' : undefined;

  if (attemptedPurchase.productId) {
    const catalogItem = resolveCatalogProduct(attemptedPurchase.productId);
    if (catalogItem) {
      merchant = catalogItem.merchantName;
      category = catalogItem.category;
      mccCode = catalogItem.mcc;
      amount = catalogItem.unitPricePaise * (attemptedPurchase.quantity || 1);
      catalogVersion = catalogItem.catalogVersion;
    }
  }

  const resolvedAttempt: AttemptedPurchase = {
    ...attemptedPurchase,
    merchant,
    category,
    amount,
    mccCode,
  };

  const totalPaise = reserveState.totalPaise ?? reserveState.total ?? 200000;
  const currentHeldPaise = reserveState.heldPaise ?? 0;
  const currentSettledPaise = reserveState.settledPaise ?? 0;
  const currentAvailablePaise =
    reserveState.availablePaise ?? (totalPaise - currentHeldPaise - currentSettledPaise);

  const createTx = (
    decisionStatus: DecisionStatus,
    paymentStatus: PaymentStatus,
    reason: string
  ): Transaction => {
    let expiresAt: string | undefined;
    if (paymentStatus === 'reserved') {
      const reservedTtl = policy.reservedTtlSeconds ?? 900;
      expiresAt = new Date(new Date(timestamp).getTime() + reservedTtl * 1000).toISOString();
    } else {
      const frozenTtl = policy.frozenTtlSeconds ?? 20;
      expiresAt = new Date(new Date(timestamp).getTime() + frozenTtl * 1000).toISOString();
    }

    const legacyStatus: Transaction['status'] =
      paymentStatus === 'reserved' ? 'reserved' : 'frozen';

    return {
      id: txId,
      merchant,
      amount,
      category,
      quantity: attemptedPurchase.quantity,
      status: legacyStatus,
      decisionStatus,
      paymentStatus,
      decision: decisionStatus,
      reason,
      timestamp,
      mccCode,
      agentId: attemptedPurchase.agentId,
      policyId: attemptedPurchase.policyId || policy.id || 'default_policy',
      policyVersion: attemptedPurchase.policyVersion || policy.version || 1,
      razorpayOrderId: attemptedPurchase.razorpayOrderId,
      sessionId: attemptedPurchase.sessionId || policy.sessionId,
      tenantId: attemptedPurchase.tenantId || policy.tenantId || 'default_tenant',
      productId: attemptedPurchase.productId,
      catalogVersion,
      hash: '',
      prevHash: '',
      expiresAt,
    };
  };

  const makeDeniedResult = (reason: string, ruleViolated: string, limitPaise?: number): GuardCheckResult => {
    const deniedTx = createTx('denied', 'failed', reason);
    return {
      decision: 'denied',
      decisionStatus: 'denied',
      paymentStatus: 'failed',
      reason,
      ruleViolated,
      limitPaise,
      requestedPaise: amount,
      policyId: policy.id || 'default_policy',
      policyVersion: policy.version || 1,
      transaction: deniedTx,
      updatedReserveState: {
        ...reserveState,
        totalPaise,
        heldPaise: currentHeldPaise,
        settledPaise: currentSettledPaise,
        availablePaise: currentAvailablePaise,
        total: totalPaise,
        remaining: currentAvailablePaise,
        transactions: [...reserveState.transactions, deniedTx],
      },
    };
  };

  const makeReviewResult = (reason: string, ruleViolated: string, limitPaise?: number): GuardCheckResult => {
    const reviewTx = createTx('review', 'requested', reason);
    return {
      decision: 'review',
      decisionStatus: 'review',
      paymentStatus: 'requested',
      reason,
      ruleViolated,
      limitPaise,
      requestedPaise: amount,
      policyId: policy.id || 'default_policy',
      policyVersion: policy.version || 1,
      transaction: reviewTx,
      updatedReserveState: {
        ...reserveState,
        totalPaise,
        heldPaise: currentHeldPaise,
        settledPaise: currentSettledPaise,
        availablePaise: currentAvailablePaise,
        total: totalPaise,
        remaining: currentAvailablePaise,
        transactions: [...reserveState.transactions, reviewTx],
      },
    };
  };

  // Rule 1: Merchant Whitelist Check (Exact & Asymmetric Sub-brand Safe Match)
  if (
    policy.allowedMerchants &&
    policy.allowedMerchants.length > 0 &&
    !isMerchantAllowed(merchant, policy.allowedMerchants)
  ) {
    const reason = `Merchant mismatch: Merchant '${merchant}' is not allowed by policy.`;
    return makeDeniedResult(reason, 'MERCHANT_NOT_ALLOWED');
  }

  // Rule 2: Category Matching Check
  if (!isCategoryAllowed(resolvedAttempt, policy)) {
    const reason = `Category mismatch: Purchase category '${category}' does not match policy category '${policy.category}'.`;
    return makeDeniedResult(reason, 'CATEGORY_NOT_ALLOWED');
  }

  // Rule 3a: Multi-Dimensional Quantity & Unit-Price Sanity Check (Risk-Based Anomaly)
  const reasonableQty = policy.reasonableQuantity ?? 2;
  const quantity = attemptedPurchase.quantity;

  if (quantity !== undefined && quantity > reasonableQty) {
    const unitPrice = quantity > 0 ? Math.floor(amount / quantity) : amount;
    const microThreshold = policy.microPurchaseThreshold ?? 5000;
    const isMicroPurchase = amount <= microThreshold;

    if (!isMicroPurchase) {
      if (quantity > 2 * reasonableQty) {
        const reason = `Quantity anomaly exceeded hard limit: Quantity (${quantity}) at unit price (₹${(unitPrice / 100).toFixed(2)}) exceeds 2x limit (${2 * reasonableQty}).`;
        return makeDeniedResult(reason, 'QUANTITY_ANOMALY');
      } else {
        const reason = `Quantity anomaly review required: Quantity (${quantity}) exceeds expected reasonable limit (${reasonableQty}). Flagged for review.`;
        return makeReviewResult(reason, 'QUANTITY_ANOMALY');
      }
    }
  }

  // Rule 3b: Amount Ceiling & Fail-Safe Unbounded Check
  if (policy.amountCeiling === undefined) {
    const reason = `Unbounded purchase risk: Policy has no explicit amount ceiling defined. Failsafe activated.`;
    return makeDeniedResult(reason, 'UNBOUNDED_CEILING_FAILSAFE');
  }

  if (amount > policy.amountCeiling) {
    const reason = `Amount ceiling exceeded: Purchase amount (₹${(amount / 100).toFixed(2)}) exceeds policy ceiling (₹${(policy.amountCeiling / 100).toFixed(2)}).`;
    return makeDeniedResult(reason, 'AMOUNT_CEILING_EXCEEDED', policy.amountCeiling);
  }

  // Rule 4: Session-Scoped Cumulative Spend Check
  const activeSessionId = attemptedPurchase.sessionId || policy.sessionId;
  const sessionTransactions = activeSessionId
    ? reserveState.transactions.filter((t) => (t.sessionId || activeSessionId) === activeSessionId)
    : reserveState.transactions;

  const cumulativeSpend =
    sessionTransactions
      .filter((t) => t.status === 'reserved' || (t.paymentStatus && ['reserved', 'order_created', 'authorized', 'captured'].includes(t.paymentStatus)) || t.status === 'authorized' || t.status === 'captured')
      .reduce((sum, t) => sum + t.amount, 0) + amount;

  const exceedsSessionCap =
    policy.sessionCap !== undefined && cumulativeSpend > policy.sessionCap;
  const exceedsAvailableReserve =
    amount > currentAvailablePaise;

  if (exceedsSessionCap || exceedsAvailableReserve) {
    const capLimit = policy.sessionCap ?? currentAvailablePaise;
    const reason = `Combined orders exceeding session budget: Cumulative spend (₹${(cumulativeSpend / 100).toFixed(2)}) exceeds session cap (₹${(capLimit / 100).toFixed(2)}).`;
    return makeDeniedResult(reason, 'SESSION_CAP_EXCEEDED', capLimit);
  }

  // Rule 5: Default Approval -> Atomic Reservation Created
  const reason = 'Transaction authorized & reserved';
  const reservedTx = createTx('allowed', 'reserved', reason);
  const updatedHeldPaise = currentHeldPaise + amount;
  const updatedAvailablePaise = totalPaise - updatedHeldPaise - currentSettledPaise;

  return {
    decision: 'allowed',
    decisionStatus: 'allowed',
    paymentStatus: 'reserved',
    reason,
    limitPaise: policy.amountCeiling,
    requestedPaise: amount,
    policyId: policy.id || 'default_policy',
    policyVersion: policy.version || 1,
    transaction: reservedTx,
    updatedReserveState: {
      ...reserveState,
      totalPaise,
      heldPaise: updatedHeldPaise,
      settledPaise: currentSettledPaise,
      availablePaise: updatedAvailablePaise,
      total: totalPaise,
      remaining: updatedAvailablePaise,
      transactions: [...reserveState.transactions, reservedTx],
    },
  };
}


