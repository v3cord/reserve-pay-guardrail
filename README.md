# Reserve Pay Guardrail

> **The layer that sits between 'agent decides' and 'money moves.'**

[![Node.js Version](https://img.shields.io/badge/node.js-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue.svg)](https://www.typescriptlang.org/)
[![Next.js](https://img.shields.io/badge/Next.js-14.2-black.svg)](https://nextjs.org/)
[![MCP](https://img.shields.io/badge/Model_Context_Protocol-Native-purple.svg)](https://modelcontextprotocol.io/)
[![Tests](https://img.shields.io/badge/tests-115%20passed-success.svg)](https://vitest.dev/)
[![Razorpay](https://img.shields.io/badge/Payments-Razorpay%20SDK-0C2340.svg)](https://razorpay.com/)
[![LLM Engine](https://img.shields.io/badge/LLM-Gemini%203.6%20Flash-4285F4.svg)](https://ai.google.dev/)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

---

## Table of Contents

- [Overview](#overview)
- [System Architecture](#system-architecture)
- [Key Features](#key-features)
- [Repository Structure](#repository-structure)
- [Model Context Protocol (MCP) Integration](#model-context-protocol-mcp-integration)
- [TypeScript Agent SDK (`@razorpay/reserve-guard`)](#typescript-agent-sdk-razorpayreserve-guard)
- [API Reference](#api-reference)
- [Concurrency & Two-Phase Commit (2PC)](#concurrency--two-phase-commit-2pc)
- [Tamper-Evident Cryptographic Ledger](#tamper-evident-cryptographic-ledger)
- [Security, Authentication & RBAC](#security-authentication--rbac)
- [Interactive Controller UI](#interactive-controller-ui)
- [Getting Started](#getting-started)
  - [Prerequisites](#prerequisites)
  - [Environment Configuration](#environment-configuration)
  - [Installation & Running](#installation--running)
  - [Running the Test Suite](#running-the-test-suite)
- [Benchmarks & Deterministic Proof](#benchmarks--deterministic-proof)
- [Contributing & License](#contributing--license)

---

## Overview

Autonomous AI agents are increasingly tasked with procurement, booking, dining, and resource provisioning. However, giving agents unchecked financial authority introduces catastrophic risks: runaway loops, hallucinated orders, double-spending under concurrent execution, and merchant policy violations.

**Reserve Pay Guardrail** is a distributed, real-time risk mitigation and spending control engine. It acts as an authoritative proxy between agent decision-making and payment execution, ensuring:
- **Zero Double-Spending**: Distributed 2PC holds with PostgreSQL row locks and Redis Lua token buckets.
- **Natural Language Intent Governance**: Natural language prompts are translated into deterministic JSON policies using **Google Gemini 3.6 Flash**.
- **Native AI Tooling**: Pre-built integrations for **Model Context Protocol (MCP)**, **OpenAI Function Calling**, **Anthropic Tools**, and **LangChain**.
- **Cryptographic Auditability**: SHA-256 sequence-locked tamper-evident hash chaining.
- **Fail-Closed Security**: Role-based access control (RBAC), webhook signature verification, and automated micro-purchase heuristics.

---

## System Architecture

```mermaid
flowchart TB
    subgraph AgentLayer["Autonomous AI Agents"]
        Claude["Claude Desktop / Cursor (MCP)"]
        LangChainAgent["LangChain / CrewAI / AutoGen"]
        DirectAgent["OpenAI / Custom Agent SDK"]
    end

    subgraph InterfaceLayer["Integration Layer"]
        MCP["MCP Server (STDIO / SSE)\nreserve_check_budget\nreserve_request_purchase\nreserve_explain_policy"]
        SDK["@razorpay/reserve-guard SDK\nReserveGuardClient\ncreateReserveGuardrailTool"]
        REST["Next.js REST API\n/api/purchase • /api/policy\n/api/reserve • /api/verify-payment"]
    end

    subgraph GuardrailCore["Reserve Pay Guardrail Engine"]
        Auth["RBAC & Security Filter\nADMIN_ROLE | AGENT_ROLE | WEBHOOK_ROLE"]
        NLParser["Gemini 3.6 Flash Intent Parser\nNatural Language -> Structured Policy"]
        GuardEngine["Deterministic Policy Engine\n• Merchant Least Privilege\n• Ceiling & Session Caps\n• Micro-Purchase Sanity Check\n• MCC Code Validation"]
        StateEngine["2PC State Machine & TTL Engine\nAutomatic Expiration (20s)"]
        HashChain["SHA-256 Tamper-Evident Hash Chain\nSequence-Locked Ledger"]
    end

    subgraph StorageLayer["Storage & Concurrency Engine"]
        PG[("PostgreSQL\nSELECT ... FOR UPDATE\nRow-Level Locks")]
        SQLite[("SQLite (better-sqlite3)\nWAL Mode + Immediate Locks")]
        Redis[("Redis Token Bucket\nAtomic Lua Scripts")]
    end

    subgraph PaymentLayer["Razorpay Payment Gateway"]
        OrdersAPI["Razorpay Orders API\nOrder Creation (2PC Hold)"]
        Checkout["Razorpay Checkout Modal\nCustomer Payment"]
        Webhooks["Webhook Ingestion\nHMAC-SHA256 Reconciliation"]
    end

    Claude --> MCP
    LangChainAgent --> SDK
    DirectAgent --> SDK
    MCP --> GuardrailCore
    SDK --> REST
    REST --> Auth

    Auth --> NLParser
    Auth --> GuardEngine
    GuardEngine --> StateEngine
    StateEngine --> HashChain
    
    StateEngine <--> PG
    StateEngine <--> SQLite
    StateEngine <--> Redis

    StateEngine --> OrdersAPI
    OrdersAPI --> Checkout
    Checkout --> Webhooks
    Webhooks --> StateEngine
```

---

## Key Features

| Feature | Description |
|---|---|
| **Model Context Protocol (MCP) Native** | First-class MCP server over STDIO/SSE providing tools (`reserve_check_budget`, `reserve_request_purchase`, `reserve_explain_policy`) for Claude Desktop, Cursor, and IDE extensions. |
| **Universal Agent SDK (`@razorpay/reserve-guard`)** | Lightweight TypeScript SDK with zero-boilerplate exports for OpenAI Function Calling, Anthropic Tools, LangChain `StructuredTool`, and custom agent loops. |
| **Gemini 3.6 Flash Intent Parsing** | Converts natural language directives (*"₹1000 reserve, groceries only, order dinner for 2 under ₹800"*) into deterministic JSON schemas with fallback extraction. |
| **Distributed 2PC & Zero Double-Spending** | High-concurrency transaction locking with PostgreSQL row-level locks (`SELECT ... FOR UPDATE`), Redis Lua scripts, and atomic state updates. |
| **Cryptographic Hash Chaining** | SHA-256 sequence-locked ledger where each transaction links to the previous transaction hash (`prevHash` -> `hash`), guaranteeing non-repudiation. |
| **Micro-Purchase Sanity Check** | Intelligent heuristic that prevents false-positive quantity blocks on inexpensive items (e.g. 5 sharpeners @ ₹2) while enforcing quantity limits on high-value goods. |
| **Server-Side TTL State Machine** | 20-second automatic expiration of stale pending reservations to `"skipped — agent moved on"`, preventing phantom budget lockouts. |
| **Enterprise RBAC & Fail-Closed Bootstrap** | Triple-role access control (`ADMIN_ROLE`, `AGENT_ROLE`, `WEBHOOK_ROLE`), production credential validation, and immutable security audit logs. |
| **Interactive 3-Panel Controller UI** | Projector-ready (1280x720 safe) dark-mode dashboard featuring live balance draining, policy inspection, manual overrides, and Razorpay Checkout modal settlement. |

---

## Repository Structure

```
.
├── backend/                         # Main application backend & dashboard
│   ├── app/                         # Next.js 14 App Router
│   │   ├── api/                     # REST API Endpoints
│   │   │   ├── parse-intent/        # Gemini intent parsing
│   │   │   ├── policy/              # Policy management & retrieval
│   │   │   ├── purchase/            # 2PC purchase evaluation & order creation
│   │   │   ├── release/             # 2PC reservation release endpoint
│   │   │   ├── reserve/             # Reserve ledger state & hash integrity
│   │   │   ├── stream/              # SSE real-time sync broadcaster
│   │   │   ├── verify-payment/      # Razorpay signature settlement
│   │   │   └── webhook/             # Razorpay webhook listener
│   │   ├── layout.tsx               # Root layout & theme wrapper
│   │   └── page.tsx                 # 3-Panel Interactive Controller Dashboard
│   ├── lib/                         # Core domain logic & storage engines
│   │   ├── __tests__/               # Test suites (115 passing Vitest tests)
│   │   │   ├── apiRoutes.test.ts
│   │   │   ├── auth.test.ts
│   │   │   ├── concurrencyTokenBucket.test.ts
│   │   │   ├── guardCheck.test.ts
│   │   │   ├── mcpSdk.test.ts
│   │   │   ├── parseIntent.test.ts
│   │   │   ├── remediation.test.ts
│   │   │   ├── store.test.ts
│   │   │   └── webhook.test.ts
│   │   ├── auth.ts                  # RBAC, API Key/JWT verification & audit logs
│   │   ├── crypto.ts                # SHA-256 hash chaining calculation
│   │   ├── db.ts                    # PostgreSQL Pool & SQLite (better-sqlite3) init
│   │   ├── events.ts                # Server-Sent Events (SSE) broadcaster
│   │   ├── guardCheck.ts            # Guardrail evaluation & merchant matching
│   │   ├── parseIntent.ts           # Gemini 3.6 Flash structured output parser
│   │   ├── postgresStore.ts         # PostgreSQL store with row-level locks
│   │   ├── razorpayClient.ts        # Razorpay Node SDK client wrapper
│   │   ├── sqliteStore.ts           # SQLite store with WAL mode & transactions
│   │   ├── store.ts                 # Unified store interface dispatcher
│   │   ├── tokenBucket.ts           # Redis Lua distributed token bucket
│   │   └── types.ts                 # Core TypeScript types & data contracts
│   ├── mcp-server/                  # Model Context Protocol (MCP) Server
│   │   └── index.ts                 # MCP Server with STDIO transport & tools
│   ├── sdk/                         # Official TypeScript Agent SDK
│   │   └── index.ts                 # Client, OpenAI, Anthropic & LangChain adapters
│   ├── proof.md                     # Concurrency benchmarks & proof methodology
│   ├── package.json                 # Backend dependencies and scripts
│   ├── tailwind.config.ts           # Tailwind CSS configuration
│   ├── tsconfig.json                # TypeScript compiler configuration
│   └── vitest.config.ts             # Vitest test runner configuration
├── frontend/                        # Marketing landing page and visual assets
│   ├── index.html                   # High-fidelity Framer landing page
│   └── guardrail_flow.jpg           # Architecture visualization graphic
└── README.md                        # Project documentation (this file)
```

---

## Model Context Protocol (MCP) Integration

Autonomous agents running in **Claude Desktop**, **Cursor**, **LangGraph**, or any MCP-compliant client can directly interact with Reserve Pay Guardrail.

### 1. Claude Desktop Setup
Add the server entry to your `claude_desktop_config.json` (Windows: `%APPDATA%\Claude\claude_desktop_config.json` | macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "reserve-pay-guardrail": {
      "command": "npx",
      "args": [
        "tsx",
        "d:/Gemini CLI/Razorpay/backend/mcp-server/index.ts"
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

| MCP Tool | Parameters | Description |
|---|---|---|
| `reserve_check_budget` | `agentId` (string) | Checks active policy limits, total/available balance, and 2PC held funds. |
| `reserve_request_purchase` | `merchant`, `amount`, `category`, `quantity`, `idempotencyKey`, `agentId` | Evaluates purchase against policies, creates an atomic 2PC hold, and returns a Razorpay Order ID on approval or a freeze reason. |
| `reserve_explain_policy` | `agentId`, `query` (optional) | Returns a plain-language summary of active spending rules and merchant allowances. |

---

## TypeScript Agent SDK (`@razorpay/reserve-guard`)

The SDK provides a lightweight client and zero-config tool definitions for major agent frameworks.

### 1. Installation
```bash
npm install @razorpay/reserve-guard
```

### 2. Direct Autonomous Agent Execution
```typescript
import { ReserveGuardClient } from './backend/sdk';

const guardClient = new ReserveGuardClient({
  baseUrl: 'http://localhost:3000',
  apiKey: process.env.RESERVE_GUARD_API_KEY || 'agent_api_key_default',
  agentId: 'procurement-agent-01',
});

async function main() {
  // Step 1: Check available budget
  const budget = await guardClient.checkBudget();
  console.log(`Available budget: ₹${budget.availableRupees}`);

  // Step 2: Request an authorized purchase
  const purchase = await guardClient.requestPurchase({
    merchant: 'Amazon',
    amount: 450.00, // Amount in INR
    category: 'Electronics',
    quantity: 1,
  });

  if (purchase.status === 'APPROVED') {
    console.log(`Approved! Razorpay Order ID: ${purchase.razorpayOrderId}`);
    // Agent proceeds to trigger checkout / settlement
  } else {
    console.warn(`Frozen by Guardrail: ${purchase.reason}`);
  }
}

main();
```

### 3. Multi-Framework Agent Tool Bindings
```typescript
import { createReserveGuardrailTool } from './backend/sdk';

const paymentTool = createReserveGuardrailTool({
  apiKey: process.env.RESERVE_GUARD_API_KEY,
  agentId: 'procurement-agent-01',
});

// OpenAI Function Calling:
const openaiTools = [paymentTool.openai];

// Anthropic Claude Tools:
const anthropicTools = [paymentTool.anthropic];

// LangChain StructuredTool:
const langchainTools = [paymentTool.langchain];
```

---

## API Reference

All requests require authentication headers (`X-API-Key` or `Authorization: Bearer <jwt>`).

| Endpoint | Method | Required Role | Description |
|---|---|---|---|
| `/api/parse-intent` | `POST` | `ADMIN_ROLE` | Parses natural language intent into structured JSON policy via Gemini 3.6 Flash. |
| `/api/policy` | `GET`, `POST` | `AGENT_ROLE` / `ADMIN_ROLE` | Retrieves or sets active spending rules, ceilings, and allowed merchants. |
| `/api/purchase` | `POST` | `AGENT_ROLE` / `ADMIN_ROLE` | Evaluates purchase, executes 2PC reservation, and creates Razorpay Order. |
| `/api/reserve` | `GET`, `POST` | `AGENT_ROLE` / `ADMIN_ROLE` | Retrieves ledger balance, held funds, transaction log, and SHA-256 integrity. |
| `/api/release` | `POST` | `AGENT_ROLE` / `ADMIN_ROLE` | Releases a pending 2PC hold back to available balance upon cancellation. |
| `/api/verify-payment` | `POST` | `AGENT_ROLE` / `ADMIN_ROLE` | Verifies Razorpay HMAC signature (`order_id|payment_id`) and settles 2PC hold. |
| `/api/webhook` | `POST` | `WEBHOOK_ROLE` | Ingests Razorpay webhooks (`payment.captured`, `payment.disputed`, `refund.processed`). |
| `/api/stream` | `GET` | Public / UI | Server-Sent Events (SSE) stream for real-time dashboard updates. |

---

## Concurrency & Two-Phase Commit (2PC)

Reserve Pay Guardrail solves the double-spending race condition inherent to distributed agent systems via a strict Two-Phase Commit (2PC) protocol:

```mermaid
sequenceDiagram
    autonumber
    actor Agent as Autonomous Agent
    participant Guard as Guardrail Engine
    participant Store as State Store (Postgres / Redis)
    participant RZP as Razorpay API
    actor User as Human / Checkout

    Note over Agent,Store: Phase 1: Prepare & Reserve (2PC Hold)
    Agent->>Guard: POST /api/purchase {merchant, amount, category}
    Guard->>Store: Acquire Lock & Check Policy
    alt Policy Passed & Balance Sufficient
        Store->>Store: Deduct Available Balance -> Increment Held Balance
        Guard->>RZP: Create Order (amount)
        RZP-->>Guard: Return razorpay_order_id
        Guard-->>Agent: Status: APPROVED, order_id: rzp_123
    else Policy Violation or Insufficient Funds
        Store-->>Guard: Policy Violation / Budget Exceeded
        Guard-->>Agent: Status: FROZEN, reason: "Exceeds session cap"
    end

    Note over Agent,User: Phase 2: Settle / Commit
    User->>RZP: Completes Checkout Modal
    RZP->>Guard: Webhook / Verify (payment.captured)
    Guard->>Store: Transition Status: 'reserved' -> 'captured'
    Store->>Store: Deduct Held Balance -> Increment Settled Balance
    Guard->>Guard: Append to SHA-256 Hash Chain
```

---

## Tamper-Evident Cryptographic Ledger

Every transaction is sequence-locked in an immutable SHA-256 hash chain:

$$\text{Hash}_n = \text{SHA256}(\text{id} + \text{amount} + \text{merchant} + \text{category} + \text{status} + \text{timestamp} + \text{Hash}_{n-1})$$

- **Genesis Block**: Root transaction seeded with `prevHash: "0000000000000000000000000000000000000000000000000000000000000000"`.
- **Mathematical Integrity**: Calling `verifyLedgerIntegrity()` re-computes all chained hashes. Any manual database tampering breaks the chain and flags the exact corrupted transaction index immediately.

---

## Security, Authentication & RBAC

The system enforces fail-closed Role-Based Access Control:

1. **`ADMIN_ROLE`**:
   - Access to `/api/parse-intent`, setting policies, resetting store state, and executing manual overrides.
2. **`AGENT_ROLE`**:
   - Authorized to check budget, evaluate purchases, request 2PC holds, and release reservations.
3. **`WEBHOOK_ROLE`**:
   - Specifically restricted to `/api/webhook` with mandatory Razorpay HMAC-SHA256 signature verification (`X-Razorpay-Signature`).
4. **Fail-Closed Bootstrap**:
   - In `NODE_ENV=production`, the server aborts startup if default test keys, dummy placeholders, or missing secrets are detected.
5. **Security Audit Logs**:
   - All unauthorized attempts, forbidden privilege escalations, and signature verification failures are permanently recorded in `security_audit_logs`.

---

## Interactive Controller UI

The Next.js 14 Controller Dashboard provides a live 3-panel command center tailored for presentations and demonstrations:

1. **Panel 1: Natural Language Policy & Intent Engine**
   - Natural language input bar (*"₹1000 reserve, groceries only, order dinner for 2 under ₹800"*).
   - Real-time Gemini 3.6 Flash structured JSON policy visualization.
2. **Panel 2: 2PC Reserve Status & Live Balance Draining**
   - Visual balance meter displaying Total, Available, 2PC Held, and Settled amounts.
   - Quick purchase simulation form with instant freeze/approve feedback.
3. **Panel 3: Cryptographic Ledger & Transaction Stream**
   - Live transaction feed with SHA-256 hash badges and status indicators (`reserved`, `captured`, `frozen`, `refunded`, `expired`).
   - Razorpay Checkout modal trigger for end-to-end payment settlement.

---

## Getting Started

### Prerequisites
- **Node.js**: `v18.0.0` or higher (`v20+` recommended)
- **npm**: `v9.0.0` or higher
- **PostgreSQL / Redis** *(optional, SQLite and in-memory token buckets are used by default for zero-setup local dev)*

### Environment Configuration
Create a `.env.local` file inside the `backend/` directory:

```env
# Gemini API Key (for Natural Language Intent Parsing)
GEMINI_API_KEY=your_gemini_api_key_here

# Razorpay API Credentials
RAZORPAY_KEY_ID=rzp_test_your_key_id
RAZORPAY_KEY_SECRET=your_razorpay_secret
RAZORPAY_WEBHOOK_SECRET=your_webhook_secret

# Security & RBAC Keys
ADMIN_API_KEY=admin_api_key_default
AGENT_API_KEY=agent_api_key_default
JWT_SECRET=guardrail_jwt_secret_default_key_12345

# Database & Cache (Optional - defaults to SQLite/InMemory if unset)
# DATABASE_URL=postgresql://postgres:postgres@localhost:5432/reserve_db
# REDIS_URL=redis://localhost:6379
```

### Installation & Running

```bash
# 1. Navigate to backend directory
cd backend

# 2. Install dependencies
npm install

# 3. Start development server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser to view the Product Landing Page, or visit [http://localhost:3000/dashboard](http://localhost:3000/dashboard) to access the Interactive Controller UI.

### Running the Test Suite
The project includes a comprehensive Vitest suite covering all API endpoints, concurrency locks, token bucket rate-limiting, and MCP tools:

```bash
cd backend
npm test
```

```
 Test Files  10 passed (10)
      Tests  115 passed (115)
```

---

## Benchmarks & Deterministic Proof

To validate double-spending prevention under extreme concurrency, the system was subjected to a high-concurrency race condition benchmark (`backend/proof.md`):

- **Scenario**: 100 concurrent asynchronous agents attempting to spend an identical budget at the exact same millisecond.
- **Guarantee**: Strict 2PC atomicity ensures exactly 1 transaction succeeds while 99 are safely rejected.
- **Result**: **100% Double-Spending Prevented** with 0 balance leakage.

---

## Contributing & License

Contributions are welcome! Please ensure all test suites pass (`npm test`) and code adheres to TypeScript and ESLint standards.

Distributed under the **MIT License**. See `LICENSE` for more information.
