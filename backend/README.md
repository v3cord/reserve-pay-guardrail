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
SQLite / PostgreSQL atomically reserves funds.
↓
Razorpay executes the approved payment.↓
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

**Concurrency-safe fund reservation.** SQLite uses `BEGIN IMMEDIATE` transactions. PostgreSQL uses `SERIALIZABLE` isolation with `SELECT ... FOR UPDATE`. A distributed atomic token bucket (Vercel KV / Upstash via Lua eval, or ioredis TCP Redis via Lua eval, falling back to in-memory) provides an additional ephemeral coordination layer. Zero overspend is enforced at the database level.

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
- Optional: Vercel KV (Upstash) or a plain Redis instance for the distributed token bucket — falls back to in-memory if not configured

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

See `.env.example` for all required and optional variables. Key variables:

| Variable | Purpose |
|---|---|
| `GEMINI_API_KEY` | Google Gemini API for intent parsing |
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` | Razorpay API credentials |
| `RAZORPAY_WEBHOOK_SECRET` | Webhook HMAC verification |
| `NEXT_PUBLIC_RAZORPAY_KEY_ID` | Publishable key for browser |
| `DATABASE_URL` | PostgreSQL connection string (omit for SQLite) |
| `ADMIN_API_KEY` / `AGENT_API_KEY` | API authentication keys |
| `JWT_SECRET` | Session JWT signing secret (min 32 chars) |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | Vercel KV (Upstash) — injected automatically by Vercel when you add a KV store |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | Direct Upstash REST env var names (alternative to KV_*) |
| `REDIS_URL` | Plain TCP Redis via ioredis (local dev / self-hosted) |

The system runs fully in mock mode without real Razorpay or Gemini credentials — mock mode is clearly labeled in the UI.

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

Click **ATTACK GUARDRAIL** in the dashboard to run adversarial scenarios against the real backend:

| Scenario | Expected Outcome |
|----------|-----------------|
| Amount overflow | DENIED — no Razorpay order |
| Merchant violation | DENIED — no Razorpay order |
| Category violation | DENIED — no Razorpay order |
| Quantity anomaly | DENIED / REVIEW |
| Prompt injection | SAFE — policy clamped within limits |
| Duplicate request | DEDUPLICATED — second call returns cached |
| Concurrent race | SAFE CONCURRENCY — zero overspend |
| Gateway timeout → reconcile | RECONCILED — reservation released or order found |

---

## MCP Integration

The repo includes an MCP server (`backend/mcp-server/`) for Claude Desktop, Cursor, and custom agent runtimes:

```json
{
  "mcpServers": {
    "reserve-pay": {
      "command": "npx",
      "args": ["tsx", "path/to/backend/mcp-server/index.ts"]
    }
  }
}
```

Tools exposed:
- `reserve_check_budget` — returns real-time available budget, held funds, and active policy
- `reserve_request_purchase` — evaluates and atomically executes a purchase through the guardrail
- `reserve_explain_policy` — returns a plain-language explanation of spending restrictions

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
| Concurrency safety | ✅ Verified via tests |
| Token bucket (Vercel KV / Upstash / REDIS_URL set) | ✅ Distributed atomic Lua acquire |
| Token bucket (no Redis env vars set) | ⚠️ In-memory fallback |

---

## License

MIT — Built for Autonomous AI Commerce.
