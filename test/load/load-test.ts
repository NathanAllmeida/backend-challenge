import { v7 as uuidv7 } from 'uuid';

const targets = (process.env.LOAD_TARGETS ?? 'http://localhost:3001,http://localhost:3002,http://localhost:3003').split(',');
const walletCount = Number(process.env.LOAD_WALLETS ?? 20);
const totalRequests = Number(process.env.LOAD_REQUESTS ?? 3000);
const concurrency = Number(process.env.LOAD_CONCURRENCY ?? 50);
const duplicateRatio = Number(process.env.LOAD_DUPLICATE_RATIO ?? 0.1);

interface Wallet {
  id: string;
  playerId: string;
}

interface Sample {
  status: number;
  ms: number;
}

const pick = <T>(items: T[]): T => items[Math.floor(Math.random() * items.length)]!;

async function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Sample & { body: any }> {
  const startedAt = performance.now();

  try {
    const response = await fetch(`${pick(targets)}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    return { status: response.status, ms: performance.now() - startedAt, body: await response.json() };
  } catch {
    return { status: 0, ms: performance.now() - startedAt, body: null };
  }
}

async function scrape(metric: string): Promise<number[]> {
  const bodies = await Promise.all(targets.map((target) => fetch(`${target}/metrics`).then((response) => response.text()).catch(() => '')));

  return bodies.map((body) => body
    .split('\n')
    .filter((line) => line.startsWith(metric))
    .reduce((total, line) => total + Number(line.split(' ').at(-1)), 0));
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
}

const wallets: Wallet[] = [];
for (let i = 0; i < walletCount; i++) {
  const created = await post('/wallets', { playerId: `load-${uuidv7()}`, initialBalance: { amount: '100000.00', currency: 'BRL' } });
  wallets.push(created.body as Wallet);
}

const lockConflictsBefore = (await scrape('wallet_lock_conflicts_total')).reduce((a, b) => a + b, 0);
const sent: Array<{ payload: Record<string, unknown>; key: string }> = [];
const samples: Sample[] = [];
let next = 0;

async function worker(): Promise<void> {
  while (next < totalRequests) {
    next += 1;

    const replay = sent.length > 0 && Math.random() < duplicateRatio;
    const request = replay ? pick(sent) : (() => {
      const wallet = pick(wallets);
      const kind = Math.random() < 0.7 ? 'BET' : 'WIN';
      const payload = {
        providerId: 'load',
        externalTransactionId: uuidv7(),
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: uuidv7(),
        gameId: 'load-test',
        kind,
        money: { amount: kind === 'BET' ? '1.00' : '0.50', currency: 'BRL' },
      };
      const created = { payload, key: `load:${payload.externalTransactionId}` };
      sent.push(created);
      return created;
    })();

    const result = await post('/wagering/transactions', request.payload, { 'Idempotency-Key': request.key });
    samples.push({ status: result.status, ms: result.ms });
  }
}

const startedAt = performance.now();
await Promise.all(Array.from({ length: concurrency }, worker));
const elapsedSeconds = (performance.now() - startedAt) / 1000;

const lagAtEnd = Math.max(...await scrape('outbox_lag_seconds'));
const drainStartedAt = performance.now();
while ((await scrape('outbox_pending_messages')).some((pending) => pending > 0) && performance.now() - drainStartedAt < 60_000) {
  await Bun.sleep(250);
}
const drainSeconds = (performance.now() - drainStartedAt) / 1000;

const lockConflicts = (await scrape('wallet_lock_conflicts_total')).reduce((a, b) => a + b, 0) - lockConflictsBefore;
const reconciliations = await Promise.all(wallets.map((wallet) => post(`/wallets/${wallet.id}/reconciliation`, {})));

const latencies = samples.map((sample) => sample.ms).sort((a, b) => a - b);
const byStatus = samples.reduce<Record<string, number>>((acc, sample) => ({ ...acc, [sample.status]: (acc[sample.status] ?? 0) + 1 }), {});
const errors = samples.filter((sample) => sample.status === 0 || sample.status >= 500).length;

console.log(JSON.stringify({
  setup: { targets, wallets: walletCount, requests: totalRequests, concurrency, duplicateRatio },
  throughputRps: Number((samples.length / elapsedSeconds).toFixed(1)),
  latencyMs: {
    p50: Number(percentile(latencies, 50).toFixed(1)),
    p95: Number(percentile(latencies, 95).toFixed(1)),
    p99: Number(percentile(latencies, 99).toFixed(1)),
    max: Number((latencies.at(-1) ?? 0).toFixed(1)),
  },
  responsesByStatus: byStatus,
  errorRate: Number((errors / samples.length).toFixed(4)),
  errorLatencyMs: samples.filter((sample) => sample.status === 0 || sample.status >= 500).map((sample) => Math.round(sample.ms)),
  lockConflicts,
  outbox: { lagAtEndSeconds: Number(lagAtEnd.toFixed(2)), secondsToDrain: Number(drainSeconds.toFixed(2)) },
  walletsConsistent: reconciliations.every((report) => report.body?.consistent === true),
}, null, 2));
