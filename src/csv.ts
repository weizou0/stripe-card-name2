import { readFileSync } from 'node:fs';

export interface CsvRow {
  customerId: string;
  fullName: string;
  raw: Record<string, string>;
}

function normalizeHeader(header: string): string {
  return header
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '');
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (inQuotes) {
      if (char === '"') {
        if (line[index + 1] === '"') {
          current += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      fields.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields;
}

function findColumnIndex(headers: string[], patterns: string[]): number {
  const normalizedHeaders = headers.map(normalizeHeader);
  for (const pattern of patterns) {
    const index = normalizedHeaders.indexOf(normalizeHeader(pattern));
    if (index !== -1) return index;
  }
  return -1;
}

export function readCustomerNameCsv(filePath: string): CsvRow[] {
  const contents = readFileSync(filePath, 'utf8');
  const lines = contents.split(/\r?\n/).filter((line) => line.trim() !== '');
  if (lines.length === 0) return [];

  const headers = parseCsvLine(lines[0]!);
  const customerIdIndex = findColumnIndex(headers, [
    'customer_id',
  ]);
  const fullNameIndex = findColumnIndex(headers, [
    'full_customer_name',
  ]);

  if (customerIdIndex === -1) {
    throw new Error(`${filePath}: missing customer_id column`);
  }
  if (fullNameIndex === -1) {
    throw new Error(`${filePath}: missing fullname/full_customer_name column`);
  }

  const rows: CsvRow[] = [];
  for (let index = 1; index < lines.length; index += 1) {
    const fields = parseCsvLine(lines[index]!);
    const customerId = fields[customerIdIndex]?.trim();
    const fullName = fields[fullNameIndex]?.trim();
    if (!customerId || !fullName) continue;

    rows.push({
      customerId,
      fullName,
      raw: Object.fromEntries(headers.map((header, idx) => [header, fields[idx] ?? ''])),
    });
  }
  return rows;
}
