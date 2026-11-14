import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { createMetrics } from './metrics.js';
import { openDatabase } from './db/index.js';
import { createApp } from './app.js';

const config = loadConfig();
const logger = createLogger({ level: config.logLevel });
const metrics = createMetrics();

// Migrations run automatically on start so a fresh checkout works with `npm start`.
const db = openDatabase(config.databasePath);
const app = createApp({ db, config, logger, metrics });

if (!config.webhookSecret) {
  logger.warn('WEBHOOK_SECRET is empty: webhook authentication is disabled');
}

const server = app.listen(config.port, () => {
  logger.info('server listening', { port: config.port });
});

function shutdown(signal) {
  logger.info('shutting down', { signal });
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
