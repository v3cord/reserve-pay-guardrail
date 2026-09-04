'use client';

import React, { useState } from 'react';
import { Terminal, Code, CheckCircle2, Play, CreditCard, ChevronDown, ChevronUp } from 'lucide-react';
import CornerBrackets from './CornerBrackets';

interface McpLog {
  id: string;
  tool: string;
  payload: Record<string, unknown>;
  result?: Record<string, unknown> | null;
  status: 'running' | 'done' | 'error';
}

export default function McpDemo() {
  const [logs, setLogs] = useState<McpLog[]>([]);
  const [expandedLog, setExpandedLog] = useState<string | null>(null);

  const toggleLog = (id: string) => {
    setExpandedLog(expandedLog === id ? null : id);
  };

  const runMcpCheckBudget = async () => {
    const id = Date.now().toString();
    const payload = { agentId: 'demo_agent' };
    setLogs((prev) => [...prev, { id, tool: 'reserve_check_budget', payload, status: 'running' }]);
    
    try {
      const [policyRes, reserveRes] = await Promise.all([
        fetch('/api/policy').then(r => r.json()),
        fetch('/api/reserve').then(r => r.json()),
      ]);
      
      const result = {
        agentId: 'demo_agent',
        activePolicy: policyRes.policy,
        reserveState: reserveRes,
        summary: `Remaining Budget: ₹${((reserveRes.availablePaise || 200000) / 100).toFixed(2)}`,
      };
      
      setLogs((prev) => prev.map(l => l.id === id ? { ...l, status: 'done', result } : l));
      setExpandedLog(id);
    } catch (e: unknown) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      setLogs((prev) => prev.map(l => l.id === id ? { ...l, status: 'error', result: { error: errorMsg } } : l));
    }
  };

  const runMcpRequestPurchase = async () => {
    const id = Date.now().toString();
    const payload = { 
      agentId: 'demo_agent',
      merchant: 'Swiggy',
      amount: 450.50, // INR
      category: 'Food & Dining',
      quantity: 1,
      idempotencyKey: `mcp_${id}`
    };
    
    setLogs((prev) => [...prev, { id, tool: 'reserve_request_purchase', payload, status: 'running' }]);
    
    try {
      const res = await fetch('/api/purchase', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-idempotency-key': payload.idempotencyKey
        },
        body: JSON.stringify({ ...payload, amount: payload.amount * 100 }) // convert to paise
      });
      const data = await res.json();
      
      const result = {
        decision: data.decision,
        reason: data.reason,
        ruleViolated: data.ruleViolated,
        transactionId: data.transaction?.id,
        paymentStatus: data.transaction?.paymentStatus,
        razorpayOrderId: data.razorpayOrderId
      };
      
      setLogs((prev) => prev.map(l => l.id === id ? { ...l, status: 'done', result } : l));
      setExpandedLog(id);
    } catch (e: unknown) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      setLogs((prev) => prev.map(l => l.id === id ? { ...l, status: 'error', result: { error: errorMsg } } : l));
    }
  };

  return (
    <div className="flex flex-col gap-4 w-full">
      <div className="flex flex-col items-start gap-3 justify-between flex-wrap">
        <p className="text-[11px] font-mono text-[#8e9296]">
          This demo simulates an MCP tool invocation using the same backend financial authorization path. The production MCP server exposes the same financial capabilities to agents.
        </p>
        <div className="flex items-center gap-2">
          <button onClick={runMcpCheckBudget} className="bg-[#111416] hover:bg-[#23272a] border border-[#23272a] hover:border-[#ff571a]/50 text-[#8e9296] hover:text-white font-pixel text-[9px] font-bold px-3 py-2 rounded-[2px] transition flex items-center gap-1.5 uppercase">
            <Terminal className="w-3.5 h-3.5 text-[#ff571a]" /><span>check_budget</span>
          </button>
          <button onClick={runMcpRequestPurchase} className="bg-[#111416] hover:bg-[#23272a] border border-[#23272a] hover:border-[#ff571a]/50 text-[#8e9296] hover:text-white font-pixel text-[9px] font-bold px-3 py-2 rounded-[2px] transition flex items-center gap-1.5 uppercase">
            <CreditCard className="w-3.5 h-3.5 text-[#22c55e]" /><span>request_purchase</span>
          </button>
        </div>
      </div>
      
      {logs.length > 0 && (
        <div className="flex flex-col gap-2 mt-2">
          {logs.map((log) => (
            <div key={log.id} className="bg-[#0b0d0e] border border-[#23272a] rounded-[2px] overflow-hidden">
              <button 
                onClick={() => toggleLog(log.id)}
                className="w-full flex items-center justify-between p-3 bg-[#0f1112] hover:bg-[#16191c] transition border-b border-transparent data-[expanded=true]:border-[#23272a]"
                data-expanded={expandedLog === log.id}
              >
                <div className="flex items-center gap-3">
                  {log.status === 'running' ? (
                    <span className="w-3.5 h-3.5 border-2 border-[#ff571a] border-t-transparent rounded-full animate-spin" />
                  ) : log.status === 'done' ? (
                    <CheckCircle2 className="w-3.5 h-3.5 text-[#22c55e]" />
                  ) : (
                    <Terminal className="w-3.5 h-3.5 text-[#ff3366]" />
                  )}
                  <span className="font-mono text-[11px] text-[#f0f1f1] font-bold">{log.tool}</span>
                  <span className="font-pixel text-[9px] text-[#5a5e62]">ID: {log.id.slice(-6)}</span>
                </div>
                {expandedLog === log.id ? <ChevronUp className="w-3.5 h-3.5 text-[#5a5e62]" /> : <ChevronDown className="w-3.5 h-3.5 text-[#5a5e62]" />}
              </button>
              
              {expandedLog === log.id && (
                <div className="p-3 bg-[#070809] flex flex-col gap-3">
                  <div className="flex flex-col gap-1.5">
                    <div className="text-[9px] font-pixel text-[#8e9296] uppercase tracking-wider">Input Payload</div>
                    <pre className="text-[10px] font-mono text-[#38bdf8] bg-[#0b0d0e] p-2 rounded-[2px] border border-[#1b1e20] overflow-x-auto">
                      {JSON.stringify(log.payload, null, 2)}
                    </pre>
                  </div>
                  {log.result && (
                    <div className="flex flex-col gap-1.5">
                      <div className="text-[9px] font-pixel text-[#8e9296] uppercase tracking-wider">MCP Output</div>
                      <pre className={`text-[10px] font-mono bg-[#0b0d0e] p-2 rounded-[2px] border border-[#1b1e20] overflow-x-auto ${log.status === 'error' ? 'text-[#ff3366]' : 'text-[#22c55e]'}`}>
                        {JSON.stringify(log.result, null, 2)}
                      </pre>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
