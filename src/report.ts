import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import path from 'node:path';

export type CardAction =
  | 'updated'
  | 'would_update'
  | 'skipped_card_has_name'
  | 'skipped_no_customer_name'
  | 'failed';

export interface ReportRow {
  customerId: string;
  cardId: string;
  brand: string;
  last4: string;
  newName: string;
  action: CardAction;
  error?: string;
}

const COLUMNS = [
  'timestamp',
  'customer_id',
  'card_id',
  'brand',
  'last4',
  'new_name',
  'action',
  'error',
] as const;

function escapeCsv(value: string): string {
  if (value === '') return '';
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export class ReportWriter {
  private readonly stream: WriteStream;

  constructor(private readonly filePath: string) {
    mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
    this.stream = createWriteStream(path.resolve(filePath), { flags: 'a' });
    this.stream.write(`${COLUMNS.join(',')}\n`);
  }

  get path(): string {
    return this.filePath;
  }

  write(row: ReportRow): void {
    const cells = [
      new Date().toISOString(),
      row.customerId,
      row.cardId,
      row.brand,
      row.last4,
      row.newName,
      row.action,
      row.error ?? '',
    ];
    this.stream.write(`${cells.map(escapeCsv).join(',')}\n`);
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.stream.once('error', reject);
      this.stream.end(() => resolve());
    });
  }
}
