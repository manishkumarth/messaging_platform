const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

/**
 * Tiny structured JSON logger (one line per entry).
 * Callers pass explicit fields only; message bodies, phone numbers and secrets
 * are never logged anywhere in this codebase.
 */
export function createLogger({ level = 'info', write = (line) => process.stdout.write(line + '\n') } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;

  const log = (lvl, msg, fields = {}) => {
    if (LEVELS[lvl] < threshold) return;
    write(JSON.stringify({ time: new Date().toISOString(), level: lvl, msg, ...fields }));
  };

  return {
    debug: (msg, fields) => log('debug', msg, fields),
    info: (msg, fields) => log('info', msg, fields),
    warn: (msg, fields) => log('warn', msg, fields),
    error: (msg, fields) => log('error', msg, fields),
  };
}
