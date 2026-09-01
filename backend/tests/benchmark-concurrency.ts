import { SqliteReserveStore } from '../lib/sqliteStore';
import { InMemoryTokenBucket } from '../lib/tokenBucket';

async function runConcurrencyBenchmark() {
  console.log('===============================================================');
  console.log('? Reserve Pay Guardrail — 1,000-Request Concurrency Benchmark');
  console.log('===============================================================');

  const totalCapPaise = 100000; // ?1,000 reserve pool
  const itemPricePaise = 25000; // ?250 per item (exactly 4 purchases allowed)
  const concurrencyCount = 1000;
  const agentId = `bench_agent_${Date.now()}`;

  const tokenBucket = new InMemoryTokenBucket();
  const store = new SqliteReserveStore(tokenBucket);
  await store.resetStore(agentId);
  await store.setReserveState({ totalPaise: totalCapPaise, heldPaise: 0, settledPaise: 0 }, agentId);
  await store.setActivePolicy(
    {
      amountCeiling: 50000,
      category: 'Food & Dining',
      allowedMerchants: ['Swiggy'],
      sessionCap: totalCapPaise,
    },
    agentId
  );

  console.log(`Initial Reserve Cap: ?${(totalCapPaise / 100).toFixed(2)}`);
  console.log(`Item Price: ?${(itemPricePaise / 100).toFixed(2)}`);
  console.log(`Launching ${concurrencyCount} simultaneous purchase requests...`);

  const startTime = Date.now();
  const requests = Array.from({ length: concurrencyCount }, (_, i) => {
    return store.processPurchaseAtomic({
      id: `bench_tx_${i}`,
      agentId,
      merchant: 'Swiggy',
      amount: itemPricePaise,
      category: 'Food & Dining',
    });
  });

  const results = await Promise.all(requests);
  const totalDurationMs = Date.now() - startTime;

  const allowed = results.filter((r) => r.decision === 'allowed');
  const denied = results.filter((r) => r.decision === 'denied' || r.decision === 'review');

  const finalState = await store.getReserveState(agentId);
  const totalSpentOrHeld = finalState.heldPaise + finalState.settledPaise;
  const overspend = Math.max(0, totalSpentOrHeld - totalCapPaise);

  console.log('\n--- Benchmark Results ---');
  console.log(`Total Requests Processed: ${concurrencyCount}`);
  console.log(`Total Time: ${totalDurationMs} ms (${(concurrencyCount / (totalDurationMs / 1000)).toFixed(2)} req/sec)`);
  console.log(`Allowed Purchases: ${allowed.length} (Expected: ${totalCapPaise / itemPricePaise})`);
  console.log(`Denied / Rate-limited: ${denied.length}`);
  console.log(`Final Held Balance: ?${(finalState.heldPaise / 100).toFixed(2)}`);
  console.log(`Final Settled Balance: ?${(finalState.settledPaise / 100).toFixed(2)}`);
  console.log(`Total Overspend: ?${(overspend / 100).toFixed(2)}`);

  if (overspend === 0 && allowed.length === totalCapPaise / itemPricePaise) {
    console.log('\n? ZERO-OVERSPEND INVARIANT MAINTAINED UNDER 1,000 CONCURRENT REQUESTS');
  } else {
    console.error('\n? CONCURRENCY INVARIANT VIOLATED!');
    process.exit(1);
  }
}

runConcurrencyBenchmark().catch(console.error);
