# stripe-rescue

Backfills the legacy Stripe card `name` (cardholder name) from `customer.name`, for every
card stored on a customer's `sources` (legacy card objects, `card_...`).

Rules:

- A card is updated **only when its `name` is null/blank**.
- The new value is always `customer.name` (trimmed). Customers without a name are skipped.
- Dry run is the default; real writes require `--wet`.

## Setup

```bash
npm install
cp .env.example .env   # then set STRIPE_SECRET_KEY
```

## Usage

```bash
# dry run over all customers (no writes)
npm run backfill

# dry run over specific customers
npm run backfill -- --customer-ids cus_123,cus_456

# real run, 50 req/s, 10 customers in parallel, first 500 customers only
npm run backfill -- --wet --rps 50 --concurrency 10 --max-customers 500
```

### Options

| Option | Default | Description |
| --- | --- | --- |
| `--wet` | off | Perform real Stripe writes. Without it the script only reports. |
| `--dry-run` | on | Explicit dry run (mutually exclusive with `--wet`). |
| `--customer-ids <ids>` | – | Comma separated customer ids, repeatable. |
| `--customer-ids-file <path>` | – | File with one customer id per line. |
| `--resume` | off | Continue after the customer id stored in the cursor file. |
| `--cursor-file <path>` | `<log-dir>/cursor.json` | Where the resume cursor is stored. |
| `--batch-size <n>` | `100` | Customers fetched/processed per batch (max 100 = Stripe page size). |
| `--concurrency <n>` | `5` | Customers processed in parallel inside a batch. |
| `--rps <n>` | `25` | Global cap on Stripe requests per second. |
| `--max-retries <n>` | `5` | Retries per request on 429/5xx/network errors. |
| `--max-customers <n>` | unlimited | Stop after N customers. |
| `--log-dir <path>` | `logs` | Where log + CSV report are written. |
| `--log-level <level>` | `info` | `trace|debug|info|warn|error`. |

### Abort and resume

A full scan takes hours, so the position in the customer list is checkpointed:

- After **each completed batch**, the last customer id of that Stripe page is written to
  `logs/cursor.json` (atomically, via temp file + rename).
- `SIGINT`/`SIGTERM` stops the run after the current batch, so the stored cursor matches
  exactly what was processed.
- Rerunning with `--resume` reads that id and passes it as `starting_after` to
  `customers.list`, continuing where the previous run stopped.

```bash
npm run backfill -- --wet            # aborted after a few hours (Ctrl+C)
npm run backfill -- --wet --resume   # continues after the last completed batch
```

Notes:

- The cursor records whether it came from a dry or wet run; resuming a dry cursor as a wet
  run (or vice versa) is refused.
- Cursor tracking is disabled when `--customer-ids` / `--customer-ids-file` is used.
- Customers created *after* a run started are not picked up by a resumed run (the list is
  ordered newest-first, so new customers land before the cursor).
- Cards that failed inside an already-checkpointed batch are not retried by `--resume`; they
  are in the CSV report as `failed` rows, so replay them with `--customer-ids-file`.
- Re-running a range is always safe: only blank card names are written.

### Rate limits

Stripe allows roughly **100 read and 100 write requests/second in live mode** and
**25 requests/second in test mode**. The default `--rps 25` is safe everywhere; for a large
live run `--rps 80` leaves headroom for your production traffic.

Every Stripe call goes through one shared token-bucket limiter. On `429`
(`rate_limit`), `lock_timeout`, 5xx, or connection errors the call is retried with
exponential backoff + jitter, honouring the `Retry-After` header. The Stripe SDK's own
retries are disabled (`maxNetworkRetries: 0`) so all retry behaviour is logged here.

### Output

- Console: pretty log lines.
- File: JSON lines at `logs/<runId>-<dry|wet>.log`.
- CSV report: `logs/<runId>-<dry|wet>-report.csv` with
  `timestamp,customer_id,card_id,brand,last4,new_name,action,error`.

Actions: `updated`, `would_update`, `skipped_card_has_name`, `skipped_no_customer_name`, `failed`.

Exit codes: `0` success, `1` at least one failure, `130` interrupted (SIGINT/SIGTERM stops
after the current batch).

## Scripts

```bash
npm run backfill    # tsx src/index.ts
npm run typecheck   # tsc --noEmit
npm run build       # tsc -> dist/
```
