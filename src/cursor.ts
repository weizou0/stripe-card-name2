import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export type RunMode = 'dry' | 'wet';

export interface CursorState {
  lastCustomerId: string;
  customersProcessed: number;
  mode: RunMode;
  updatedAt: string;
}

/**
 * Reads the cursor written by a previous run. Returns null when the file does
 * not exist yet; throws when it exists but is unusable.
 */
export function readCursor(filePath: string): CursorState | null {
  let raw: string;
  try {
    raw = readFileSync(path.resolve(filePath), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }

  const parsed = JSON.parse(raw) as Partial<CursorState>;
  if (typeof parsed.lastCustomerId !== 'string' || !parsed.lastCustomerId.startsWith('cus_')) {
    throw new Error(`${filePath} does not contain a valid lastCustomerId`);
  }

  return {
    lastCustomerId: parsed.lastCustomerId,
    customersProcessed: typeof parsed.customersProcessed === 'number' ? parsed.customersProcessed : 0,
    mode: parsed.mode === 'wet' ? 'wet' : 'dry',
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '',
  };
}

export class CursorWriter {
  private readonly target: string;

  constructor(
    filePath: string,
    private readonly mode: RunMode,
  ) {
    this.target = path.resolve(filePath);
    mkdirSync(path.dirname(this.target), { recursive: true });
  }

  /** Atomic write so a kill mid-save cannot leave a truncated cursor behind. */
  save(lastCustomerId: string, customersProcessed: number): void {
    const state: CursorState = {
      lastCustomerId,
      customersProcessed,
      mode: this.mode,
      updatedAt: new Date().toISOString(),
    };
    const temp = `${this.target}.tmp`;
    writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    renameSync(temp, this.target);
  }
}
