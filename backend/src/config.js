import 'dotenv/config';

const int = (value, fallback) => {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
};

export function loadConfig(env = process.env) {
  return {
    port: int(env.PORT, 3000),
    databasePath: env.DATABASE_PATH || './data/app.db',
    webhookSecret: env.WEBHOOK_SECRET || '',
    logLevel: env.LOG_LEVEL || 'info',
    maxTextLength: int(env.MAX_TEXT_LENGTH, 4096),
  };
}
