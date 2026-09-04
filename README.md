# Reserve Pay Guardrail

> **The Financial Policy Engine & Guardrail for Autonomous AI Commerce**

[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue.svg)](https://www.typescriptlang.org/)
[![Next.js](https://img.shields.io/badge/Next.js-14.2-black.svg)](https://nextjs.org/)
[![Model Context Protocol](https://img.shields.io/badge/MCP-Native-purple.svg)](https://modelcontextprotocol.io/)
[![Invariant Tests](https://img.shields.io/badge/Invariants-11%20Passed-success.svg)](https://vitest.dev/)
[![Payments](https://img.shields.io/badge/Payments-Razorpay%20API-0C2340.svg)](https://razorpay.com/)
[![LLM Engine](https://img.shields.io/badge/LLM-Gemini%20Flash-4285F4.svg)](https://ai.google.dev/)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

---

## 60-Second Overview

When autonomous AI agents make real-world purchases (e.g. food delivery, cloud resources, SaaS subscriptions, flight bookings), giving them direct API keys or payment cards introduces severe financial risks:
- **Prompt Injection & Jailbreaks**: Adversaries manipulating agent goals to purchase unauthorized luxury goods or drain accounts.
- **Runaway Agent Loops & Double-Spending**: Multiple concurrent subagents making simultaneous transactions that blow past budget ceilings.
- **Unverified Merchant & Category Violations**: Agents ordering from malicious, risky, or out-of-scope merchants.
- **Untracked Ledger Drift**: Lack of non-repudiable audit trails showing *why* money moved.

**Reserve Pay Guardrail** is a production-oriented prototype financial policy engine that sits between **Agent Intent** and **Money Movement**:

```
[ Natural Language Intent ] -> ( Gemini Policy Synthesis ) -> [ Guardrail Policy ]
                                                                       │
[ Agent Purchase Request  ] ───────────────────────────────────────────┘
         │
         ▼
[ 1. Multi-Factor Deterministic Guardrail Check ]
   ├── Merchant Allowlist & Asymmetric Sub-brand Match
   ├── Category & MCC Code Verification
   ├── Single Amount Ceiling Check
   ├── Cumulative Session Cap Check
   └── Risk-Based Quantity Anomaly Check
         │
         ▼ (Allowed)
[ 2. Atomic Local Financial Reservation (PostgreSQL / SQLite) ]
   └── Serializable row lock guarantees exact Paise budget hold
         │
         ▼
[ 3. Razorpay Standard Order Creation (`rcpt_...`) ]
   ├── SUCCESS ───────────────► Razorpay Order Created
   ├── DEFINITE FAILURE ──────► Instant Compensation & Release
   └── UNKNOWN (Timeout) ─────► Flagged for Reconciler
         │
         ▼
[ 4. Payment Capture & Compensating Settlement ]
   └── Webhook event-first ledger verification + state update
         │
         ▼
[ 5. Append-Only Cryptographic SHA-256 Event Chain ]
```

---

## Benchmark Scorecard

> All benchmarks were run in a local test environment against a live PostgreSQL + Redis instance.
> Reproduce any result with the commands shown below.

| Invariant / Benchmark | How to Reproduce | Result | Status |
| :--- | :--- | :--- | :--- |
| **Zero-Overspend Under Concurrency** | `npx tsx tests/benchmark-concurrency.ts` | **₹0.00 Overspend** (4/4 allowed, 996 rejected) | 🧪 **BENCHMARKED IN LOCAL TEST ENVIRONMENT** |
| **Adversarial Prompt Injection Defense** | `npx tsx tests/benchmark-intent.ts` | **100.0% Neutralized** (0 financial hallucinations) | 🧪 **BENCHMARKED IN LOCAL TEST ENVIRONMENT** |
| **Tamper-Evident Ledger Integrity** | `npm test -- --reporter=verbose` (store.test.ts) | **100% Chain Integrity Verified** | 🧪 **BENCHMARKED IN LOCAL TEST ENVIRONMENT** |
| **Durable Idempotency** | `npm test -- --reporter=verbose` (store.test.ts) | **100% Deduplicated** (0 double charges) | 🧪 **BENCHMARKED IN LOCAL TEST ENVIRONMENT** |
| **Network Timeout Reconciliation** | `npm test -- --reporter=verbose` (webhook.test.ts) | **100% State Compensation & Auto-Release** | 🧪 **BENCHMARKED IN LOCAL TEST ENVIRONMENT** |
| **Client-Side Credential Scanning** | `bash scripts/ci-gate.sh` | **0 Exposed Admin Keys** (HttpOnly JWT auth) | 🧪 **BENCHMARKED IN LOCAL TEST ENVIRONMENT** |

---

## Key Architecture Pillars

### 1. Atomic Reservation + Compensating Payment Workflow
Unlike fragile distributed two-phase commits across third-party payment gateways, Reserve Pay uses an **Atomic Local Reservation + Compensating Payment Workflow**:
1. **Local Atomic Lock**: PostgreSQL `SELECT ... FOR UPDATE` (or SQLite immediate WAL transaction) atomically verifies remaining session budget and locks the funds into `heldPaise`.
2. **Side Effect Execution**: The Razorpay order is initiated with a deterministic internal receipt reference (`rcpt_...` $\le 40$ chars).
3. **3-Way Gateway Outcome Handling**:
   - `SUCCESS`: Transaction transitions to `order_created` -> captured via webhook or checkout verification.
   - `DEFINITE_FAILURE`: Instant local compensation (`heldPaise` released, zero funds leaked).
   - `UNKNOWN_OUTCOME` (Network Timeout / Gateway Drop): Flagged as `order_creation_unknown` -> picked up by the background reconciler.

### 2. Multi-Layer Prompt Injection & Jailbreak Defense
- Zero-width space and invisible Unicode character stripping.
- Base64, Hex, and URL-encoded payload decoding before inspection.
- Leetspeak unmasking (`1gn0r3` -> `ignore`, `byp4ss` -> `bypass`).
- Strict schema enforcement via Google Gemini `Type.OBJECT` structured generation.
- Hardcoded ceiling clamps ($Ceiling \le ₹10,000$, $SessionCap \le ₹100,000$) preventing any synthesized policy from granting unbounded financial access.

### 3. Tamper-Evident Append-Only Cryptographic Ledger
- Every state transition (`RESERVATION_CREATED`, `ORDER_CREATED`, `PAYMENT_CAPTURED`, `RESERVATION_RELEASED`, `REFUND_PROCESSED`) is logged to an immutable `ledger_events` table.
- Each event is cryptographically chained:
  $$\text{Hash}_N = \text{SHA-256}(\text{ID} \parallel \text{TxID} \parallel \text{EventType} \parallel \text{Seq} \parallel \text{PayloadHash} \parallel \text{PrevHash}_{N-1})$$
- State updates on mutable transaction rows (e.g. `reserved` -> `captured`) do not mutate historic ledger records, completely eliminating false tamper alerts while ensuring a tamper-evident, append-only cryptographic event history.

### 4. Zero Client-Side Credentials
- The browser dashboard and client components never possess or store administrative keys.
- Authentication utilizes secure **HttpOnly SameSite Strict session cookies** with automated JWT validation and role-based access control (`admin`, `service`, `agent`, `demo_user`).

---

## 7-Step Interactive Agent Commerce Flow

1. **Natural Language Intent Input**: `"₹1000 reserve, groceries only, dinner for 2 under ₹800"`.
2. **Authoritative Catalog Selection**: Agent selects verified product (`Swiggy - Dinner for 2 | ₹650`).
3. **Multi-Factor Guardrail Check**: Deterministically checks single amount ceiling, merchant allowlist, category isolation, and cumulative budget.
4. **Atomic Local Reservation**: `heldPaise` incremented by `65000` under row lock.
5. **Razorpay Standard Order Creation**: Generates order with bounded amount and `rcpt_` tracking ID.
6. **Payment Capture & Compensating Settlement**: Webhook verifies HMAC-SHA256 signature, asserts triple-binding (`order_id`, `payment_id`, `amount`), settles reservation (`settledPaise += 65000`, `heldPaise -= 65000`).
7. **Tamper-Evident Audit Event**: Appends cryptographically verified ledger record.

---

## Getting Started

### Prerequisites
- Node.js 18.0.0 or higher
- npm 9.0.0 or higher

### Environment Setup
Create a `.env.local` file in the `backend/` directory:
```bash
GEMINI_API_KEY=your_google_gemini_api_key
RAZORPAY_KEY_ID=rzp_test_your_key_id
RAZORPAY_KEY_SECRET=your_razorpay_key_secret
ADMIN_API_KEY=your_secure_admin_api_key
JWT_SECRET=your_session_jwt_secret
```

### Running Locally
```bash
# Navigate to backend directory
cd backend

# Install dependencies
npm install

# Start development server (Dashboard & API)
npm run dev
```

Visit `http://localhost:3000` to launch the interactive controller dashboard.

---

## Running Invariant Tests & Benchmarks

```bash
# Run 9 Financial System Invariants & Reconciliation Tests
npm test

# Run 1,000-Request Concurrency Stress Benchmark
npx tsx tests/benchmark-concurrency.ts

# Run 500-Intent & Adversarial Injection Benchmark
npx tsx tests/benchmark-intent.ts
```

---

## Model Context Protocol (MCP) Integration

The repository includes a production MCP server (`backend/mcp-server/`) exposing tools for Claude Desktop, Cursor, and custom agent runtimes:
- `synthesize_financial_policy`: Translates natural language budget directives into verified policies.
- `execute_agent_purchase`: Safely executes catalog purchases through the guardrail.
- `check_reserve_budget`: Returns real-time available budget in integer Paise.
- `verify_ledger_integrity`: Validates the complete cryptographic hash chain.

---

## License

MIT License &bull; Built for Autonomous AI Commerce.
