'use client';

import React from 'react';
import { CheckCircle, XCircle, AlertTriangle } from 'lucide-react';
import type { PolicyExplanation as PolicyExplanationType } from '@/lib/types';

interface Props {
  explanation: PolicyExplanationType;
  className?: string;
}

const ruleLabel: Record<string, string> = {
  AMOUNT:   'AMOUNT  ',
  MERCHANT: 'MERCHANT',
  CATEGORY: 'CATEGORY',
  QUANTITY: 'QUANTITY',
  SESSION:  'SESSION ',
};

export default function PolicyExplanation({ explanation, className = '' }: Props) {
  const decisionColor =
    explanation.decision === 'APPROVED'
      ? 'text-[#22c55e] border-[#22c55e]/40 bg-[#061e14]'
      : explanation.decision === 'REVIEW'
      ? 'text-[#f9c425] border-[#f9c425]/40 bg-[#141209]'
      : 'text-[#ff3366] border-[#ff3366]/40 bg-[#160a0d]';

  const decisionIcon =
    explanation.decision === 'APPROVED' ? (
      <CheckCircle className="w-4 h-4 text-[#22c55e]" />
    ) : explanation.decision === 'REVIEW' ? (
      <AlertTriangle className="w-4 h-4 text-[#f9c425]" />
    ) : (
      <XCircle className="w-4 h-4 text-[#ff3366]" />
    );

  return (
    <div className={`font-mono text-xs rounded-[2px] border border-[#23272a] bg-[#070809] overflow-hidden ${className}`}>
      {/* Header */}
      <div className="px-3 py-2 border-b border-[#1b1e20] flex items-center justify-between">
        <span className="text-[10px] font-pixel text-[#5a5e62] uppercase tracking-widest">
          POLICY CHECK — v{explanation.policyVersion} / {explanation.policyId}
        </span>
        {explanation.resolvedMerchant && (
          <span className="text-[10px] text-[#8e9296]">
            {explanation.resolvedMerchant} · {explanation.resolvedCategory}
          </span>
        )}
      </div>

      {/* Check lines */}
      <div className="px-3 py-2 flex flex-col gap-1">
        {explanation.checks.map((check) => (
          <div key={check.rule} className="flex items-center gap-2">
            {check.passed ? (
              <span className="text-[#22c55e]">✓</span>
            ) : explanation.decision === 'REVIEW' ? (
              <span className="text-[#f9c425]">⚠</span>
            ) : (
              <span className="text-[#ff3366]">✗</span>
            )}
            <span className="text-[#8e9296] w-20 shrink-0">
              {ruleLabel[check.rule] ?? check.rule}
            </span>
            <span className={check.passed ? 'text-[#22c55e]' : explanation.decision === 'REVIEW' ? 'text-[#f9c425]' : 'text-[#ff3366]'}>
              {check.detail}
            </span>
          </div>
        ))}
      </div>

      {/* Decision footer */}
      <div className={`px-3 py-2 border-t border-[#1b1e20] flex items-center gap-2 ${decisionColor} border`}>
        {decisionIcon}
        <span className="font-pixel font-bold tracking-wider text-[11px]">
          DECISION: {explanation.decision}
        </span>
        {explanation.resolvedPrice !== undefined && (
          <span className="ml-auto text-[10px] opacity-75">
            ₹{(explanation.resolvedPrice / 100).toFixed(2)}
          </span>
        )}
      </div>
    </div>
  );
}
