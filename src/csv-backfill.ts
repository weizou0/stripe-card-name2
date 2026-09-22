import { createHash } from 'node:crypto';
import type { Logger } from 'pino';
import type Stripe from 'stripe';
import { STRIPE_MAX_PAGE_SIZE } from './config.js';
import type { CsvRunConfig } from './csv-config.js';
import type { CsvRow } from './csv.js';
import type { ReportWriter } from './report.js';
import { asStripeError, type StripeCaller } from './stripe-call.js';
import type { AbortState } from './backfill.js';

export interface CsvBackfillDeps {
  stripe: Stripe;
  logger: Logger;
  report: ReportWriter;
  config: CsvRunConfig;
  callStripe: StripeCaller;
  abortState?: AbortState;
}

export interface CsvSummary {
  rowsScanned: number;
  rowsSkippedInvalidCustomer: number;
  customersProcessed: number;
  customersUpdated: number;
  customersWouldUpdate: number;
  customersSkippedAlreadyCorrect: number;
  customersFailed: number;
  cardsScanned: number;
  cardsUpdated: number;
  cardsWouldUpdate: number;
  cardsSkippedAlreadyCorrect: number;
  customersSkippedNoCards: number;
  cardsFailed: number;
  batches: number;
  aborted: boolean;
}

function createSummary(): CsvSummary {
  return {
    rowsScanned: 0,
    rowsSkippedInvalidCustomer: 0,
    customersProcessed: 0,
    customersUpdated: 0,
    customersWouldUpdate: 0,
    customersSkippedAlreadyCorrect: 0,
    customersFailed: 0,
    cardsScanned: 0,
    cardsUpdated: 0,
    cardsWouldUpdate: 0,
    cardsSkippedAlreadyCorrect: 0,
    customersSkippedNoCards: 0,
    cardsFailed: 0,
    batches: 0,
    aborted: false,
  };
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function blankToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function idempotencyKey(cardId: string, name: string): string {
  const digest = createHash('sha256').update(name).digest('hex').slice(0, 16);
  return `card-name-from-csv:${cardId}:${digest}`;
}

function customerIdempotencyKey(customerId: string, name: string): string {
  const digest = createHash('sha256').update(name).digest('hex').slice(0, 16);
  return `customer-name-from-csv:${customerId}:${digest}`;
}

async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      const item = items[index];
      if (item === undefined) return;
      await worker(item);
    }
  });
  await Promise.all(runners);
}

async function listCardSources(
  deps: CsvBackfillDeps,
  customerId: string,
): Promise<Stripe.Card[]> {
  const { stripe, callStripe } = deps;
  const cards: Stripe.Card[] = [];
  let startingAfter: string | undefined;

  for (;;) {
    const page: Stripe.ApiList<Stripe.CustomerSource> = await callStripe(
      'customers.listSources',
      () =>
        stripe.customers.listSources(customerId, {
          object: 'card',
          limit: STRIPE_MAX_PAGE_SIZE,
          ...(startingAfter ? { starting_after: startingAfter } : {}),
        }),
      { customer_id: customerId, starting_after: startingAfter },
    );

    for (const source of page.data) {
      if (source.object === 'card') cards.push(source);
    }

    const last = page.data[page.data.length - 1];
    if (!page.has_more || !last) return cards;
    startingAfter = last.id;
  }
}

async function processCard(
  deps: CsvBackfillDeps,
  summary: CsvSummary,
  customerId: string,
  card: Stripe.Card,
  newName: string,
): Promise<void> {
  const { logger, report, config, stripe, callStripe } = deps;
  const logContext = {
    customer_id: customerId,
    card_id: card.id,
    brand: card.brand,
    last4: card.last4,
    new_name: newName,
  };

  summary.cardsScanned += 1;

  if (blankToNull(card.name) === newName) {
    summary.cardsSkippedAlreadyCorrect += 1;
    logger.info({ ...logContext, action: 'skipped_already_correct' }, 'card name already correct');
    report.write({
      customerId,
      cardId: card.id,
      brand: card.brand ?? '',
      last4: card.last4 ?? '',
      newName,
      action: 'skipped_already_correct',
    });
    return;
  }

  if (config.dryRun) {
    summary.cardsWouldUpdate += 1;
    logger.info({ ...logContext, action: 'would_update' }, 'dry run: would set card name');
    report.write({
      customerId,
      cardId: card.id,
      brand: card.brand ?? '',
      last4: card.last4 ?? '',
      newName,
      action: 'would_update',
    });
    return;
  }

  try {
    await callStripe(
      'customers.updateSource',
      () =>
        stripe.customers.updateSource(
          customerId,
          card.id,
          { name: newName },
          { idempotencyKey: idempotencyKey(card.id, newName) },
        ),
      logContext,
    );
    summary.cardsUpdated += 1;
    logger.info({ ...logContext, action: 'updated' }, 'card name updated');
    report.write({
      customerId,
      cardId: card.id,
      brand: card.brand ?? '',
      last4: card.last4 ?? '',
      newName,
      action: 'updated',
    });
  } catch (error) {
    const err = asStripeError(error);
    summary.cardsFailed += 1;
    logger.error(
      { ...logContext, action: 'failed', stripe_code: err.code, request_id: err.requestId },
      'card name update failed',
    );
    report.write({
      customerId,
      cardId: card.id,
      brand: card.brand ?? '',
      last4: card.last4 ?? '',
      newName,
      action: 'failed',
      error: err.message ?? String(error),
    });
  }
}

async function updateCustomerName(
  deps: CsvBackfillDeps,
  summary: CsvSummary,
  row: CsvRow,
): Promise<void> {
  const { logger, report, config, stripe, callStripe } = deps;
  const logContext = {
    customer_id: row.customerId,
    new_name: row.fullName,
  };

  try {
    const customer = await callStripe(
      'customers.retrieve',
      () => stripe.customers.retrieve(row.customerId),
      { customer_id: row.customerId },
    );

    if ('deleted' in customer && customer.deleted) {
      summary.customersFailed += 1;
      logger.warn({ ...logContext }, 'customer is deleted, skipping customer name update');
      report.write({
        customerId: row.customerId,
        cardId: '',
        brand: '',
        last4: '',
        newName: row.fullName,
        action: 'failed',
        error: 'customer is deleted',
      });
      return;
    }

    if (blankToNull(customer.name) === row.fullName) {
      summary.customersSkippedAlreadyCorrect += 1;
      logger.info({ ...logContext, action: 'skipped_customer_already_correct' }, 'customer name already correct');
      return;
    }

    if (config.dryRun) {
      summary.customersWouldUpdate += 1;
      logger.info({ ...logContext, action: 'would_update_customer' }, 'dry run: would set customer name');
      report.write({
        customerId: row.customerId,
        cardId: '',
        brand: '',
        last4: '',
        newName: row.fullName,
        action: 'would_update_customer',
      });
      return;
    }

    await callStripe(
      'customers.update',
      () =>
        stripe.customers.update(
          row.customerId,
          { name: row.fullName },
          { idempotencyKey: customerIdempotencyKey(row.customerId, row.fullName) },
        ),
      logContext,
    );
    summary.customersUpdated += 1;
    logger.info({ ...logContext, action: 'updated_customer' }, 'customer name updated');
    report.write({
      customerId: row.customerId,
      cardId: '',
      brand: '',
      last4: '',
      newName: row.fullName,
      action: 'updated_customer',
    });
  } catch (error) {
    const err = asStripeError(error);
    summary.customersFailed += 1;
    logger.error(
      { ...logContext, stripe_code: err.code, request_id: err.requestId },
      'customer name update failed',
    );
    report.write({
      customerId: row.customerId,
      cardId: '',
      brand: '',
      last4: '',
      newName: row.fullName,
      action: 'failed',
      error: err.message ?? String(error),
    });
  }
}

async function processCustomerFromCsv(
  deps: CsvBackfillDeps,
  summary: CsvSummary,
  row: CsvRow,
): Promise<void> {
  const { logger, report } = deps;

  summary.rowsScanned += 1;

  if (!row.customerId.startsWith('cus_')) {
    summary.rowsSkippedInvalidCustomer += 1;
    logger.warn({ customer_id: row.customerId, action: 'skipped_invalid_customer_id' }, 'skipping row with invalid customer id');
    return;
  }

  await updateCustomerName(deps, summary, row);

  try {
    const cards = await listCardSources(deps, row.customerId);
    summary.customersProcessed += 1;

    if (cards.length === 0) {
      summary.customersSkippedNoCards += 1;
      logger.info(
        { customer_id: row.customerId, action: 'skipped_no_cards' },
        'customer has no card sources',
      );
      report.write({
        customerId: row.customerId,
        cardId: '',
        brand: '',
        last4: '',
        newName: row.fullName,
        action: 'skipped_no_cards',
      });
      return;
    }

    logger.info(
      { customer_id: row.customerId, customer_name: row.fullName, card_count: cards.length },
      'processing customer from csv',
    );

    for (const card of cards) {
      await processCard(deps, summary, row.customerId, card, row.fullName);
    }
  } catch (error) {
    const err = asStripeError(error);
    summary.customersFailed += 1;
    logger.error(
      { customer_id: row.customerId, stripe_code: err.code, request_id: err.requestId },
      'customer processing failed',
    );
    report.write({
      customerId: row.customerId,
      cardId: '',
      brand: '',
      last4: '',
      newName: row.fullName,
      action: 'failed',
      error: err.message ?? String(error),
    });
  }
}

export async function runCsvBackfill(
  deps: CsvBackfillDeps,
  rows: CsvRow[],
): Promise<CsvSummary> {
  const { config, logger, abortState } = deps;
  const summary = createSummary();

  for (const batch of chunk(rows, config.batchSize)) {
    if (abortState?.aborted) break;
    summary.batches += 1;
    logger.info(
      {
        batch: summary.batches,
        batch_size: batch.length,
        first_customer_id: batch[0]?.customerId,
      },
      'batch started',
    );

    await runWithConcurrency(batch, config.concurrency, (row) =>
      processCustomerFromCsv(deps, summary, row),
    );

    logger.info(
      {
        batch: summary.batches,
        rows_scanned: summary.rowsScanned,
        customers_updated: config.dryRun ? summary.customersWouldUpdate : summary.customersUpdated,
        customers_failed: summary.customersFailed,
        cards_updated: config.dryRun ? summary.cardsWouldUpdate : summary.cardsUpdated,
        cards_failed: summary.cardsFailed,
      },
      'batch finished',
    );
  }

  summary.aborted = abortState?.aborted ?? false;
  return summary;
}
