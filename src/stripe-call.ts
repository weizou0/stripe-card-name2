import type { Logger } from 'pino';
import type { RateLimiter } from './rate-limiter.js';

const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 30_000;

export interface StripeErrorShape {
  type?: string;
  code?: string;
  statusCode?: number;
  message?: string;
  requestId?: string;
  headers?: Record<string, string | undefined>;
}

export function asStripeError(error: unknown): StripeErrorShape {
  return (error ?? {}) as StripeErrorShape;
}

export function isRateLimited(error: unknown): boolean {
  const err = asStripeError(error);
  return err.statusCode === 429 || err.type === 'StripeRateLimitError' || err.code === 'rate_limit';
}

export function isRetryable(error: unknown): boolean {
  const err = asStripeError(error);
  if (isRateLimited(error)) return true;
  if (err.code === 'lock_timeout') return true;
  if (err.type === 'StripeConnectionError' || err.type === 'StripeAPIError') return true;
  return typeof err.statusCode === 'number' && err.statusCode >= 500;
}

function retryAfterMs(error: unknown): number | null {
  const raw = asStripeError(error).headers?.['retry-after'];
  if (!raw) return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds * 1000) : null;
}

export function backoffMs(attempt: number, error: unknown): number {
  const exponential = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempt);
  const jittered = exponential / 2 + Math.random() * (exponential / 2);
  return Math.min(MAX_BACKOFF_MS, Math.max(retryAfterMs(error) ?? 0, Math.ceil(jittered)));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type StripeCaller = <T>(
  operation: string,
  fn: () => Promise<T>,
  meta?: Record<string, unknown>,
) => Promise<T>;

export function createStripeCaller(deps: {
  limiter: RateLimiter;
  logger: Logger;
  maxRetries: number;
}): StripeCaller {
  const { limiter, logger, maxRetries } = deps;

  return async function callStripe<T>(
    operation: string,
    fn: () => Promise<T>,
    meta: Record<string, unknown> = {},
  ): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      await limiter.acquire();
      try {
        return await fn();
      } catch (error) {
        const err = asStripeError(error);
        const retryable = isRetryable(error);

        if (!retryable || attempt >= maxRetries) {
          logger.error(
            {
              ...meta,
              operation,
              attempt,
              retryable,
              stripe_type: err.type,
              stripe_code: err.code,
              status_code: err.statusCode,
              request_id: err.requestId,
              err: err.message,
            },
            'stripe request failed',
          );
          throw error;
        }

        const delayMs = backoffMs(attempt, error);
        logger.warn(
          {
            ...meta,
            operation,
            attempt,
            delay_ms: delayMs,
            throttled: isRateLimited(error),
            stripe_type: err.type,
            stripe_code: err.code,
            status_code: err.statusCode,
            request_id: err.requestId,
            err: err.message,
          },
          'stripe request retryable failure, backing off',
        );
        await sleep(delayMs);
      }
    }
  };
}
