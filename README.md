# Reserve Pay Guardrail

> **The Financial Policy Engine & Guardrail for Autonomous AI Commerce**

[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue.svg)](https://www.typescriptlang.org/)
[![Next.js](https://img.shields.io/badge/Next.js-14.2-black.svg)](https://nextjs.org/)
[![Model Context Protocol](https://img.shields.io/badge/MCP-Native-purple.svg)](https://modelcontextprotocol.io/)
[![Payments](https://img.shields.io/badge/Payments-Razorpay%20API-0C2340.svg)](https://razorpay.com/)
[![LLM Engine](https://img.shields.io/badge/LLM-Gemini%20Flash-4285F4.svg)](https://ai.google.dev/)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

---

## Overview

When autonomous AI agents make real-world purchases (food delivery, cloud resources, SaaS subscriptions, flight bookings), giving them direct API keys or payment cards introduces real financial risks:

- **Prompt Injection & Jailbreaks**: Adversaries manipulating agent goals to drain accounts or purchase unauthorized goods.
- **Runaway Agent Loops & Double-Spending**: Multiple concurrent agents making simultaneous transactions that blow past budget ceilings.
- **Unverified Merchant & Category Violations**: Agents ordering from out-of-scope or malicious merchants.
- **Untracked Ledger Drift**: No tamper-evident audit trail explaining why money moved.

**Reserve Pay Guardrail** is a financial policy engine that sits between **Agent Intent** and **Money Movement**:

```
[ Natural Language Intent ] -> ( Gemini Policy Synthesis ) -> [ Guardrail Policy ]
                                                                       │
[ Agent Purchase Request  ] ───────────────────────────────────────────┘
         │
         ▼
[ 1. Multi-Factor Deterministic Guardrail Check ]
   ├── Merchant Allowlist & Asymmetric Sub-brand Match
   ├── Category & MCC Code Verification
   ├── Single Amount Ceiling Check (fail-safe: deny if undefined)
   ├── Near-limit REVIEW (80–100% of ceiling → flagged, not auto-approved)
   ├── Cumulative Session Cap Check
   └── Risk-Based Quantity Anomaly Check (review at 1–2x, deny above 2x)
         │
         ▼ (Allowed)
[ 2. Atomic Local Financial Reservation (PostgreSQL / SQLite) ]
   └── SQLite IMMEDIATE tx / PostgreSQL SERIALIZABLE isolation + FOR UPDATE
         │
         ▼
[ 3. Razorpay Standard Order Creation ]
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

## Key Architecture Pillars

### 1. Atomic Reservation + Compensating Payment Workflow

Reserve Pay uses an **Atomic Local Reservation + Compensating Payment Workflow**:

1. **Local Atomic Lock**: SQLite `BEGIN IMMEDIATE` transaction or PostgreSQL `SERIALIZABLE` isolation with `SELECT ... FOR UPDATE` atomically verifies remaining session budget and locks the funds into `heldPaise`.
2. **Side Effect Execution**: The Razorpay order is initiated with a deterministic internal receipt reference (`rcpt_...` ≤ 40 chars).
3. **3-Way Gateway Outcome Handling**:
   - `SUCCESS`: Transaction transitions to `order_created` → captured via webhook.
   - `DEFINITE_FAILURE`: Instant local compensation (`heldPaise` released, zero funds leaked).
   - `UNKNOWN_OUTCOME` (Network Timeout / Gateway Drop): Flagged as `order_creation_unknown` → picked up by the background reconciler.

### 2. Multi-Layer Prompt Injection & Jailbreak Defense

- Zero-width space and invisible Unicode character stripping.
- Base64, Hex, and URL-encoded payload decoding before inspection.
- Leetspeak unmasking (`1gn0r3` → `ignore`, `byp4ss` → `bypass`).
- Strict schema enforcement via Google Gemini structured JSON generation.
- Hardcoded ceiling clamps (`amountCeiling ≤ ₹1,00,000`, `sessionCap ≤ ₹10,00,000`) preventing any synthesized policy from granting unbounded financial access.

### 3. Tamper-Evident Append-Only Cryptographic Ledger

- Every state transition (`RESERVATION_CREATED`, `ORDER_ATTACHED`, `PAYMENT_CAPTURED`, `RESERVATION_RELEASED`, `PAYMENT_REFUNDED`, `PAYMENT_DISPUTED`) is logged to an immutable `ledger_events` table.
- Each event is cryptographically chained:

  ```
  Hash_N = SHA-256(id : transactionId : eventType : timestamp : payloadHash : sequenceNum : prevHash_{N-1})
  ```

- State updates on mutable transaction rows do not mutate historic ledger records, ensuring a tamper-evident, append-only cryptographic event history.
- `verifyLedgerIntegrity()` recalculates and checks every hash in the chain.

### 4. Zero Client-Side Credentials

- The browser dashboard never holds or stores administrative keys.
- Authentication supports **API keys**, **HttpOnly session cookies with JWT** (HS256), and **HMAC-SHA256 request signatures**, with role-based access control (`admin`, `agent`, `demo_user`).

---

## Getting Started

### Prerequisites

- Node.js 18.0.0 or higher
- npm 9.0.0 or higher
- Optional: PostgreSQL/Supabase for production storage (SQLite used by default)
- Optional: Vercel KV (Upstash) or a plain Redis instance for the distributed token bucket — falls back to in-memory if not configured

### Environment Setup

Create a `.env.local` file in the `backend/` directory (see `.env.example` for all variables):

```bash
GEMINI_API_KEY=your_google_gemini_api_key
RAZORPAY_KEY_ID=rzp_test_your_key_id
RAZORPAY_KEY_SECRET=your_razorpay_key_secret
RAZORPAY_WEBHOOK_SECRET=your_webhook_secret_here
NEXT_PUBLIC_RAZORPAY_KEY_ID=rzp_test_your_key_id
ADMIN_API_KEY=your_secure_admin_api_key
AGENT_API_KEY=your_secure_agent_api_key
JWT_SECRET=your_session_jwt_secret_min_32_chars
```

The system runs fully in mock mode without real Razorpay or Gemini credentials — mock mode is clearly labeled in the UI.

### Running Locally

```bash
cd backend
npm install
npm run dev
```

Visit `http://localhost:3000/dashboard` to launch the interactive controller dashboard.

---

## Running Tests & Benchmarks

```bash
# Run all tests (policy engine, catalog, integration, concurrency, idempotency, failures, webhooks)
npm test

# Run 1,000-request concurrency stress benchmark
npx tsx tests/benchmark-concurrency.ts

# Run AI intent & adversarial injection benchmark
npx tsx tests/benchmark-ai.ts

# Full CI gate
bash scripts/ci-gate.sh
```

---

## What the Tests Verify

| Test Suite | File | What It Covers |
|---|---|---|
| Policy engine rules | `tests/policyEngine.test.ts` | All guardrail rules: merchant, category, MCC, ceiling, session cap, quantity |
| Store & 2PC state machine | `lib/__tests__/store.test.ts` | Reserve → capture → release transitions, hash chain, concurrency |
| Concurrency control | `tests/concurrency.test.ts` | TOCTOU safety under parallel requests |
| Idempotency | `tests/idempotency.test.ts` | Duplicate request deduplication |
| Webhook security | `tests/webhookSecurity.test.ts` | HMAC-SHA256 signature verification |
| Network timeout reconciliation | `tests/networkTimeoutReconciliation.test.ts` | `order_creation_unknown` → reconcile → release |
| Guard check unit tests | `lib/__tests__/guardCheck.test.ts` | Rule engine in isolation |
| Auth | `lib/__tests__/auth.test.ts` | API key, JWT, and HMAC auth |

---

## Model Context Protocol (MCP) Integration

The repository includes an MCP server (`backend/mcp-server/`) exposing tools for Claude Desktop, Cursor, and custom agent runtimes:

- `reserve_check_budget`: Returns real-time available budget, held funds, and active policy for an agent.
- `reserve_request_purchase`: Evaluates and atomically executes a catalog purchase through the guardrail with Razorpay order creation.
- `reserve_explain_policy`: Returns a plain-language explanation of spending restrictions and allowed vendors.

---

## What Is Real vs Simulated

| Feature | Status |
|---------|--------|
| Gemini intent parsing (when API key set) | ✅ Real Gemini API call |
| Deterministic guardrail policy enforcement | ✅ Rule engine — no AI involvement |
| Atomic fund reservation | ✅ SQLite WAL / PostgreSQL SERIALIZABLE |
| Razorpay order creation (live keys) | ✅ Real Razorpay API |
| Razorpay order creation (no keys) | ⚠️ Mock — labeled in UI |
| Webhook HMAC-SHA256 verification | ✅ Real |
| Ledger SHA-256 hash chain | ✅ Real |
| Concurrency safety | ✅ Verified via test suite |
| Token bucket (Vercel KV / Upstash / REDIS_URL set) | ✅ Distributed atomic Lua acquire |
| Token bucket (no Redis env vars set) | ⚠️ In-memory fallback |

---

## License

MIT License · Built for Autonomous AI Commerce.
