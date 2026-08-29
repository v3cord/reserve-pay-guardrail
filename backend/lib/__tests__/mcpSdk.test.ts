import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  handleCheckBudget,
  handleRequestPurchase,
  handleExplainPolicy,
  createReserveMcpServer,
  RESERVE_CHECK_BUDGET_TOOL,
  RESERVE_REQUEST_PURCHASE_TOOL,
  RESERVE_EXPLAIN_POLICY_TOOL,
} from '../../mcp-server/index';
import {
  createReserveGuardrailTool,
  ReserveGuardClient,
} from '../../sdk/index';
import { resetStore, setActivePolicy, setReserveState } from '../store';

vi.mock('../razorpayClient', () => ({
  validateRazorpayConfig: vi.fn(),
  getRazorpayClient: () => ({
    orders: {
      create: vi.fn().mockImplementation(async (params) => ({
        id: `order_mcp_mock_${Date.now()}`,
        entity: 'order',
        amount: params.amount,
        currency: params.currency,
        notes: params.notes,
        status: 'created',
      })),
    },
  }),
}));

describe('Model Context Protocol (MCP) Server & Agent SDK', () => {
  beforeEach(async () => {
    await resetStore();
    await setActivePolicy({
      amountCeiling: 50000, // ₹500.00
      category: 'Electronics',
      allowedMerchants: ['Amazon', 'BestBuy'],
      sessionCap: 100000, // ₹1000.00
      reasonableQuantity: 2,
    });
    await setReserveState({
      totalPaise: 200000,
      heldPaise: 0,
      settledPaise: 0,
      transactions: [],
    });
  });

  describe('MCP Server Tool Handlers', () => {
    it('reserve_check_budget returns active policy and remaining balance', async () => {
      const result = await handleCheckBudget('default_agent');
      expect(result.agentId).toBe('default_agent');
      expect(result.budget.totalRupees).toBe('2000.00');
      expect(result.budget.availableRupees).toBe('2000.00');
      expect(result.activePolicy.category).toBe('Electronics');
      expect(result.activePolicy.allowedMerchants).toContain('Amazon');
    });

    it('reserve_request_purchase approves allowed purchase and returns Razorpay Order ID', async () => {
      const result = await handleRequestPurchase({
        merchant: 'Amazon',
        amount: 250, // ₹250.00
        category: 'Electronics',
        quantity: 1,
      });

      expect(result.status).toBe('APPROVED');
      expect(result.decision).toBe('approve');
      expect(result.razorpayOrderId).toBeDefined();
      expect(result.amountRupees).toBe('250.00');
      expect(result.remainingBudgetRupees).toBe('1750.00');
    });

    it('reserve_request_purchase freezes unallowed purchase and returns descriptive reason', async () => {
      const result = await handleRequestPurchase({
        merchant: 'UnallowedStore',
        amount: 300,
        category: 'Electronics',
      });

      expect(result.status).toBe('FROZEN');
      expect(result.decision).toBe('freeze');
      expect(result.reason?.toLowerCase()).toContain('merchant mismatch');
      expect(result.razorpayOrderId).toBeUndefined();
    });

    it('reserve_explain_policy returns human-readable spending rules', async () => {
      const result = await handleExplainPolicy('default_agent', 'Can I buy a tablet on Amazon?');
      expect(result.explanation).toContain('Active Reserve Pay Guardrail Policy');
      expect(result.explanation).toContain('Amazon, BestBuy');
      expect(result.explanation).toContain('₹500.00');
      expect(result.explanation).toContain('Context Query: "Can I buy a tablet on Amazon?"');
    });

    it('createReserveMcpServer initializes server with all three tools', async () => {
      const server = createReserveMcpServer();
      expect(server).toBeDefined();
      expect(RESERVE_CHECK_BUDGET_TOOL.name).toBe('reserve_check_budget');
      expect(RESERVE_REQUEST_PURCHASE_TOOL.name).toBe('reserve_request_purchase');
      expect(RESERVE_EXPLAIN_POLICY_TOOL.name).toBe('reserve_explain_policy');
    });
  });

  describe('TypeScript Agent SDK (@razorpay/reserve-guard)', () => {
    it('createReserveGuardrailTool exports multi-format tool bindings (OpenAI, Anthropic, LangChain)', async () => {
      const tool = createReserveGuardrailTool({
        apiKey: 'test_key',
        agentId: 'agent-007',
      });

      expect(tool.name).toBe('reserve_request_purchase');
      expect(tool.openai.type).toBe('function');
      expect(tool.openai.function.name).toBe('reserve_request_purchase');
      expect(tool.anthropic.name).toBe('reserve_request_purchase');
      expect(tool.langchain.name).toBe('reserve_request_purchase');
      expect(typeof tool.execute).toBe('function');
    });

    it('ReserveGuardClient handles API calls and response parsing', async () => {
      const client = new ReserveGuardClient({
        baseUrl: 'http://localhost:3000',
        apiKey: 'test_key',
      });

      // Mock global fetch for SDK testing
      const originalFetch = global.fetch;
      global.fetch = vi.fn().mockImplementation(async (url: string, options?: RequestInit) => {
        if (url.includes('/api/purchase')) {
          const body = JSON.parse(options?.body as string);
          if (body.merchant === 'Amazon') {
            return {
              json: async () => ({
                decision: 'approve',
                reason: 'Transaction reserved',
                razorpayOrderId: 'order_sdk_123',
                transaction: { id: 'tx_sdk_1' },
                updatedReserveState: { availablePaise: 160000 },
              }),
            };
          } else {
            return {
              json: async () => ({
                decision: 'freeze',
                reason: 'Merchant mismatch',
                updatedReserveState: { availablePaise: 200000 },
              }),
            };
          }
        }
        return { json: async () => ({}) };
      });

      try {
        const approvedRes = await client.requestPurchase({
          merchant: 'Amazon',
          amount: 400,
          category: 'Electronics',
        });
        expect(approvedRes.status).toBe('APPROVED');
        expect(approvedRes.razorpayOrderId).toBe('order_sdk_123');

        const frozenRes = await client.requestPurchase({
          merchant: 'RandomStore',
          amount: 100,
          category: 'Electronics',
        });
        expect(frozenRes.status).toBe('FROZEN');
        expect(frozenRes.reason).toContain('Merchant mismatch');
      } finally {
        global.fetch = originalFetch;
      }
    });
  });
});
