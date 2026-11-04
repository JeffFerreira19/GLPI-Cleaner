type Level = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';

function log(level: Level, message: string, meta?: unknown): void {
  const line = `[${new Date().toISOString()}] [${level}] ${message}`;
  const extra = meta === undefined ? '' : ` ${JSON.stringify(meta)}`;
  if (level === 'ERROR') console.error(line + extra);
  else if (level === 'WARN') console.warn(line + extra);
  else console.log(line + extra);
}

export const logger = {
  info: (m: string, meta?: unknown) => log('INFO', m, meta),
  warn: (m: string, meta?: unknown) => log('WARN', m, meta),
  error: (m: string, meta?: unknown) => log('ERROR', m, meta),
  debug: (m: string, meta?: unknown) => {
    if (process.env.LOG_LEVEL === 'debug') log('DEBUG', m, meta);
  },
};
