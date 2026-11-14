import { loadConfig } from '../config.js';
import { openDatabase } from './index.js';
import { runMigrations } from './migrate.js';

const config = loadConfig();
const db = openDatabase(config.databasePath, { migrate: false });
const ran = runMigrations(db);

console.log(
  ran.length
    ? `Applied ${ran.length} migration(s): ${ran.join(', ')}`
    : 'Database is up to date, nothing to apply.',
);
console.log(`Database: ${config.databasePath}`);
db.close();
