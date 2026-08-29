# Reserve Pay Guardrail

> **The layer that sits between 'agent decides' and 'money moves.'**

Reserve Pay Guardrail is a distributed, real-time risk mitigation and spending control engine for autonomous AI agents and automated payment workflows. It parses natural language intent into deterministic financial policies, guarantees zero double-spending with Redis-backed atomic token buckets and PostgreSQL row-level locks, and provides native tool-calling integrations via Model Context Protocol (MCP) and the `@razorpay/reserve-guard` SDK.

---

## Key Features

- **Model Context Protocol (MCP) Native**: Official MCP server over STDIO/SSE providing `reserve_check_budget`, `reserve_request_purchase`, and `reserve_explain_policy` tools for Claude Desktop, Cursor, LangGraph, and CrewAI.
- **Universal Agent SDK (`@razorpay/reserve-guard`)**: Pre-built, multi-format tool bindings for OpenAI Function Calling, Anthropic Tools, LangChain `StructuredTool`, and custom agent runtimes.
- **Natural Language Intent Parsing**: Converts natural language prompts (e.g., *"₹1000 reserve, groceries only, order dinner for 2 under ₹800"*) into structured JSON policies using **Google Gemini 3.6 Flash** (`@google/genai`).
- **Distributed 2PC & Zero Double-Spending**: PostgreSQL state store with `SELECT ... FOR UPDATE` row locks, Redis Token-Bucket Lua scripts, and sequence-locked SHA-256 tamper-evident hash chaining.
- **Micro-Purchase Sanity Check**: Contextual evaluation of unit prices and quantities so inexpensive micro-items (e.g. 5 sharpeners @ ₹2) are permitted without false-positive freezes.
- **Server-Side TTL State Machine**: Automatic 20s expiration of stale frozen transactions to `"skipped — agent moved on"` without client-side timer fragility.
- **Live 3-Panel Controller UI**: Dark-mode, high-contrast UI tailored for projector presentations (1280x720 safe) with live balance bar draining and Razorpay Checkout modal settlement.

---

## Model Context Protocol (MCP) Setup

Autonomous agents in **Claude Desktop**, **Cursor**, or custom MCP clients can connect to Reserve Pay Guardrail natively.

### 1. Claude Desktop Configuration
Add the following entry to your `claude_desktop_config.json` (located at `%APPDATA%\Claude\claude_desktop_config.json` on Windows or `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "reserve-pay-guardrail": {
      "command": "npx",
      "args": [
        "tsx",
        "d:/Gemini CLI/Razorpay/reserve-pay-guardrail/mcp-server/index.ts"
      ],
      "env": {
        "RESERVE_GUARD_API_URL": "http://localhost:3000",
        "RESERVE_GUARD_API_KEY": "agent_api_key_default"
      }
    }
  }
}
```

### 2. Available MCP Tools

| Tool Name | Description |
|---|---|
| `reserve_check_budget` | Inspects remaining balance, held 2PC funds, and active policy rules. |
| `reserve_request_purchase` | Evaluates purchase against guardrails; returns 2PC `razorpayOrderId` or frozen reason. |
| `reserve_explain_policy` | Natural language explanation of spending limits, allowed merchants, and categories. |

---

## TypeScript Agent SDK (`@razorpay/reserve-guard`)

### 1. Installation
```bash
npm install @razorpay/reserve-guard
```

### 2. Autonomous Agent Purchase Example (Allowed vs. Frozen)

```typescript
import { createReserveGuardrailTool, ReserveGuardClient } from './sdk/index';

const guardClient = new ReserveGuardClient({
  baseUrl: 'http://localhost:3000',
  apiKey: process.env.RESERVE_GUARD_API_KEY || 'agent_api_key_default',
  agentId: 'shopping-agent-01',
});

async function runAutonomousAgent() {
  // Check budget before attempting purchases
  const budget = await guardClient.checkBudget();
  console.log(`Available budget: ₹${budget.availableRupees}`);

  // 1. Allowed Purchase (Approved with Razorpay Order ID)
  const allowed = await guardClient.requestPurchase({
    merchant: 'Amazon',
    amount: 350.00,
    category: 'Electronics',
    quantity: 1,
  });
  console.log(`Purchase 1: [${allowed.status}] Order ID: ${allowed.razorpayOrderId}`);

  // 2. Unallowed Purchase (Frozen with Descriptive Rejection Reason)
  const frozen = await guardClient.requestPurchase({
    merchant: 'UnallowedStore',
    amount: 150.00,
    category: 'Electronics',
  });
  console.log(`Purchase 2: [${frozen.status}] Reason: ${frozen.reason}`);
}

runAutonomousAgent();
```

### 3. OpenAI / LangChain Tool Integration
```typescript
import { createReserveGuardrailTool } from './sdk/index';

const paymentTool = createReserveGuardrailTool({
  apiKey: process.env.RESERVE_GUARD_API_KEY,
  agentId: 'shopping-agent-01',
});

// Pass directly to OpenAI Tools array
const tools = [paymentTool.openai];

// Or pass to LangChain agent executor
const langchainTools = [paymentTool.langchain];
```

---

## Getting Started

### Prerequisites
- **Node.js**: v18+ (v20+ recommended)
- **npm**: v9+

### Installation & Development

```bash
# Clone or navigate to the repository
cd reserve-pay-guardrail

# Install dependencies
npm install

# Run test suite (115 passing tests)
npm test

# Run development server
npm run dev
```
Open [http://localhost:3000](http://localhost:3000) in your browser.

---

## API Reference

| Endpoint | Method | Description |
|---|---|---|
| `/api/parse-intent` | `POST` | Parses natural language intent into structured `Policy` JSON using Gemini. |
| `/api/policy` | `POST` / `GET` | Updates or retrieves the active spending `Policy`. |
| `/api/purchase` | `POST` | Evaluates attempted purchase, creates 2PC hold, and issues Razorpay order ID. |
| `/api/reserve` | `GET` / `POST` | Retrieves 2PC ledger balance and cryptographic hash integrity status. |
| `/api/verify-payment` | `POST` | Verifies Razorpay HMAC signature and settles 2PC hold into captured ledger state. |
| `/api/release` | `POST` | Releases held 2PC funds back into the available budget on cancellation. |
| `/api/webhook` | `POST` | Razorpay webhook reconciliation (`payment.captured`, `payment.disputed`, `refund.processed`). |

---

## Tech Stack
- **Framework**: Next.js 14 (App Router)
- **Tool Protocols**: Model Context Protocol (`@modelcontextprotocol/sdk`)
- **Database & Concurrency**: PostgreSQL (`pg`), SQLite (`better-sqlite3`), Redis (`ioredis`)
- **Payment Gateway**: Razorpay Node SDK
- **Testing**: Vitest + React Testing Library + jsdom
- **LLM Engine**: Google Gemini 3.6 Flash (`@google/genai`)
