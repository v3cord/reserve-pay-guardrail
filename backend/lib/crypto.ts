import { createHash } from 'crypto';

export const GENESIS_PREV_HASH = '0000000000000000000000000000000000000000000000000000000000000000';

export function calculatePayloadHash(payload: Record<string, unknown> | null | undefined): string {
  if (!payload) return createHash('sha256').update('{}').digest('hex');
  const sortedKeys = Object.keys(payload).sort();
  const sortedObj: Record<string, unknown> = {};
  for (const k of sortedKeys) {
    sortedObj[k] = payload[k];
  }
  return createHash('sha256').update(JSON.stringify(sortedObj)).digest('hex');
}

export function calculateLedgerEventHash(event: {
  id: string;
  transactionId: string;
  eventType: string;
  timestamp: string;
  payloadHash: string;
  sequenceNum: number;
  prevHash: string;
}): string {
  const data = `${event.id}:${event.transactionId}:${event.eventType}:${event.timestamp}:${event.payloadHash}:${event.sequenceNum}:${event.prevHash}`;
  return createHash('sha256').update(data).digest('hex');
}

export function calculateTransactionHash(tx: {
  id: string;
  timestamp: string;
  amount: number;
  merchant: string;
  status: 'approved' | 'frozen' | string;
  prevHash: string;
}): string {
  const decision = tx.status;
  const data = `${tx.id}${tx.timestamp}${tx.amount}${tx.merchant}${decision}${tx.prevHash}`;
  return createHash('sha256').update(data).digest('hex');
}