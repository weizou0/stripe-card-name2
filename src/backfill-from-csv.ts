import 'dotenv/config';
import Stripe from 'stripe';
import { parseCsvConfig } from './csv-config.js';
import { readCustomerNameCsv, type CsvRow } from './csv.js';
import { createLogger } from './logger.js';
import { RateLimiter } from './rate-limiter.js';
import { ReportWriter } from './report.js';
import { createStripeCaller } from './stripe-call.js';
import { runCsvBackfill } from './csv-backfill.js';
import type { AbortState } from './backfill.js';

async function main(): Promise<number> {
  const config = parseCsvConfig();
  if (!config) return 0;

  const apiKey = process.env.STRIPE_SECRET_KEY?.trim();
  if (!apiKey) {
    throw new Error('STRIPE_SECRET_KEY is not set. Copy .env.example to .env and fill it in.');
  }
  const keyMode = /_live_/.test(apiKey) ? 'live' : 'test';

  const logger = createLogger({ level: config.logLevel, logFile: config.logFile });
  const report = new ReportWriter(config.reportFile);
  const abortState: AbortState = { aborted: false };

  const allRows: CsvRow[] = [];
  for (const filePath of config.csvFiles) {
    const rows = readCustomerNameCsv(filePath);
    logger.info({ file: filePath, rows: rows.length }, 'loaded csv');
    allRows.push(...rows);
  }

  // Preserve order and avoid redundant Stripe calls when the same customer
  // appears in multiple files.
  const seen = new Set<string>();
  const rows = allRows.filter((row) => {
    if (seen.has(row.customerId)) return false;
    seen.add(row.customerId);
    return true;
  });

  const stripe = new Stripe(apiKey, {
    maxNetworkRetries: 0,
    timeout: 30_000,
    appInfo: { name: 'stripe-rescue/card-name-from-csv', version: '1.0.0' },
  });

  const callStripe = createStripeCaller({
    limiter: new RateLimiter(config.rps),
    logger,
    maxRetries: config.maxRetries,
  });

  const onSignal = (signal: string): void => {
    if (abortState.aborted) return;
    abortState.aborted = true;
    logger.warn({ signal }, 'abort requested, finishing current batch then stopping');
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));

  logger.info(
    {
      run_id: config.runId,
      mode: config.dryRun ? 'DRY RUN' : 'WET RUN',
      stripe_key_mode: keyMode,
      csv_files: config.csvFiles,
      unique_rows: rows.length,
      batch_size: config.batchSize,
      concurrency: config.concurrency,
      rps: config.rps,
      max_retries: config.maxRetries,
      log_file: config.logFile,
      report_file: config.reportFile,
    },
    'starting card.name csv backfill',
  );

  if (!config.dryRun && keyMode === 'live') {
    logger.warn('WET RUN against LIVE Stripe data: card names will be written');
  }

  const startedAt = Date.now();
  try {
    const summary = await runCsvBackfill({
      stripe,
      logger,
      report,
      config,
      callStripe,
      abortState,
    }, rows);

    logger.info(
      {
        mode: config.dryRun ? 'DRY RUN' : 'WET RUN',
        duration_s: Math.round((Date.now() - startedAt) / 100) / 10,
        ...summary,
        log_file: config.logFile,
        report_file: config.reportFile,
      },
      'csv backfill finished',
    );

    const failed = summary.cardsFailed + summary.customersFailed;
    if (failed > 0) return 1;
    return summary.aborted ? 130 : 0;
  } finally {
    await report.close();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
