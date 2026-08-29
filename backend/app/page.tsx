'use client';

import React, { useState, useEffect } from 'react';
import { Policy, ReserveState, Transaction } from '@/lib/types';

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

  const UI_AUTH_HEADERS = {
    'Content-Type': 'application/json',
    'X-API-Key': process.env.NEXT_PUBLIC_ADMIN_API_KEY || 'admin_api_key_default',
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

  // 2. Submit Attempted Purchase (/api/purchase) - Converts INR input to integer Paise
  const handleSimulatePurchase = async (
    e?: React.FormEvent,
    purchasePayload?: Record<string, unknown>
  ) => {
    if (e) e.preventDefault();
    const payload = purchasePayload || {
      merchant: simMerchant,
      amount: Math.round(parseFloat(simAmount) * 100), // Convert INR to integer Paise
      category: simCategory,
      quantity: parseInt(simQuantity, 10) || 1,
    };

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
          typeof window !== 'undefined'
        ) {
          const RazorpayClass = (window as unknown as { Razorpay: new (options: Record<string, unknown>) => { open: () => void } }).Razorpay;
          if (!RazorpayClass) {
            console.error('Razorpay SDK failed to load.');
            alert('Payment gateway failed to load. Please disable ad-blockers and try again.');
            return data;
          }
          try {
            const options = {
            key: process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID || 'rzp_test_dev_key',
            amount: payload.amount as number, // already in integer paise
            currency: 'INR',
            name: 'Reserve Pay Guardrail',
            description: `Purchase from ${payload.merchant}`,
            order_id: data.razorpayOrderId,
            modal: {
              ondismiss: async function () {
                console.log('Checkout modal closed/dismissed. Releasing 2PC reservation.');
                try {
                  await fetch('/api/release', {
                    method: 'POST',
                    headers: UI_AUTH_HEADERS,
                    body: JSON.stringify({ orderId: data.razorpayOrderId, reason: 'Checkout modal cancelled by user' }),
                  });
                  fetchInitialData();
                } catch (releaseErr) {
                  console.error('Failed to release reservation:', releaseErr);
                }
              },
            },
            handler: async function (response: Record<string, unknown>) {
              console.log('Razorpay payment authorized successfully:', response);
              // Send payment signature for verification and 2PC settlement
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
              color: '#2563eb',
            },
          };
          const rzp = new RazorpayClass(options);
          rzp.open();
        } catch (checkoutErr) {
          console.warn('Razorpay Checkout UI initialization error:', checkoutErr);
        }
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
          override: true,
        }),
      });
      const data = await res.json();
      if (data.updatedReserveState) {
        setReserveState(data.updatedReserveState);
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

      setDemoStepStatus('✅ Demo Sequence Completed Successfully!');
      await delay(2000);
    } catch (err) {
      console.error('Error during demo sequence:', err);
      setDemoStepStatus('❌ Demo sequence encountered an error.');
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
    <main className="min-h-screen bg-slate-950 text-slate-100 p-4 md:p-6 flex flex-col gap-5 max-w-6xl mx-auto font-sans">
      {/* Header - 1280x720 projector safe */}
      <header className="border-b border-slate-800 pb-3 flex justify-between items-center flex-wrap gap-3">
        <div>
          <h1 className="text-3xl md:text-4xl font-extrabold tracking-tight text-white flex items-center gap-2.5">
            <span className="bg-blue-600 text-white px-2.5 py-0.5 rounded-lg text-xl md:text-2xl font-bold">
              🛡️ Reserve Pay
            </span>
            Two-Phase Commit Guardrail Controller
          </h1>
          <div className="flex items-center gap-3 mt-1 flex-wrap">
            <p className="text-slate-400 text-sm md:text-base font-medium">
              Integer Paise Ledger &bull; Atomic 2PC Reservation State Machine
            </p>
            {reserveState.ledgerIntegrity?.isValid !== false ? (
              <span className="bg-emerald-950 text-emerald-300 border border-emerald-600/70 text-xs font-black px-2.5 py-1 rounded-full inline-flex items-center gap-1.5 shadow-sm">
                <span className="h-2 w-2 rounded-full bg-emerald-400 animate-ping"></span>
                🟢 Ledger Integrity: SHA-256 Verified (0 Precision Loss)
              </span>
            ) : (
              <span className="bg-rose-950 text-rose-300 border border-rose-600 text-xs font-black px-2.5 py-1 rounded-full inline-flex items-center gap-1.5 shadow-sm">
                🔴 Ledger Integrity: Tampered @ Index {reserveState.ledgerIntegrity.corruptedIndex}
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2.5">
          <button
            onClick={handleRunDemo}
            disabled={isDemoRunning}
            className="bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 disabled:opacity-50 text-white font-extrabold text-sm md:text-base px-4 py-2 rounded-xl shadow-lg transition active:scale-95 flex items-center gap-2"
          >
            {isDemoRunning ? (
              <>
                <span className="animate-spin inline-block w-4 h-4 border-2 border-current border-t-transparent text-white rounded-full"></span>
                Running Demo...
              </>
            ) : (
              '🚀 Run Demo'
            )}
          </button>

          <button
            onClick={fetchInitialData}
            className="text-xs bg-slate-900 border border-slate-700 hover:border-slate-500 text-slate-300 font-bold px-3 py-2 rounded-xl transition"
          >
            🔄 Refresh
          </button>
        </div>
      </header>

      {/* Demo Progress Banner */}
      {demoStepStatus && (
        <div className="bg-purple-950/90 border border-purple-500 text-purple-200 px-4 py-2.5 rounded-xl font-bold text-center text-sm md:text-base shadow-lg flex items-center justify-center gap-3">
          <span className="relative flex h-3 w-3">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-purple-400 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-3 w-3 bg-purple-500"></span>
          </span>
          {demoStepStatus}
        </div>
      )}

      {/* Panel 1: Top - Intent Input & Parsed Policy JSON */}
      <section className="grid md:grid-cols-2 gap-4 bg-slate-900 border border-slate-800 p-4 rounded-2xl shadow-xl">
        <div className="flex flex-col gap-2">
          <label className="text-base font-bold text-blue-400 flex items-center gap-2">
            <span>💬</span> Natural Language Intent Prompt
          </label>
          <textarea
            value={intentInput}
            onChange={(e) => setIntentInput(e.target.value)}
            className="w-full h-28 p-3 bg-slate-950 border-2 border-slate-700 rounded-xl text-base text-white font-medium focus:outline-none focus:border-blue-500 transition shadow-inner resize-none"
            placeholder="Type your spending guardrail prompt..."
          />
          <div className="flex justify-end">
            <button
              onClick={handleParseIntent}
              disabled={isParsing || isDemoRunning}
              className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-bold px-4 py-2 rounded-xl shadow-lg transition active:scale-95 flex items-center gap-2"
            >
              {isParsing ? 'Parsing with Gemini...' : 'Parse & Set Policy →'}
            </button>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex justify-between items-center">
            <span className="text-base font-bold text-emerald-400 flex items-center gap-2">
              <span>⚙️</span> Live Active Policy (Paise Minor-Units)
            </span>
            <span className="bg-emerald-950 text-emerald-300 text-xs font-bold px-2 py-0.5 rounded-full border border-emerald-800">
              Active Policy
            </span>
          </div>
          <pre className="w-full h-28 p-3 bg-slate-950 border-2 border-slate-800 rounded-xl text-sm text-emerald-300 font-mono overflow-auto shadow-inner">
            {parsedPolicy
              ? JSON.stringify(parsedPolicy, null, 2)
              : '// Click "Parse & Set Policy" to load live policy'}
          </pre>
        </div>
      </section>

      {/* Panel 2: Middle - 2PC Reserve Ledger Balance Bar */}
      <section className="bg-slate-900 border border-slate-800 p-4 rounded-2xl shadow-xl flex flex-col gap-3">
        <div className="flex justify-between items-end flex-wrap gap-2">
          <div>
            <h2 className="text-lg font-bold text-amber-400 flex items-center gap-2">
              <span>💳</span> Two-Phase Commit Reserve Ledger
            </h2>
            <div className="flex items-center gap-4 text-xs md:text-sm text-slate-400 mt-1 flex-wrap">
              <span>Available: <strong className="text-emerald-400 font-black">₹{(availablePaise / 100).toFixed(2)}</strong></span>
              <span>Held (2PC Pending): <strong className="text-amber-400 font-black">₹{(heldPaise / 100).toFixed(2)}</strong></span>
              <span>Settled (Captured): <strong className="text-indigo-400 font-black">₹{(settledPaise / 100).toFixed(2)}</strong></span>
            </div>
          </div>
          <div className="text-right">
            <span className="text-2xl md:text-3xl font-black text-white">
              ₹{(availablePaise / 100).toFixed(2)}
            </span>
            <span className="text-slate-400 text-sm font-semibold">
              {' '}
              / ₹{(totalPaise / 100).toFixed(2)} total ({totalPaise.toLocaleString()} Paise)
            </span>
          </div>
        </div>

        {/* Multi-Segment 2PC Ledger Balance Bar */}
        <div className="w-full bg-slate-950 border-2 border-slate-800 rounded-full h-7 p-1 shadow-inner relative overflow-hidden flex gap-1">
          {/* Available slice */}
          <div
            className="h-full rounded-l-full bg-gradient-to-r from-emerald-600 to-teal-500 transition-all duration-500 flex items-center justify-center text-[10px] font-extrabold text-white"
            style={{ width: `${percentageAvailable}%` }}
            title={`Available: ₹${(availablePaise / 100).toFixed(2)}`}
          >
            {percentageAvailable > 15 && `Avail ${percentageAvailable.toFixed(0)}%`}
          </div>
          {/* Held (2PC) slice */}
          {percentageHeld > 0 && (
            <div
              className="h-full bg-gradient-to-r from-amber-500 to-yellow-400 animate-pulse transition-all duration-500 flex items-center justify-center text-[10px] font-black text-slate-950"
              style={{ width: `${percentageHeld}%` }}
              title={`Held in 2PC: ₹${(heldPaise / 100).toFixed(2)}`}
            >
              {percentageHeld > 10 && `Held ${percentageHeld.toFixed(0)}%`}
            </div>
          )}
          {/* Settled slice */}
          {percentageSettled > 0 && (
            <div
              className="h-full rounded-r-full bg-gradient-to-r from-indigo-600 to-purple-600 transition-all duration-500 flex items-center justify-center text-[10px] font-extrabold text-white"
              style={{ width: `${percentageSettled}%` }}
              title={`Settled: ₹${(settledPaise / 100).toFixed(2)}`}
            >
              {percentageSettled > 10 && `Settled ${percentageSettled.toFixed(0)}%`}
            </div>
          )}
        </div>
      </section>

      {/* Single Purchase Simulator Controls */}
      <section className="bg-slate-900 border border-slate-800 p-4 rounded-2xl shadow-xl flex flex-col gap-3">
        <h2 className="text-base font-bold text-indigo-400 flex items-center gap-2">
          <span>🛒</span> Test Purchase Simulator
        </h2>
        <form onSubmit={(e) => handleSimulatePurchase(e)} className="grid grid-cols-2 md:grid-cols-5 gap-2.5">
          <input
            type="text"
            placeholder="Merchant"
            value={simMerchant}
            onChange={(e) => setSimMerchant(e.target.value)}
            className="p-2 bg-slate-950 border border-slate-700 rounded-lg text-sm text-white font-medium focus:border-indigo-500"
            required
          />
          <input
            type="number"
            step="0.01"
            placeholder="Amount (₹)"
            value={simAmount}
            onChange={(e) => setSimAmount(e.target.value)}
            className="p-2 bg-slate-950 border border-slate-700 rounded-lg text-sm text-white font-medium focus:border-indigo-500"
            required
          />
          <input
            type="text"
            placeholder="Category"
            value={simCategory}
            onChange={(e) => setSimCategory(e.target.value)}
            className="p-2 bg-slate-950 border border-slate-700 rounded-lg text-sm text-white font-medium focus:border-indigo-500"
            required
          />
          <input
            type="number"
            placeholder="Quantity"
            value={simQuantity}
            onChange={(e) => setSimQuantity(e.target.value)}
            className="p-2 bg-slate-950 border border-slate-700 rounded-lg text-sm text-white font-medium focus:border-indigo-500"
            required
          />
          <button
            type="submit"
            disabled={isSubmittingPurchase || isDemoRunning}
            className="col-span-2 md:col-span-1 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm font-bold px-3 py-2 rounded-lg transition active:scale-95"
          >
            {isSubmittingPurchase ? 'Reserving...' : 'Submit Tx'}
          </button>
        </form>
      </section>

      {/* Panel 3: Bottom - Transaction Feed */}
      <section className="bg-slate-900 border border-slate-800 p-4 rounded-2xl shadow-xl flex flex-col gap-3">
        <div className="flex justify-between items-center">
          <h2 className="text-xl font-bold text-white flex items-center gap-2">
            <span>📋</span> Live 2PC Transaction Ledger
          </h2>
          <span className="text-slate-400 text-xs font-semibold">
            {reserveState.transactions.length} items total
          </span>
        </div>

        {reserveState.transactions.length === 0 ? (
          <div className="p-6 text-center text-slate-500 font-medium bg-slate-950 rounded-xl border border-slate-800 text-sm">
            No transactions processed yet. Click &quot;🚀 Run Demo&quot; or use the simulator above!
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {reserveState.transactions.map((tx) => {
              const isSkipped = tx.reason?.includes('skipped — agent moved on');
              const isReserved = tx.status === 'reserved';
              const isCaptured = tx.status === 'captured';
              const isFrozen = tx.status === 'frozen';
              const isExpired = tx.status === 'expired';

              return (
                <div
                  key={tx.id}
                  className={`p-4 rounded-xl border-2 transition-all flex flex-col md:flex-row justify-between items-start md:items-center gap-3 ${
                    isCaptured
                      ? 'bg-emerald-950/60 border-emerald-600 text-emerald-100'
                      : isReserved
                      ? 'bg-amber-950/40 border-amber-500/80 text-amber-100'
                      : isFrozen
                      ? 'bg-rose-950/50 border-rose-600/80 text-rose-100'
                      : isExpired || isSkipped
                      ? 'bg-slate-900 border-slate-700 text-slate-400 opacity-80'
                      : 'bg-slate-900 border-slate-800 text-slate-200'
                  }`}
                >
                  <div className="flex flex-col gap-1">
                    <div className="flex items-center gap-2.5 flex-wrap">
                      <span className="text-lg font-extrabold text-white">{tx.merchant}</span>
                      <span
                        className={`text-xs font-black uppercase tracking-wider px-2.5 py-0.5 rounded-full ${
                          isCaptured
                            ? 'bg-emerald-500 text-slate-950'
                            : isReserved
                            ? 'bg-amber-400 text-slate-950 animate-pulse'
                            : isFrozen
                            ? 'bg-rose-500 text-white'
                            : isExpired
                            ? 'bg-slate-700 text-slate-300'
                            : 'bg-slate-700 text-slate-300'
                        }`}
                      >
                        {isReserved ? '2PC RESERVED (HELD)' : tx.status}
                      </span>
                      <span className="text-slate-400 text-xs font-medium">
                        {new Date(tx.timestamp).toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit',
                          second: '2-digit',
                        })}
                      </span>
                    </div>
                    <div className="text-xs font-medium text-slate-300">
                      Category: <span className="text-white font-semibold">{tx.category}</span>
                      {tx.quantity && ` • Quantity: ${tx.quantity}`}
                      {tx.razorpayOrderId && (
                        <span className="ml-2 font-mono text-emerald-400 font-bold">
                          • Order: {tx.razorpayOrderId}
                        </span>
                      )}
                      {tx.razorpayPaymentId && (
                        <span className="ml-2 font-mono text-cyan-400 font-bold">
                          • Payment: {tx.razorpayPaymentId}
                        </span>
                      )}
                    </div>
                    {tx.reason && (
                      <div
                        className={`mt-1 text-xs font-bold px-2.5 py-1 rounded-lg border ${
                          isCaptured
                            ? 'text-emerald-300 bg-emerald-950/80 border-emerald-800'
                            : isReserved
                            ? 'text-amber-300 bg-amber-950/80 border-amber-700/50'
                            : isFrozen
                            ? 'text-rose-300 bg-rose-950/80 border-rose-700/50'
                            : 'text-slate-400 bg-slate-950 border-slate-800'
                        }`}
                      >
                        {isFrozen ? `⚠️ ${tx.reason}` : `ℹ️ ${tx.reason}`}
                      </div>
                    )}
                  </div>

                  <div className="flex items-center gap-3 w-full md:w-auto justify-between md:justify-end border-t md:border-t-0 border-slate-800/80 pt-2 md:pt-0">
                    <div className="text-right">
                      <span className="text-xl font-black text-white">
                        ₹{(tx.amount / 100).toFixed(2)}
                      </span>
                      <div className="text-[10px] text-slate-400 font-mono">
                        {tx.amount.toLocaleString()} paise
                      </div>
                    </div>
                    {isFrozen && !isSkipped && (
                      <button
                        onClick={() => handleApproveAnyway(tx)}
                        className="bg-amber-500 hover:bg-amber-400 text-slate-950 text-xs md:text-sm font-extrabold px-3 py-1.5 rounded-lg shadow-md transition active:scale-95 whitespace-nowrap"
                      >
                        Approve Anyway
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
  );
}

