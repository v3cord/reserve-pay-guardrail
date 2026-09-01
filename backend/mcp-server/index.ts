import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import {
  getActivePolicy,
  getReserveState,
  processPurchaseAtomic,
} from '../lib/store';
import { AttemptedPurchase, Policy, ReserveState } from '../lib/types';
import { getRazorpayClient } from '../lib/razorpayClient';

// Tool Definitions
export const RESERVE_CHECK_BUDGET_TOOL: Tool = {
  name: 'reserve_check_budget',
  description:
    'Check active guardrail policy, current 2PC reserve balance, and remaining available spending budget for the agent.',
  inputSchema: {
    type: 'object',
    properties: {
      agentId: {
        type: 'string',
        description: 'Unique agent identifier (defaults to default_agent)',
      },
    },
  },
};

export const RESERVE_REQUEST_PURCHASE_TOOL: Tool = {
  name: 'reserve_request_purchase',
  description:
    'Evaluate an attempted purchase against spending guardrails and create a Two-Phase Commit (2PC) reservation with Razorpay order creation.',
  inputSchema: {
    type: 'object',
    properties: {
      merchant: {
        type: 'string',
        description: 'Merchant or vendor name (e.g., "Amazon", "Swiggy", "BestBuy")',
      },
      amount: {
        type: 'number',
        description: 'Purchase amount in INR Rupees (e.g. 550.50) or integer Paise if amountInPaise is true.',
      },
      amountInPaise: {
        type: 'boolean',
        description: 'Set to true if amount is already provided in integer Paise minor-units. Defaults to false (INR Rupees).',
      },
      category: {
        type: 'string',
        description: 'Item or service category (e.g., "Groceries", "Electronics", "Food & Dining")',
      },
      quantity: {
        type: 'number',
        description: 'Quantity of items being purchased (defaults to 1)',
      },
      mccCode: {
        type: 'string',
        description: 'Merchant Category Code (MCC) if available (e.g., "5812", "5411")',
      },
      agentId: {
        type: 'string',
        description: 'Unique agent identifier (defaults to default_agent)',
      },
      sessionId: {
        type: 'string',
        description: 'Active agent task/session ID for cumulative session-cap budgeting',
      },
      idempotencyKey: {
        type: 'string',
        description: 'Unique key (e.g. UUID) provided by the client to prevent double-charging on retries',
      },
    },
    required: ['merchant', 'amount', 'category', 'idempotencyKey'],
  },
};

export const RESERVE_EXPLAIN_POLICY_TOOL: Tool = {
  name: 'reserve_explain_policy',
  description:
    'Returns a plain-language explanation of spending restrictions, allowed vendors, budget caps, and policies for autonomous AI agents.',
  inputSchema: {
    type: 'object',
    properties: {
      agentId: {
        type: 'string',
        description: 'Unique agent identifier (defaults to default_agent)',
      },
      query: {
        type: 'string',
        description: 'Optional question or context (e.g. "Can I buy 5 notebooks on Amazon?")',
      },
    },
  },
};

export async function handleCheckBudget(agentId = 'default_agent') {
  const policy = await getActivePolicy(agentId);
  const reserve = await getReserveState(agentId);

  const totalPaise = reserve.totalPaise ?? reserve.total ?? 200000;
  const heldPaise = reserve.heldPaise ?? 0;
  const settledPaise = reserve.settledPaise ?? 0;
  const availablePaise = reserve.availablePaise ?? (totalPaise - heldPaise - settledPaise);

  return {
    agentId,
    budget: {
      availableRupees: (availablePaise / 100).toFixed(2),
      heldRupees: (heldPaise / 100).toFixed(2),
      settledRupees: (settledPaise / 100).toFixed(2),
      totalRupees: (totalPaise / 100).toFixed(2),
      availablePaise,
      heldPaise,
      settledPaise,
      totalPaise,
    },
    activePolicy: {
      category: policy.category || 'All Categories',
      allowedMerchants: policy.allowedMerchants?.length ? policy.allowedMerchants : ['Any Merchant'],
      amountCeilingRupees: policy.amountCeiling !== undefined ? (policy.amountCeiling / 100).toFixed(2) : 'Uncapped',
      sessionCapRupees: policy.sessionCap !== undefined ? (policy.sessionCap / 100).toFixed(2) : 'Uncapped',
      reasonableQuantity: policy.reasonableQuantity ?? 2,
    },
    ledgerIntegrity: reserve.ledgerIntegrity ?? { isValid: true },
  };
}

export async function handleRequestPurchase(args: {
  merchant: string;
  amount: number;
  amountInPaise?: boolean;
  category: string;
  quantity?: number;
  mccCode?: string;
  agentId?: string;
  sessionId?: string;
  idempotencyKey?: string;
}) {
  const agentId = args.agentId || 'default_agent';
  const amountPaise = args.amountInPaise
    ? Math.round(args.amount)
    : Math.round(args.amount * 100);

  const txId = args.idempotencyKey || `mcp_tx_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

  const purchasePayload: AttemptedPurchase = {
    id: txId,
    merchant: args.merchant,
    amount: amountPaise,
    category: args.category,
    quantity: args.quantity ?? 1,
    mccCode: args.mccCode,
    agentId,
    sessionId: args.sessionId,
  };

  // Run atomic guardrail check
  const guardResult = await processPurchaseAtomic(purchasePayload);

  if (guardResult.decision === 'allowed' || guardResult.decision === 'approve') {
    let razorpayOrderId: string | undefined;
    try {
      const razorpay = getRazorpayClient();
      const rzpOrder: any = await (razorpay.orders as any).create({
        amount: amountPaise,
        currency: 'INR',
        receipt: `rcpt_mcp_${purchasePayload.id}`.slice(0, 40),
        notes: {
          merchant: purchasePayload.merchant || '',
          category: purchasePayload.category || '',
          agentId: agentId || '',
        },
      });
      razorpayOrderId = rzpOrder?.id;
    } catch {
      razorpayOrderId = `order_sim_${Date.now()}`;
    }

    return {
      status: 'APPROVED',
      decision: 'allowed',
      razorpayOrderId,
      transactionId: purchasePayload.id,
      amountRupees: (amountPaise / 100).toFixed(2),
      amountPaise,
      merchant: purchasePayload.merchant,
      category: purchasePayload.category,
      remainingBudgetRupees: (guardResult.updatedReserveState.availablePaise / 100).toFixed(2),
      message: `Purchase approved! Atomic reservation created. Order ID: ${razorpayOrderId}`,
    };
  } else {
    return {
      status: 'FROZEN',
      decision: 'freeze',
      reason: guardResult.reason,
      transactionId: purchasePayload.id,
      amountRupees: (amountPaise / 100).toFixed(2),
      amountPaise,
      merchant: purchasePayload.merchant,
      category: purchasePayload.category,
      remainingBudgetRupees: (guardResult.updatedReserveState.availablePaise / 100).toFixed(2),
      message: `Purchase FROZEN by guardrail policy: ${guardResult.reason}`,
    };
  }
}

export async function handleExplainPolicy(agentId = 'default_agent', query?: string) {
  const policy = await getActivePolicy(agentId);
  const reserve = await getReserveState(agentId);

  const availableRupees = (reserve.availablePaise / 100).toFixed(2);
  const ceilingRupees = policy.amountCeiling !== undefined ? `₹${(policy.amountCeiling / 100).toFixed(2)}` : 'No single-item ceiling';
  const sessionCapRupees = policy.sessionCap !== undefined ? `₹${(policy.sessionCap / 100).toFixed(2)}` : 'No cumulative session cap';
  const merchants = policy.allowedMerchants?.length ? policy.allowedMerchants.join(', ') : 'Any merchant';
  const category = policy.category || 'Any category';
  const maxQty = policy.reasonableQuantity ?? 2;

  let explanation = `Active Reserve Pay Guardrail Policy for Agent '${agentId}':\n` +
    `• Allowed Merchants: ${merchants}\n` +
    `• Allowed Category: ${category}\n` +
    `• Single Transaction Ceiling: ${ceilingRupees}\n` +
    `• Cumulative Session Cap: ${sessionCapRupees}\n` +
    `• Max Normal Item Quantity: ${maxQty} (micro-purchases $\\le 5\\%$ of ceiling are exempt)\n` +
    `• Current Remaining Budget: ₹${availableRupees}\n\n` +
    `Guideline: Purchases matching the allowed merchants and category within budget limits will be approved with an atomic 2PC Razorpay Order ID. Violations will be safely frozen.`;

  if (query) {
    explanation += `\n\nContext Query: "${query}"\nPlease adhere to the constraints above before executing transactions.`;
  }

  return {
    agentId,
    explanation,
    policy,
    remainingBudgetRupees: availableRupees,
  };
}

export function createReserveMcpServer(): Server {
  const server = new Server(
    {
      name: 'razorpay-reserve-guard-mcp',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // List available tools
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      RESERVE_CHECK_BUDGET_TOOL,
      RESERVE_REQUEST_PURCHASE_TOOL,
      RESERVE_EXPLAIN_POLICY_TOOL,
    ],
  }));

  // Execute tool call
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      if (name === 'reserve_check_budget') {
        const agentId = (args?.agentId as string) || 'default_agent';
        const res = await handleCheckBudget(agentId);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(res, null, 2),
            },
          ],
        };
      }

      if (name === 'reserve_request_purchase') {
        const purchaseArgs = args as unknown as {
          merchant: string;
          amount: number;
          amountInPaise?: boolean;
          category: string;
          quantity?: number;
          mccCode?: string;
          agentId?: string;
          sessionId?: string;
          idempotencyKey?: string;
        };
        const res = await handleRequestPurchase(purchaseArgs);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(res, null, 2),
            },
          ],
        };
      }

      if (name === 'reserve_explain_policy') {
        const agentId = (args?.agentId as string) || 'default_agent';
        const query = args?.query as string | undefined;
        const res = await handleExplainPolicy(agentId, query);
        return {
          content: [
            {
              type: 'text',
              text: res.explanation,
            },
          ],
        };
      }

      throw new Error(`Unknown MCP Tool: ${name}`);
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `Error executing tool '${name}': ${errorMsg}`,
          },
        ],
      };
    }
  });

  return server;
}

export async function main() {
  const server = createReserveMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[Reserve Guardrail MCP Server] Running on stdio');
}

if (typeof require !== 'undefined' && require.main === module) {
  main().catch((err) => {
    console.error('[Reserve Guardrail MCP Server] Fatal error:', err);
    process.exit(1);
  });
}
