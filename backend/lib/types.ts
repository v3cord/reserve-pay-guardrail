export interface Policy {
  id?: string;
  version?: number;
  amountCeiling?: number; // In integer Paise
  category?: string;
  merchantMode?: 'unrestricted' | 'allowlist';
  allowedMerchants: string[];
  sessionCap?: number; // In integer Paise
  reasonableQuantity?: number;
  mccCode?: string;
  allowedMccCodes?: string[];
  sessionId?: string;
  tenantId?: string;
  microPurchaseThreshold?: number; // Absolute limit in paise for bypassing quantity checks
  frozenTtlSeconds?: number;
  reservedTtlSeconds?: number;
}

export type DecisionStatus = 'allowed' | 'review' | 'denied';

export type PaymentStatus =
  | 'requested'
  | 'reserved'
  | 'order_creation_unknown'
  | 'order_created'
  | 'authorized'
  | 'captured'
  | 'released'
  | 'expired'
  | 'failed'
  | 'partially_refunded'
  | 'refunded'
  | 'disputed';

// Backward-compatible alias for existing code
export type TransactionStatus =
  | PaymentStatus
  | 'approved'
  | 'frozen'
  | 'skipped';

export interface CatalogProduct {
  id?: string;
  productId: string;
  name?: string;
  merchantId: string;
  merchantName: string;
  merchant?: string;
  mcc: string;
  category: string;
  unitPricePaise: number;
  pricePaise?: number;
  currency: string;
  catalogVersion: string;
}

export type LedgerEventType =
  | 'RESERVATION_CREATED'
  | 'ORDER_CREATED'
  | 'ORDER_ATTACHED'
  | 'ORDER_UNKNOWN_FLAGGED'
  | 'ORDER_RECONCILED'
  | 'ORDER_RECONCILED_FOUND'
  | 'ORDER_RECONCILE_PENDING'
  | 'PAYMENT_AUTHORIZED'
  | 'PAYMENT_CAPTURED'
  | 'PAYMENT_REFUNDED'
  | 'PAYMENT_DISPUTED'
  | 'PAYMENT_AMOUNT_MISMATCH'
  | 'RESERVATION_RELEASED'
  | 'RESERVATION_EXPIRED'
  | 'TRANSACTION_DISPUTED'
  | 'REVIEW_REQUIRED'
  | 'HUMAN_OVERRIDE_APPROVED'
  | 'HUMAN_OVERRIDE_DENIED'
  | 'GUARD_REJECTED';

export interface LedgerEvent {
  id: string;
  transactionId: string;
  tenantId: string;
  agentId: string;
  eventType: LedgerEventType;
  payload: Record<string, unknown>;
  sequenceNum: number;
  prevHash: string;
  hash: string;
  timestamp: string;
  policyId?: string;
  policyVersion?: number;
}

export interface Transaction {
  id: string;
  merchant: string;
  amount: number; // In integer Paise
  category: string;
  quantity?: number;
  status: TransactionStatus;
  decisionStatus?: DecisionStatus;
  paymentStatus?: PaymentStatus;
  reason?: string;
  timestamp: string;
  mccCode?: string;
  hash: string;
  prevHash: string;
  razorpayOrderId?: string;
  razorpayPaymentId?: string;
  agentId?: string;
  policyId?: string;
  policyVersion?: number;
  sessionId?: string;
  tenantId?: string;
  productId?: string;
  catalogVersion?: string;
  resolvedMerchantId?: string;
  resolvedUnitPricePaise?: number;
  capturedPaise?: number;
  refundedPaise?: number;
  remainingRefundablePaise?: number;
  expiresAt?: string;
  decision?: DecisionStatus;
}

export interface ReserveState {
  totalPaise: number;
  heldPaise: number;
  settledPaise: number;
  availablePaise: number;
  total?: number; // Backward-compatible alias for totalPaise
  remaining?: number; // Backward-compatible alias for availablePaise
  transactions: Transaction[];
  ledgerEvents?: LedgerEvent[];
  ledgerIntegrity?: {
    isValid: boolean;
    corruptedIndex?: number;
    reason?: string;
    totalEventsVerified?: number;
  };
}

export interface AttemptedPurchase {
  id?: string;
  productId?: string;
  merchant?: string;
  amount?: number; // In integer Paise
  category?: string;
  quantity?: number;
  timestamp?: string;
  mccCode?: string;
  agentId?: string;
  policyId?: string;
  policyVersion?: number;
  razorpayOrderId?: string;
  sessionId?: string;
  tenantId?: string;
  payment_capture?: 0 | 1 | boolean;
  receipt?: string;
  idempotencyKey?: string;
  expiresAt?: string;
  override?: boolean;
  catalogVersion?: string;
}

export interface PurchaseRequestBody extends AttemptedPurchase {
  override?: boolean;
  catalogVersion?: string;
}

export interface PolicyCheckLine {
  rule: 'AMOUNT' | 'MERCHANT' | 'CATEGORY' | 'QUANTITY' | 'SESSION';
  passed: boolean;
  detail: string;
  limit?: string;
  actual?: string;
}

export interface PolicyExplanation {
  checks: PolicyCheckLine[];
  decision: 'APPROVED' | 'REVIEW' | 'DENIED';
  policyVersion: number;
  policyId: string;
  catalogVersion?: string;
  resolvedProductId?: string;
  resolvedMerchant?: string;
  resolvedPrice?: number;
  resolvedCategory?: string;
  resolvedMcc?: string;
}

export interface GuardCheckResult {
  decision: DecisionStatus | 'approve' | 'freeze';
  paymentStatus?: PaymentStatus;
  decisionStatus?: DecisionStatus;
  reason: string;
  ruleViolated?: string;
  limitPaise?: number;
  requestedPaise?: number;
  policyId?: string;
  policyVersion?: number;
  policyExplanation?: PolicyExplanation;
  updatedReserveState: ReserveState;
  ledgerEvent?: LedgerEvent;
  transaction?: Transaction;
}

export type AuthRole = 'admin' | 'service' | 'agent' | 'demo_user' | 'ADMIN_ROLE' | 'AGENT_ROLE' | 'WEBHOOK_ROLE';

export interface AuthContext {
  role: AuthRole;
  identity: string;
  agentId?: string;
  tenantId?: string;
  sessionId?: string;
  authMethod: 'api_key' | 'jwt' | 'webhook_signature' | 'demo_session';
}

export interface AuthenticateRequestOptions {
  allowedRoles?: AuthRole[];
  requireSignature?: boolean;
  rawBody?: string;
}

export interface AuthResult {
  authenticated: boolean;
  context?: AuthContext;
  error?: string;
  statusCode?: number;
}

export interface SecurityAuditEvent {
  id?: string;
  timestamp?: string;
  eventType:
    | 'UNAUTHORIZED_ACCESS'
    | 'FORBIDDEN_PRIVILEGE_ESCALATION'
    | 'SIGNATURE_VERIFICATION_FAILED'
    | 'SECRET_VALIDATION_FAILURE'
    | 'MANUAL_OVERRIDE_EXECUTED'
    | 'RECONCILIATION_TRIGGERED'
    | 'IDEMPOTENCY_MISMATCH'
    | 'RATE_LIMIT_EXCEEDED';
  role?: string;
  identity?: string;
  endpoint: string;
  method: string;
  details: string;
  ip?: string;
}

export type ReserveStoreType = 'postgres' | 'sqlite' | 'memory';

export interface TokenBucketAcquireResult {
  allowed: boolean;
  remainingPaise: number;
  remainingBudgetPaise?: number;
  reason?: string;
}

export interface IRedisTokenBucket {
  acquireReserve(agentId: string, requestedPaise: number, initialTotalPaise?: number): Promise<TokenBucketAcquireResult>;
  releaseReserve(agentId: string, amountPaise: number): Promise<number>;
  refundReserve(agentId: string, amountPaise: number): Promise<number>;
  getRemainingBudget(agentId: string): Promise<number | null>;
  setRemainingBudget(agentId: string, remainingPaise: number): Promise<void>;
  reset(agentId?: string): Promise<void>;
}

export type IdempotencyStatus = 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'EXPIRED';

export interface IdempotencyRecord {
  tenantId: string;
  agentId: string;
  key: string;
  requestHash: string;
  status: IdempotencyStatus;
  response?: Record<string, unknown> | null;
  ownerToken?: string;
  leaseExpiresAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SettleResult {
  success: boolean;
  transactionId?: string;
  updatedReserveState?: ReserveState;
  transaction?: Transaction;
  error?: string;
}

export interface ReleaseResult {
  success: boolean;
  transactionId?: string;
  releasedAmountPaise?: number;
  updatedReserveState?: ReserveState;
  transaction?: Transaction;
  error?: string;
}

export interface RefundResult {
  success: boolean;
  transactionId?: string;
  refundId?: string;
  refundedAmountPaise?: number;
  updatedReserveState?: ReserveState;
  refundTransaction?: Transaction;
  error?: string;
}

export interface DisputeResult {
  success: boolean;
  transactionId?: string;
  disputedAmountPaise?: number;
  status?: string;
  updatedReserveState?: ReserveState;
  transaction?: Transaction;
  error?: string;
}

export interface LedgerIntegrityResult {
  isValid: boolean;
  corruptedIndex?: number;
  reason?: string;
  totalEventsVerified?: number;
}

export interface IReserveStore {
  readonly storeType: ReserveStoreType;
  init?(): Promise<void> | void;
  getActivePolicy(agentId?: string): Promise<Policy> | Policy;
  getPolicy(agentId?: string): Promise<Policy> | Policy;
  setActivePolicy(policy: Policy, agentId?: string): Promise<Policy> | Policy;
  setPolicy(policy: Policy, agentId?: string): Promise<Policy> | Policy;
  getReserveState(agentId?: string, filterSessionId?: string): Promise<ReserveState> | ReserveState;
  setReserveState(
    state: ReserveState | { totalPaise?: number; heldPaise?: number; settledPaise?: number; total?: number; remaining?: number; transactions?: Transaction[] },
    agentId?: string
  ): Promise<ReserveState> | ReserveState;
  processPurchaseAtomic(purchase: AttemptedPurchase, agentId?: string): Promise<GuardCheckResult>;
  attachRazorpayOrder(txId: string, razorpayOrderId: string, agentId?: string): Promise<void>;
  claimWebhookEvent(eventId: string, eventType: string, payloadHash: string): Promise<boolean>;
  settleTransaction(txIdOrOrderId: string, razorpayPaymentId?: string, agentId?: string): Promise<SettleResult>;
  releaseReservation(txIdOrOrderId: string, reason?: string, agentId?: string): Promise<ReleaseResult>;
  getTransactionByIdOrOrderId(identifier: string, agentId?: string): Promise<Transaction | null> | Transaction | null;
  processRefund(orderIdOrPaymentId: string, refundAmountPaise: number, refundId?: string, reason?: string, agentId?: string): Promise<RefundResult> | RefundResult;
  disputeTransaction(orderIdOrPaymentId: string, disputeReason?: string, disputeId?: string | null, agentId?: string): Promise<DisputeResult> | DisputeResult;
  verifyLedgerIntegrity(agentId?: string): Promise<LedgerIntegrityResult> | LedgerIntegrityResult;
  resetStore(agentId?: string): Promise<void> | void;
  recordSecurityAudit(event: SecurityAuditEvent): Promise<SecurityAuditEvent> | SecurityAuditEvent;
  getSecurityAuditLogs(limit?: number): Promise<SecurityAuditEvent[]> | SecurityAuditEvent[];
  rebuildHashChainForAgent?(agentId?: string): Promise<void> | void;
  getLastTransactionHash?(agentId?: string): Promise<string> | string;
  getLastLedgerEventHash(agentId?: string): Promise<string> | string;
  appendLedgerEvent(event: Omit<LedgerEvent, 'id' | 'sequenceNum' | 'prevHash' | 'hash'>): Promise<LedgerEvent> | LedgerEvent;
  getLedgerEvents(agentId?: string, limit?: number): Promise<LedgerEvent[]> | LedgerEvent[];
  expireStaleTransactions(agentId?: string): Promise<number> | number;
  claimIdempotencyKey(tenantId: string, agentId: string, key: string, requestHash: string): Promise<{ status: 'CLAIMED' | 'CACHED' | 'MISMATCH' | 'PROCESSING'; cachedResponse?: Record<string, unknown>; ownerToken?: string }>;
  completeIdempotencyKey(tenantId: string, agentId: string, key: string, response: Record<string, unknown>): Promise<void>;
  failIdempotencyKey(tenantId: string, agentId: string, key: string): Promise<void>;
  flagOrderCreationUnknown(txId: string, agentId?: string): Promise<void>;
  reconcileStaleTransactions?(): Promise<{ reconciledCount: number; releasedCount: number }>;
}

export const VALID_PAYMENT_TRANSITIONS: Record<PaymentStatus, PaymentStatus[]> = {
  'requested': ['reserved', 'failed'],
  'reserved': ['order_creation_unknown', 'order_created', 'authorized', 'captured', 'released', 'expired', 'failed'],
  'order_creation_unknown': ['order_created', 'released', 'failed'],
  'order_created': ['authorized', 'captured', 'released', 'failed'],
  'authorized': ['captured', 'released', 'failed'],
  'captured': ['partially_refunded', 'refunded', 'disputed'],
  'released': [],
  'expired': [],
  'failed': [],
  'partially_refunded': ['partially_refunded', 'refunded', 'disputed'],
  'refunded': ['disputed'],
  'disputed': [],
};

export function isValidTransition(from: PaymentStatus, to: PaymentStatus): boolean {
  const allowed = VALID_PAYMENT_TRANSITIONS[from];
  return allowed ? allowed.includes(to) : false;
}
