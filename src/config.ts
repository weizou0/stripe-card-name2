import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

/**
 * Stripe documents ~100 read + 100 write requests/second in live mode and
 * 25 requests/second in test mode. 25 is therefore the safe default; bump it to
 * ~80 for large live runs to keep headroom for the rest of your platform.
 */
export const DEFAULT_RPS = 25;
export const DEFAULT_BATCH_SIZE = 100;
export const DEFAULT_CONCURRENCY = 5;
export const DEFAULT_MAX_RETRIES = 5;
export const STRIPE_MAX_PAGE_SIZE = 100;

export interface RunConfig {
  runId: string;
  dryRun: boolean;
  resume: boolean;
  cursorFile: string;
  customerIds: string[];
  batchSize: number;
  concurrency: number;
  rps: number;
  maxRetries: number;
  maxCustomers: number | null;
  logLevel: string;
  logDir: string;
  logFile: string;
  reportFile: string;
}

const USAGE = `
stripe-rescue - backfill legacy card.name from customer.name

Usage:
  npm run backfill -- [options]

Options:
  --wet                     Perform real Stripe writes. Omit for a dry run (default).
  --dry-run                 Explicit dry run (default, mutually exclusive with --wet).
  --customer-ids <ids>      Comma separated customer ids to process (repeatable).
  --customer-ids-file <p>   File with one customer id per line.
  --resume                  Continue after the customer id stored in the cursor file.
  --cursor-file <path>      Cursor file location (default <log-dir>/cursor.json).
  --batch-size <n>          Customers per batch, 1-${STRIPE_MAX_PAGE_SIZE} (default ${DEFAULT_BATCH_SIZE}).
  --concurrency <n>         Customers processed in parallel (default ${DEFAULT_CONCURRENCY}).
  --rps <n>                 Max Stripe requests per second (default ${DEFAULT_RPS}).
  --max-retries <n>         Retries per request on 429/5xx (default ${DEFAULT_MAX_RETRIES}).
  --max-customers <n>       Stop after N customers (default: no limit).
  --log-dir <path>          Directory for log + report files (default logs).
  --log-level <level>       pino level: trace|debug|info|warn|error (default info).
  --help                    Show this message.
`.trim();

function parseIntOption(raw: string | undefined, name: string, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, received "${raw}"`);
  }
  return value;
}

function splitIds(values: string[]): string[] {
  const ids = values
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return [...new Set(ids)];
}

function readIdsFile(filePath: string): string[] {
  const contents = readFileSync(filePath, 'utf8');
  return splitIds(contents.split(/\r?\n/));
}

export function parseConfig(argv: string[] = process.argv.slice(2)): RunConfig | null {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      wet: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      'customer-ids': { type: 'string', multiple: true, default: [] },
      'customer-ids-file': { type: 'string' },
      resume: { type: 'boolean', default: false },
      'cursor-file': { type: 'string' },
      'batch-size': { type: 'string' },
      concurrency: { type: 'string' },
      rps: { type: 'string' },
      'max-retries': { type: 'string' },
      'max-customers': { type: 'string' },
      'log-dir': { type: 'string' },
      'log-level': { type: 'string' },
      help: { type: 'boolean', default: false },
    },
  });

  if (values.help) {
    console.log(USAGE);
    return null;
  }

  if (values.wet && values['dry-run']) {
    throw new Error('--wet and --dry-run are mutually exclusive');
  }

  const batchSize = parseIntOption(values['batch-size'], '--batch-size', DEFAULT_BATCH_SIZE);
  if (batchSize > STRIPE_MAX_PAGE_SIZE) {
    throw new Error(`--batch-size cannot exceed the Stripe page size of ${STRIPE_MAX_PAGE_SIZE}`);
  }

  const customerIds = [
    ...splitIds(values['customer-ids'] ?? []),
    ...(values['customer-ids-file'] ? readIdsFile(values['customer-ids-file']) : []),
  ];
  const invalidId = customerIds.find((id) => !id.startsWith('cus_'));
  if (invalidId) {
    throw new Error(`"${invalidId}" does not look like a customer id (expected cus_...)`);
  }

  if (values.resume && customerIds.length > 0) {
    throw new Error('--resume cannot be combined with explicit customer ids');
  }

  const dryRun = !values.wet;
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const logDir = values['log-dir'] ?? 'logs';
  const mode = dryRun ? 'dry' : 'wet';

  return {
    runId,
    dryRun,
    resume: values.resume ?? false,
    cursorFile: values['cursor-file'] ?? path.join(logDir, 'cursor.json'),
    customerIds: [...new Set(customerIds)],
    batchSize,
    concurrency: parseIntOption(values.concurrency, '--concurrency', DEFAULT_CONCURRENCY),
    rps: parseIntOption(values.rps, '--rps', DEFAULT_RPS),
    maxRetries: parseIntOption(values['max-retries'], '--max-retries', DEFAULT_MAX_RETRIES),
    maxCustomers:
      values['max-customers'] === undefined
        ? null
        : parseIntOption(values['max-customers'], '--max-customers', 0),
    logLevel: values['log-level'] ?? 'info',
    logDir,
    logFile: path.join(logDir, `${runId}-${mode}.log`),
    reportFile: path.join(logDir, `${runId}-${mode}-report.csv`),
  };
}
