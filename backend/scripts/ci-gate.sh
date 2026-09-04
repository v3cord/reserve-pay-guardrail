#!/usr/bin/env bash
# ci-gate.sh — Reserve Pay Guardrail CI Gate
# Run from backend/ directory: bash scripts/ci-gate.sh
set -euo pipefail

BACKEND_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$BACKEND_DIR"

echo "════════════════════════════════════════════════════════════"
echo "  Reserve Pay Guardrail — CI Gate"
echo "  $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
echo "════════════════════════════════════════════════════════════"

# ── Step 1: Lint ─────────────────────────────────────────────────────────────
echo ""
echo "▶ Step 1/5: ESLint"
npm run lint
echo "  ✓ Lint passed"

# ── Step 2: TypeScript type check ─────────────────────────────────────────────
echo ""
echo "▶ Step 2/5: TypeScript (noEmit)"
npx tsc --noEmit
echo "  ✓ Type check passed"

# ── Step 3: Tests ─────────────────────────────────────────────────────────────
echo ""
echo "▶ Step 3/5: Tests"
npm test
echo "  ✓ All tests passed"

# ── Step 4: AI Benchmark (safety gate — exit 1 if unsafe authorization) ───────
echo ""
echo "▶ Step 4/5: AI Intent Benchmark (injection safety)"
npx tsx tests/benchmark-ai.ts
echo "  ✓ Benchmark passed — 0% unsafe authorization rate"

# ── Step 5: Secret scan ────────────────────────────────────────────────────────
echo ""
echo "▶ Step 5/5: Secret scan"

# Scan for live Razorpay keys (should never appear in source)
if grep -rn "rzp_live_" \
     --include="*.ts" --include="*.tsx" --include="*.js" --include="*.json" \
     --exclude-dir=node_modules --exclude-dir=.next \
     . 2>/dev/null | grep -v ".env.example"; then
  echo "  ✗ FAIL: Live Razorpay key (rzp_live_*) found in source files"
  exit 1
fi

# Scan for real secret key patterns (not in .env.example)
if grep -rn "RAZORPAY_KEY_SECRET\s*=\s*[^y]" \
     --include="*.ts" --include="*.tsx" --include="*.js" \
     --exclude-dir=node_modules --exclude-dir=.next \
     . 2>/dev/null; then
  echo "  ✗ FAIL: RAZORPAY_KEY_SECRET assignment found in source"
  exit 1
fi

# Verify .env.local is not committed
if git ls-files --error-unmatch .env.local 2>/dev/null; then
  echo "  ✗ FAIL: .env.local is tracked by git — remove it and rotate credentials"
  exit 1
fi

# Verify only NEXT_PUBLIC_ key is exposed to browser
PUBLIC_SECRETS=$(grep -rn "NEXT_PUBLIC_" \
  --include="*.ts" --include="*.tsx" \
  --exclude-dir=node_modules --exclude-dir=.next \
  . 2>/dev/null | grep -v "NEXT_PUBLIC_RAZORPAY_KEY_ID" || true)

if [ -n "$PUBLIC_SECRETS" ]; then
  echo "  ⚠ WARNING: Unexpected NEXT_PUBLIC_ variables found (review if any are secrets):"
  echo "$PUBLIC_SECRETS"
fi

echo "  ✓ Secret scan passed"

# ── Step 6: Build ─────────────────────────────────────────────────────────────
echo ""
echo "▶ Step 6/5: Production build"
npm run build
echo "  ✓ Build passed"

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "════════════════════════════════════════════════════════════"
echo "  SUBMISSION READY: YES"
echo "  All 6 checks passed."
echo "════════════════════════════════════════════════════════════"
echo ""
