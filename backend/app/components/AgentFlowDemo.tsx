'use client';

import React, { useState } from 'react';
import {
  Terminal, Search, ShieldCheck, CreditCard, ArrowRight,
  Loader2, CheckCircle2, XCircle, AlertTriangle, RotateCw,
} from 'lucide-react';
import PolicyExplanation from './PolicyExplanation';
import type { PolicyExplanation as PolicyExplanationType } from '@/lib/types';

type StepStatus = 'idle' | 'running' | 'done' | 'error' | 'review';

interface FlowState {
  parseIntent: StepStatus;
  catalogSearch: StepStatus;
  policyCheck: StepStatus;
  reservation: StepStatus;
  payment: StepStatus;
}

interface CatalogProduct {
  productId: string;
  name?: string;
  merchantName: string;
  category: string;
  priceRupees: string;
  unitPricePaise: number;
}

interface FlowResult {
  intent?: string;
  parsedPolicy?: Record<string, unknown>;
  catalogResults?: CatalogProduct[];
  selectedProduct?: CatalogProduct;
  purchaseDecision?: string;
  purchaseReason?: string;
  policyExplanation?: PolicyExplanationType;
  razorpayOrderId?: string;
  amount?: number;
  error?: string;
}

const STEP_ICONS: Record<string, React.ReactNode> = {
  parseIntent:   <Terminal className="w-3.5 h-3.5" />,
  catalogSearch: <Search className="w-3.5 h-3.5" />,
  policyCheck:   <ShieldCheck className="w-3.5 h-3.5" />,
  reservation:   <CreditCard className="w-3.5 h-3.5" />,
  payment:       <CheckCircle2 className="w-3.5 h-3.5" />,
};

const STEP_LABELS: Record<string, string> = {
  parseIntent:   'Parse Intent → Policy',
  catalogSearch: 'Catalog Search',
  policyCheck:   'Policy Check',
  reservation:   'Atomic Reservation',
  payment:       'Order Created',
};

function statusIcon(status: StepStatus) {
  switch (status) {
    case 'running': return <Loader2 className="w-3.5 h-3.5 animate-spin text-[#ff571a]" />;
    case 'done':    return <CheckCircle2 className="w-3.5 h-3.5 text-[#22c55e]" />;
    case 'error':   return <XCircle className="w-3.5 h-3.5 text-[#ff3366]" />;
    case 'review':  return <AlertTriangle className="w-3.5 h-3.5 text-[#f9c425]" />;
    default:        return <div className="w-3.5 h-3.5 rounded-full border border-[#2f3438]" />;
  }
}

interface Props {
  onPurchaseComplete?: () => void;
  triggerRazorpayCheckout?: (orderId: string, amount: number, merchant: string) => void;
}

export default function AgentFlowDemo({ onPurchaseComplete, triggerRazorpayCheckout }: Props) {
  const [intent, setIntent] = useState('Order dinner for two under ₹800');
  const [isRunning, setIsRunning] = useState(false);
  const [steps, setSteps] = useState<FlowState>({
    parseIntent: 'idle', catalogSearch: 'idle', policyCheck: 'idle',
    reservation: 'idle', payment: 'idle',
  });
  const [result, setResult] = useState<FlowResult>({});

  const setStep = (step: keyof FlowState, status: StepStatus) =>
    setSteps((prev) => ({ ...prev, [step]: status }));

  const handleRun = async () => {
    if (!intent.trim() || isRunning) return;
    setIsRunning(true);
    setResult({});
    setSteps({ parseIntent: 'idle', catalogSearch: 'idle', policyCheck: 'idle', reservation: 'idle', payment: 'idle' });

    try {
      // Step 1: Parse intent → policy
      setStep('parseIntent', 'running');
      const intentRes = await fetch('/api/parse-intent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ intent, setActive: true }),
      }).then((r) => r.json());

      if (intentRes.error) throw new Error(intentRes.error);
      const parsedPolicy = intentRes.policy || intentRes.activePolicy;
      setResult((p) => ({ ...p, intent, parsedPolicy }));
      setStep('parseIntent', 'done');

      // Step 2: Search catalog
      setStep('catalogSearch', 'running');
      const category = parsedPolicy?.category || '';
      const maxPrice = parsedPolicy?.amountCeiling ? parsedPolicy.amountCeiling / 100 : undefined;
      const catalogUrl = `/api/catalog-search?q=${encodeURIComponent(intent)}&${category ? `category=${encodeURIComponent(category)}&` : ''}${maxPrice ? `maxPrice=${maxPrice}` : ''}`;
      const catalogRes = await fetch(catalogUrl).then((r) => r.json()).catch(() => ({}));

      if (catalogRes.error) {
        throw new Error(catalogRes.error);
      }

      let products: CatalogProduct[] = catalogRes.products || [];

      // Fallback: If strict category or filter returned 0 products, try search with just the query
      if (products.length === 0) {
        const fallbackUrl = `/api/catalog-search?q=${encodeURIComponent(intent)}`;
        const fallbackRes = await fetch(fallbackUrl).then((r) => r.json()).catch(() => ({}));
        if (fallbackRes.products && fallbackRes.products.length > 0) {
          products = fallbackRes.products;
        }
      }

      const selectedProduct = products[0] || null;

      setResult((p) => ({ ...p, catalogResults: products, selectedProduct: selectedProduct ?? undefined }));
      setStep('catalogSearch', selectedProduct ? 'done' : 'error');

      if (!selectedProduct) {
        setResult((p) => ({ ...p, error: 'No catalog products found matching your intent.' }));
        setIsRunning(false);
        return;
      }

      // Step 3: Policy check (via purchase dry-run preview)
      setStep('policyCheck', 'running');
      await new Promise((r) => setTimeout(r, 300)); // brief pause for visual effect

      const idempotencyKey = `agent_flow_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const purchaseRes = await fetch('/api/purchase', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-idempotency-key': idempotencyKey,
        },
        body: JSON.stringify({
          productId: selectedProduct.productId,
          quantity: 1,
          idempotencyKey,
        }),
      }).then((r) => r.json());

      const policyExplanation = purchaseRes.policyExplanation as PolicyExplanationType | undefined;
      const decision = purchaseRes.decision || purchaseRes.decisionStatus;

      setResult((p) => ({
        ...p,
        purchaseDecision: decision,
        purchaseReason: purchaseRes.reason,
        policyExplanation,
        razorpayOrderId: purchaseRes.razorpayOrderId,
        amount: purchaseRes.amount,
      }));

      if (decision === 'denied') {
        setStep('policyCheck', 'error');
        setStep('reservation', 'error');
        setIsRunning(false);
        return;
      }

      if (decision === 'review') {
        setStep('policyCheck', 'review');
        setStep('reservation', 'review');
        setIsRunning(false);
        return;
      }

      setStep('policyCheck', 'done');

      // Step 4: Reservation confirmed
      setStep('reservation', 'running');
      await new Promise((r) => setTimeout(r, 200));
      setStep('reservation', 'done');

      // Step 5: Payment
      setStep('payment', 'running');
      await new Promise((r) => setTimeout(r, 200));
      setStep('payment', 'done');

      onPurchaseComplete?.();

      if (purchaseRes.razorpayOrderId && purchaseRes.amount && triggerRazorpayCheckout) {
        triggerRazorpayCheckout(
          purchaseRes.razorpayOrderId,
          purchaseRes.amount,
          selectedProduct.merchantName
        );
      }
    } catch (err) {
      setResult((p) => ({ ...p, error: err instanceof Error ? err.message : String(err) }));
      // Mark current running step as error
      setSteps((prev) => {
        const updated = { ...prev };
        for (const k of Object.keys(updated) as (keyof FlowState)[]) {
          if (updated[k] === 'running') updated[k] = 'error';
        }
        return updated;
      });
    } finally {
      setIsRunning(false);
    }
  };

  const stepKeys = Object.keys(steps) as (keyof FlowState)[];

  return (
    <div className="flex flex-col gap-4">
      {/* Intent input */}
      <div className="flex gap-2">
        <input
          value={intent}
          onChange={(e) => setIntent(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleRun()}
          placeholder="Order dinner for two under ₹800"
          className="flex-1 p-2.5 bg-[#070809] border border-[#23272a] focus:border-[#ff571a] rounded-[2px] text-xs text-white font-mono focus:outline-none transition"
        />
        <button
          onClick={handleRun}
          disabled={isRunning || !intent.trim()}
          className="flex items-center gap-2 bg-[#ff571a] hover:bg-[#e0440b] disabled:opacity-50 text-white font-pixel font-bold text-[10px] px-4 py-2 rounded-[2px] transition uppercase tracking-wider"
        >
          {isRunning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ArrowRight className="w-3.5 h-3.5" />}
          RUN
        </button>
      </div>

      {/* Pipeline steps */}
      <div className="flex flex-col gap-1">
        {stepKeys.map((step, i) => (
          <div key={step} className="flex items-center gap-2.5">
            {statusIcon(steps[step])}
            <div className="flex items-center gap-1.5 text-[10px] font-mono">
              {STEP_ICONS[step]}
              <span className={steps[step] === 'idle' ? 'text-[#5a5e62]' : steps[step] === 'done' ? 'text-[#22c55e]' : steps[step] === 'error' ? 'text-[#ff3366]' : steps[step] === 'review' ? 'text-[#f9c425]' : 'text-white'}>
                {STEP_LABELS[step]}
              </span>
            </div>
            {i < stepKeys.length - 1 && <ArrowRight className="w-3 h-3 text-[#2f3438] ml-0.5" />}

            {/* Inline result snippets */}
            {step === 'catalogSearch' && steps.catalogSearch === 'done' && result.selectedProduct && (
              <span className="ml-auto text-[10px] font-mono text-[#38bdf8]">
                {result.selectedProduct.name || result.selectedProduct.merchantName} · ₹{result.selectedProduct.priceRupees}
              </span>
            )}
            {step === 'payment' && steps.payment === 'done' && result.razorpayOrderId && (
              <span className="ml-auto text-[10px] font-mono text-[#22c55e] truncate max-w-48" title={result.razorpayOrderId}>
                {result.razorpayOrderId}
              </span>
            )}
          </div>
        ))}
      </div>

      {/* Policy explanation */}
      {result.policyExplanation && (
        <PolicyExplanation explanation={result.policyExplanation} />
      )}

      {/* Error / review messages */}
      {result.error && (
        <div className="text-[#ff3366] font-mono text-[10px] p-2 bg-[#160a0d] border border-[#ff3366]/30 rounded-[2px]">
          {result.error}
        </div>
      )}
      {result.purchaseDecision === 'review' && (
        <div className="text-[#f9c425] font-mono text-[10px] p-2 bg-[#141209] border border-[#f9c425]/30 rounded-[2px]">
          REVIEW REQUIRED — {result.purchaseReason}
        </div>
      )}
    </div>
  );
}
