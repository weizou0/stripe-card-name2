import { createHash } from 'node:crypto';
import type { Logger } from 'pino';
import type Stripe from 'stripe';
import type { RunConfig } from './config.js';
import { STRIPE_MAX_PAGE_SIZE } from './config.js';
import type { ReportWriter } from './report.js';
import { asStripeError, type StripeCaller } from './stripe-call.js';

export interface AbortState {
  aborted: boolean;
}

export interface Summary {
  batches: number;
  customersScanned: number;
  customersSkippedNoName: number;
  customersFailed: number;
  cardsScanned: number;
  cardsUpdated: number;
  cardsWouldUpdate: number;
  cardsSkippedHasName: number;
  cardsFailed: number;
  aborted: boolean;
}

export interface BackfillDeps {
  stripe: Stripe;
  logger: Logger;
  report: ReportWriter;
  config: RunConfig;
  callStripe: StripeCaller;
  abortState: AbortState;
  resumeAfterCustomerId: string | null;
  resumeCustomersProcessed: number;
  saveCursor: ((lastCustomerId: string, customersProcessed: number) => void) | null;
}

interface CustomerTask {
  id: string;
  customer?: Stripe.Customer;
}

interface CustomerBatch {
  tasks: CustomerTask[];
  /** Last customer id on the Stripe page; null when the batch is not resumable. */
  cursor: string | null;
}

function createSummary(): Summary {
  return {
    batches: 0,
    customersScanned: 0,
    customersSkippedNoName: 0,
    customersFailed: 0,
    cardsScanned: 0,
    cardsUpdated: 0,
    cardsWouldUpdate: 0,
    cardsSkippedHasName: 0,
    cardsFailed: 0,
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
  return `card-name-backfill:${cardId}:${digest}`;
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

async function* iterateCustomerTasks(deps: BackfillDeps): AsyncGenerator<CustomerBatch> {
  const { config, callStripe, stripe, abortState } = deps;

  if (config.customerIds.length > 0) {
    const selected =
      config.maxCustomers === null
        ? config.customerIds
        : config.customerIds.slice(0, config.maxCustomers);
    for (const batch of chunk(selected, config.batchSize)) {
      if (abortState.aborted) return;
      yield { tasks: batch.map((id) => ({ id })), cursor: null };
    }
    return;
  }

  let startingAfter: string | undefined = deps.resumeAfterCustomerId ?? undefined;
  let emitted = 0;

  while (!abortState.aborted) {
    const remaining = config.maxCustomers === null ? config.batchSize : config.maxCustomers - emitted;
    if (remaining <= 0) return;

    const limit = Math.min(config.batchSize, remaining, STRIPE_MAX_PAGE_SIZE);
    const page: Stripe.ApiList<Stripe.Customer> = await callStripe(
      'customers.list',
      () => stripe.customers.list({ limit, ...(startingAfter ? { starting_after: startingAfter } : {}) }),
      { limit, starting_after: startingAfter },
    );

    const last = page.data[page.data.length - 1];
    if (!last) return;

    emitted += page.data.length;
    yield {
      tasks: page.data.map((customer) => ({ id: customer.id, customer })),
      cursor: last.id,
    };

    if (!page.has_more) return;
    startingAfter = last.id;
  }
}

async function listCardSources(deps: BackfillDeps, customerId: string): Promise<Stripe.Card[]> {
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
  deps: BackfillDeps,
  summary: Summary,
  customer: Stripe.Customer,
  card: Stripe.Card,
  newName: string,
): Promise<void> {
  const { logger, report, config, stripe, callStripe } = deps;
  const logContext = {
    customer_id: customer.id,
    card_id: card.id,
    brand: card.brand,
    last4: card.last4,
    new_name: newName,
  };

  summary.cardsScanned += 1;

  if (blankToNull(card.name)) {
    summary.cardsSkippedHasName += 1;
    logger.info({ ...logContext, action: 'skipped_card_has_name' }, 'card already has a name, skipping');
    report.write({
      customerId: customer.id,
      cardId: card.id,
      brand: card.brand ?? '',
      last4: card.last4 ?? '',
      newName: '',
      action: 'skipped_card_has_name',
    });
    return;
  }

  if (config.dryRun) {
    summary.cardsWouldUpdate += 1;
    logger.info({ ...logContext, action: 'would_update' }, 'dry run: would set card name');
    report.write({
      customerId: customer.id,
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
          customer.id,
          card.id,
          { name: newName },
          { idempotencyKey: idempotencyKey(card.id, newName) },
        ),
      logContext,
    );
    summary.cardsUpdated += 1;
    logger.info({ ...logContext, action: 'updated' }, 'card name updated');
    report.write({
      customerId: customer.id,
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
      customerId: customer.id,
      cardId: card.id,
      brand: card.brand ?? '',
      last4: card.last4 ?? '',
      newName,
      action: 'failed',
      error: err.message ?? String(error),
    });
  }
}

async function processCustomer(
  deps: BackfillDeps,
  summary: Summary,
  task: CustomerTask,
): Promise<void> {
  const { logger, report, stripe, callStripe } = deps;

  try {
    let customer = task.customer;
    if (!customer) {
      const retrieved = await callStripe(
        'customers.retrieve',
        () => stripe.customers.retrieve(task.id),
        { customer_id: task.id },
      );
      if ('deleted' in retrieved && retrieved.deleted) {
        summary.customersScanned += 1;
        logger.warn({ customer_id: task.id }, 'customer is deleted, skipping');
        return;
      }
      customer = retrieved as Stripe.Customer;
    }

    summary.customersScanned += 1;
    const newName = blankToNull(customer.name);

    if (!newName) {
      summary.customersSkippedNoName += 1;
      logger.info(
        { customer_id: customer.id, action: 'skipped_no_customer_name' },
        'customer has no name, skipping all cards',
      );
      report.write({
        customerId: customer.id,
        cardId: '',
        brand: '',
        last4: '',
        newName: '',
        action: 'skipped_no_customer_name',
      });
      return;
    }

    const cards = await listCardSources(deps, customer.id);
    logger.info(
      { customer_id: customer.id, customer_name: newName, card_count: cards.length },
      'processing customer',
    );

    for (const card of cards) {
      await processCard(deps, summary, customer, card, newName);
    }
  } catch (error) {
    const err = asStripeError(error);
    summary.customersFailed += 1;
    logger.error(
      { customer_id: task.id, stripe_code: err.code, request_id: err.requestId },
      'customer processing failed',
    );
    report.write({
      customerId: task.id,
      cardId: '',
      brand: '',
      last4: '',
      newName: '',
      action: 'failed',
      error: err.message ?? String(error),
    });
  }
}

export async function runBackfill(deps: BackfillDeps): Promise<Summary> {
  const { config, logger, abortState, saveCursor } = deps;
  const summary = createSummary();
  let customersProcessed = deps.resumeCustomersProcessed;

  for await (const batch of iterateCustomerTasks(deps)) {
    if (abortState.aborted) break;

    summary.batches += 1;
    logger.info(
      {
        batch: summary.batches,
        batch_size: batch.tasks.length,
        first_customer_id: batch.tasks[0]?.id,
      },
      'batch started',
    );

    await runWithConcurrency(batch.tasks, config.concurrency, (task) =>
      processCustomer(deps, summary, task),
    );

    customersProcessed += batch.tasks.length;

    // Saved only after the whole batch is done, so the cursor never points past
    // completed work and an aborted run can resume from exactly here.
    if (batch.cursor && saveCursor) saveCursor(batch.cursor, customersProcessed);

    logger.info(
      {
        batch: summary.batches,
        customers_scanned: summary.customersScanned,
        customers_processed_total: customersProcessed,
        cards_updated: config.dryRun ? summary.cardsWouldUpdate : summary.cardsUpdated,
        cards_failed: summary.cardsFailed,
        resume_cursor: batch.cursor,
      },
      'batch finished',
    );
  }

  summary.aborted = abortState.aborted;
  return summary;
}
