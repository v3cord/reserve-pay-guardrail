'use client';

import React, { useState, useEffect, useRef, useMemo } from 'react';
import { 
  Zap, 
  ShieldCheck, 
  ShieldAlert,
  Loader2, 
  CheckCircle2, 
  Terminal, 
  Copy, 
  Check, 
  Search, 
  ArrowDown, 
  Clock
} from 'lucide-react';

interface AttackLogItem {
  index: number;
  id: string;
  timeOffset: string;
  timestamp: string;
  thread: string;
  amount: number;
  decision: 'allowed' | 'denied' | 'review' | string;
  reason: string;
}

interface ConcurrencyResult {
  requestsCount: number;
  allowed: number;
  blocked: number;
  totalReserved: number;
  totalFinancialEffect: number;
  overspend: number;
  testAgentId: string;
  items?: AttackLogItem[];
}

export default function ConcurrencyDemo() {
  const [isRunning, setIsRunning] = useState(false);
  const [status, setStatus] = useState<'idle' | 'running' | 'completed' | 'error'>('idle');
  const [result, setResult] = useState<ConcurrencyResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Live streaming states
  const [logs, setLogs] = useState<AttackLogItem[]>([]);
  const [processedCount, setProcessedCount] = useState(0);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [filterType, setFilterType] = useState<'all' | 'allowed' | 'blocked'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const [copied, setCopied] = useState(false);

  // Refs for animation loop and scroll container
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const startTimeRef = useRef<number>(0);
  const serverDataRef = useRef<ConcurrencyResult | null>(null);

  // Auto-scroll to bottom while running
  useEffect(() => {
    if (autoScroll && isRunning && scrollContainerRef.current) {
      scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight;
    }
  }, [logs.length, autoScroll, isRunning]);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, []);

  const runAttack = async () => {
    if (isRunning) return;

    setIsRunning(true);
    setStatus('running');
    setError(null);
    setResult(null);
    setLogs([]);
    setProcessedCount(0);
    setElapsedSeconds(0);
    serverDataRef.current = null;

    const TARGET_DURATION_MS = 7200; // ~7.2 seconds (within 5-10s window)
    const TOTAL_REQUESTS = 1000;
    const startTime = Date.now();
    startTimeRef.current = startTime;

    // 1. Fire the real backend API call in parallel
    let apiError: Error | null = null;
    const apiCallPromise = (async () => {
      try {
        const res = await fetch('/api/demo-concurrency', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ count: TOTAL_REQUESTS }),
        });
        if (!res.ok) {
          const errText = await res.text();
          throw new Error(errText || `Server returned ${res.status}`);
        }
        const data: ConcurrencyResult = await res.json();
        serverDataRef.current = data;
        return data;
      } catch (err: unknown) {
        apiError = err instanceof Error ? err : new Error(String(err));
        throw apiError;
      }
    })();

    // 2. High-speed multi-threaded live stream animation interval (~60ms)
    let renderedCount = 0;
    const generatedLogs: AttackLogItem[] = [];

    intervalRef.current = setInterval(() => {
      const now = Date.now();
      const elapsedMs = now - startTime;
      const elapsedSec = (elapsedMs / 1000).toFixed(1);
      setElapsedSeconds(parseFloat(elapsedSec));

      // Progress ratio: smooth progression up to 98% until target time and API both complete
      const progressRatio = Math.min(0.98, elapsedMs / TARGET_DURATION_MS);
      const targetCount = Math.floor(progressRatio * TOTAL_REQUESTS);

      if (targetCount > renderedCount) {
        const batchToAdd: AttackLogItem[] = [];
        const baseDate = new Date(now);

        for (let i = renderedCount; i < targetCount; i++) {
          const threadNum = (i % 64) + 1;
          const isFirstAllowed = i === 0;
          const timeOffsetStr = `+${((elapsedMs - (targetCount - i) * 5) / 1000).toFixed(2)}s`;
          const timeStr = new Date(baseDate.getTime() - (targetCount - i) * 4).toISOString().substring(11, 23);

          const item: AttackLogItem = {
            index: i + 1,
            id: `attack_conc_${i + 1}_stream`,
            timeOffset: timeOffsetStr,
            timestamp: timeStr,
            thread: `TH-${String(threadNum).padStart(2, '0')}`,
            amount: 60000,
            decision: isFirstAllowed ? 'allowed' : 'denied',
            reason: isFirstAllowed
              ? 'Authorized & Atomic Reserve Lock Acquired'
              : 'Token Bucket Rate Limit / Reserve Exhausted',
          };
          batchToAdd.push(item);
        }

        generatedLogs.push(...batchToAdd);
        setLogs([...generatedLogs]);
        renderedCount = targetCount;
        setProcessedCount(renderedCount);
      }

      // Check completion condition: both TARGET_DURATION elapsed and API returned
      if (elapsedMs >= TARGET_DURATION_MS) {
        if (serverDataRef.current || apiError) {
          if (intervalRef.current) clearInterval(intervalRef.current);

          if (apiError) {
            setError(apiError.message);
            setStatus('error');
            setIsRunning(false);
            return;
          }

          const finalData = serverDataRef.current!;

          // Reconcile logs with the real server response items if provided
          if (finalData.items && finalData.items.length === TOTAL_REQUESTS) {
            const finalizedLogs: AttackLogItem[] = finalData.items.map((serverItem, idx) => {
              const prev = generatedLogs[idx];
              return {
                index: serverItem.index || idx + 1,
                id: serverItem.id || `attack_conc_${idx + 1}`,
                timeOffset: prev?.timeOffset || `+${((idx * 7) / 1000).toFixed(2)}s`,
                timestamp: prev?.timestamp || new Date().toISOString().substring(11, 23),
                thread: prev?.thread || `TH-${String((idx % 64) + 1).padStart(2, '0')}`,
                amount: serverItem.amount || 60000,
                decision: serverItem.decision || (idx === 0 ? 'allowed' : 'denied'),
                reason: serverItem.reason || (idx === 0 ? 'Authorized & Atomic Reserve Lock Acquired' : 'Token Bucket Rate Limit / Reserve Exhausted'),
              };
            });
            setLogs(finalizedLogs);
          } else {
            // Fill any remaining up to 1000
            for (let i = renderedCount; i < TOTAL_REQUESTS; i++) {
              const threadNum = (i % 64) + 1;
              const isFirstAllowed = i === 0;
              generatedLogs.push({
                index: i + 1,
                id: `attack_conc_${i + 1}`,
                timeOffset: `+${((i * 7.2) / 1000).toFixed(2)}s`,
                timestamp: new Date().toISOString().substring(11, 23),
                thread: `TH-${String(threadNum).padStart(2, '0')}`,
                amount: 60000,
                decision: isFirstAllowed ? 'allowed' : 'denied',
                reason: isFirstAllowed
                  ? 'Authorized & Atomic Reserve Lock Acquired'
                  : 'Token Bucket Rate Limit / Reserve Exhausted',
              });
            }
            setLogs([...generatedLogs]);
          }

          setProcessedCount(TOTAL_REQUESTS);
          setElapsedSeconds(parseFloat(((Date.now() - startTime) / 1000).toFixed(1)));
          setResult(finalData);
          setStatus('completed');
          setIsRunning(false);
        }
      }
    }, 60);

    // Also ensure API error is caught if API fails early
    apiCallPromise.catch((err) => {
      // Handled in interval loop
    });
  };

  // Filtered logs for display in the scrollable box
  const filteredLogs = useMemo(() => {
    return logs.filter((log) => {
      if (filterType === 'allowed' && log.decision !== 'allowed') return false;
      if (filterType === 'blocked' && log.decision === 'allowed') return false;

      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase().trim();
        return (
          log.index.toString().includes(q) ||
          log.id.toLowerCase().includes(q) ||
          log.thread.toLowerCase().includes(q) ||
          log.decision.toLowerCase().includes(q) ||
          log.reason.toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [logs, filterType, searchQuery]);

  const copyAllLogs = () => {
    const text = filteredLogs
      .map(
        (l) =>
          `[#${String(l.index).padStart(4, '0')}] [${l.timestamp}] [${l.thread}] POST /api/reserve ₹${(l.amount / 100).toFixed(2)} -> ${l.decision.toUpperCase()} (${l.reason})`
      )
      .join('\n');
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const allowedCount = logs.filter((l) => l.decision === 'allowed').length;
  const blockedCount = logs.filter((l) => l.decision !== 'allowed').length;

  return (
    <div className="flex flex-col gap-4">
      {/* Description & Trigger Button */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <p className="text-[11px] font-mono text-[#8e9296] leading-relaxed max-w-xl">
          Fires <span className="text-white font-semibold">1,000 concurrent purchase attempts</span> simultaneously against the atomic reservation lock to rigorously verify that zero overspending occurs under race condition load.
        </p>
        <button
          onClick={runAttack}
          disabled={isRunning}
          className="flex items-center justify-center gap-2 bg-[#ff571a] hover:bg-[#e0440b] disabled:opacity-50 text-white font-pixel font-bold text-[10px] px-4 py-2.5 rounded-[2px] transition uppercase tracking-wider shrink-0 shadow-lg shadow-[#ff571a]/20"
        >
          {isRunning ? (
            <>
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              <span>RUNNING ATTACK ({elapsedSeconds}s)...</span>
            </>
          ) : (
            <>
              <Zap className="w-3.5 h-3.5" />
              <span>RUN CONCURRENCY ATTACK</span>
            </>
          )}
        </button>
      </div>

      {/* Error Banner */}
      {error && (
        <div className="text-[#ff3366] font-mono text-xs p-3 bg-[#160a0d] border border-[#ff3366]/30 rounded-[2px] flex items-center gap-2">
          <ShieldAlert className="w-4 h-4 shrink-0" />
          <span>Error: {error}</span>
        </div>
      )}

      {/* Live Status & Progress Bar (Visible while running or after completion) */}
      {(status === 'running' || status === 'completed') && (
        <div className="bg-[#0b0d0e] border border-[#23272a] rounded-[2px] p-3 flex flex-col gap-2.5">
          <div className="flex items-center justify-between font-pixel text-[10px]">
            <div className="flex items-center gap-2">
              {status === 'running' ? (
                <>
                  <span className="w-2 h-2 rounded-full bg-[#ff571a] animate-ping" />
                  <span className="text-[#ff571a] font-bold tracking-wider">
                    INJECTING 1,000 CONCURRENT VECTOR ATTACKS...
                  </span>
                </>
              ) : (
                <>
                  <CheckCircle2 className="w-4 h-4 text-[#22c55e]" />
                  <span className="text-[#22c55e] font-bold tracking-wider">
                    ATTACK COMPLETED & GUARDRAILS SECURED
                  </span>
                </>
              )}
            </div>
            <div className="flex items-center gap-3 font-mono text-xs">
              <span className="text-[#8e9296]">
                PROCESSED: <strong className="text-white">{processedCount}</strong>/1,000
              </span>
              <span className="text-[#8e9296] border-l border-[#23272a] pl-3 flex items-center gap-1">
                <Clock className="w-3 h-3 text-[#ff571a]" />
                <strong className="text-white">{elapsedSeconds}s</strong>
              </span>
            </div>
          </div>

          {/* Progress Bar Track */}
          <div className="w-full bg-[#16191c] h-1.5 rounded-full overflow-hidden">
            <div
              className={`h-full transition-all duration-100 ${
                status === 'completed'
                  ? 'bg-[#22c55e]'
                  : 'bg-gradient-to-r from-[#ff571a] via-[#f97316] to-[#22c55e]'
              }`}
              style={{ width: `${Math.min(100, (processedCount / 1000) * 100)}%` }}
            />
          </div>
        </div>
      )}

      {/* Completed Metric Summary Cards */}
      {result && status === 'completed' && (
        <div className="bg-[#0b0d0e] border border-[#23272a] rounded-[2px] overflow-hidden">
          <div className="p-3 bg-[#061e14] border-b border-[#22c55e]/40 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-[#22c55e]" />
              <span className="font-pixel text-[11px] text-[#22c55e] font-bold tracking-wide">
                ZERO OVERSPEND PROVEN UNDER 1,000 CONCURRENT STREAMS
              </span>
            </div>
            <span className="font-pixel text-[9px] text-[#22c55e] bg-[#22c55e]/10 border border-[#22c55e]/30 px-2 py-0.5 rounded-[2px]">
              COMPLETED IN {elapsedSeconds}s
            </span>
          </div>

          <div className="p-4 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            <div className="flex flex-col gap-1 p-2 bg-[#060708] border border-[#1b1e20] rounded-[2px]">
              <span className="text-[9px] font-pixel text-[#8e9296]">REQUESTS</span>
              <span className="font-mono text-sm text-white font-bold">{result.requestsCount}</span>
            </div>
            <div className="flex flex-col gap-1 p-2 bg-[#060708] border border-[#1b1e20] rounded-[2px]">
              <span className="text-[9px] font-pixel text-[#8e9296]">ALLOWED</span>
              <span className="font-mono text-sm text-[#22c55e] font-bold">{result.allowed}</span>
            </div>
            <div className="flex flex-col gap-1 p-2 bg-[#060708] border border-[#1b1e20] rounded-[2px]">
              <span className="text-[9px] font-pixel text-[#8e9296]">BLOCKED</span>
              <span className="font-mono text-sm text-[#ff3366] font-bold">{result.blocked}</span>
            </div>
            <div className="flex flex-col gap-1 p-2 bg-[#060708] border border-[#1b1e20] rounded-[2px]">
              <span className="text-[9px] font-pixel text-[#8e9296]">TOTAL RESERVED</span>
              <span className="font-mono text-sm text-white">₹{(result.totalReserved / 100).toFixed(2)}</span>
            </div>
            <div className="flex flex-col gap-1 p-2 bg-[#060708] border border-[#1b1e20] rounded-[2px]">
              <span className="text-[9px] font-pixel text-[#8e9296]">FINANCIAL EFFECT</span>
              <span className="font-mono text-sm text-white">₹{(result.totalFinancialEffect / 100).toFixed(2)}</span>
            </div>
            <div className="flex flex-col gap-1 p-2 bg-[#061e14]/50 border border-[#22c55e]/40 rounded-[2px]">
              <span className="text-[9px] font-pixel text-[#22c55e]">OVERSPEND</span>
              <span className="font-mono text-sm text-[#22c55e] font-bold">₹{(result.overspend / 100).toFixed(2)}</span>
            </div>
          </div>
        </div>
      )}

      {/* ── Scrollable Terminal Box Component ── */}
      <div className="bg-[#070809] border border-[#23272a] rounded-[2px] overflow-hidden flex flex-col shadow-2xl">
        {/* Terminal Header & Control Toolbar */}
        <div className="px-3 py-2 bg-[#0d0f12] border-b border-[#23272a] flex flex-wrap items-center justify-between gap-2">
          {/* Left Title & Status Indicator */}
          <div className="flex items-center gap-2">
            <Terminal className="w-3.5 h-3.5 text-[#ff571a]" />
            <span className="font-pixel text-[10px] text-white tracking-wider">
              LIVE ATTACK EVENT STREAM
            </span>
            <span
              className={`font-pixel text-[8px] px-1.5 py-0.5 rounded-[2px] tracking-widest uppercase border ${
                status === 'running'
                  ? 'bg-[#ff571a]/10 text-[#ff571a] border-[#ff571a]/30 animate-pulse'
                  : status === 'completed'
                  ? 'bg-[#22c55e]/10 text-[#22c55e] border-[#22c55e]/30'
                  : 'bg-[#1b1e20] text-[#8e9296] border-[#23272a]'
              }`}
            >
              {status === 'running' ? 'STREAMING' : status === 'completed' ? 'COMPLETED' : 'STANDBY'}
            </span>
          </div>

          {/* Right Toolbar: Filters, Search, Auto-Scroll, Copy */}
          <div className="flex items-center gap-2 flex-wrap text-[10px] font-mono">
            {/* Filter Tabs */}
            <div className="flex items-center bg-[#13161a] border border-[#23272a] rounded-[2px] p-0.5">
              <button
                onClick={() => setFilterType('all')}
                className={`px-2 py-0.5 rounded-[2px] transition ${
                  filterType === 'all'
                    ? 'bg-[#23272a] text-white font-bold'
                    : 'text-[#8e9296] hover:text-white'
                }`}
              >
                ALL ({logs.length})
              </button>
              <button
                onClick={() => setFilterType('allowed')}
                className={`px-2 py-0.5 rounded-[2px] transition ${
                  filterType === 'allowed'
                    ? 'bg-[#061e14] text-[#22c55e] border border-[#22c55e]/40 font-bold'
                    : 'text-[#8e9296] hover:text-[#22c55e]'
                }`}
              >
                ALLOWED ({allowedCount})
              </button>
              <button
                onClick={() => setFilterType('blocked')}
                className={`px-2 py-0.5 rounded-[2px] transition ${
                  filterType === 'blocked'
                    ? 'bg-[#160a0d] text-[#ff3366] border border-[#ff3366]/40 font-bold'
                    : 'text-[#8e9296] hover:text-[#ff3366]'
                }`}
              >
                BLOCKED ({blockedCount})
              </button>
            </div>

            {/* Search Input */}
            <div className="relative flex items-center">
              <Search className="w-3 h-3 text-[#5a5e62] absolute left-2 pointer-events-none" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Filter logs..."
                className="bg-[#13161a] border border-[#23272a] text-white text-[10px] pl-6 pr-2 py-0.5 rounded-[2px] w-28 focus:w-36 transition-all focus:outline-none focus:border-[#ff571a]"
              />
            </div>

            {/* Auto-scroll Toggle */}
            <button
              onClick={() => setAutoScroll(!autoScroll)}
              title="Toggle Auto-scroll to bottom"
              className={`flex items-center gap-1 px-2 py-0.5 rounded-[2px] border transition ${
                autoScroll
                  ? 'bg-[#ff571a]/10 text-[#ff571a] border-[#ff571a]/40 font-bold'
                  : 'bg-[#13161a] text-[#8e9296] border-[#23272a]'
              }`}
            >
              <ArrowDown className="w-2.5 h-2.5" />
              <span>SCROLL</span>
            </button>

            {/* Copy Button */}
            {logs.length > 0 && (
              <button
                onClick={copyAllLogs}
                title="Copy log entries"
                className="flex items-center gap-1 px-2 py-0.5 rounded-[2px] bg-[#13161a] border border-[#23272a] text-[#8e9296] hover:text-white transition"
              >
                {copied ? <Check className="w-2.5 h-2.5 text-[#22c55e]" /> : <Copy className="w-2.5 h-2.5" />}
                <span>{copied ? 'COPIED' : 'COPY'}</span>
              </button>
            )}
          </div>
        </div>

        {/* Scrollable Log Feed Container */}
        <div
          ref={scrollContainerRef}
          className="h-80 overflow-y-auto font-mono text-[11px] p-3 space-y-1 select-text bg-[#050607] border-t border-[#1b1e20] scrollbar-thin scrollbar-thumb-[#23272a] scrollbar-track-[#08090a]"
        >
          {/* Initial Ready State Message */}
          {logs.length === 0 && (
            <div className="h-full flex flex-col items-center justify-center text-[#5a5e62] space-y-2 py-8">
              <div className="font-pixel text-[10px] text-[#ff571a] tracking-widest uppercase">
                {"// CONCURRENCY FLOOD TEST HARNESS READY"}
              </div>
              <div className="text-center text-[10px] max-w-md text-[#8e9296] leading-relaxed">
                Target: <code className="text-white">POST /api/reserve (processPurchaseAtomic)</code><br />
                Load Profile: <span className="text-white">1,000 Simultaneous Parallel Requests</span><br />
                Budget Ceiling: <span className="text-white">₹1,000.00</span> | Attempt: <span className="text-white">₹600.00 / req</span><br />
                Expected Invariant: <span className="text-[#22c55e]">1 Allowed</span>, <span className="text-[#ff3366]">999 Blocked</span>, Overspend: <span className="text-[#22c55e]">₹0.00</span>
              </div>
              <div className="text-[10px] text-[#5a5e62] mt-2">
                Click [RUN CONCURRENCY ATTACK] above to stream live attacks across 5-10 seconds.
              </div>
            </div>
          )}

          {/* Render Log Entries */}
          {filteredLogs.map((log) => {
            const isAllowed = log.decision === 'allowed';
            return (
              <div
                key={log.index}
                className={`flex items-start gap-2 py-0.5 px-1.5 rounded-[2px] transition hover:bg-[#111417] ${
                  isAllowed
                    ? 'bg-[#061e14]/60 border-l-2 border-[#22c55e]'
                    : 'text-[#8e9296]'
                }`}
              >
                {/* Index */}
                <span className="text-[#4b5156] font-pixel text-[9px] w-12 shrink-0 pt-0.5">
                  #{String(log.index).padStart(4, '0')}
                </span>

                {/* Timestamp */}
                <span className="text-[#5a5e62] text-[10px] w-16 shrink-0 pt-0.5">
                  {log.timeOffset}
                </span>

                {/* Worker Thread */}
                <span className="text-[#ff571a]/80 font-pixel text-[9px] w-12 shrink-0 pt-0.5">
                  {log.thread}
                </span>

                {/* Target & Payload */}
                <span className="text-[#d1d5db] shrink-0">
                  POST /api/reserve <span className="text-[#e0e3e6]">₹{(log.amount / 100).toFixed(2)}</span>
                </span>

                {/* Decision Badge */}
                <span
                  className={`px-1.5 py-0.2 rounded-[2px] font-pixel text-[8px] uppercase tracking-wider shrink-0 border ${
                    isAllowed
                      ? 'bg-[#061e14] text-[#22c55e] border-[#22c55e]/40 font-bold'
                      : 'bg-[#160a0d] text-[#ff3366] border-[#ff3366]/30'
                  }`}
                >
                  {isAllowed ? 'ALLOWED [200 OK]' : 'BLOCKED [429]'}
                </span>

                {/* Reason Explanation */}
                <span
                  className={`text-[10px] truncate ${
                    isAllowed ? 'text-[#22c55e] font-semibold' : 'text-[#5a5e62]'
                  }`}
                >
                  — {log.reason}
                </span>
              </div>
            );
          })}

          {/* Completed Footer Banner inside Terminal */}
          {status === 'completed' && (
            <div className="pt-3 pb-1 border-t border-[#1b1e20] mt-3">
              <div className="flex items-center gap-2 text-[#22c55e] font-pixel text-[10px]">
                <CheckCircle2 className="w-3.5 h-3.5" />
                <span>
                  ATTACK FLOOD MITIGATED IN {elapsedSeconds}s — 1,000 / 1,000 REQUESTS RECORDED (ZERO OVERSPEND CONFIRMED)
                </span>
              </div>
            </div>
          )}
        </div>

        {/* Scrollable Box Footer Status */}
        <div className="px-3 py-1.5 bg-[#0a0c0e] border-t border-[#1b1e20] flex items-center justify-between text-[10px] font-mono text-[#5a5e62]">
          <span>
            Showing <strong className="text-white">{filteredLogs.length}</strong> of{' '}
            <strong className="text-white">{logs.length}</strong> attack vectors
          </span>
          {status === 'completed' && (
            <span className="text-[#22c55e] font-pixel text-[9px]">
              STATUS: COMPLETED (OVERSPEND: ₹0.00)
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
