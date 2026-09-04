'use client';

import React from 'react';
import { CheckCircle, XCircle, Clock, AlertTriangle, RotateCw, ShieldCheck } from 'lucide-react';
import type { LedgerEvent } from '@/lib/types';

interface Props {
  events: LedgerEvent[];
  isVerified?: boolean;
  corruptedIndex?: number;
  className?: string;
}

const EVENT_META: Record<string, { label: string; color: string; icon: React.ReactNode }> = {
  RESERVATION_CREATED:    { label: 'RESERVED',    color: 'text-[#f9c425] border-[#f9c425]/40', icon: <Clock className="w-3 h-3" /> },
  ORDER_ATTACHED:         { label: 'ORDER',        color: 'text-[#38bdf8] border-[#38bdf8]/40', icon: <CheckCircle className="w-3 h-3" /> },
  ORDER_CREATED:          { label: 'ORDER',        color: 'text-[#38bdf8] border-[#38bdf8]/40', icon: <CheckCircle className="w-3 h-3" /> },
  PAYMENT_CAPTURED:       { label: 'CAPTURED',     color: 'text-[#22c55e] border-[#22c55e]/40', icon: <CheckCircle className="w-3 h-3" /> },
  RESERVATION_RELEASED:   { label: 'RELEASED',     color: 'text-[#8e9296] border-[#23272a]',    icon: <RotateCw className="w-3 h-3" /> },
  RESERVATION_EXPIRED:    { label: 'EXPIRED',      color: 'text-[#8e9296] border-[#23272a]',    icon: <Clock className="w-3 h-3" /> },
  GUARD_REJECTED:         { label: 'DENIED',       color: 'text-[#ff3366] border-[#ff3366]/40', icon: <XCircle className="w-3 h-3" /> },
  REVIEW_REQUIRED:        { label: 'REVIEW',       color: 'text-[#f9c425] border-[#f9c425]/40', icon: <AlertTriangle className="w-3 h-3" /> },
  PAYMENT_REFUNDED:       { label: 'REFUNDED',     color: 'text-[#a78bfa] border-[#a78bfa]/40', icon: <RotateCw className="w-3 h-3" /> },
  ORDER_UNKNOWN_FLAGGED:  { label: 'UNKNOWN',      color: 'text-[#fb923c] border-[#fb923c]/40', icon: <AlertTriangle className="w-3 h-3" /> },
  ORDER_RECONCILED_FOUND: { label: 'RECONCILED',   color: 'text-[#22c55e] border-[#22c55e]/40', icon: <CheckCircle className="w-3 h-3" /> },
  ORDER_RECONCILED:       { label: 'RECONCILED',   color: 'text-[#22c55e] border-[#22c55e]/40', icon: <CheckCircle className="w-3 h-3" /> },
  HUMAN_OVERRIDE_APPROVED:{ label: 'OVERRIDE',     color: 'text-[#f9c425] border-[#f9c425]/40', icon: <ShieldCheck className="w-3 h-3" /> },
  PAYMENT_AMOUNT_MISMATCH:{ label: 'MISMATCH',     color: 'text-[#ff3366] border-[#ff3366]/40', icon: <XCircle className="w-3 h-3" /> },
  TRANSACTION_DISPUTED:   { label: 'DISPUTED',     color: 'text-[#ff3366] border-[#ff3366]/40', icon: <AlertTriangle className="w-3 h-3" /> },
};

function shortHash(h: string): string {
  return h ? `${h.slice(0, 6)}…${h.slice(-4)}` : '——';
}

export default function LedgerTimeline({ events, isVerified = true, corruptedIndex, className = '' }: Props) {
  if (!events || events.length === 0) {
    return (
      <div className={`text-center text-[#5a5e62] font-mono text-xs py-6 ${className}`}>
        No ledger events recorded yet.
      </div>
    );
  }

  // Display most-recent first
  const sorted = [...events].sort((a, b) => b.sequenceNum - a.sequenceNum);

  return (
    <div className={`flex flex-col gap-0 ${className}`}>
      {/* Integrity badge */}
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] font-pixel text-[#5a5e62] uppercase tracking-widest">
          AUDIT CHAIN · {events.length} EVENTS
        </span>
        {isVerified ? (
          <span className="inline-flex items-center gap-1 text-[10px] font-pixel text-[#22c55e] border border-[#22c55e]/30 bg-[#061e14] px-2 py-0.5 rounded-[2px]">
            <ShieldCheck className="w-3 h-3" /> CHAIN VERIFIED
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-[10px] font-pixel text-[#ff3366] border border-[#ff3366]/30 bg-[#160a0d] px-2 py-0.5 rounded-[2px]">
            <XCircle className="w-3 h-3" /> TAMPERED @ {corruptedIndex}
          </span>
        )}
      </div>

      {sorted.map((evt, idx) => {
        const meta = EVENT_META[evt.eventType] ?? { label: evt.eventType, color: 'text-[#8e9296] border-[#23272a]', icon: <Clock className="w-3 h-3" /> };
        const amount = evt.payload?.amount as number | undefined;
        const reason = evt.payload?.reason as string | undefined;
        const ruleViolated = evt.payload?.ruleViolated as string | undefined;

        return (
          <div key={evt.id} className="flex gap-2 min-h-0">
            {/* Timeline spine */}
            <div className="flex flex-col items-center w-6 shrink-0">
              <div className={`w-5 h-5 rounded-full border flex items-center justify-center ${meta.color} bg-[#070809]`}>
                {meta.icon}
              </div>
              {idx < sorted.length - 1 && (
                <div className="w-px flex-1 bg-[#1b1e20] my-0.5" />
              )}
            </div>

            {/* Event body */}
            <div className="pb-2 flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className={`text-[9px] font-pixel font-bold px-1.5 py-0.5 rounded-[2px] border ${meta.color} bg-[#070809]`}>
                  {meta.label}
                </span>
                {amount !== undefined && (
                  <span className="text-[10px] font-mono text-white font-bold">
                    ₹{(amount / 100).toFixed(2)}
                  </span>
                )}
                <span className="text-[#5a5e62] text-[10px] font-mono ml-auto">
                  {new Date(evt.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                </span>
              </div>
              <div className="text-[10px] font-mono text-[#5a5e62] mt-0.5 flex items-center gap-2 flex-wrap">
                <span>seq:{evt.sequenceNum}</span>
                <span title={`prevHash: ${evt.prevHash}`}>prev:{shortHash(evt.prevHash)}</span>
                <span title={`hash: ${evt.hash}`}>hash:{shortHash(evt.hash)}</span>
                {ruleViolated && <span className="text-[#ff3366]">{ruleViolated}</span>}
              </div>
              {reason && (
                <div className="text-[10px] font-mono text-[#8e9296] mt-0.5 truncate" title={reason}>
                  {reason.slice(0, 80)}{reason.length > 80 ? '…' : ''}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
