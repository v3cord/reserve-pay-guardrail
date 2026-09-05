# Reserve Pay Guardrail Backend

> The Financial Policy Engine and Guardrail for Autonomous AI Commerce

[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue.svg)](https://www.typescriptlang.org/)
[![Next.js](https://img.shields.io/badge/Next.js-14.2-black.svg)](https://nextjs.org/)
[![Model Context Protocol](https://img.shields.io/badge/MCP-Native-purple.svg)](https://modelcontextprotocol.io/)
[![Payments](https://img.shields.io/badge/Payments-Razorpay%20API-0C2340.svg)](https://razorpay.com/)
[![LLM Engine](https://img.shields.io/badge/LLM-Gemini%20Flash-4285F4.svg)](https://ai.google.dev/)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](../LICENSE)

---

## What This Does

When autonomous AI agents make real-world purchases, giving them direct API credentials or credit cards creates critical financial risk. Reserve Pay Guardrail sits between agent intent and money movement:

```
AI interprets natural language intent.
  |
  v
Deterministic guardrail authorizes or denies money.
  |
  v
PostgreSQL / SQLite atomically locks reserved funds.
  |
  v
Razorpay executes approved payments.
  |
  v
Webhooks verify signature and settle capture.
  |
  v
Append-only SHA-256 ledger records every transition.
```

---

## Architecture

```
[ Natural Language Intent ] ---> Gemini Policy Synthesis ---> [ Spending Policy ]
                                                                      |
[ Agent Purchase Request ] -------------------------------------------+
         |
         v
[ Multi-Factor Deterministic Guardrail ]
   |-- Merchant Allowlist & Sub-Brand Normalization
   |-- Category & MCC Code Verification
   |-- Single-Transaction Amount Ceiling (Fail-safe: deny if undefined)
   |-- Near-Limit Review (80-100% of ceiling flagged for human review)
   |-- Cumulative Session Cap Check (Authoritative SQL aggregate)
   `-- Risk-Based Quantity Anomaly Verification
         |
         v
[ Atomic Local Financial Reservation ]
   `-- PostgreSQL SERIALIZABLE + SELECT FOR UPDATE / SQLite BEGIN IMMEDIATE
         |
         v
[ Razorpay Standard Order Creation ]
   |-- SUCCESS -------------> Order attached to active reservation
   |-- DEFINITE FAILURE ----> Immediate reservation release (zero funds leaked)
   `-- UNKNOWN (Timeout) ---> Flagged for background reconciler
         |
         v
[ Webhook-Verified Capture + Triple-Binding Validation ]
   `-- order_id + payment_id + amount must match reservation
         |
         v
[ Append-Only Cryptographic SHA-256 Event Chain ]
```

---

## Key Security Properties

- AI never authorizes money: Generative models extract spending policies. The deterministic rule engine makes every decision with zero AI involvement. Extracted limits are clamped: amountCeiling <= INR 1,00,000, sessionCap <= INR 10,00,000.
- Concurrency-safe fund reservation: SQLite uses BEGIN IMMEDIATE transactions; PostgreSQL uses SERIALIZABLE isolation with SELECT ... FOR UPDATE. Ephemeral rate limiting is coordinated via a distributed Redis Lua token bucket or in-memory bucket. Zero overspend is guaranteed under high load.
- Tamper-evident append-only audit ledger: Every financial transition is recorded with SHA-256 event chaining.
- Three-outcome gateway handling: Orders produce success, definite failure, or unknown (timeout). Every state has a deterministic compensation and reconciliation path.

---

## Getting Started

### Prerequisites

- Node.js 18.0.0 or higher
- npm 9.0.0 or higher
- Optional: PostgreSQL connection string via DATABASE_URL (defaults to SQLite if omitted)
- Optional: Redis connection string via REDIS_URL or KV_REST_API_* (defaults to in-memory if omitted)

### Installation and Run

```bash
npm install
cp .env.example .env.local
npm run dev
```

Visit `http://localhost:3000/dashboard`.

---

## Running Tests

```bash
# Unit and integration test suite
npm test

# Concurrency stress benchmark (1,000 parallel requests)
npx tsx tests/benchmark-concurrency.ts

# Adversarial prompt injection benchmark
npx tsx tests/benchmark-ai.ts

# Typecheck
npx tsc --noEmit
```

---

## Model Context Protocol (MCP) Integration

The repository includes a native MCP server (`mcp-server/index.ts`) exposing tools for Cursor, Claude Desktop, and autonomous agents:

- `reserve_check_budget`: Returns real-time available budget, held funds, and active policy.
- `reserve_request_purchase`: Evaluates and executes a purchase through the guardrail.
- `reserve_explain_policy`: Returns a plain-language explanation of active spending restrictions.

---

## Verification Matrix

| Subsystem | Production / Live Mode | Development / Fallback Mode |
|---|---|---|
| AI Intent Parsing | Live Google Gemini Flash API call | Deterministic regex / heuristic fallback |
| Policy Decision Engine | Fully deterministic TypeScript rule engine | Fully deterministic TypeScript rule engine |
| Atomic Fund Reservation | PostgreSQL SERIALIZABLE with row-level locks | SQLite WAL mode with BEGIN IMMEDIATE |
| Gateway Order Creation | Real Razorpay Orders API | Mock gateway with deterministic receipt generation |
| Webhook Verification | HMAC-SHA256 signature verification | HMAC-SHA256 signature verification |
| Event Audit Trail | SHA-256 append-only cryptographic hash chain | SHA-256 append-only cryptographic hash chain |
| Concurrency Control | Distributed Redis Lua token bucket + DB locks | In-memory token bucket + local DB locks |
| Background Reconciler | Remote Razorpay API reconciliation | Local ledger state reconciliation |

---

## License

MIT License. See LICENSE for details.
