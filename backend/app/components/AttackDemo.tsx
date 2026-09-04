'use client';

import React, { useState } from 'react';
import { ShieldCheck, ShieldAlert, AlertTriangle, Loader2, Play, CheckCircle2, XCircle } from 'lucide-react';

interface ScenarioEvidence {
  razorpayOrderCreated: boolean;
  backendState?: Record<string, unknown>;
  explanation: string;
}

interface ScenarioResult {
  scenario: string;
  outcome: string;
  passed: boolean;
  evidence: ScenarioEvidence;
}

interface AttackDemoResponse {
  timestamp: string;
  totalScenarios: number;
  passed: number;
  failed: number;
  allPassed: boolean;
  results: ScenarioResult[];
}

export default function AttackDemo() {
  const [isRunning, setIsRunning] = useState(false);
  const [response, setResponse] = useState<AttackDemoResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleRun = async () => {
    setIsRunning(true);
    setError(null);
    setResponse(null);

    try {
      const res = await fetch('/api/attack-demo', { method: 'POST' });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `HTTP ${res.status}`);
      }
      const data: AttackDemoResponse = await res.json();
      setResponse(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsRunning(false);
    }
  };

  const outcomeColor = (outcome: string, passed: boolean) => {
    if (!passed) return 'text-[#ff3366] border-[#ff3366]/40 bg-[#160a0d]';
    switch (outcome) {
      case 'DENIED':           return 'text-[#22c55e] border-[#22c55e]/40 bg-[#061e14]';
      case 'DEDUPLICATED':     return 'text-[#38bdf8] border-[#38bdf8]/40 bg-[#071318]';
      case 'SAFE_CONCURRENCY': return 'text-[#22c55e] border-[#22c55e]/40 bg-[#061e14]';
      case 'RECONCILED':       return 'text-[#a78bfa] border-[#a78bfa]/40 bg-[#100b1a]';
      case 'REVIEW':           return 'text-[#f9c425] border-[#f9c425]/40 bg-[#141209]';
      default:                 return 'text-[#8e9296] border-[#23272a]';
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Run button */}
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-mono text-[#8e9296]">
          Runs 8 adversarial scenarios against real backend logic.
        </p>
        <button
          onClick={handleRun}
          disabled={isRunning}
          className="flex items-center gap-2 bg-[#ff571a] hover:bg-[#e0440b] disabled:opacity-50 text-white font-pixel font-bold text-[10px] px-4 py-2.5 rounded-[2px] transition uppercase tracking-wider"
        >
          {isRunning ? (
            <><Loader2 className="w-3.5 h-3.5 animate-spin" /><span>RUNNING...</span></>
          ) : (
            <><ShieldAlert className="w-3.5 h-3.5" /><span>ATTACK GUARDRAIL</span></>
          )}
        </button>
      </div>

      {error && (
        <div className="text-[#ff3366] font-mono text-xs p-3 bg-[#160a0d] border border-[#ff3366]/30 rounded-[2px]">
          Error: {error}
        </div>
      )}

      {response && (
        <>
          {/* Summary bar */}
          <div className={`flex items-center gap-3 px-4 py-2.5 rounded-[2px] border font-pixel text-[11px] ${response.allPassed ? 'bg-[#061e14] border-[#22c55e]/40 text-[#22c55e]' : 'bg-[#160a0d] border-[#ff3366]/40 text-[#ff3366]'}`}>
            {response.allPassed ? <ShieldCheck className="w-4 h-4" /> : <ShieldAlert className="w-4 h-4" />}
            <span>{response.allPassed ? 'ALL GUARDRAILS HELD' : 'SOME GUARDRAILS FAILED'}</span>
            <span className="ml-auto">{response.passed}/{response.totalScenarios} PASSED</span>
          </div>

          {/* Scenario list */}
          <div className="flex flex-col gap-2">
            {response.results.map((result, i) => (
              <div key={i} className="bg-[#0b0d0e] border border-[#23272a] rounded-[2px] p-3 flex flex-col gap-1.5">
                <div className="flex items-center gap-2 flex-wrap">
                  {result.passed ? (
                    <CheckCircle2 className="w-3.5 h-3.5 text-[#22c55e] shrink-0" />
                  ) : (
                    <XCircle className="w-3.5 h-3.5 text-[#ff3366] shrink-0" />
                  )}
                  <span className="font-pixel text-[11px] text-white font-bold">
                    {i + 1}. {result.scenario}
                  </span>
                  <span className={`ml-auto text-[9px] font-pixel font-bold px-2 py-0.5 rounded-[2px] border ${outcomeColor(result.outcome, result.passed)}`}>
                    {result.outcome}
                  </span>
                </div>

                <div className="text-[10px] font-mono text-[#8e9296] leading-relaxed">
                  {result.evidence.explanation}
                </div>

                <div className="flex items-center gap-3 text-[10px] font-mono">
                  <span className={result.evidence.razorpayOrderCreated ? 'text-[#ff3366]' : 'text-[#22c55e]'}>
                    {result.evidence.razorpayOrderCreated ? '⚠ RAZORPAY ORDER CREATED' : '✓ NO RAZORPAY ORDER CREATED'}
                  </span>
                </div>
              </div>
            ))}
          </div>

          <div className="text-[10px] font-mono text-[#5a5e62]">
            Completed: {new Date(response.timestamp).toLocaleTimeString()}
          </div>
        </>
      )}
    </div>
  );
}
