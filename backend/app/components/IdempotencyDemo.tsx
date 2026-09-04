'use client';

import React, { useState } from 'react';
import { Repeat, ShieldCheck, Loader2 } from 'lucide-react';

interface IdempotencyResult {
  firstRequestStatus: string;
  replayRequestStatus: string;
  additionalCharge: number;
  idempotencyKey: string;
}

export default function IdempotencyDemo() {
  const [isRunning, setIsRunning] = useState(false);
  const [result, setResult] = useState<IdempotencyResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runDemo = async () => {
    setIsRunning(true);
    setError(null);
    setResult(null);

    try {
      const res = await fetch('/api/demo-idempotency', { method: 'POST' });
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
          Fires a purchase request, then replays the exact same request using the same idempotency key.
        </p>
        <button
          onClick={runDemo}
          disabled={isRunning}
          className="flex items-center gap-2 bg-[#ff571a] hover:bg-[#e0440b] disabled:opacity-50 text-white font-pixel font-bold text-[10px] px-4 py-2.5 rounded-[2px] transition uppercase tracking-wider"
        >
          {isRunning ? (
            <><Loader2 className="w-3.5 h-3.5 animate-spin" /><span>RUNNING...</span></>
          ) : (
            <><Repeat className="w-3.5 h-3.5" /><span>REPLAY SAME REQUEST</span></>
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
            <span className="font-pixel text-[11px] text-[#22c55e] font-bold">IDEMPOTENCY ENFORCED</span>
          </div>
          <div className="p-4 grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="flex flex-col gap-1">
              <span className="text-[9px] font-pixel text-[#8e9296]">ORIGINAL REQUEST</span>
              <span className="font-mono text-sm text-white">{result.firstRequestStatus}</span>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-[9px] font-pixel text-[#8e9296]">REPLAY REQUEST</span>
              <span className="font-mono text-sm text-[#38bdf8]">{result.replayRequestStatus}</span>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-[9px] font-pixel text-[#8e9296]">ADDITIONAL CHARGE</span>
              <span className="font-mono text-sm text-[#22c55e] font-bold">₹{(result.additionalCharge / 100).toFixed(2)}</span>
            </div>
          </div>
          <div className="p-3 bg-[#070809] border-t border-[#1b1e20]">
            <p className="text-[10px] font-mono text-[#5a5e62]">
              Replayed idempotency-key: {result.idempotencyKey}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
