'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Policy, ReserveState, Transaction, LedgerEvent } from '@/lib/types';
import CornerBrackets from '../components/CornerBrackets';
import TelemetryBadge from '../components/TelemetryBadge';
import AgentFlowDemo from '../components/AgentFlowDemo';
import AttackDemo from '../components/AttackDemo';
import LedgerTimeline from '../components/LedgerTimeline';
import ConcurrencyDemo from '../components/ConcurrencyDemo';
import IdempotencyDemo from '../components/IdempotencyDemo';
import McpDemo from '../components/McpDemo';
import {
  Terminal, Activity, Zap, Play, RotateCw, ArrowRight, CreditCard,
  Lock, Layers, AlertTriangle, Clock, Radio, ShieldAlert, BookOpen, ChevronDown, Wrench
} from 'lucide-react';

export default function Home() {
  const [intentInput, setIntentInput] = useState(
    '₹2000 reserve, food only, order dinner for 2 under ₹800'
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
  const [ledgerEvents, setLedgerEvents] = useState<LedgerEvent[]>([]);

  const [isParsing, setIsParsing] = useState(false);
  const [isSubmittingPurchase, setIsSubmittingPurchase] = useState(false);
  const [isDemoRunning, setIsDemoRunning] = useState(false);
  const [demoStepStatus, setDemoStepStatus] = useState<string | null>(null);
  const [showAdminTools, setShowAdminTools] = useState(false);

  // Admin/manual simulator form state
  const [simMerchant, setSimMerchant] = useState('Swiggy');
  const [simAmount, setSimAmount] = useState('550');
  const [simCategory, setSimCategory] = useState('Food & Dining');
  const [simQuantity, setSimQuantity] = useState('1');

  const fetchInitialData = useCallback(async () => {
    try {
      const [policyRes, reserveRes] = await Promise.all([
        fetch('/api/policy').then((r) => r.json()),
        fetch('/api/reserve').then((r) => r.json()),
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
        if (reserveRes.ledgerEvents) setLedgerEvents(reserveRes.ledgerEvents);
      }
    } catch (err) {
      console.error('Failed to load initial data:', err);
    }
  }, []);

  useEffect(() => {
    const boot = async () => {
      try { await fetch('/api/session', { method: 'POST' }); } catch {}
      await fetchInitialData();
    };
    boot();

    if (typeof window !== 'undefined' && !document.getElementById('razorpay-checkout-script')) {
      const script = document.createElement('script');
      script.id = 'razorpay-checkout-script';
      script.src = 'https://checkout.razorpay.com/v1/checkout.js';
      script.async = true;
      document.body.appendChild(script);
    }

    const eventSource = new EventSource('/api/stream');
    eventSource.onmessage = (event) => {
      if (event.data === 'update') fetchInitialData();
    };
    return () => eventSource.close();
  }, [fetchInitialData]);

  const handleParseIntent = async () => {
    if (!intentInput.trim()) return;
    setIsParsing(true);
    try {
      const res = await fetch('/api/parse-intent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ intent: intentInput, setActive: true }),
      });
      const data = await res.json();
      if (data.policy) setParsedPolicy(data.policy);
    } catch (err) { console.error(err); }
    finally { setIsParsing(false); }
  };

  const triggerRazorpayCheckout = (orderId: string, amountPaise: number, merchantName: string) => {
    if (orderId.startsWith('order_mock_') || orderId.startsWith('order_test_mock_')) {
      alert(`[Mock Mode] Reserved!\n\nOrder: ${orderId}\nAmount: ₹${(amountPaise / 100).toFixed(2)}\nMerchant: ${merchantName}\n\nSimulating settlement...`);
      fetch('/api/verify-payment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          razorpay_order_id: orderId,
          razorpay_payment_id: `pay_mock_${Date.now()}`,
          razorpay_signature: 'mock_dev_signature_skip',
        }),
      }).then((r) => r.json()).then((data) => {
        if (data.updatedReserveState) setReserveState(data.updatedReserveState);
        fetchInitialData();
      }).catch(console.error);
      return;
    }
    const RzpClass = (window as unknown as { Razorpay: new (o: Record<string, unknown>) => { open(): void } }).Razorpay;
    if (!RzpClass) { alert('Razorpay SDK failed to load.'); return; }
    const rzp = new RzpClass({
      key: process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID || 'rzp_test_dev_key',
      amount: amountPaise, currency: 'INR',
      name: 'Reserve Pay Guardrail', description: `Purchase from ${merchantName}`,
      order_id: orderId,
      modal: {
        ondismiss: async () => {
          await fetch('/api/release', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ orderId, reason: 'Checkout modal cancelled' }) });
          fetchInitialData();
        },
      },
      handler: async (response: Record<string, unknown>) => {
        const verifyRes = await fetch('/api/verify-payment', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(response) });
        const verifyData = await verifyRes.json();
        if (verifyData.updatedReserveState) setReserveState(verifyData.updatedReserveState);
        else fetchInitialData();
      },
      prefill: { name: 'Reserve Pay User', email: 'user@example.com', contact: '9999999999' },
      theme: { color: '#FF571A' },
    });
    rzp.open();
  };

  const handleSimulatePurchase = async (e?: React.FormEvent, payload?: Record<string, unknown>) => {
    if (e) e.preventDefault();
    let body = payload;
    if (!body) {
      const cleanAmount = parseFloat(String(simAmount).replace(/[^0-9.]/g, ''));
      if (isNaN(cleanAmount) || cleanAmount <= 0) { alert('Enter a valid positive amount in ₹'); return; }
      body = { merchant: simMerchant.trim() || 'Swiggy', amount: Math.round(cleanAmount * 100), category: simCategory.trim() || 'Food & Dining', quantity: parseInt(simQuantity, 10) || 1 };
    }
    setIsSubmittingPurchase(true);
    try {
      const res = await fetch('/api/purchase', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await res.json();
      if (data.updatedReserveState) setReserveState(data.updatedReserveState);
      if (data.decision === 'allowed' && data.razorpayOrderId && typeof window !== 'undefined' && !isDemoRunning) {
        triggerRazorpayCheckout(data.razorpayOrderId, body.amount as number, body.merchant as string);
      }
      return data;
    } catch (err) { console.error(err); }
    finally { setIsSubmittingPurchase(false); }
  };

  const handleApproveAnyway = async (tx: Transaction) => {
    const res = await fetch('/api/purchase', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...tx, merchant: tx.merchant || 'Unknown', category: tx.category || 'General', amount: tx.amount, override: true }) });
    const data = await res.json();
    if (data.updatedReserveState) setReserveState(data.updatedReserveState);
    if (data.decision === 'allowed' && data.razorpayOrderId) triggerRazorpayCheckout(data.razorpayOrderId, tx.amount, tx.merchant);
  };

  const handleRunDemo = async () => {
    setIsDemoRunning(true);
    const merchant1 = parsedPolicy?.allowedMerchants?.[0] || 'Swiggy';
    const merchant2 = parsedPolicy?.allowedMerchants?.[1] || merchant1;
    const cat = parsedPolicy?.category || 'Food & Dining';
    const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
    try {
      setDemoStepStatus('Step 1/3: ₹550 from allowed merchant → Atomic Reservation Created...');
      await handleSimulatePurchase(undefined, { merchant: merchant1, amount: 55000, category: cat, quantity: 1 });
      await delay(1800);
      setDemoStepStatus('Step 2/3: ₹500 → Cumulative ₹1050 exceeds sessionCap → DENIED...');
      await handleSimulatePurchase(undefined, { merchant: merchant2, amount: 50000, category: cat, quantity: 1 });
      await delay(1800);
      setDemoStepStatus('Step 3/3: ₹300 from Walmart (unlisted merchant) → DENIED...');
      await handleSimulatePurchase(undefined, { merchant: 'Walmart', amount: 30000, category: 'Electronics', quantity: 1 });
      setDemoStepStatus('Demo Sequence Completed.');
      await delay(2000);
    } catch (err) {
      console.error(err);
      setDemoStepStatus('Demo encountered an error.');
    } finally {
      setIsDemoRunning(false);
      setDemoStepStatus(null);
    }
  };

  const totalPaise = reserveState.totalPaise ?? 200000;
  const heldPaise = reserveState.heldPaise ?? 0;
  const settledPaise = reserveState.settledPaise ?? 0;
  const availablePaise = reserveState.availablePaise ?? (totalPaise - heldPaise - settledPaise);
  const pctAvail = Math.max(0, Math.min(100, (availablePaise / totalPaise) * 100));
  const pctHeld = Math.max(0, Math.min(100, (heldPaise / totalPaise) * 100));
  const pctSettled = Math.max(0, Math.min(100, (settledPaise / totalPaise) * 100));

  return (
    <div className="min-h-screen bg-black text-[#f0f1f1] flex flex-col font-sans selection:bg-[#ff571a] selection:text-white pb-16">
      {/* Nav */}
      <nav className="w-full bg-[#0f1112] border-b border-[#2f3131] px-4 md:px-8 py-2.5 flex items-center justify-between flex-wrap gap-3 z-30 sticky top-0 backdrop-blur-md">
        <div className="flex items-center gap-3 flex-wrap text-xs">
          <span className="bg-[#ff571a] text-white font-pixel font-bold px-2.5 py-1 rounded-[2px] tracking-wider uppercase flex items-center gap-1.5 shadow-sm text-[10px] md:text-[11px]">
            <Radio className="w-3 h-3 animate-pulse" />
            ATOMIC RESERVATION ENGINE ACTIVE
          </span>
          <span className="text-[#8e9296] font-mono text-xs hidden sm:inline">
            FINANCIAL POLICY GUARDRAIL FOR AUTONOMOUS AI COMMERCE
          </span>
        </div>
        <div className="flex items-center gap-3 text-xs">
          <span className="text-[#22c55e] font-mono text-[11px] flex items-center gap-1">
            <Lock className="w-3 h-3" /><span>SESSION AUTHENTICATED</span>
          </span>
          <TelemetryBadge status="active" label="SSE LIVE" sublabel="STREAMING" />
        </div>
      </nav>

      <main className="max-w-6xl w-full mx-auto p-4 md:p-6 flex flex-col gap-6">
        {/* Header */}
        <header className="relative bg-[#0b0d0e] border border-[#23272a] p-6 rounded-[2px] flex flex-col md:flex-row justify-between items-start md:items-center gap-5 shadow-2xl">
          <CornerBrackets color="#ff571a" size={16} />
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <span className="text-[9px] md:text-[10px] font-pixel tracking-widest text-[#ff571a] uppercase bg-[#ff571a]/10 px-2 py-0.5 rounded-[2px] border border-[#ff571a]/30">
                SYSTEM CONTROLLER // V3.0
              </span>
            </div>
            <h1 className="text-lg md:text-2xl font-pixel tracking-tight text-white flex items-center gap-2 flex-wrap">
              <span className="text-[#ff571a]">RESERVE PAY</span>
              <span className="text-[#5a5e62] font-light">/</span>
              <span className="text-sm md:text-lg font-pixel text-[#8e9296] font-normal">Guardrail Controller</span>
            </h1>
            <div className="flex items-center gap-3 mt-0.5 flex-wrap text-xs">
              <p className="text-[#8e9296] font-mono text-[11px] md:text-xs">
                Integer Paise Ledger &bull; Atomic Reservation State Machine
              </p>
              {reserveState.ledgerIntegrity?.isValid !== false ? (
                <span className="bg-[#0f1112] text-[#22c55e] border border-[#22c55e]/40 text-[10px] md:text-[11px] font-pixel font-bold px-2 py-0.5 rounded-[2px] inline-flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-[#22c55e] animate-ping" />SHA-256 VERIFIED
                </span>
              ) : (
                <span className="bg-[#160a0d] text-[#ff3366] border border-[#ff3366]/50 text-[10px] md:text-[11px] font-pixel font-bold px-2 py-0.5 rounded-[2px] inline-flex items-center gap-1.5">
                  <AlertTriangle className="w-3 h-3" />TAMPERED @ {reserveState.ledgerIntegrity.corruptedIndex}
                </span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-3 w-full md:w-auto justify-end">
            <button onClick={handleRunDemo} disabled={isDemoRunning}
              className="bg-[#ff571a] hover:bg-[#e0440b] disabled:opacity-50 text-white font-pixel font-bold text-[10px] md:text-xs px-5 py-3 rounded-[2px] transition flex items-center gap-2 tracking-wider uppercase">
              {isDemoRunning ? <><span className="animate-spin inline-block w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full" /><span>RUNNING...</span></> : <><Play className="w-3.5 h-3.5 fill-current" /><span>RUN DEMO</span></>}
            </button>
            <button onClick={fetchInitialData} className="text-xs font-mono bg-[#111416] border border-[#2f3438] hover:border-[#ff571a]/60 text-[#8e9296] hover:text-white font-bold px-3.5 py-2.5 rounded-[2px] transition flex items-center gap-1.5">
              <RotateCw className="w-3.5 h-3.5" /><span>Sync</span>
            </button>
          </div>
        </header>

        {/* Demo progress */}
        {demoStepStatus && (
          <div className="relative bg-[#16120c] border border-[#ff571a]/60 text-[#f0f1f1] px-5 py-3 rounded-[2px] font-mono text-xs shadow-xl flex items-center justify-between gap-3">
            <CornerBrackets color="#ff571a" size={10} />
            <div className="flex items-center gap-3">
              <span className="relative flex h-2.5 w-2.5"><span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#ff571a] opacity-75" /><span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-[#ff571a]" /></span>
              <span className="font-pixel text-[10px] text-[#ff571a] uppercase tracking-wider">[LIVE SIM]</span>
              <span>{demoStepStatus}</span>
            </div>
            <Activity className="w-4 h-4 text-[#ff571a] animate-spin" />
          </div>
        )}

        {/* ── Panel 1: Agent Flow Demo ── */}
        <section className="relative bg-[#0b0d0e] border border-[#23272a] p-5 rounded-[2px] shadow-xl">
          <CornerBrackets color="#ff571a" size={14} />
          <div className="text-[10px] font-pixel text-[#5a5e62] tracking-widest uppercase mb-4 flex items-center justify-between border-b border-[#1b1e20] pb-2">
            <span className="flex items-center gap-2 text-[#ff571a]">
              <Terminal className="w-3.5 h-3.5" />{"// 01 AGENT COMMERCE FLOW"}
            </span>
            <span className="text-[#5a5e62] font-mono hidden sm:inline">INTENT → CATALOG → POLICY → RESERVE → ORDER</span>
          </div>
          <AgentFlowDemo onPurchaseComplete={fetchInitialData} triggerRazorpayCheckout={triggerRazorpayCheckout} />
        </section>

        {/* ── Panel 2: Reserve Ledger ── */}
        <section className="relative bg-[#0b0d0e] border border-[#23272a] p-5 rounded-[2px] shadow-xl flex flex-col gap-4">
          <CornerBrackets color="#ff571a" size={14} />
          <div className="text-[10px] font-pixel text-[#5a5e62] tracking-widest uppercase flex items-center justify-between border-b border-[#1b1e20] pb-2">
            <span className="flex items-center gap-2 text-[#ff571a]">
              <Layers className="w-3.5 h-3.5" />{"// 02 ATOMIC RESERVATION LEDGER"}
            </span>
            <span className="text-[#5a5e62] font-mono hidden sm:inline">ATOMIC BALANCE MONITOR</span>
          </div>
          <div className="flex justify-between items-end flex-wrap gap-3">
            <div>
              <h2 className="text-xs font-bold text-white uppercase tracking-wider font-pixel flex items-center gap-2">
                <CreditCard className="w-4 h-4 text-[#ff571a]" />Pool Allocation & Commit State
              </h2>
              <div className="flex items-center gap-4 text-xs font-mono text-[#8e9296] mt-2 flex-wrap">
                <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-[2px] bg-[#22c55e]" />Available: <strong className="text-[#22c55e]">₹{(availablePaise / 100).toFixed(2)}</strong></span>
                <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-[2px] bg-[#f9c425]" />Held: <strong className="text-[#f9c425]">₹{(heldPaise / 100).toFixed(2)}</strong></span>
                <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-[2px] bg-[#6366f1]" />Settled: <strong className="text-[#6366f1]">₹{(settledPaise / 100).toFixed(2)}</strong></span>
              </div>
            </div>
            <div className="text-right">
              <div className="text-lg md:text-2xl font-bold font-pixel text-white">₹{(availablePaise / 100).toFixed(2)}</div>
              <div className="text-[#5a5e62] text-xs font-mono">TOTAL: ₹{(totalPaise / 100).toFixed(2)}</div>
            </div>
          </div>
          <div className="w-full bg-[#070809] border border-[#23272a] rounded-[2px] h-6 p-0.5 overflow-hidden flex gap-0.5">
            {pctAvail > 0 && <div className="h-full bg-gradient-to-r from-[#10b981] to-[#059669] transition-all duration-500 flex items-center justify-center text-[9px] font-pixel font-bold text-black" style={{ width: `${pctAvail}%` }}>{pctAvail > 15 && `AVAIL ${pctAvail.toFixed(0)}%`}</div>}
            {pctHeld > 0 && <div className="h-full bg-gradient-to-r from-[#f59e0b] to-[#f9c425] animate-pulse transition-all duration-500 flex items-center justify-center text-[9px] font-pixel font-bold text-black" style={{ width: `${pctHeld}%` }}>{pctHeld > 10 && `HELD ${pctHeld.toFixed(0)}%`}</div>}
            {pctSettled > 0 && <div className="h-full bg-gradient-to-r from-[#6366f1] to-[#4f46e5] transition-all duration-500 flex items-center justify-center text-[9px] font-pixel font-bold text-white" style={{ width: `${pctSettled}%` }}>{pctSettled > 10 && `SETTLED ${pctSettled.toFixed(0)}%`}</div>}
          </div>
        </section>

        {/* ── Panel 3: Attack Guardrail ── */}
        <section className="relative bg-[#0b0d0e] border border-[#23272a] p-5 rounded-[2px] shadow-xl">
          <CornerBrackets color="#ff571a" size={14} />
          <div className="text-[10px] font-pixel text-[#5a5e62] tracking-widest uppercase mb-4 flex items-center justify-between border-b border-[#1b1e20] pb-2">
            <span className="flex items-center gap-2 text-[#ff571a]">
              <ShieldAlert className="w-3.5 h-3.5" />{"// 03 ATTACK GUARDRAIL DEMO"}
            </span>
            <span className="text-[#5a5e62] font-mono hidden sm:inline">8 ADVERSARIAL SCENARIOS</span>
          </div>
          <AttackDemo />
        </section>

        {/* ── Panel 4: Ledger Timeline ── */}
        <section className="relative bg-[#0b0d0e] border border-[#23272a] p-5 rounded-[2px] shadow-xl">
          <CornerBrackets color="#ff571a" size={14} />
          <div className="text-[10px] font-pixel text-[#5a5e62] tracking-widest uppercase mb-4 flex items-center justify-between border-b border-[#1b1e20] pb-2">
            <span className="flex items-center gap-2 text-[#ff571a]">
              <BookOpen className="w-3.5 h-3.5" />{"// 04 IMMUTABLE LEDGER TIMELINE"}
            </span>
            <span className="text-[#8e9296] font-pixel text-[9px] bg-[#111416] px-2 py-0.5 rounded-[2px] border border-[#23272a]">
              {ledgerEvents.length} EVENTS
            </span>
          </div>
          <LedgerTimeline
            events={ledgerEvents}
            isVerified={reserveState.ledgerIntegrity?.isValid !== false}
            corruptedIndex={reserveState.ledgerIntegrity?.corruptedIndex}
          />
        </section>

        {/* ── Panel 5: Transaction Feed ── */}
        <section className="relative bg-[#0b0d0e] border border-[#23272a] p-5 rounded-[2px] shadow-xl flex flex-col gap-4">
          <CornerBrackets color="#ff571a" size={14} />
          <div className="text-[10px] font-pixel text-[#5a5e62] tracking-widest uppercase flex items-center justify-between border-b border-[#1b1e20] pb-2">
            <span className="flex items-center gap-2 text-[#ff571a]">
              <Activity className="w-3.5 h-3.5" />{"// 05 REAL-TIME TRANSACTION FEED"}
            </span>
            <span className="text-[#8e9296] font-pixel text-[9px] bg-[#111416] px-2 py-0.5 rounded-[2px] border border-[#23272a]">
              {reserveState.transactions.length} RECORDS
            </span>
          </div>
          {reserveState.transactions.length === 0 ? (
            <div className="p-8 text-center text-[#5a5e62] font-mono bg-[#070809] rounded-[2px] border border-[#23272a] text-xs flex flex-col items-center gap-2">
              <Clock className="w-6 h-6" />
              <div className="font-pixel text-[11px] text-[#8e9296]">NO TRANSACTIONS YET</div>
              <div className="text-[11px]">Use the Agent Flow Demo above or click Run Demo.</div>
            </div>
          ) : (
            <div className="flex flex-col gap-2.5">
              {[...reserveState.transactions].reverse().map((tx) => {
                const isReserved = tx.status === 'reserved';
                const isCaptured = tx.status === 'captured';
                const isFrozen = tx.status === 'frozen';
                const isReview = tx.decisionStatus === 'review';
                const isExpired = tx.status === 'expired' || tx.status === 'released';
                const isSkipped = tx.reason?.includes('skipped');
                return (
                  <div key={tx.id} className={`relative p-3.5 rounded-[2px] border transition-all flex flex-col md:flex-row justify-between items-start md:items-center gap-3 ${
                    isCaptured ? 'bg-[#061e14]/60 border-[#10b981]/50' :
                    isReserved ? 'bg-[#211606]/60 border-[#f59e0b]/60' :
                    isReview   ? 'bg-[#141209]/60 border-[#f9c425]/60' :
                    isFrozen   ? 'bg-[#23090f]/60 border-[#ff3366]/60' :
                    'bg-[#0e1012] border-[#23272a] opacity-75'
                  }`}>
                    <div className="flex flex-col gap-1.5 flex-1">
                      <div className="flex items-center gap-2.5 flex-wrap">
                        <span className="text-xs font-bold text-white font-pixel">{tx.merchant}</span>
                        <span className={`text-[9px] font-pixel font-bold uppercase px-2 py-0.5 rounded-[2px] border ${
                          isCaptured ? 'bg-[#064e3b] text-[#34d399] border-[#059669]' :
                          isReserved ? 'bg-[#78350f] text-[#fcd34d] border-[#d97706] animate-pulse' :
                          isReview   ? 'bg-[#1a1300] text-[#f9c425] border-[#f9c425]/50' :
                          isFrozen   ? 'bg-[#881337] text-[#fda4af] border-[#e11d48]' :
                          'bg-[#1b1e20] text-[#8e9296] border-[#2f3438]'
                        }`}>
                          {isReserved ? 'ATOMIC RESERVED' : isReview ? 'REVIEW REQUIRED' : tx.status.toUpperCase()}
                        </span>
                        <span className="text-[#5a5e62] font-mono text-[11px]">
                          {new Date(tx.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                        </span>
                      </div>
                      <div className="text-[11px] font-mono text-[#8e9296] flex items-center gap-3 flex-wrap">
                        <span>CAT: <strong className="text-white">{tx.category}</strong></span>
                        {tx.quantity && <span>QTY: <strong className="text-white">{tx.quantity}</strong></span>}
                        {tx.productId && <span>PID: <strong className="text-[#38bdf8]">{tx.productId}</strong></span>}
                        {tx.razorpayOrderId && <span className="text-[#34d399]">ORDER: {tx.razorpayOrderId.slice(0, 20)}…</span>}
                      </div>
                      {tx.reason && (
                        <div className={`mt-0.5 text-[11px] font-mono px-2 py-1 rounded-[2px] border ${
                          isCaptured ? 'text-[#6ee7b7] bg-[#022c22]/80 border-[#065f46]' :
                          isReserved ? 'text-[#fde68a] bg-[#451a03]/80 border-[#78350f]' :
                          isFrozen   ? 'text-[#fecdd3] bg-[#4c0519]/80 border-[#9f1239]' :
                          'text-[#8e9296] bg-[#070809] border-[#1b1e20]'
                        }`}>{tx.reason}</div>
                      )}
                    </div>
                    <div className="flex items-center gap-3.5 w-full md:w-auto justify-between md:justify-end border-t md:border-t-0 border-[#23272a] pt-2 md:pt-0">
                      <div className="text-right font-mono">
                        <span className="text-sm font-bold font-pixel text-white">₹{(tx.amount / 100).toFixed(2)}</span>
                        <div className="text-[10px] text-[#5a5e62]">{tx.amount.toLocaleString()} PAISE</div>
                      </div>
                      {isFrozen && !isSkipped && (
                        <button onClick={() => handleApproveAnyway(tx)} className="bg-[#f9c425] hover:bg-[#eab308] text-black text-[10px] font-pixel font-bold px-3 py-1.5 rounded-[2px] transition uppercase tracking-wider whitespace-nowrap">
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

        {/* ── Panel 6: MCP Demo ── */}
        <section className="relative bg-[#0b0d0e] border border-[#23272a] p-5 rounded-[2px] shadow-xl">
          <CornerBrackets color="#353535" size={14} />
          <div className="text-[10px] font-pixel text-[#5a5e62] tracking-widest uppercase mb-4 flex items-center justify-between border-b border-[#1b1e20] pb-2">
            <span className="flex items-center gap-2 text-[#38bdf8]">
              <Wrench className="w-3.5 h-3.5" />{"// 06 MCP TOOL SIMULATION"}
            </span>
            <span className="text-[#5a5e62] font-mono hidden sm:inline">MODEL CONTEXT PROTOCOL</span>
          </div>
          <McpDemo />
        </section>

        {/* ── Panel 7: Concurrency Attack ── */}
        <section className="relative bg-[#0b0d0e] border border-[#23272a] p-5 rounded-[2px] shadow-xl">
          <CornerBrackets color="#353535" size={14} />
          <div className="text-[10px] font-pixel text-[#5a5e62] tracking-widest uppercase mb-4 flex items-center justify-between border-b border-[#1b1e20] pb-2">
            <span className="flex items-center gap-2 text-[#ff571a]">
              <Zap className="w-3.5 h-3.5" />{"// 07 CONCURRENCY ATTACK"}
            </span>
          </div>
          <ConcurrencyDemo />
        </section>

        {/* ── Panel 8: Idempotency Replay ── */}
        <section className="relative bg-[#0b0d0e] border border-[#23272a] p-5 rounded-[2px] shadow-xl">
          <CornerBrackets color="#353535" size={14} />
          <div className="text-[10px] font-pixel text-[#5a5e62] tracking-widest uppercase mb-4 flex items-center justify-between border-b border-[#1b1e20] pb-2">
            <span className="flex items-center gap-2 text-[#38bdf8]">
              <RotateCw className="w-3.5 h-3.5" />{"// 08 IDEMPOTENCY REPLAY"}
            </span>
          </div>
          <IdempotencyDemo />
        </section>

        {/* ── Panel 9: Intent & Policy (collapsed into admin tools) ── */}
        <section className="relative bg-[#0b0d0e] border border-[#23272a] rounded-[2px] shadow-xl overflow-hidden">
          <CornerBrackets color="#353535" size={12} />
          <button onClick={() => setShowAdminTools((p) => !p)} className="w-full px-5 py-3 flex items-center justify-between text-[10px] font-pixel text-[#5a5e62] uppercase tracking-widest hover:text-[#ff571a] transition">
            <span className="flex items-center gap-2"><Zap className="w-3.5 h-3.5" />{"// 09 MANUAL SIMULATOR & POLICY TOOLS"}</span>
            <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showAdminTools ? 'rotate-180' : ''}`} />
          </button>

          {showAdminTools && (
            <div className="px-5 pb-5 flex flex-col gap-5">
              {/* Policy synthesis */}
              <div className="flex flex-col gap-3">
                <div className="text-[10px] font-pixel text-[#8e9296] uppercase tracking-widest border-b border-[#1b1e20] pb-1">Intent Parser</div>
                <div className="grid md:grid-cols-2 gap-4">
                  <div className="flex flex-col gap-2">
                    <textarea value={intentInput} onChange={(e) => setIntentInput(e.target.value)}
                      className="w-full h-24 p-3 bg-[#070809] border border-[#23272a] focus:border-[#ff571a] rounded-[2px] text-xs text-white font-mono focus:outline-none transition resize-none"
                      placeholder="₹1000 reserve, groceries only..." />
                    <button onClick={handleParseIntent} disabled={isParsing}
                      className="self-end bg-[#ff571a] hover:bg-[#e0440b] disabled:opacity-50 text-white text-[10px] font-pixel font-bold px-4 py-2 rounded-[2px] transition flex items-center gap-2 uppercase">
                      {isParsing ? <><span className="animate-spin w-3 h-3 border-2 border-white border-t-transparent rounded-full inline-block" /><span>PARSING...</span></> : <><span>PARSE & SET POLICY</span><ArrowRight className="w-3 h-3" /></>}
                    </button>
                  </div>
                  <pre className="w-full h-24 p-3 bg-[#070809] border border-[#23272a] rounded-[2px] text-xs text-[#22c55e] font-mono overflow-auto">
                    {parsedPolicy ? JSON.stringify(parsedPolicy, null, 2) : <span className="text-[#5a5e62]">{"// policy will appear here"}</span>}
                  </pre>
                </div>
              </div>

              {/* Raw simulator */}
              <div className="flex flex-col gap-2">
                <div className="text-[10px] font-pixel text-[#8e9296] uppercase tracking-widest border-b border-[#1b1e20] pb-1">Raw Transaction Simulator (Admin / Demo Role)</div>
                <form onSubmit={(e) => handleSimulatePurchase(e)} className="grid grid-cols-2 md:grid-cols-5 gap-3">
                  {[['Merchant', simMerchant, setSimMerchant, 'text', 'e.g. Swiggy'], ['Amount (₹)', simAmount, setSimAmount, 'number', '550'], ['Category', simCategory, setSimCategory, 'text', 'Food & Dining'], ['Qty', simQuantity, setSimQuantity, 'number', '1']].map(([label, val, setter, type, ph]) => (
                    <div key={label as string} className="flex flex-col gap-1">
                      <label className="text-[9px] font-pixel text-[#8e9296] uppercase">{label as string}</label>
                      <input type={type as string} placeholder={ph as string} value={val as string} onChange={(e) => (setter as (v: string) => void)(e.target.value)}
                        className="p-2.5 bg-[#070809] border border-[#23272a] focus:border-[#ff571a] rounded-[2px] text-xs text-white font-mono focus:outline-none transition" required />
                    </div>
                  ))}
                  <div className="flex flex-col justify-end">
                    <button type="submit" disabled={isSubmittingPurchase || isDemoRunning}
                      className="w-full bg-[#16191c] hover:bg-[#ff571a] hover:text-white border border-[#2f3438] hover:border-[#ff571a] disabled:opacity-50 text-[#f0f1f1] text-[10px] font-pixel font-bold p-2.5 rounded-[2px] transition flex items-center justify-center gap-1.5 uppercase">
                      {isSubmittingPurchase ? <><span className="animate-spin w-3 h-3 border-2 border-white border-t-transparent rounded-full inline-block" /><span>RESERVING...</span></> : <><span>SUBMIT TX</span><ArrowRight className="w-3 h-3" /></>}
                    </button>
                  </div>
                </form>
              </div>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
