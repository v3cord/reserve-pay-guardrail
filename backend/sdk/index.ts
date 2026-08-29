/**
 * @razorpay/reserve-guard
 * Official TypeScript SDK & Agent Integration Toolkit for Razorpay Reserve Pay Guardrail.
 */

export interface ReserveGuardClientConfig {
  baseUrl?: string;
  apiKey?: string;
  agentId?: string;
  tenantId?: string;
}

export interface PurchaseRequest {
  merchant: string;
  amount: number; // in INR Rupees (e.g. 550.00) or Paise if amountInPaise is true
  amountInPaise?: boolean;
  category: string;
  quantity?: number;
  mccCode?: string;
  agentId?: string;
  sessionId?: string;
  override?: boolean;
}

export interface PurchaseResponse {
  decision: 'approve' | 'freeze';
  reason: string;
  razorpayOrderId?: string;
  transactionId?: string;
  status: 'APPROVED' | 'FROZEN';
  remainingBudgetRupees?: string;
  updatedReserveState?: {
    totalPaise: number;
    heldPaise: number;
    settledPaise: number;
    availablePaise: number;
  };
}

export interface BudgetResponse {
  agentId: string;
  availableRupees: string;
  heldRupees: string;
  settledRupees: string;
  totalRupees: string;
  availablePaise: number;
  heldPaise: number;
  settledPaise: number;
  totalPaise: number;
  policy: {
    amountCeiling?: number;
    category?: string;
    allowedMerchants: string[];
    sessionCap?: number;
    reasonableQuantity?: number;
  };
}

/**
 * Direct HTTP Client for interacting with Reserve Pay Guardrail Controller.
 */
export class ReserveGuardClient {
  private baseUrl: string;
  private apiKey: string;
  private defaultAgentId: string;
  private defaultTenantId: string;

  constructor(config: ReserveGuardClientConfig = {}) {
    this.baseUrl = (config.baseUrl || process.env.RESERVE_GUARD_API_URL || 'http://localhost:3000').replace(/\/$/, '');
    this.apiKey = config.apiKey || process.env.RESERVE_GUARD_API_KEY || 'agent_api_key_default';
    this.defaultAgentId = config.agentId || 'default_agent';
    this.defaultTenantId = config.tenantId || 'default_tenant';
  }

  private getHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'X-API-Key': this.apiKey,
      'X-Agent-ID': this.defaultAgentId,
      'X-Tenant-ID': this.defaultTenantId,
    };
  }

  async checkBudget(agentId?: string): Promise<BudgetResponse> {
    const targetAgentId = agentId || this.defaultAgentId;
    const [policyRes, reserveRes] = await Promise.all([
      fetch(`${this.baseUrl}/api/policy?agentId=${encodeURIComponent(targetAgentId)}`, {
        headers: this.getHeaders(),
      }).then((r) => r.json()),
      fetch(`${this.baseUrl}/api/reserve?agentId=${encodeURIComponent(targetAgentId)}`, {
        headers: this.getHeaders(),
      }).then((r) => r.json()),
    ]);

    const totalPaise = reserveRes.totalPaise ?? reserveRes.total ?? 200000;
    const heldPaise = reserveRes.heldPaise ?? 0;
    const settledPaise = reserveRes.settledPaise ?? 0;
    const availablePaise = reserveRes.availablePaise ?? reserveRes.remaining ?? (totalPaise - heldPaise - settledPaise);

    return {
      agentId: targetAgentId,
      availableRupees: (availablePaise / 100).toFixed(2),
      heldRupees: (heldPaise / 100).toFixed(2),
      settledRupees: (settledPaise / 100).toFixed(2),
      totalRupees: (totalPaise / 100).toFixed(2),
      availablePaise,
      heldPaise,
      settledPaise,
      totalPaise,
      policy: policyRes.policy || {},
    };
  }

  async requestPurchase(request: PurchaseRequest): Promise<PurchaseResponse> {
    const agentId = request.agentId || this.defaultAgentId;
    const amountPaise = request.amountInPaise
      ? Math.round(request.amount)
      : Math.round(request.amount * 100);

    const payload = {
      merchant: request.merchant,
      amount: amountPaise,
      category: request.category,
      quantity: request.quantity ?? 1,
      mccCode: request.mccCode,
      agentId,
      sessionId: request.sessionId,
      override: request.override,
    };

    const res = await fetch(`${this.baseUrl}/api/purchase`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(payload),
    });

    const data = await res.json();
    const isApproved = data.decision === 'approve';

    return {
      decision: data.decision,
      reason: data.reason,
      razorpayOrderId: data.razorpayOrderId,
      transactionId: data.transaction?.id,
      status: isApproved ? 'APPROVED' : 'FROZEN',
      remainingBudgetRupees: data.updatedReserveState?.availablePaise !== undefined
        ? (data.updatedReserveState.availablePaise / 100).toFixed(2)
        : undefined,
      updatedReserveState: data.updatedReserveState,
    };
  }

  async releaseReservation(orderIdOrTxId: string, reason?: string, agentId?: string): Promise<{ success: boolean; error?: string }> {
    const res = await fetch(`${this.baseUrl}/api/release`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({
        orderId: orderIdOrTxId,
        txId: orderIdOrTxId,
        reason: reason || 'Released by agent SDK',
        agentId: agentId || this.defaultAgentId,
      }),
    });
    return res.json();
  }

  async verifyPayment(params: {
    razorpay_order_id: string;
    razorpay_payment_id: string;
    razorpay_signature: string;
  }): Promise<{ success: boolean; error?: string }> {
    const res = await fetch(`${this.baseUrl}/api/verify-payment`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(params),
    });
    return res.json();
  }
}

/**
 * Universal Tool Wrapper for Autonomous Agents (OpenAI, LangChain, Anthropic, Custom Agents)
 */
export interface ReserveGuardTool {
  name: string;
  description: string;
  execute: (input: PurchaseRequest) => Promise<PurchaseResponse>;
  openai: {
    type: 'function';
    function: {
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    };
  };
  anthropic: {
    name: string;
    description: string;
    input_schema: Record<string, unknown>;
  };
  langchain: {
    name: string;
    description: string;
    schema: Record<string, unknown>;
    call: (input: PurchaseRequest) => Promise<PurchaseResponse>;
  };
}

/**
 * Factory function creating an embeddable payment tool for AI Agents.
 */
export function createReserveGuardrailTool(config: ReserveGuardClientConfig = {}): ReserveGuardTool {
  const client = new ReserveGuardClient(config);

  const parametersSchema = {
    type: 'object',
    properties: {
      merchant: {
        type: 'string',
        description: 'The vendor or merchant name (e.g. "Amazon", "Swiggy", "BestBuy")',
      },
      amount: {
        type: 'number',
        description: 'Purchase amount in INR Rupees (e.g. 550.00)',
      },
      category: {
        type: 'string',
        description: 'Item category (e.g. "Groceries", "Electronics", "Food & Dining")',
      },
      quantity: {
        type: 'number',
        description: 'Quantity of items to purchase (defaults to 1)',
      },
      mccCode: {
        type: 'string',
        description: 'Merchant Category Code (optional)',
      },
    },
    required: ['merchant', 'amount', 'category'],
  };

  const toolName = 'reserve_request_purchase';
  const toolDescription =
    'Evaluates and authorizes a purchase against the active Reserve Pay Guardrail policy. Returns an atomic Razorpay Order ID on approval or a descriptive freeze reason if violating spending rules.';

  const executeFn = async (input: PurchaseRequest) => {
    return client.requestPurchase(input);
  };

  return {
    name: toolName,
    description: toolDescription,
    execute: executeFn,
    openai: {
      type: 'function',
      function: {
        name: toolName,
        description: toolDescription,
        parameters: parametersSchema,
      },
    },
    anthropic: {
      name: toolName,
      description: toolDescription,
      input_schema: parametersSchema,
    },
    langchain: {
      name: toolName,
      description: toolDescription,
      schema: parametersSchema,
      call: executeFn,
    },
  };
}

export default ReserveGuardClient;
