'use client';

import React, { useState } from 'react';
import {
  Layers, ShieldCheck, Database, Cpu, ArrowRight,
  Lock, RefreshCw, Key, CheckCircle, Terminal, Zap, FileText
} from 'lucide-react';
import CornerBrackets from './CornerBrackets';

interface ArchitectureStage {
  id: string;
  step: string;
  title: string;
  tech: string;
  description: string;
  guarantee: string;
  color: string;
  borderColor: string;
  bgColor: string;
}

const STAGES: ArchitectureStage[] = [
  {
    id: 'stage_1',
    step: 'STAGE 01',
    title: 'Natural Language Intent Synthesis',
    tech: 'Google Gemini Flash + Regex Fallback',
    description: 'Extracts structured spending policies (ceilings, merchants, categories, session caps) with XML tag isolation to prevent prompt injection.',
    guarantee: 'Fail-closed hard clamping: Ceiling <= INR 1,00,000, Session <= INR 10,00,000',
    color: 'text-[#38bdf8]',
    borderColor: 'border-[#38bdf8]/40',
    bgColor: 'bg-[#0b1b2b]/60',
  },
  {
    id: 'stage_2',
    step: 'STAGE 02',
    title: '6-Factor Policy Decision Engine',
    tech: 'Deterministic TypeScript Rules',
    description: 'Evaluates merchant allowlist/blocklist with canonical alias normalization, category MCC codes, amount ceiling, 80% near-limit human review, cumulative session caps, and quantity sanity.',
    guarantee: 'Zero AI money authorization. Fully deterministic and auditable.',
    color: 'text-[#ff571a]',
    borderColor: 'border-[#ff571a]/40',
    bgColor: 'bg-[#2a0e05]/60',
  },
  {
    id: 'stage_3',
    step: 'STAGE 03',
    title: 'Atomic Fund Reservation & Concurrency',
    tech: 'PostgreSQL SERIALIZABLE + Row Locks / SQLite BEGIN IMMEDIATE',
    description: 'Acquires row-level locks on agent balance before gateway order creation. Ephemeral token bucket coordinates distributed rate limits.',
    guarantee: 'Mathematical zero double-spending under 1,000+ parallel concurrent requests.',
    color: 'text-[#f59e0b]',
    borderColor: 'border-[#f59e0b]/40',
    bgColor: 'bg-[#291804]/60',
  },
  {
    id: 'stage_4',
    step: 'STAGE 04',
    title: 'Gateway Order Creation & Timeout Handling',
    tech: 'Razorpay Orders API + 3-Outcome Settlement',
    description: 'Generates Razorpay order linked to active reservation. Success attaches order ID; definite failure triggers immediate rollback; timeouts route to background reconciler.',
    guarantee: 'Zero fund leakage on network drops or downstream gateway errors.',
    color: 'text-[#a855f7]',
    borderColor: 'border-[#a855f7]/40',
    bgColor: 'bg-[#1e0a2e]/60',
  },
  {
    id: 'stage_5',
    step: 'STAGE 05',
    title: 'Webhook Verification & Triple-Binding',
    tech: 'HMAC-SHA256 Signature Verification',
    description: 'Validates webhook payload authenticity using Razorpay webhook secret. Enforces triple-binding: order_id, payment_id, and captured amount must strictly match reservation.',
    guarantee: 'Prevents rogue captured callbacks and tampered payment amounts.',
    color: 'text-[#22c55e]',
    borderColor: 'border-[#22c55e]/40',
    bgColor: 'bg-[#052312]/60',
  },
  {
    id: 'stage_6',
    step: 'STAGE 06',
    title: 'Cryptographic Event Chain Audit Ledger',
    tech: 'SHA-256 Hash Chain (Append-Only)',
    description: 'Every financial state transition links to the prior block hash. Automated verification detects any out-of-sequence mutations or manual tampering.',
    guarantee: 'Cryptographic non-repudiation and enterprise compliance auditability.',
    color: 'text-[#10b981]',
    borderColor: 'border-[#10b981]/40',
    bgColor: 'bg-[#04241a]/60',
  },
  {
    id: 'stage_7',
    step: 'STAGE 07',
    title: 'Automated 20s TTL Reconciler & Remediation',
    tech: 'Background Cron / Polling + 1-Click Human Override',
    description: 'Auto-expires reservations orphaned past 20 seconds. Reconciles unknown order states with Razorpay API, providing 1-click human admin remediation.',
    guarantee: 'No stuck balances, orphaned locks, or unreleased reserves.',
    color: 'text-[#ec4899]',
    borderColor: 'border-[#ec4899]/40',
    bgColor: 'bg-[#260515]/60',
  }
];

const SUBSYSTEM_MATRIX = [
  {
    subsystem: 'AI Intent Parsing',
    production: 'Live Google Gemini 2.5 Flash API',
    fallback: 'Deterministic regex / keyword fallback',
    guarantee: 'XML structural envelope, hard ceiling <= INR 1L',
  },
  {
    subsystem: 'Policy Engine',
    production: '6-Factor Deterministic Rule Engine',
    fallback: '6-Factor Deterministic Rule Engine',
    guarantee: 'Zero LLM money authorization; fail-closed',
  },
  {
    subsystem: 'Atomic Reservation',
    production: 'PostgreSQL SERIALIZABLE + Row Locks',
    fallback: 'SQLite WAL mode with BEGIN IMMEDIATE',
    guarantee: 'Zero double-spending under 1,000+ parallel requests',
  },
  {
    subsystem: 'Rate Limiting',
    production: 'Distributed Redis Lua Token Bucket',
    fallback: 'In-Memory Token Bucket',
    guarantee: 'Burst spend rate-limiting & sub-millisecond locks',
  },
  {
    subsystem: 'Payment Gateway',
    production: 'Razorpay Orders API (Live Keys)',
    fallback: 'Mock Gateway with Deterministic Receipts',
    guarantee: '3-Outcome handling (success, fail, timeout)',
  },
  {
    subsystem: 'Webhook Capture',
    production: 'HMAC-SHA256 Signature Verification',
    fallback: 'HMAC-SHA256 Signature Verification',
    guarantee: 'Triple-binding: order_id + payment_id + amount',
  },
  {
    subsystem: 'Audit Trail',
    production: 'SHA-256 Append-Only Hash Chain',
    fallback: 'SHA-256 Append-Only Hash Chain',
    guarantee: 'Tamper-evident verification over entire history',
  },
  {
    subsystem: 'Reconciliation',
    production: 'Remote Razorpay API Verification',
    fallback: 'Local Ledger State Auto-Expiration',
    guarantee: '20s TTL automatic lock release on abandoned holds',
  },
  {
    subsystem: 'Agent Protocol',
    production: 'Native Model Context Protocol (MCP) Server',
    fallback: 'Native Model Context Protocol (MCP) Server',
    guarantee: 'budget, purchase, and explain tools for AI agents',
  },
];

export default function ArchitectureOverview() {
  const [selectedStage, setSelectedStage] = useState<string>(STAGES[0].id);

  const active = STAGES.find((s) => s.id === selectedStage) || STAGES[0];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 border-b border-[#1b1e20] pb-3">
        <div>
          <h2 className="text-sm md:text-base font-pixel text-white uppercase tracking-wider flex items-center gap-2">
            <Layers className="w-4 h-4 text-[#ff571a]" />
            Architecture Overview &amp; Backend Parity
          </h2>
          <p className="text-[11px] font-mono text-[#8e9296] mt-0.5">
            Deterministic financial policy guardrail interceptor between autonomous AI agents and payment execution.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono bg-[#16191c] border border-[#2f3438] text-[#22c55e] px-2.5 py-1 rounded-[2px]">
            7 Pipeline Stages
          </span>
          <span className="text-[10px] font-mono bg-[#16191c] border border-[#2f3438] text-[#38bdf8] px-2.5 py-1 rounded-[2px]">
            9 Subsystem Invariants
          </span>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2">
        {STAGES.map((s) => {
          const isSelected = s.id === selectedStage;
          return (
            <button
              key={s.id}
              onClick={() => setSelectedStage(s.id)}
              className={`p-2.5 rounded-[2px] border text-left transition flex flex-col justify-between ${
                isSelected
                  ? `${s.borderColor} ${s.bgColor} shadow-lg`
                  : 'border-[#1b1e20] bg-[#070809] hover:border-[#2f3438]'
              }`}
            >
              <div className="flex items-center justify-between text-[9px] font-mono mb-1">
                <span className={isSelected ? s.color : 'text-[#5a5e62]'}>{s.step}</span>
                {isSelected && <span className="h-1.5 w-1.5 rounded-full bg-[#ff571a] animate-pulse" />}
              </div>
              <div className={`text-[10px] font-pixel font-bold truncate ${isSelected ? 'text-white' : 'text-[#8e9296]'}`}>
                {s.title.split(' ')[0]} {s.title.split(' ')[1] || ''}
              </div>
            </button>
          );
        })}
      </div>

      <div className={`relative p-5 rounded-[2px] border ${active.borderColor} ${active.bgColor} transition`}>
        <CornerBrackets color="#ff571a" size={14} />
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-[#23272a] pb-3 mb-3">
          <div>
            <div className="text-[10px] font-mono text-[#ff571a] uppercase tracking-widest">{active.step}</div>
            <h3 className="text-base font-pixel text-white">{active.title}</h3>
          </div>
          <div className="font-mono text-xs text-[#8e9296] bg-[#070809] px-3 py-1 rounded-[2px] border border-[#23272a]">
            TECH: <span className="text-white">{active.tech}</span>
          </div>
        </div>
        <div className="grid md:grid-cols-2 gap-4 text-xs font-mono">
          <div>
            <span className="text-[10px] text-[#5a5e62] uppercase tracking-wider block mb-1">Functional Description</span>
            <p className="text-[#d1d5db] leading-relaxed">{active.description}</p>
          </div>
          <div>
            <span className="text-[10px] text-[#5a5e62] uppercase tracking-wider block mb-1">Deterministic Guarantee</span>
            <p className="text-[#22c55e] leading-relaxed flex items-start gap-1.5">
              <CheckCircle className="w-3.5 h-3.5 text-[#22c55e] shrink-0 mt-0.5" />
              <span>{active.guarantee}</span>
            </p>
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <div className="text-[10px] font-pixel text-[#8e9296] uppercase tracking-widest border-b border-[#1b1e20] pb-1.5 flex items-center justify-between">
          <span className="flex items-center gap-2 text-white">
            <ShieldCheck className="w-3.5 h-3.5 text-[#22c55e]" />
            Subsystem Verification Matrix (Live vs Fallback)
          </span>
          <span className="text-[#5a5e62] font-mono hidden sm:inline">ALL INVARIANTS PASS UNIT &amp; BENCHMARK TESTS</span>
        </div>

        <div className="overflow-x-auto border border-[#23272a] rounded-[2px]">
          <table className="w-full text-left text-[11px] font-mono">
            <thead className="bg-[#0f1112] text-[#8e9296] uppercase text-[9px] font-pixel border-b border-[#23272a]">
              <tr>
                <th className="p-2.5">Subsystem</th>
                <th className="p-2.5">Production Mode</th>
                <th className="p-2.5">Dev / Fallback Mode</th>
                <th className="p-2.5">Core Invariant Guarantee</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#1b1e20] bg-[#070809]">
              {SUBSYSTEM_MATRIX.map((row, idx) => (
                <tr key={idx} className="hover:bg-[#0e1113] transition">
                  <td className="p-2.5 text-white font-bold whitespace-nowrap">{row.subsystem}</td>
                  <td className="p-2.5 text-[#38bdf8] whitespace-nowrap">{row.production}</td>
                  <td className="p-2.5 text-[#8e9296] whitespace-nowrap">{row.fallback}</td>
                  <td className="p-2.5 text-[#22c55e]">{row.guarantee}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
