# Reserve Pay Guardrail

> **The Financial Policy Engine & Guardrail for Autonomous AI Commerce**

[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue.svg)](https://www.typescriptlang.org/)
[![Next.js](https://img.shields.io/badge/Next.js-14.2-black.svg)](https://nextjs.org/)
[![Model Context Protocol](https://img.shields.io/badge/MCP-Native-purple.svg)](https://modelcontextprotocol.io/)
[![Payments](https://img.shields.io/badge/Payments-Razorpay%20API-0C2340.svg)](https://razorpay.com/)
[![LLM Engine](https://img.shields.io/badge/LLM-Gemini%20Flash-4285F4.svg)](https://ai.google.dev/)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

---

## What This Does

When autonomous AI agents make real-world purchases, giving them direct API keys or payment cards creates serious financial risk. Reserve Pay Guardrail sits between **Agent Intent** and **Money Movement**:

```
AI interprets intent.
↓
Deterministic guardrail authorizes money.
↓
PostgreSQL/SQLite atomically reserves funds.
↓
Razorpay executes the approved payment.
↓
Webhooks confirm payment.
↓
Append-only ledger records every transition.
```

---

## Architecture

```
[ Natural Language Intent ] ──► Gemini Policy Synthesis ──► [ Spending Policy ]
                                                                      │
[ Agent Purchase Request ] ───────────────────────────────────────────┘
         │
         ▼
[ Multi-Factor Deterministic Guardrail ]
   ├── Merchant Allowlist & Asymmetric Sub-brand Match
   ├── Category & MCC Code Verification
   ├── Single-Transaction Amount Ceiling (fail-safe: deny if undefined)
   ├── Near-limit REVIEW (80–100% of ceiling → flagged, not auto-approved)
   ├── Cumulative Session Cap Check (authoritative SQL aggregate, no LIMIT)
   └── Risk-Based Quantity Anomaly Check (review at 1–2x, deny above 2x)
         │
         ▼
[ Atomic Local Financial Reservation ]
   └── SQLite IMMEDIATE tx / PostgreSQL SERIALIZABLE isolation + FOR UPDATE
         │
         ▼
[ Razorpay Standard Order Creation ]
   ├── SUCCESS ────────────► Order attached to reservation
   ├── DEFINITE FAILURE ───► Instant reservation release (zero funds leaked)
   └── UNKNOWN (Timeout) ──► Flagged for background reconciler
         │
         ▼
[ Webhook-Verified Capture + Triple-Binding Validation ]
   └── order_id + payment_id + amount must match reservation
         │
         ▼
[ Append-Only Cryptographic SHA-256 Event Chain ]
```

---

## Key Security Properties

**AI never authorizes money.** The AI extracts a spending policy (ceiling, category, merchants). A deterministic rule engine makes every allow/deny decision with no AI involvement. Extracted policies are clamped: `amountCeiling ≤ ₹1,00,000`, `sessionCap ≤ ₹10,00,000`.

**Concurrency-safe fund reservation.** SQLite uses `BEGIN IMMEDIATE` transactions. PostgreSQL uses `SERIALIZABLE` isolation with `SELECT ... FOR UPDATE`. The Redis token bucket provides an additional ephemeral coordination layer. Zero overspend is enforced at the database level.

**Tamper-evident append-only audit ledger.** Every state transition is recorded as a ledger event with:
```
Hash_N = SHA-256(id : txId : eventType : timestamp : payloadHash : seqNum : prevHash_{N-1})
```
The global per-agent sequence and previous-hash are computed under the same lock as the append, preventing concurrent writes from breaking the chain.

**Three-outcome gateway handling.** Razorpay order creation has exactly three outcomes: success, definite failure, and unknown (timeout). Each is handled deterministically — no money is leaked in any path.

---

## Getting Started

### Prerequisites

- Node.js 18+ and npm 9+
- Optional: PostgreSQL/Supabase for production storage (SQLite used by default)
- Optional: Redis for distributed token bucket (falls back to in-memory)

### Setup

```bash
cd backend
npm install
cp .env.example .env.local
# Edit .env.local with your credentials
npm run dev
```

Visit `http://localhost:3000/dashboard`.

### Environment Variables

See `.env.example` for all required and optional variables. The system runs fully in mock mode without real Razorpay or Gemini credentials — mock mode is clearly labeled in the UI.

---

## Running Tests

```bash
# All tests (policy engine, catalog, integration, concurrency, idempotency, failures, webhooks)
npm test

# Concurrency stress benchmark (1,000 concurrent requests)
npx tsx tests/benchmark-concurrency.ts

# AI intent benchmark (adversarial injection corpus)
npx tsx tests/benchmark-ai.ts

# Full CI gate
bash scripts/ci-gate.sh
```

---

## Agent Commerce Flow (Dashboard)

1. **Type a natural language intent**: `"Order dinner for two under ₹800"`
2. **AI extracts a spending policy**: ceiling, category, allowed merchants
3. **Catalog search**: finds `Swiggy - Dinner for 2 | ₹650`
4. **Policy check**: displays `AMOUNT ✓ ₹650 < ₹800 | MERCHANT ✓ | CATEGORY ✓ | ...`
5. **Atomic reservation**: `heldPaise += 65000` under lock
6. **Razorpay order created**: `order_mock_...` (or real order in live mode)
7. **Payment captured**: webhook verifies HMAC + triple-binding → `settledPaise += 65000`
8. **Ledger event appended**: SHA-256 chained to previous event

---

## Attack Guardrail Demo

Click **ATTACK GUARDRAIL** in the dashboard to run 8 adversarial scenarios against the real backend:

| # | Scenario | Expected Outcome |
|---|----------|-----------------|
| 1 | Amount overflow | DENIED — no Razorpay order |
| 2 | Merchant violation | DENIED — no Razorpay order |
| 3 | Category violation | DENIED — no Razorpay order |
| 4 | Quantity anomaly | DENIED / REVIEW |
| 5 | Prompt injection | SAFE — policy clamped within limits |
| 6 | Duplicate request | DEDUPLICATED — second call returns cached |
| 7 | Concurrent race | SAFE CONCURRENCY — zero overspend |
| 8 | Gateway timeout → reconcile | RECONCILED — reservation released or order found |

---

## MCP Integration

The repo includes an MCP server (`backend/mcp-server/`) for Claude Desktop, Cursor, and custom agent runtimes:

```json
{
  "mcpServers": {
    "reserve-pay": {
      "command": "node",
      "args": ["path/to/backend/mcp-server/index.ts"]
    }
  }
}
```

Tools: `reserve_check_budget`, `reserve_request_purchase`, `reserve_explain_policy`.

---

## What Is Real vs Simulated

| Feature | Real |
|---------|------|
| Gemini intent parsing (when API key set) | ✅ Real Gemini API call |
| Guardrail policy enforcement | ✅ Deterministic rule engine |
| Atomic fund reservation | ✅ SQLite WAL / PostgreSQL SERIALIZABLE |
| Razorpay order creation (live keys) | ✅ Real Razorpay API |
| Razorpay order creation (no keys) | ⚠️ Mock — labeled in UI |
| Webhook verification | ✅ Real HMAC-SHA256 |
| Ledger hash chain | ✅ Real SHA-256 |
| Concurrency safety | ✅ Verified via tests |

---

## License

MIT — Built for Autonomous AI Commerce.
