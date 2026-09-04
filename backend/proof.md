# Reserve Pay Guardrail: Test Coverage & Proof Methodology

This document describes the real tests used to verify the financial guarantees claimed by Reserve Pay Guardrail. All proofs are executed by the actual test suite (`npm test`) against the real SQLite store with real SQLite `BEGIN IMMEDIATE` transaction semantics.

## How to Run

```bash
cd backend
npm test
```

---

## 1. Zero Overspend Under Concurrency

**Claim:** No number of concurrent purchase requests can cause total reserved + settled funds to exceed the configured reserve.

**Proof:** `tests/financialCoreInvariants.test.ts` — Invariant 8

1,000 concurrent `processPurchaseAtomic` calls are fired against a reserve of ₹1,000 (100,000 paise) with each request attempting ₹100 (10,000 paise).
- Expected allowed: exactly 10
- Expected denied: exactly 990
- Final assertion: `heldPaise + settledPaise ≤ totalPaise` and `availablePaise ≥ 0`

The SQLite `BEGIN IMMEDIATE` transaction mode serializes concurrent writes at the database level. No application-level spinlock or in-process mutex is used.

```
tests/financialCoreInvariants.test.ts
  Financial Core Invariants — 8 Required Proofs
    ✓ Invariant 8: 1,000 concurrent requests cannot overspend the reserve (SQLite serialized)
```

Also verified in `tests/concurrency.test.ts` across multiple concurrent scenarios with varying reserve sizes and request counts.

---

## 2. Available Balance Never Goes Negative

**Claim:** `availablePaise` is always ≥ 0. `totalPaise = heldPaise + settledPaise + availablePaise` holds after every operation.

**Proof:** `tests/financialCoreInvariants.test.ts` — Invariants 1, 2, 3

- Invariant 1: Reserve is filled to capacity, then a further attempt is denied. `availablePaise ≥ 0` asserted.
- Invariant 2: A reservation is released twice (idempotent). `heldPaise` stays at 0, never goes negative.
- Invariant 3: Multiple purchases verified that `heldPaise + settledPaise ≤ totalPaise`.

---

## 3. Over-Refund Prevention

**Claim:** `refundedPaise ≤ capturedPaise` for every transaction. A refund attempt exceeding the remaining refundable balance is rejected with an error.

**Proof:** `tests/financialCoreInvariants.test.ts` — Invariant 4

A transaction is captured for ₹600. Partial refunds of ₹300 and ₹250 succeed. A third refund of ₹100 is rejected because 300 + 250 + 100 = 650 > 600. The exact remainder (₹50) succeeds. A subsequent single-paise refund is then rejected because the transaction is fully refunded.

---

## 4. Denied Requests Cause Zero Financial Side Effects

**Claim:** A denied purchase (wrong merchant, amount over ceiling, category mismatch, etc.) does not alter `heldPaise`, `settledPaise`, or `availablePaise`.

**Proof:** `tests/financialCoreInvariants.test.ts` — Invariant 6

State is captured before two denied requests (unallowed merchant, amount ceiling exceeded). State is asserted identical after both denials.

---

## 5. Released Reservations Are No Longer Counted Toward Session Spend

**Claim:** After `releaseReservation()`, the released amount is subtracted from `heldPaise` and is no longer counted in the session cumulative spend, allowing subsequent purchases to succeed within the same cap.

**Proof:** `tests/financialCoreInvariants.test.ts` — Invariant 7

- Reserve ₹700. A second ₹400 purchase is denied because 700 + 400 > session cap of ₹1,000.
- ₹700 reservation is released. `heldPaise` returns to 0.
- A ₹400 purchase now succeeds because the released amount no longer counts.

---

## 6. Tamper-Evident Ledger Chain

**Claim:** Every state transition is appended as a cryptographically chained SHA-256 event. Any tampering with a past event is detected by `verifyLedgerIntegrity()`.

**Proof:** `lib/__tests__/store.test.ts`

- Three sequential purchases are made. `tx2.prevHash === tx1.hash` and `tx3.prevHash === tx2.hash` are asserted.
- `verifyLedgerIntegrity()` passes on an intact chain.
- A direct SQLite `UPDATE` tampers with `tx_tamp_2.amount`. `verifyLedgerIntegrity()` returns `{ isValid: false, corruptedIndex: 1 }`.

Concurrent appends are also verified: after 50 concurrent purchases, `verifyLedgerIntegrity()` passes and sequence numbers have no duplicates (`tests/concurrency.test.ts`).

---

## 7. Idempotent Refunds

**Claim:** Submitting the same `refundId` twice does not double-decrement `settledPaise`.

**Proof:** `tests/financialCoreInvariants.test.ts`

A ₹500 transaction is captured and a ₹200 refund is processed with `refundId = 'ref_idem_...'`. The same call is repeated. `settledPaise` remains at ₹300 (not ₹100).

---

## 8. Invalid State Transitions Are Rejected

**Claim:** The payment state machine enforces valid transitions only. `settleTransaction` on a released tx fails. `releaseReservation` on a captured tx fails. `processRefund` on a reserved (not captured) tx fails.

**Proof:** `tests/financialCoreInvariants.test.ts`

Each invalid transition returns `{ success: false, error: '...' }` with a descriptive message. No financial state is mutated.

---

## Summary

All 8 invariants are machine-verified by the test suite on every run. No simulated scripts, mocked locks, or synthetic in-process concurrency constructs are used — the proofs run against the real SQLite IMMEDIATE transaction engine that the production code also uses.
