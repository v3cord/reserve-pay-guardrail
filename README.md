# Reserve Pay Guardrail

> The Financial Policy Engine and Guardrail for Autonomous AI Commerce

[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue.svg)](https://www.typescriptlang.org/)
[![Next.js](https://img.shields.io/badge/Next.js-14.2-black.svg)](https://nextjs.org/)
[![Model Context Protocol](https://img.shields.io/badge/MCP-Native-purple.svg)](https://modelcontextprotocol.io/)
[![Payments](https://img.shields.io/badge/Payments-Razorpay%20API-0C2340.svg)](https://razorpay.com/)
[![LLM Engine](https://img.shields.io/badge/LLM-Gemini%20Flash-4285F4.svg)](https://ai.google.dev/)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

---

## Overview

When autonomous AI agents make real-world purchases (such as food delivery, cloud infrastructure, SaaS subscriptions, and travel bookings), granting them direct access to API credentials or payment cards introduces severe financial liabilities:

- Prompt Injection and Jailbreaks: Adversaries manipulate agent goals to drain treasury balances or order unauthorized inventory.
- Runaway Agent Loops and Race Conditions: Multiple concurrent agent threads dispatching parallel transactions that blow past session caps.
- Vendor and Category Violations: Agents executing transactions with unapproved, high-risk, or fraudulent merchants.
- Ledger Drift and Untracked Funds: Lack of a tamper-evident, cryptographically verifiable record explaining why money moved.

Reserve Pay Guardrail is a deterministic financial policy engine that sits between natural language agent intent and physical payment execution:

```
[ Natural Language Intent ] -> ( Gemini Policy Synthesis ) -> [ Guardrail Policy ]
                                                                       |
[ Agent Purchase Request  ] -------------------------------------------+
         |
         v
[ 1. Multi-Factor Deterministic Guardrail Check ]
   |-- Merchant Allowlist & Sub-Brand Normalization
   |-- Category & MCC Code Verification
   |-- Single-Transaction Ceiling Check (Fail-Safe: Deny if undefined)
   |-- Near-Limit Review Trigger (80-100% of ceiling flagged for human review)
   |-- Cumulative Session Cap Check (Authoritative SQL Aggregate)
   `-- Risk-Based Quantity Anomaly Verification
         |
         v (Approved)
[ 2. Atomic Financial Reservation ]
   `-- PostgreSQL SERIALIZABLE + SELECT FOR UPDATE / SQLite BEGIN IMMEDIATE
         |
         v
[ 3. Payment Gateway Order Creation (Razorpay) ]
   |-- SUCCESS --------------> Order Attached to Active Reservation
   |-- DEFINITE FAILURE -----> Immediate Reservation Release & Compensation
   `-- UNKNOWN (Timeout) ----> Flagged for Background Reconciler
         |
         v
[ 4. Payment Capture & Compensating Settlement ]
   `-- Webhook Signature Verification + Triple-Binding Validation
         |
         v
[ 5. Tamper-Evident Append-Only Cryptographic Audit Ledger ]
   `-- Cryptographically Chained SHA-256 Event Stream
```

---

## Key Architectural Principles

### 1. AI Never Authorizes Money
The generative model (Google Gemini) is strictly limited to extracting structured spending policy parameters (spending ceiling, product category, allowed merchants, quantity limits). All allow, review, or deny decisions are executed by a zero-dependency deterministic rule engine. Policy values are hard-clamped at the boundary (amount ceiling <= INR 1,00,000; session cap <= INR 10,00,000) so no synthesized instruction can grant unbounded financial authority.

### 2. Atomic Local Reservation and Zero Overspend
Every transaction must acquire a local atomic lock on `heldPaise` before any external payment gateway API is contacted:
- PostgreSQL: Executed under `SERIALIZABLE` transaction isolation with row-level locks (`SELECT ... FOR UPDATE`) on the agent's reserve state record.
- SQLite: Executed within `BEGIN IMMEDIATE` transactions to prevent dirty reads and write races.
- Token Bucket Layer: Ephemeral rate coordination powered by atomic Redis/Upstash Lua scripts (or in-memory token bucket) to absorb high-velocity denial-of-service attempts before touching persistent database storage.

### 3. Three-Way Gateway Outcome Handling
External payment calls have three distinct execution states:
1. Success: Razorpay order ID is bound to the local reservation and recorded in the cryptographic ledger.
2. Definite Failure: The local reservation is released immediately, unlocking funds with zero leakage.
3. Unknown Outcome (Network Timeout / Gateway Drop): The reservation is flagged as `order_creation_unknown`. A dedicated background reconciler polls the payment gateway to locate or safely release the held funds.

### 4. Tamper-Evident SHA-256 Ledger
Every financial event (`RESERVATION_CREATED`, `ORDER_ATTACHED`, `ORDER_UNKNOWN_FLAGGED`, `ORDER_RECONCILED`, `PAYMENT_CAPTURED`, `RESERVATION_RELEASED`, `RESERVATION_EXPIRED`) is logged to an immutable append-only ledger. Each record is cryptographically linked:

```
Hash_N = SHA-256(id : transactionId : eventType : timestamp : payloadHash : sequenceNum : prevHash_{N-1})
```

Any modification, truncation, or reordering of historic rows invalidates downstream hashes, detectable via `verifyLedgerIntegrity()`.

### 5. Multi-Layer Prompt Injection and Jailbreak Sanitization
Incoming agent prompts pass through a defensive filter prior to policy parsing:
- Stripping zero-width characters, invisible unicode, and control characters.
- Decoding obfuscated URL encoding, hexadecimal escapes, and base64 layers.
- Neutralizing leetspeak and common delimiter injection strategies.
- Structural XML isolation to separate system instructions from untrusted user payloads.
- Multi-lingual keyword filters for English, Hindi, Hinglish, and Spanish jailbreak patterns.

---

## System Dashboard Panels

The interactive control dashboard (`/dashboard`) provides operational controls and real-time observability:

1. Agent Commerce Flow (Panel 01): Interactive end-to-end purchasing pipeline. Natural language intent is parsed into policy, matched against catalog products, evaluated through the guardrail, reserved atomically, and dispatched to Razorpay.
2. Real-Time Reserve & Ledger State (Panel 02): Live visualization of total budget, held reservations, settled payments, available balance, and verified cryptographic hash integrity.
3. Policy Rules Engine (Panel 03): Active policy rules displaying amount ceiling, merchant mode, allowed vendors, category, and session caps.
4. Adversarial Attack Suite (Panel 04): One-click execution of 8 security test scenarios against real backend logic.
5. Model Context Protocol Integration (Panel 05): Live inspector for MCP client requests (`reserve_check_budget`, `reserve_request_purchase`, `reserve_explain_policy`).
6. Background Reconciler (Panel 06): Automated monitoring for stalled, dropped, or timed-out gateway calls with automated resolution.
7. Concurrency Attack Suite (Panel 07): High-load benchmark launching 1,000 parallel requests against the atomic reservation lock with real-time stream logging and interactive filtering.
8. Idempotency Replay (Panel 08): Replay attack simulator testing duplicate prevention via client tokens and payload hashing.
9. Manual Simulator and Policy Tools (Panel 09): Administrative utilities to update policies, test custom transaction payloads, and inspect raw ledger events.

---

## Adversarial Attack Scenarios

| Scenario | Attack Vector | Expected Enforcement |
|---|---|---|
| 01. Amount Overflow | Request exceeds single transaction limit | DENIED: Amount ceiling violation |
| 02. Merchant Violation | Request targeting unapproved vendor | DENIED: Merchant allowlist restriction |
| 03. Category Violation | Intent ordering prohibited MCC / category | DENIED: Category mismatch |
| 04. Quantity Anomaly | Bulk order exceeding reasonable quantities | DENIED or REVIEW: Quantity anomaly trigger |
| 05. Prompt Injection | Adversarial payload attempting to override limits | SAFE: Hard safety clamping enforced |
| 06. Idempotency Replay | Duplicate purchase attempts with identical key | DEDUPLICATED: Cached response returned |
| 07. Race Condition | Concurrent threads competing for remaining budget | SAFE CONCURRENCY: Exactly zero overspend |
| 08. Gateway Timeout | Gateway connection dropped during order creation | RECONCILED: Stalled reservation released |

---

## Model Context Protocol (MCP) Server

The repository includes a native Model Context Protocol server located in `backend/mcp-server/`. It can be integrated into Cursor, Claude Desktop, or custom agent frameworks.

### Configuration (`claude_desktop_config.json` or Cursor MCP settings)

```json
{
  "mcpServers": {
    "reserve-pay": {
      "command": "npx",
      "args": ["tsx", "path/to/backend/mcp-server/index.ts"],
      "env": {
        "API_BASE_URL": "http://localhost:3000",
        "AGENT_API_KEY": "agent_api_key_default"
      }
    }
  }
}
```

### Exposed Tools

- `reserve_check_budget`: Retrieves active policy constraints, available reserve balance, held funds, and settled spend for an agent ID.
- `reserve_request_purchase`: Evaluates and executes a product purchase through the deterministic guardrail, locking funds and creating a payment gateway order.
- `reserve_explain_policy`: Produces a natural-language breakdown of active spending rules, merchant allowlists, and category restrictions.

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

## Getting Started

### Prerequisites

- Node.js 18.0.0 or higher
- npm 9.0.0 or higher
- Optional: PostgreSQL / Supabase connection (SQLite is used automatically if `DATABASE_URL` is omitted)
- Optional: Redis / Upstash connection (In-memory token bucket is used automatically if Redis credentials are omitted)

### Installation

```bash
# Clone the repository
git clone https://github.com/v3cord/reserve-pay-guardrail.git
cd reserve-pay-guardrail/backend

# Install dependencies
npm install

# Configure environment variables
cp .env.example .env.local
```

### Environment Configuration

Configure `backend/.env.local` according to your deployment target:

```bash
# AI Intent Parser (Optional - falls back to deterministic parsing if omitted)
GEMINI_API_KEY=your_gemini_api_key

# Payment Gateway (Optional - falls back to mock mode if omitted)
RAZORPAY_KEY_ID=rzp_test_your_key_id
RAZORPAY_KEY_SECRET=your_key_secret
RAZORPAY_WEBHOOK_SECRET=your_webhook_secret
NEXT_PUBLIC_RAZORPAY_KEY_ID=rzp_test_your_key_id

# Database Configuration (Optional - uses SQLite if omitted)
DATABASE_URL=postgresql://user:password@host:6543/postgres

# API Security and Authentication
ADMIN_API_KEY=admin_api_key_default
AGENT_API_KEY=agent_api_key_default
AGENT_HMAC_SECRET=agent_hmac_secret_default
JWT_SECRET=guardrail_jwt_secret_default_key_12345

# Distributed Token Bucket (Optional - uses in-memory bucket if omitted)
KV_REST_API_URL=your_upstash_rest_url
KV_REST_API_TOKEN=your_upstash_rest_token
REDIS_URL=redis://localhost:6379
```

### Starting the Application

```bash
# Start the Next.js development server
npm run dev
```

Navigate to `http://localhost:3000/dashboard` in your browser.

---

## Testing and Benchmarks

```bash
# Execute unit and integration tests
npm test

# Run the 1,000-request parallel concurrency stress benchmark
npx tsx tests/benchmark-concurrency.ts

# Run the AI intent and prompt injection benchmark
npx tsx tests/benchmark-ai.ts

# Execute type check
npx tsc --noEmit
```

---

## License

Distributed under the MIT License. See `LICENSE` for details.

