const claudeClient = require('./src/core/claude-client');
const n = require('./src/pillar3-statement/statement-narrative');

function base(): any {
  return {
    row: {
      period_start: '2026-06-29', period_end: '2026-07-26',
      total_sales: 73125, estimated_margin: 60425, cashflow_consistency_note: '',
      outstanding_receivables: 500, reconciliation_accuracy: 0.86, summary_json: '',
    },
    dailySales: [], daysWithActivity: 25, daysInPeriod: 28, daysClosed: 21,
    deniRepaymentRate: 0.75, unconfirmedSales: 38525,
  };
}

async function run(label: string, impl: (...a: any[]) => Promise<string>) {
  claudeClient.askClaude = impl;
  try {
    const out = await n.phraseSummary(base());
    console.log('=== ' + label + ' ===');
    console.log('type=' + typeof out, 'length=' + out.length, 'nonEmptyTrim=' + (out.trim().length > 0));
    console.log(JSON.stringify(out.slice(0, 80)));
  } catch (e: any) {
    console.log('=== ' + label + ' === THREW: ' + e.message);
  }
  console.log();
}

(async () => {
  await run('throws synchronously', () => { throw new Error('boom'); });
  await run('rejects', () => Promise.reject(new Error('network fail')));
  await run('returns empty string', async () => '');
  await run('returns whitespace only', async () => '   \n  ');
  await run('returns normal text', async () => 'The trader logged KES 73,125 in sales.');
  await run('hangs then rejects (simulated timeout)', () => new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 50)));
})();
