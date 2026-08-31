'use client';

import React, { useState, useEffect } from 'react';
import { Policy, ReserveState, Transaction } from '@/lib/types';
import CornerBrackets from './components/CornerBrackets';
import TelemetryBadge from './components/TelemetryBadge';
import {
  Terminal,
  Activity,
  Zap,
  Play,
  RotateCw,
  ArrowRight,
  CreditCard,
  Lock,
  Layers,
  ExternalLink,
  AlertTriangle,
  Clock,
  Radio,
} from 'lucide-react';

export default function Home() {
  const [intentInput, setIntentInput] = useState(
    '₹1000 reserve, groceries only, order dinner for 2 under ₹800'
  );
  const [parsedPolicy, setParsedPolicy] = useState<Policy | null>(null);
  const [reserveState, setReserveState] = useState<ReserveState>({
    totalPaise: 200000,
    heldPaise: 0,
    settledPaise: 0,
    availablePaise: 200000,
    total: 200000,
    remaining: 200000,
    transactions: [],
    ledgerIntegrity: { isValid: true },
  });

  const [isParsing, setIsParsing] = useState(false);
  const [isSubmittingPurchase, setIsSubmittingPurchase] = useState(false);
  const [isDemoRunning, setIsDemoRunning] = useState(false);
  const [demoStepStatus, setDemoStepStatus] = useState<string | null>(null);

  // Quick purchase simulation form state (user enters in INR rupees)
  const [simMerchant, setSimMerchant] = useState('Swiggy');
  const [simAmount, setSimAmount] = useState('550');
  const [simCategory, setSimCategory] = useState('Groceries');
  const [simQuantity, setSimQuantity] = useState('1');

  // Load active policy and reserve state on mount & load Razorpay Checkout script
  useEffect(() => {
    fetchInitialData();

    // Dynamically load Razorpay Checkout script
    if (typeof window !== 'undefined' && !document.getElementById('razorpay-checkout-script')) {
      const script = document.createElement('script');
      script.id = 'razorpay-checkout-script';
      script.src = 'https://checkout.razorpay.com/v1/checkout.js';
      script.async = true;
      document.body.appendChild(script);
    }

    // Subscribe to SSE for true live sync
    const eventSource = new EventSource('/api/stream');
    eventSource.onmessage = (event) => {
      if (event.data === 'update') {
        fetchInitialData();
      }
    };

    return () => {
      eventSource.close();
    };
  }, []);

  const [adminApiKey, setAdminApiKey] = useState('admin_api_key_default');

  const UI_AUTH_HEADERS = {
    'Content-Type': 'application/json',
    'X-API-Key': adminApiKey,
  };

  const fetchInitialData = async () => {
    try {
      const [policyRes, reserveRes] = await Promise.all([
        fetch('/api/policy', { headers: { 'X-API-Key': process.env.NEXT_PUBLIC_ADMIN_API_KEY || 'admin_api_key_default' } }).then((r) => r.json()),
        fetch('/api/reserve', { headers: { 'X-API-Key': process.env.NEXT_PUBLIC_ADMIN_API_KEY || 'admin_api_key_default' } }).then((r) => r.json()),
      ]);

      if (policyRes.policy) setParsedPolicy(policyRes.policy);
      if (reserveRes.totalPaise !== undefined || reserveRes.total !== undefined) {
        setReserveState({
          ...reserveRes,
          totalPaise: reserveRes.totalPaise ?? reserveRes.total ?? 200000,
          heldPaise: reserveRes.heldPaise ?? 0,
          settledPaise: reserveRes.settledPaise ?? 0,
          availablePaise: reserveRes.availablePaise ?? reserveRes.remaining ?? 200000,
        });
      }
    } catch (err) {
      console.error('Failed to load initial data:', err);
    }
  };

  // 1. Natural Language Intent Parsing (/api/parse-intent)
  const handleParseIntent = async () => {
    if (!intentInput.trim()) return;
    setIsParsing(true);
    try {
      const res = await fetch('/api/parse-intent', {
        method: 'POST',
        headers: UI_AUTH_HEADERS,
        body: JSON.stringify({ intent: intentInput, setActive: true }),
      });
      const data = await res.json();
      if (data.policy) {
        setParsedPolicy(data.policy);
      }
    } catch (err) {
      console.error('Failed to parse intent:', err);
    } finally {
      setIsParsing(false);
    }
  };

  // Trigger Razorpay Checkout modal
  const triggerRazorpayCheckout = (orderId: string, amountPaise: number, merchantName: string) => {
    // If running without real Razorpay keys, the backend issues a mock order ID.
    // The real Razorpay UI will crash if fed a fake key/order, so we handle it gracefully here.
    if (orderId.startsWith('order_test_mock_')) {
      alert(`[Dev Mode] Guardrail Approved!\n\nMock Order ID: ${orderId}\nAmount: ₹${(amountPaise / 100).toFixed(2)}\n\n(In production with real API keys, the Razorpay payment modal would open here)`);
      
      // Simulate a successful verification webhook call
      fetch('/api/verify-payment', {
        method: 'POST',
        headers: UI_AUTH_HEADERS,
        body: JSON.stringify({
          razorpay_order_id: orderId,
          razorpay_payment_id: `pay_mock_${Date.now()}`,
          razorpay_signature: 'mock_dev_signature_skip'
        }),
      }).then(res => res.json()).then(data => {
        if (data.updatedReserveState) setReserveState(data.updatedReserveState);
        fetchInitialData();
      }).catch(console.error);
      
      return;
    }

    const RazorpayClass = (window as unknown as { Razorpay: new (options: Record<string, unknown>) => { open: () => void } }).Razorpay;
    if (!RazorpayClass) {
      console.error('Razorpay SDK failed to load.');
      alert('Payment gateway failed to load. Please disable ad-blockers and try again.');
      return;
    }
    try {
      const options = {
        key: process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID || 'rzp_test_dev_key',
        amount: amountPaise,
        currency: 'INR',
        name: 'Reserve Pay Guardrail',
        description: `Purchase from ${merchantName}`,
        order_id: orderId,
        modal: {
          ondismiss: async function () {
            console.log('Checkout modal closed/dismissed. Releasing 2PC reservation.');
            try {
              await fetch('/api/release', {
                method: 'POST',
                headers: UI_AUTH_HEADERS,
                body: JSON.stringify({ orderId: orderId, reason: 'Checkout modal cancelled by user' }),
              });
              fetchInitialData();
            } catch (releaseErr) {
              console.error('Failed to release reservation:', releaseErr);
            }
          },
        },
        handler: async function (response: Record<string, unknown>) {
          console.log('Razorpay payment authorized successfully:', response);
          try {
            const verifyRes = await fetch('/api/verify-payment', {
              method: 'POST',
              headers: UI_AUTH_HEADERS,
              body: JSON.stringify(response),
            });
            const verifyData = await verifyRes.json();
            if (verifyData.updatedReserveState) {
              setReserveState(verifyData.updatedReserveState);
            } else {
              fetchInitialData();
            }
          } catch (verifyErr) {
            console.error('Failed to verify Razorpay payment:', verifyErr);
          }
        },
        prefill: {
          name: 'Reserve Pay User',
          email: 'user@example.com',
          contact: '9999999999',
        },
        theme: {
          color: '#FF571A',
        },
      };
      const rzp = new RazorpayClass(options);
      rzp.open();
    } catch (checkoutErr) {
      console.warn('Razorpay Checkout UI initialization error:', checkoutErr);
    }
  };

  // 2. Submit Attempted Purchase (/api/purchase) - Converts INR input to integer Paise
  const handleSimulatePurchase = async (
    e?: React.FormEvent,
    purchasePayload?: Record<string, unknown>
  ) => {
    if (e) e.preventDefault();

    let payload = purchasePayload;
    if (!payload) {
      const cleanAmount = parseFloat(String(simAmount).replace(/[^0-9.]/g, ''));
      if (isNaN(cleanAmount) || cleanAmount <= 0) {
        alert('Please enter a valid positive amount in ₹ (e.g. 550.00)');
        return;
      }
      const exactAmount = Number(cleanAmount.toFixed(2));
      payload = {
        merchant: simMerchant.trim() || 'Swiggy',
        amount: Math.round(exactAmount * 100), // Convert INR to integer Paise
        category: simCategory.trim() || 'Groceries',
        quantity: parseInt(simQuantity, 10) || 1,
      };
    }

    setIsSubmittingPurchase(true);
    try {
      const res = await fetch('/api/purchase', {
        method: 'POST',
        headers: UI_AUTH_HEADERS,
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (data.updatedReserveState) {
        setReserveState(data.updatedReserveState);
      }

      // Trigger Razorpay Checkout modal if purchase is reserved/approved and has razorpayOrderId
      if (
        data.decision === 'approve' &&
        data.razorpayOrderId &&
        typeof window !== 'undefined' &&
        !isDemoRunning
      ) {
        triggerRazorpayCheckout(data.razorpayOrderId, payload.amount as number, payload.merchant as string);
      }

      return data;
    } catch (err) {
      console.error('Failed to process purchase:', err);
    } finally {
      setIsSubmittingPurchase(false);
    }
  };

  // 3. Force-approve a frozen transaction (/api/purchase with override)
  const handleApproveAnyway = async (tx: Transaction) => {
    try {
      const res = await fetch('/api/purchase', {
        method: 'POST',
        headers: UI_AUTH_HEADERS,
        body: JSON.stringify({
          ...tx,
          merchant: tx.merchant || 'Unknown Merchant',
          category: tx.category || 'General',
          amount: tx.amount,
          override: true,
        }),
      });
      const data = await res.json();
      if (data.updatedReserveState) {
        setReserveState(data.updatedReserveState);
      }
      
      if (data.decision === 'approve' && data.razorpayOrderId && typeof window !== 'undefined') {
        triggerRazorpayCheckout(data.razorpayOrderId, tx.amount, tx.merchant || 'Unknown Merchant');
      }
    } catch (err) {
      console.error('Failed to force-approve transaction:', err);
    }
  };

  // 4. Run Live Demo Sequence (3 attempts in paise with 2s delay between each)
  const handleRunDemo = async () => {
    setIsDemoRunning(true);

    const allowedMerchant1 = parsedPolicy?.allowedMerchants?.[0] || 'Swiggy';
    const allowedMerchant2 =
      parsedPolicy?.allowedMerchants?.[1] || allowedMerchant1 || 'Blinkit';
    const categoryName = parsedPolicy?.category || 'Groceries';

    const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    try {
      // Step 1: Groceries, 55000 Paise (₹550) (under ceiling ₹800, under sessionCap ₹1000 -> RESERVES)
      setDemoStepStatus('Step 1/3: Attempting Groceries (₹550.00) from allowed merchant -> 2PC Reservation Created...');
      await handleSimulatePurchase(undefined, {
        merchant: allowedMerchant1,
        amount: 55000,
        category: categoryName,
        quantity: 1,
      });

      await delay(2000);

      // Step 2: Groceries, 50000 Paise (₹500) (cumulative 550+500 = ₹1050 > ₹1000 sessionCap -> FREEZES)
      setDemoStepStatus('Step 2/3: Attempting Groceries (₹500.00) -> Cumulative spend (₹1050.00) exceeds sessionCap (₹1000.00)...');
      await handleSimulatePurchase(undefined, {
        merchant: allowedMerchant2,
        amount: 50000,
        category: categoryName,
        quantity: 1,
      });

      await delay(2000);

      // Step 3: Electronics, 30000 Paise (₹300) (merchant not in allowlist -> FREEZES)
      setDemoStepStatus(
        'Step 3/3: Attempting Electronics (₹300.00) from unallowed merchant (Walmart)...'
      );
      await handleSimulatePurchase(undefined, {
        merchant: 'Walmart',
        amount: 30000,
        category: 'Electronics',
        quantity: 1,
      });

      setDemoStepStatus('Demo Sequence Completed Successfully!');
      await delay(2000);
    } catch (err) {
      console.error('Error during demo sequence:', err);
      setDemoStepStatus('Demo sequence encountered an error.');
    } finally {
      setIsDemoRunning(false);
      setDemoStepStatus(null);
    }
  };

  const totalPaise = reserveState.totalPaise ?? reserveState.total ?? 200000;
  const heldPaise = reserveState.heldPaise ?? 0;
  const settledPaise = reserveState.settledPaise ?? 0;
  const availablePaise = reserveState.availablePaise ?? reserveState.remaining ?? (totalPaise - heldPaise - settledPaise);

  const percentageAvailable = Math.max(0, Math.min(100, (availablePaise / totalPaise) * 100));
  const percentageHeld = Math.max(0, Math.min(100, (heldPaise / totalPaise) * 100));
  const percentageSettled = Math.max(0, Math.min(100, (settledPaise / totalPaise) * 100));

  return (
    <div className="min-h-screen bg-black text-[#f0f1f1] flex flex-col font-sans selection:bg-[#ff571a] selection:text-white cyber-grid-bg pb-16">
      {/* Top Technical Announcement Bar - Matching Frontend */}
      <nav className="w-full bg-[#0f1112] border-b border-[#2f3131] px-4 md:px-8 py-2.5 flex items-center justify-between flex-wrap gap-3 z-30 sticky top-0 backdrop-blur-md">
        <div className="flex items-center gap-3 flex-wrap text-xs">
          <span className="bg-[#ff571a] text-white font-pixel font-bold px-2.5 py-1 rounded-[2px] tracking-wider uppercase flex items-center gap-1.5 shadow-sm text-[10px] md:text-[11px]">
            <Radio className="w-3 h-3 animate-pulse" />
            2PC ENGINE ACTIVE
          </span>
          <span className="text-[#8e9296] font-mono text-xs hidden sm:inline">
            THE LAYER BETWEEN AGENT DECIDES AND MONEY MOVES
          </span>
        </div>

        <div className="flex items-center gap-3 text-xs">
          <input
            type="password"
            value={adminApiKey}
            onChange={(e) => setAdminApiKey(e.target.value)}
            placeholder="Admin API Key"
            className="px-2 py-1 bg-[#070809] border border-[#2f3131] rounded-[2px] text-xs font-mono text-[#8e9296] focus:outline-none focus:border-[#ff571a] w-32 md:w-48 transition-colors"
          />
          <TelemetryBadge
            status="active"
            label="4.2ms SYNC"
            sublabel="SSE STREAMING"
          />
          <a
            href="http://localhost:3000"
            className="text-[#8e9296] hover:text-white font-mono flex items-center gap-1 transition px-2 py-1 rounded border border-transparent hover:border-[#2f3131]"
          >
            <span>Landing Page</span>
            <ExternalLink className="w-3 h-3" />
          </a>
        </div>
      </nav>

      {/* Main Container */}
      <main className="max-w-6xl w-full mx-auto p-4 md:p-6 flex flex-col gap-6 relative">
        {/* Main Header / Hero Panel */}
        <header className="relative bg-[#0b0d0e] border border-[#23272a] p-6 rounded-[2px] flex flex-col md:flex-row justify-between items-start md:items-center gap-5 shadow-2xl">
          <CornerBrackets color="#ff571a" size={16} />

          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <span className="text-[9px] md:text-[10px] font-pixel tracking-widest text-[#ff571a] uppercase bg-[#ff571a]/10 px-2 py-0.5 rounded-[2px] border border-[#ff571a]/30">
                SYSTEM CONTROLLER // V2.4
              </span>
              <span className="text-xs text-[#5a5e62] font-mono">
                [PORT 3000/3001]
              </span>
            </div>

            <h1 className="text-lg md:text-2xl font-pixel tracking-tight text-white flex items-center gap-2 flex-wrap">
              <span className="text-[#ff571a]">RESERVE PAY</span>
              <span className="text-[#5a5e62] font-light">/</span>
              <span className="text-sm md:text-lg font-pixel text-[#8e9296] font-normal">
                Guardrail Controller
              </span>
            </h1>

            <div className="flex items-center gap-3 mt-0.5 flex-wrap text-xs">
              <p className="text-[#8e9296] font-mono text-[11px] md:text-xs">
                Integer Paise Ledger &bull; Atomic 2PC Reservation State Machine
              </p>
              {reserveState.ledgerIntegrity?.isValid !== false ? (
                <span className="bg-[#0f1112] text-[#22c55e] border border-[#22c55e]/40 text-[10px] md:text-[11px] font-pixel font-bold px-2 py-0.5 rounded-[2px] inline-flex items-center gap-1.5 shadow-sm">
                  <span className="h-1.5 w-1.5 rounded-full bg-[#22c55e] animate-ping" />
                  SHA-256 VERIFIED
                </span>
              ) : (
                <span className="bg-[#160a0d] text-[#ff3366] border border-[#ff3366]/50 text-[10px] md:text-[11px] font-pixel font-bold px-2 py-0.5 rounded-[2px] inline-flex items-center gap-1.5 shadow-sm">
                  <AlertTriangle className="w-3 h-3 text-[#ff3366]" />
                  TAMPERED @ INDEX {reserveState.ledgerIntegrity.corruptedIndex}
                </span>
              )}
            </div>
          </div>

          {/* Action CTAs */}
          <div className="flex items-center gap-3 w-full md:w-auto justify-end">
            <button
              onClick={handleRunDemo}
              disabled={isDemoRunning}
              className="bg-[#ff571a] hover:bg-[#e0440b] active:bg-[#c73704] disabled:opacity-50 text-white font-pixel font-bold text-[10px] md:text-xs px-5 py-3 rounded-[2px] shadow-glow-orange transition active:scale-[0.98] flex items-center gap-2 tracking-wider uppercase"
            >
              {isDemoRunning ? (
                <>
                  <span className="animate-spin inline-block w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full" />
                  <span>RUNNING DEMO...</span>
                </>
              ) : (
                <>
                  <Play className="w-3.5 h-3.5 fill-current" />
                  <span>RUN LIVE DEMO</span>
                </>
              )}
            </button>

            <button
              onClick={fetchInitialData}
              className="text-xs font-mono bg-[#111416] border border-[#2f3438] hover:border-[#ff571a]/60 text-[#8e9296] hover:text-white font-bold px-3.5 py-2.5 rounded-[2px] transition flex items-center gap-1.5"
            >
              <RotateCw className="w-3.5 h-3.5" />
              <span>Sync</span>
            </button>
          </div>
        </header>

        {/* Demo Progress Banner */}
        {demoStepStatus && (
          <div className="relative bg-[#16120c] border border-[#ff571a]/60 text-[#f0f1f1] px-5 py-3 rounded-[2px] font-mono text-xs md:text-sm shadow-xl flex items-center justify-between gap-3 animate-orange-pulse">
            <CornerBrackets color="#ff571a" size={10} />
            <div className="flex items-center gap-3">
              <span className="relative flex h-2.5 w-2.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#ff571a] opacity-75" />
                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-[#ff571a]" />
              </span>
              <span className="font-pixel text-[10px] md:text-xs text-[#ff571a] uppercase tracking-wider">
                [LIVE SIMULATION]
              </span>
              <span className="text-[#f0f1f1] font-mono">{demoStepStatus}</span>
            </div>
            <Activity className="w-4 h-4 text-[#ff571a] animate-spin" />
          </div>
        )}

        {/* Panel 1: Intent Prompt & Active Policy JSON */}
        <section className="relative bg-[#0b0d0e] border border-[#23272a] p-5 rounded-[2px] shadow-xl">
          <CornerBrackets color="#ff571a" size={14} />
          
          <div className="text-[10px] md:text-[11px] font-pixel text-[#5a5e62] tracking-widest uppercase mb-3 flex items-center justify-between border-b border-[#1b1e20] pb-2">
            <span className="flex items-center gap-2 text-[#ff571a]">
              <Terminal className="w-3.5 h-3.5 text-[#ff571a]" />
              {"// 01 INTENT SPECIFICATION & POLICY SYNTHESIS"}
            </span>
            <span className="text-[#5a5e62] font-mono hidden sm:inline">GEMINI MULTI-MODAL GUARDRAIL</span>
          </div>

          <div className="grid md:grid-cols-2 gap-5 mt-2">
            {/* Left: Input */}
            <div className="flex flex-col gap-2.5">
              <div className="flex justify-between items-center">
                <label className="text-[11px] md:text-xs font-pixel font-bold text-[#8e9296] flex items-center gap-1.5 uppercase">
                  <span>&gt;_</span> Natural Language Spending Intent
                </label>
                <span className="text-[10px] font-mono text-[#5a5e62]">TEXT INPUT</span>
              </div>
              <textarea
                value={intentInput}
                onChange={(e) => setIntentInput(e.target.value)}
                className="w-full h-32 p-3.5 bg-[#070809] border border-[#23272a] focus:border-[#ff571a] rounded-[2px] text-xs md:text-sm text-white font-mono placeholder-[#5a5e62] focus:outline-none focus:ring-1 focus:ring-[#ff571a]/50 transition resize-none shadow-inner-dark"
                placeholder="Type your spending guardrail prompt (e.g. ₹1000 reserve, groceries only...)"
              />
              <div className="flex justify-end">
                <button
                  onClick={handleParseIntent}
                  disabled={isParsing || isDemoRunning}
                  className="bg-[#ff571a] hover:bg-[#e0440b] active:bg-[#c73704] disabled:opacity-50 text-white text-[10px] md:text-xs font-pixel font-bold px-4 py-2.5 rounded-[2px] transition active:scale-[0.98] flex items-center gap-2 uppercase tracking-wider"
                >
                  {isParsing ? (
                    <>
                      <span className="animate-spin inline-block w-3 h-3 border-2 border-white border-t-transparent rounded-full" />
                      <span>SYNTHESIZING...</span>
                    </>
                  ) : (
                    <>
                      <span>PARSE & SET POLICY</span>
                      <ArrowRight className="w-3.5 h-3.5" />
                    </>
                  )}
                </button>
              </div>
            </div>

            {/* Right: Policy Inspector */}
            <div className="flex flex-col gap-2.5">
              <div className="flex justify-between items-center">
                <span className="text-[11px] md:text-xs font-pixel font-bold text-[#22c55e] flex items-center gap-1.5 uppercase">
                  <Lock className="w-3 h-3 text-[#22c55e]" />
                  Live Policy (Paise Minor-Units)
                </span>
                <span className="bg-[#0f1112] text-[#22c55e] text-[9px] md:text-[10px] font-pixel font-bold px-2 py-0.5 rounded-[2px] border border-[#22c55e]/30">
                  ACTIVE POLICY
                </span>
              </div>
              <div className="relative">
                <pre className="w-full h-32 p-3.5 bg-[#070809] border border-[#23272a] rounded-[2px] text-xs text-[#22c55e] font-mono overflow-auto shadow-inner-dark">
                  {parsedPolicy ? (
                    <code>{JSON.stringify(parsedPolicy, null, 2)}</code>
                  ) : (
                    <span className="text-[#5a5e62]">
                      {"// Awaiting synthesis. Click \"Parse & Set Policy\" to load live state."}
                    </span>
                  )}
                </pre>
              </div>
              <div className="flex items-center justify-between text-[11px] font-mono text-[#5a5e62]">
                <span>ENCODING: INT_PAISE</span>
                <span>STATE: DETERMINISTIC</span>
              </div>
            </div>
          </div>
        </section>

        {/* Panel 2: 2PC Reserve Ledger Balance Meter */}
        <section className="relative bg-[#0b0d0e] border border-[#23272a] p-5 rounded-[2px] shadow-xl flex flex-col gap-4">
          <CornerBrackets color="#ff571a" size={14} />

          <div className="text-[10px] md:text-[11px] font-pixel text-[#5a5e62] tracking-widest uppercase flex items-center justify-between border-b border-[#1b1e20] pb-2">
            <span className="flex items-center gap-2 text-[#ff571a]">
              <Layers className="w-3.5 h-3.5 text-[#ff571a]" />
              {"// 02 TWO-PHASE COMMIT RESERVE LEDGER"}
            </span>
            <span className="text-[#5a5e62] font-mono hidden sm:inline">ATOMIC BALANCE MONITOR</span>
          </div>

          <div className="flex justify-between items-end flex-wrap gap-3">
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-xs md:text-sm font-bold text-white uppercase tracking-wider font-pixel flex items-center gap-2">
                  <CreditCard className="w-4 h-4 text-[#ff571a]" />
                  Pool Allocation & Commit State
                </h2>
              </div>
              <div className="flex items-center gap-4 text-xs font-mono text-[#8e9296] mt-2 flex-wrap">
                <span className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-[2px] bg-[#22c55e]" />
                  Available: <strong className="text-[#22c55e] font-bold font-mono">₹{(availablePaise / 100).toFixed(2)}</strong>
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-[2px] bg-[#f9c425]" />
                  Held (2PC In-Flight): <strong className="text-[#f9c425] font-bold font-mono">₹{(heldPaise / 100).toFixed(2)}</strong>
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-[2px] bg-[#6366f1]" />
                  Settled (Captured): <strong className="text-[#6366f1] font-bold font-mono">₹{(settledPaise / 100).toFixed(2)}</strong>
                </span>
              </div>
            </div>

            <div className="text-right">
              <div className="text-lg md:text-2xl font-bold font-pixel text-white tracking-tight">
                ₹{(availablePaise / 100).toFixed(2)}
              </div>
              <div className="text-[#5a5e62] text-xs font-mono">
                TOTAL: ₹{(totalPaise / 100).toFixed(2)} ({totalPaise.toLocaleString()} PAISE)
              </div>
            </div>
          </div>

          {/* High-Tech Industrial Segmented Bar */}
          <div className="w-full bg-[#070809] border border-[#23272a] rounded-[2px] h-6 p-0.5 shadow-inner-dark relative overflow-hidden flex gap-0.5">
            {/* Available slice */}
            {percentageAvailable > 0 && (
              <div
                className="h-full bg-gradient-to-r from-[#10b981] to-[#059669] transition-all duration-500 flex items-center justify-center text-[9px] font-pixel font-bold text-black"
                style={{ width: `${percentageAvailable}%` }}
                title={`Available: ₹${(availablePaise / 100).toFixed(2)}`}
              >
                {percentageAvailable > 15 && `AVAIL ${percentageAvailable.toFixed(0)}%`}
              </div>
            )}
            {/* Held (2PC) slice */}
            {percentageHeld > 0 && (
              <div
                className="h-full bg-gradient-to-r from-[#f59e0b] to-[#f9c425] animate-pulse transition-all duration-500 flex items-center justify-center text-[9px] font-pixel font-bold text-black"
                style={{ width: `${percentageHeld}%` }}
                title={`Held in 2PC: ₹${(heldPaise / 100).toFixed(2)}`}
              >
                {percentageHeld > 10 && `HELD ${percentageHeld.toFixed(0)}%`}
              </div>
            )}
            {/* Settled slice */}
            {percentageSettled > 0 && (
              <div
                className="h-full bg-gradient-to-r from-[#6366f1] to-[#4f46e5] transition-all duration-500 flex items-center justify-center text-[9px] font-pixel font-bold text-white"
                style={{ width: `${percentageSettled}%` }}
                title={`Settled: ₹${(settledPaise / 100).toFixed(2)}`}
              >
                {percentageSettled > 10 && `SETTLED ${percentageSettled.toFixed(0)}%`}
              </div>
            )}
          </div>
        </section>

        {/* Panel 3: Purchase Simulator Controls */}
        <section className="relative bg-[#0b0d0e] border border-[#23272a] p-5 rounded-[2px] shadow-xl flex flex-col gap-3">
          <CornerBrackets color="#353535" size={12} />

          <div className="text-[10px] md:text-[11px] font-pixel text-[#5a5e62] tracking-widest uppercase flex items-center justify-between border-b border-[#1b1e20] pb-2">
            <span className="flex items-center gap-2 text-[#ff571a]">
              <Zap className="w-3.5 h-3.5 text-[#ff571a]" />
              {"// 03 MANUAL TRANSACTION DISPATCH & TEST SIMULATOR"}
            </span>
            <span className="text-[#5a5e62] font-mono hidden sm:inline">2PC RESERVATION PIPELINE</span>
          </div>

          <form onSubmit={(e) => handleSimulatePurchase(e)} className="grid grid-cols-2 md:grid-cols-5 gap-3 mt-1">
            <div className="flex flex-col gap-1">
              <label className="text-[9px] font-pixel text-[#8e9296] uppercase">Merchant</label>
              <input
                type="text"
                placeholder="e.g. Swiggy"
                value={simMerchant}
                onChange={(e) => setSimMerchant(e.target.value)}
                className="p-2.5 bg-[#070809] border border-[#23272a] focus:border-[#ff571a] rounded-[2px] text-xs text-white font-mono focus:outline-none transition shadow-inner-dark"
                required
              />
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-[9px] font-pixel text-[#8e9296] uppercase">Amount (₹)</label>
              <input
                type="number"
                step="0.01"
                placeholder="e.g. 550.00"
                value={simAmount}
                onChange={(e) => setSimAmount(e.target.value)}
                className="p-2.5 bg-[#070809] border border-[#23272a] focus:border-[#ff571a] rounded-[2px] text-xs text-white font-mono focus:outline-none transition shadow-inner-dark"
                required
              />
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-[9px] font-pixel text-[#8e9296] uppercase">Category</label>
              <input
                type="text"
                placeholder="e.g. Groceries"
                value={simCategory}
                onChange={(e) => setSimCategory(e.target.value)}
                className="p-2.5 bg-[#070809] border border-[#23272a] focus:border-[#ff571a] rounded-[2px] text-xs text-white font-mono focus:outline-none transition shadow-inner-dark"
                required
              />
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-[9px] font-pixel text-[#8e9296] uppercase">Quantity</label>
              <input
                type="number"
                placeholder="e.g. 1"
                value={simQuantity}
                onChange={(e) => setSimQuantity(e.target.value)}
                className="p-2.5 bg-[#070809] border border-[#23272a] focus:border-[#ff571a] rounded-[2px] text-xs text-white font-mono focus:outline-none transition shadow-inner-dark"
                required
              />
            </div>

            <div className="col-span-2 md:col-span-1 flex flex-col justify-end">
              <button
                type="submit"
                disabled={isSubmittingPurchase || isDemoRunning}
                className="w-full bg-[#16191c] hover:bg-[#ff571a] active:bg-[#e0440b] hover:text-white border border-[#2f3438] hover:border-[#ff571a] disabled:opacity-50 text-[#f0f1f1] text-[10px] md:text-xs font-pixel font-bold p-2.5 rounded-[2px] transition active:scale-[0.98] uppercase tracking-wider flex items-center justify-center gap-1.5"
              >
                {isSubmittingPurchase ? (
                  <>
                    <span className="animate-spin inline-block w-3 h-3 border-2 border-white border-t-transparent rounded-full" />
                    <span>RESERVING...</span>
                  </>
                ) : (
                  <>
                    <span>SUBMIT TX</span>
                    <ArrowRight className="w-3.5 h-3.5" />
                  </>
                )}
              </button>
            </div>
          </form>
        </section>

        {/* Panel 4: Live 2PC Transaction Ledger Feed */}
        <section className="relative bg-[#0b0d0e] border border-[#23272a] p-5 rounded-[2px] shadow-xl flex flex-col gap-4">
          <CornerBrackets color="#ff571a" size={14} />

          <div className="text-[10px] md:text-[11px] font-pixel text-[#5a5e62] tracking-widest uppercase flex items-center justify-between border-b border-[#1b1e20] pb-2">
            <span className="flex items-center gap-2 text-[#ff571a]">
              <Activity className="w-3.5 h-3.5 text-[#ff571a]" />
              {"// 04 REAL-TIME TRANSACTION AUDIT FEED"}
            </span>
            <span className="text-[#8e9296] font-pixel text-[9px] md:text-[10px] bg-[#111416] px-2 py-0.5 rounded-[2px] border border-[#23272a]">
              {reserveState.transactions.length} RECORDS
            </span>
          </div>

          {reserveState.transactions.length === 0 ? (
            <div className="p-8 text-center text-[#5a5e62] font-mono bg-[#070809] rounded-[2px] border border-[#23272a] text-xs flex flex-col items-center justify-center gap-2">
              <Clock className="w-6 h-6 text-[#5a5e62]" />
              <div className="font-pixel text-[11px] text-[#8e9296]">NO TRANSACTIONS RECORDED YET</div>
              <div className="text-[11px] text-[#5a5e62]">
                Click &quot;Run Live Demo&quot; or dispatch a test transaction above.
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-2.5">
              {reserveState.transactions.map((tx) => {
                const isSkipped = tx.reason?.includes('skipped — agent moved on');
                const isReserved = tx.status === 'reserved';
                const isCaptured = tx.status === 'captured';
                const isFrozen = tx.status === 'frozen';
                const isExpired = tx.status === 'expired';

                return (
                  <div
                    key={tx.id}
                    className={`relative p-3.5 rounded-[2px] border transition-all flex flex-col md:flex-row justify-between items-start md:items-center gap-3 ${
                      isCaptured
                        ? 'bg-[#061e14]/60 border-[#10b981]/50 text-emerald-100 shadow-sm'
                        : isReserved
                        ? 'bg-[#211606]/60 border-[#f59e0b]/60 text-amber-100 shadow-sm'
                        : isFrozen
                        ? 'bg-[#23090f]/60 border-[#ff3366]/60 text-rose-100 shadow-sm'
                        : isExpired || isSkipped
                        ? 'bg-[#0e1012] border-[#23272a] text-[#8e9296] opacity-75'
                        : 'bg-[#0e1012] border-[#23272a] text-[#f0f1f1]'
                    }`}
                  >
                    <div className="flex flex-col gap-1.5 flex-1">
                      <div className="flex items-center gap-2.5 flex-wrap">
                        <span className="text-xs md:text-sm font-bold text-white font-pixel tracking-wide">
                          {tx.merchant}
                        </span>

                        <span
                          className={`text-[9px] md:text-[10px] font-pixel font-bold uppercase tracking-wider px-2 py-0.5 rounded-[2px] border ${
                            isCaptured
                              ? 'bg-[#064e3b] text-[#34d399] border-[#059669]'
                              : isReserved
                              ? 'bg-[#78350f] text-[#fcd34d] border-[#d97706] animate-pulse'
                              : isFrozen
                              ? 'bg-[#881337] text-[#fda4af] border-[#e11d48]'
                              : 'bg-[#1b1e20] text-[#8e9296] border-[#2f3438]'
                          }`}
                        >
                          {isReserved ? '2PC RESERVED (HELD)' : tx.status}
                        </span>

                        <span className="text-[#5a5e62] font-mono text-[11px]">
                          {new Date(tx.timestamp).toLocaleTimeString([], {
                            hour: '2-digit',
                            minute: '2-digit',
                            second: '2-digit',
                          })}
                        </span>
                      </div>

                      <div className="text-[11px] font-mono text-[#8e9296] flex items-center gap-3 flex-wrap">
                        <span>
                          CATEGORY: <strong className="text-white">{tx.category}</strong>
                        </span>
                        {tx.quantity && <span>QTY: <strong className="text-white">{tx.quantity}</strong></span>}
                        {tx.razorpayOrderId && (
                          <span className="text-[#34d399] font-mono">
                            ORDER: {tx.razorpayOrderId}
                          </span>
                        )}
                        {tx.razorpayPaymentId && (
                          <span className="text-[#38bdf8] font-mono">
                            PAYMENT: {tx.razorpayPaymentId}
                          </span>
                        )}
                      </div>

                      {tx.reason && (
                        <div
                          className={`mt-0.5 text-[11px] font-mono px-2 py-1 rounded-[2px] border ${
                            isCaptured
                              ? 'text-[#6ee7b7] bg-[#022c22]/80 border-[#065f46]'
                              : isReserved
                              ? 'text-[#fde68a] bg-[#451a03]/80 border-[#78350f]'
                              : isFrozen
                              ? 'text-[#fecdd3] bg-[#4c0519]/80 border-[#9f1239]'
                              : 'text-[#8e9296] bg-[#070809] border-[#1b1e20]'
                          }`}
                        >
                          {tx.reason}
                        </div>
                      )}
                    </div>

                    <div className="flex items-center gap-3.5 w-full md:w-auto justify-between md:justify-end border-t md:border-t-0 border-[#23272a] pt-2 md:pt-0">
                      <div className="text-right font-mono">
                        <span className="text-sm md:text-base font-bold font-pixel text-white">
                          ₹{(tx.amount / 100).toFixed(2)}
                        </span>
                        <div className="text-[10px] text-[#5a5e62]">
                          {tx.amount.toLocaleString()} PAISE
                        </div>
                      </div>

                      {isFrozen && !isSkipped && (
                        <button
                          onClick={() => handleApproveAnyway(tx)}
                          className="bg-[#f9c425] hover:bg-[#eab308] active:bg-[#ca8a04] text-black text-[10px] font-pixel font-bold px-3 py-1.5 rounded-[2px] shadow-sm transition active:scale-[0.98] whitespace-nowrap uppercase tracking-wider"
                        >
                          APPROVE ANYWAY
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
