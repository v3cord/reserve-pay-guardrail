export interface Policy {
  amountCeiling?: number; // In integer Paise
  category?: string;
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

export type TransactionStatus =
  | 'reserved'
  | 'authorized'
  | 'captured'
  | 'failed'
  | 'refunded'
  | 'frozen'
  | 'expired'
  | 'disputed'
  | 'approved';

export interface Transaction {
  id: string;
  merchant: string;
  amount: number; // In integer Paise
  category: string;
  quantity?: number;
  status: TransactionStatus;
  reason?: string;
  timestamp: string;
  mccCode?: string;
  hash: string;
  prevHash: string;
  razorpayOrderId?: string;
  razorpayPaymentId?: string;
  agentId?: string;
  policyId?: string;
  sessionId?: string;
  tenantId?: string;
  expiresAt?: string;
}

export interface ReserveState {
  totalPaise: number;
  heldPaise: number;
  settledPaise: number;
  availablePaise: number;
  total?: number; // Backward-compatible alias for totalPaise
  remaining?: number; // Backward-compatible alias for availablePaise
  transactions: Transaction[];
  ledgerIntegrity?: {
    isValid: boolean;
    corruptedIndex?: number;
  };
}

export interface AttemptedPurchase {
  id?: string;
  merchant: string;
  amount: number; // In integer Paise
  category: string;
  quantity?: number;
  timestamp?: string;
  mccCode?: string;
  agentId?: string;
  policyId?: string;
  razorpayOrderId?: string;
  sessionId?: string;
  tenantId?: string;
  payment_capture?: 0 | 1;
  receipt?: string;
  idempotencyKey?: string;
  expiresAt?: string;
}

export interface GuardCheckResult {
  decision: 'approve' | 'freeze';
  reason: string;
  updatedReserveState: ReserveState;
}

export type AuthRole = 'ADMIN_ROLE' | 'AGENT_ROLE' | 'WEBHOOK_ROLE';

export interface AuthContext {
  role: AuthRole;
  identity: string;
  agentId?: string;
  authMethod: 'api_key' | 'jwt' | 'webhook_signature';
}

export interface SecurityAuditEvent {
  id?: string;
  timestamp?: string;
  eventType: 'UNAUTHORIZED_ACCESS' | 'FORBIDDEN_PRIVILEGE_ESCALATION' | 'SIGNATURE_VERIFICATION_FAILED' | 'SECRET_VALIDATION_FAILURE' | 'MANUAL_OVERRIDE_EXECUTED';
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
  recordTransaction(transaction: Transaction): Promise<Transaction> | Transaction;
  processPurchaseAtomic(purchase: AttemptedPurchase & { override?: boolean }): Promise<GuardCheckResult> | GuardCheckResult;
  settleTransaction(txIdOrOrderId: string, razorpayPaymentId?: string, agentId?: string): Promise<SettleResult> | SettleResult;
  releaseReservation(txIdOrOrderId: string, reason?: string, agentId?: string): Promise<ReleaseResult> | ReleaseResult;
  processRefund(orderIdOrPaymentId: string, refundAmountPaise: number, refundId?: string, reason?: string, agentId?: string): Promise<RefundResult> | RefundResult;
  disputeTransaction(orderIdOrPaymentId: string, disputeReason?: string, agentId?: string): Promise<DisputeResult> | DisputeResult;
  verifyLedgerIntegrity(agentId?: string): Promise<LedgerIntegrityResult> | LedgerIntegrityResult;
  resetStore(agentId?: string): Promise<void> | void;
  recordSecurityAudit(event: SecurityAuditEvent): Promise<SecurityAuditEvent> | SecurityAuditEvent;
  getSecurityAuditLogs(limit?: number): Promise<SecurityAuditEvent[]> | SecurityAuditEvent[];
  rebuildHashChainForAgent?(agentId?: string): Promise<void> | void;
  getLastTransactionHash?(agentId?: string): Promise<string> | string;
  expireStaleTransactions?(agentId?: string): Promise<number> | number;
}


