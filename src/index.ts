import 'dotenv/config';
import Stripe from 'stripe';
import { runBackfill, type AbortState } from './backfill.js';
import { parseConfig } from './config.js';
import { CursorWriter, readCursor, type CursorState } from './cursor.js';
import { createLogger } from './logger.js';
import { RateLimiter } from './rate-limiter.js';
import { ReportWriter } from './report.js';
import { createStripeCaller } from './stripe-call.js';

async function main(): Promise<number> {
  const config = parseConfig();
  if (!config) return 0;

  const apiKey = process.env.STRIPE_SECRET_KEY?.trim();
  if (!apiKey) {
    throw new Error('STRIPE_SECRET_KEY is not set. Copy .env.example to .env and fill it in.');
  }
  const keyMode = /_live_/.test(apiKey) ? 'live' : 'test';

  const logger = createLogger({ level: config.logLevel, logFile: config.logFile });
  const report = new ReportWriter(config.reportFile);
  const abortState: AbortState = { aborted: false };
  const mode = config.dryRun ? 'dry' : 'wet';

  const cursorWriter =
    config.customerIds.length > 0 ? null : new CursorWriter(config.cursorFile, mode);

  let resumeState: CursorState | null = null;
  if (config.resume) {
    resumeState = readCursor(config.cursorFile);
    if (!resumeState) {
      logger.warn(
        { cursor_file: config.cursorFile },
        'no cursor file found, starting from the first customer',
      );
    } else if (resumeState.mode !== mode) {
      throw new Error(
        `${config.cursorFile} was written by a ${resumeState.mode} run; refusing to resume it as a ${mode} run`,
      );
    } else {
      logger.info(
        {
          cursor_file: config.cursorFile,
          resume_after_customer_id: resumeState.lastCustomerId,
          customers_already_processed: resumeState.customersProcessed,
          cursor_updated_at: resumeState.updatedAt,
        },
        'resuming from cursor',
      );
    }
  }

  const stripe = new Stripe(apiKey, {
    maxNetworkRetries: 0,
    timeout: 30_000,
    appInfo: { name: 'stripe-rescue/card-name-backfill', version: '1.0.0' },
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
      target: config.customerIds.length > 0 ? `${config.customerIds.length} explicit customer(s)` : 'all customers',
      batch_size: config.batchSize,
      concurrency: config.concurrency,
      rps: config.rps,
      max_retries: config.maxRetries,
      max_customers: config.maxCustomers ?? 'unlimited',
      resume: config.resume,
      cursor_file: cursorWriter ? config.cursorFile : 'disabled (explicit customer ids)',
      log_file: config.logFile,
      report_file: config.reportFile,
    },
    'starting card.name backfill',
  );

  if (!config.dryRun && keyMode === 'live') {
    logger.warn('WET RUN against LIVE Stripe data: card names will be written');
  }

  const startedAt = Date.now();
  try {
    const summary = await runBackfill({
      stripe,
      logger,
      report,
      config,
      callStripe,
      abortState,
      resumeAfterCustomerId: resumeState?.lastCustomerId ?? null,
      resumeCustomersProcessed: resumeState?.customersProcessed ?? 0,
      saveCursor: cursorWriter
        ? (lastCustomerId, customersProcessed) =>
            cursorWriter.save(lastCustomerId, customersProcessed)
        : null,
    });

    logger.info(
      {
        mode: config.dryRun ? 'DRY RUN' : 'WET RUN',
        duration_s: Math.round((Date.now() - startedAt) / 100) / 10,
        ...summary,
        log_file: config.logFile,
        report_file: config.reportFile,
        ...(cursorWriter ? { cursor_file: config.cursorFile } : {}),
      },
      'backfill finished',
    );

    if (summary.aborted && cursorWriter) {
      logger.warn(
        { cursor_file: config.cursorFile },
        'run aborted; rerun the same command with --resume to continue',
      );
    }

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
