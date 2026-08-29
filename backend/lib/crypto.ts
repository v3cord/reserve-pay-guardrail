import { createHash } from 'crypto';

export const GENESIS_PREV_HASH = '0000000000000000000000000000000000000000000000000000000000000000';

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