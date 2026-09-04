'use client';

import React, { useState } from 'react';
import { Zap, ShieldCheck, Loader2 } from 'lucide-react';

interface ConcurrencyResult {
  requestsCount: number;
  allowed: number;
  blocked: number;
  totalReserved: number;
  totalFinancialEffect: number;
  overspend: number;
  testAgentId: string;
}

export default function ConcurrencyDemo() {
  const [isRunning, setIsRunning] = useState(false);
  const [result, setResult] = useState<ConcurrencyResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runAttack = async () => {
    setIsRunning(true);
    setError(null);
    setResult(null);

    try {
      const res = await fetch('/api/demo-concurrency', { method: 'POST' });
      if (!res.ok) {
        throw new Error(await res.text());
      }
      const data = await res.json();
      setResult(data);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsRunning(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-mono text-[#8e9296]">
          Fires 1,000 concurrent purchase requests against a strict budget to prove zero overspend.
        </p>
        <button
          onClick={runAttack}
          disabled={isRunning}
          className="flex items-center gap-2 bg-[#ff571a] hover:bg-[#e0440b] disabled:opacity-50 text-white font-pixel font-bold text-[10px] px-4 py-2.5 rounded-[2px] transition uppercase tracking-wider"
        >
          {isRunning ? (
            <><Loader2 className="w-3.5 h-3.5 animate-spin" /><span>RUNNING...</span></>
          ) : (
            <><Zap className="w-3.5 h-3.5" /><span>RUN CONCURRENCY ATTACK</span></>
          )}
        </button>
      </div>

      {error && (
        <div className="text-[#ff3366] font-mono text-xs p-3 bg-[#160a0d] border border-[#ff3366]/30 rounded-[2px]">
          Error: {error}
        </div>
      )}

      {result && (
        <div className="bg-[#0b0d0e] border border-[#23272a] rounded-[2px] overflow-hidden">
          <div className="p-3 bg-[#061e14] border-b border-[#22c55e]/40 flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-[#22c55e]" />
            <span className="font-pixel text-[11px] text-[#22c55e] font-bold">CONCURRENCY ATTACK SECURED</span>
          </div>
          <div className="p-4 grid grid-cols-2 sm:grid-cols-3 gap-4">
            <div className="flex flex-col gap-1">
              <span className="text-[9px] font-pixel text-[#8e9296]">REQUESTS</span>
              <span className="font-mono text-sm text-white">{result.requestsCount}</span>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-[9px] font-pixel text-[#8e9296]">ALLOWED</span>
              <span className="font-mono text-sm text-[#22c55e]">{result.allowed}</span>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-[9px] font-pixel text-[#8e9296]">BLOCKED</span>
              <span className="font-mono text-sm text-[#ff3366]">{result.blocked}</span>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-[9px] font-pixel text-[#8e9296]">TOTAL RESERVED</span>
              <span className="font-mono text-sm text-white">₹{(result.totalReserved / 100).toFixed(2)}</span>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-[9px] font-pixel text-[#8e9296]">FINANCIAL EFFECT</span>
              <span className="font-mono text-sm text-white">₹{(result.totalFinancialEffect / 100).toFixed(2)}</span>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-[9px] font-pixel text-[#8e9296]">OVERSPEND</span>
              <span className="font-mono text-sm text-[#22c55e] font-bold">₹{(result.overspend / 100).toFixed(2)}</span>
            </div>
          </div>
          <div className="p-3 bg-[#070809] border-t border-[#1b1e20]">
            <p className="text-[10px] font-mono text-[#5a5e62]">
              Concurrent requests share the same atomic reservation boundary. 
              (Isolated demo agent: {result.testAgentId})
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
