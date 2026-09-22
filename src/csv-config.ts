import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  DEFAULT_BATCH_SIZE,
  DEFAULT_CONCURRENCY,
  DEFAULT_MAX_RETRIES,
  DEFAULT_RPS,
} from './config.js';

export interface CsvRunConfig {
  runId: string;
  dryRun: boolean;
  csvFiles: string[];
  batchSize: number;
  concurrency: number;
  rps: number;
  maxRetries: number;
  logLevel: string;
  logDir: string;
  logFile: string;
  reportFile: string;
}

const USAGE = `
stripe-rescue - backfill card.name from a CSV full_customer_name column

Usage:
  npm run backfill-from-csv -- <csv-file> [csv-file ...] [options]

Options:
  --wet                     Perform real Stripe writes. Omit for a dry run (default).
  --dry-run                 Explicit dry run (mutually exclusive with --wet).
  --batch-size <n>          Rows per batch, 1-${DEFAULT_BATCH_SIZE} (default ${DEFAULT_BATCH_SIZE}).
  --concurrency <n>         Rows processed in parallel (default ${DEFAULT_CONCURRENCY}).
  --rps <n>                 Max Stripe requests per second (default ${DEFAULT_RPS}).
  --max-retries <n>         Retries per request on 429/5xx (default ${DEFAULT_MAX_RETRIES}).
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

export function parseCsvConfig(argv: string[] = process.argv.slice(2)): CsvRunConfig | null {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      wet: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      'batch-size': { type: 'string' },
      concurrency: { type: 'string' },
      rps: { type: 'string' },
      'max-retries': { type: 'string' },
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

  const csvFiles = positionals.filter((positional) => positional.endsWith('.csv'));
  if (csvFiles.length === 0) {
    throw new Error('At least one CSV file path is required');
  }

  const dryRun = !values.wet;
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const logDir = values['log-dir'] ?? 'logs';
  const mode = dryRun ? 'dry' : 'wet';

  return {
    runId,
    dryRun,
    csvFiles,
    batchSize: parseIntOption(values['batch-size'], '--batch-size', DEFAULT_BATCH_SIZE),
    concurrency: parseIntOption(values.concurrency, '--concurrency', DEFAULT_CONCURRENCY),
    rps: parseIntOption(values.rps, '--rps', DEFAULT_RPS),
    maxRetries: parseIntOption(values['max-retries'], '--max-retries', DEFAULT_MAX_RETRIES),
    logLevel: values['log-level'] ?? 'info',
    logDir,
    logFile: path.join(logDir, `${runId}-${mode}-from-csv.log`),
    reportFile: path.join(logDir, `${runId}-${mode}-from-csv-report.csv`),
  };
}
