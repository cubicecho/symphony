// Runs before anything else at boot, and exits with a sentence when the configuration can't work.
import { databaseUrl, dbConnectTimeoutMs, POSTGRES_URL, port, subscriptionSettings } from './config.ts';
import { errorMessage } from './errors.ts';

const MAX_PORT = 65_535;

/**
 * Finds what is wrong with the environment.
 *
 * @returns One sentence per problem.
 */
function problems(): string[] {
  const found: string[] = [];
  try {
    const value = port();
    const isValid = value > 0 && value <= MAX_PORT;
    if (isValid === false) {
      found.push(`PORT must be between 1 and ${MAX_PORT}.`);
    }
    dbConnectTimeoutMs();
  } catch (error) {
    found.push(errorMessage(error));
  }
  try {
    subscriptionSettings();
  } catch (error) {
    found.push(errorMessage(error));
  }
  const url = databaseUrl();
  const isUsableUrl = url === '' || POSTGRES_URL.test(url);
  if (isUsableUrl === false) {
    found.push('DATABASE_URL must be a postgres:// URL, or empty for the built-in database.');
  }
  return found;
}

const found = problems();
if (found.length > 0) {
  for (const problem of found) {
    console.error(`[config] ${problem}`);
  }
  process.exit(1);
}
