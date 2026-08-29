'use client';

import React from 'react';

interface TelemetryBadgeProps {
  status?: 'active' | 'warning' | 'error' | 'idle' | 'orange';
  label: string;
  sublabel?: string;
  className?: string;
}

export default function TelemetryBadge({
  status = 'active',
  label,
  sublabel,
  className = '',
}: TelemetryBadgeProps) {
  const getColors = () => {
    switch (status) {
      case 'active':
        return {
          bg: 'bg-[#0f1112]',
          border: 'border-[#22c55e]/30',
          text: 'text-[#22c55e]',
          dot: 'bg-[#22c55e]',
          ping: 'bg-[#22c55e]',
        };
      case 'orange':
        return {
          bg: 'bg-[#150d0a]',
          border: 'border-[#ff571a]/40',
          text: 'text-[#ff571a]',
          dot: 'bg-[#ff571a]',
          ping: 'bg-[#ff571a]',
        };
      case 'warning':
        return {
          bg: 'bg-[#141209]',
          border: 'border-[#f9c425]/40',
          text: 'text-[#f9c425]',
          dot: 'bg-[#f9c425]',
          ping: 'bg-[#f9c425]',
        };
      case 'error':
        return {
          bg: 'bg-[#160a0d]',
          border: 'border-[#ff3366]/40',
          text: 'text-[#ff3366]',
          dot: 'bg-[#ff3366]',
          ping: 'bg-[#ff3366]',
        };
      default:
        return {
          bg: 'bg-[#0f1112]',
          border: 'border-[#2f3438]',
          text: 'text-[#8e9296]',
          dot: 'bg-[#8e9296]',
          ping: 'bg-[#8e9296]',
        };
    }
  };

  const c = getColors();

  return (
    <div
      className={`inline-flex items-center gap-2 px-2.5 py-1 rounded-[2px] border ${c.border} ${c.bg} font-mono text-xs ${className}`}
    >
      <span className="relative flex h-2 w-2">
        <span
          className={`animate-ping absolute inline-flex h-full w-full rounded-full ${c.ping} opacity-75`}
        />
        <span className={`relative inline-flex rounded-full h-2 w-2 ${c.dot}`} />
      </span>
      <span className={`font-pixel font-bold tracking-wider text-[10px] ${c.text}`}>{label}</span>
      {sublabel && (
        <span className="text-[#8e9296] font-mono text-[10px] font-normal border-l border-[#2f3438] pl-1.5 ml-0.5">
          {sublabel}
        </span>
      )}
    </div>
  );
}
