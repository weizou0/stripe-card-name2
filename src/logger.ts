import { mkdirSync } from 'node:fs';
import path from 'node:path';
import pino, { type Logger } from 'pino';
import pretty from 'pino-pretty';

export type { Logger };

export function createLogger(options: { level: string; logFile: string }): Logger {
  mkdirSync(path.dirname(path.resolve(options.logFile)), { recursive: true });

  const consoleStream = pretty({
    colorize: true,
    translateTime: 'SYS:yyyy-mm-dd HH:MM:ss.l',
    ignore: 'pid,hostname',
    singleLine: true,
    sync: true,
  });

  const fileStream = pino.destination({
    dest: path.resolve(options.logFile),
    sync: true,
    mkdir: true,
  });

  return pino(
    { level: options.level, base: undefined },
    pino.multistream([
      { level: options.level as pino.Level, stream: consoleStream },
      { level: options.level as pino.Level, stream: fileStream },
    ]),
  );
}
