'use client';

import React from 'react';

interface CornerBracketsProps {
  color?: string;
  size?: number;
  strokeWidth?: number;
  className?: string;
}

export default function CornerBrackets({
  color = '#FF571A',
  size = 14,
  strokeWidth = 1.5,
  className = '',
}: CornerBracketsProps) {
  return (
    <>
      {/* Top Left */}
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        className={`absolute top-0 left-0 pointer-events-none ${className}`}
      >
        <path d="M24 0H0V24" stroke={color} strokeWidth={strokeWidth} />
      </svg>

      {/* Top Right */}
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        className={`absolute top-0 right-0 pointer-events-none ${className}`}
      >
        <path d="M0 0H24V24" stroke={color} strokeWidth={strokeWidth} />
      </svg>

      {/* Bottom Left */}
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        className={`absolute bottom-0 left-0 pointer-events-none ${className}`}
      >
        <path d="M24 24H0V0" stroke={color} strokeWidth={strokeWidth} />
      </svg>

      {/* Bottom Right */}
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        className={`absolute bottom-0 right-0 pointer-events-none ${className}`}
      >
        <path d="M0 24H24V0" stroke={color} strokeWidth={strokeWidth} />
      </svg>
    </>
  );
}
