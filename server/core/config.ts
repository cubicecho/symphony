// The environment, read in one place. Every getter falls back to a group in defaults.ts.
import { readFileSync } from 'node:fs';
import { DATABASE_DEFAULTS, DISCOVERY_DEFAULTS, HTTP_DEFAULTS, STORE_DEFAULTS } from './defaults.ts';

/** A postgres:// (or postgresql://) URL. Anything else in DATABASE_URL is refused by preflight. */
export const POSTGRES_URL = /^postgres(ql)?:\/\//;

/**
 * Reads a whole-number environment variable.
 *
 * @param raw - The variable's value.
 * @param fallback - Used when it is unset or empty.
 * @returns The number.
 * @throws When it is set but is not a whole number.
 */
function envInteger(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const value = Number(raw);
  if (Number.isInteger(value) === false) {
    throw new Error(`Expected a whole number, got "${raw}".`);
  }
  return value;
}

/**
 * Reads a true/false environment variable.
 *
 * @param raw - The variable's value.
 * @param fallback - Used when it is unset or empty.
 * @returns The flag.
 * @throws When it is set but is neither `true` nor `false`.
 */
function envBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const isKnown = raw === 'true' || raw === 'false';
  if (isKnown === false) {
    throw new Error(`Expected true or false, got "${raw}".`);
  }
  return raw === 'true';
}

/**
 * The port to listen on.
 *
 * @returns `PORT`, or `HTTP_DEFAULTS.port`.
 */
export function port(): number {
  return envInteger(process.env.PORT, HTTP_DEFAULTS.port);
}

/**
 * The address to listen on.
 *
 * @returns `HOST`, or `HTTP_DEFAULTS.host`.
 */
export function host(): string {
  return process.env.HOST || HTTP_DEFAULTS.host;
}

/**
 * Where the built-in database lives.
 *
 * @returns `DATA_DIR`, or `STORE_DEFAULTS.dataDir`.
 */
export function dataDir(): string {
  return process.env.DATA_DIR || STORE_DEFAULTS.dataDir;
}

/**
 * The Postgres server, when one is used.
 *
 * @returns `DATABASE_URL`, or empty for the built-in PGlite.
 */
export function databaseUrl(): string {
  return process.env.DATABASE_URL ?? '';
}

/**
 * How long boot waits for Postgres.
 *
 * @returns `DB_CONNECT_TIMEOUT_MS`, or `DATABASE_DEFAULTS.connectTimeoutMs`.
 */
export function dbConnectTimeoutMs(): number {
  return envInteger(process.env.DB_CONNECT_TIMEOUT_MS, DATABASE_DEFAULTS.connectTimeoutMs);
}

/**
 * The key an MCP client must send in `x-api-key`.
 *
 * @returns `SYMPHONY_MCP_KEY`, or empty, which shuts /mcp.
 */
export function mcpKey(): string {
  return process.env.SYMPHONY_MCP_KEY ?? '';
}

/**
 * Whether the host is announced on the LAN over mDNS.
 *
 * @returns `LAN_ADVERTISE`, or `DISCOVERY_DEFAULTS.lanAdvertise`.
 */
export function lanAdvertise(): boolean {
  return envBoolean(process.env.LAN_ADVERTISE, DISCOVERY_DEFAULTS.lanAdvertise);
}

/**
 * Express's `trust proxy`.
 *
 * @returns `TRUST_PROXY` read as a boolean, a hop count or a list, or `HTTP_DEFAULTS.trustProxy`.
 */
export function trustProxy(): boolean | number | string {
  const raw = process.env.TRUST_PROXY ?? '';
  if (raw === '') {
    return HTTP_DEFAULTS.trustProxy;
  }
  if (raw === 'true' || raw === 'false') {
    return raw === 'true';
  }
  const hops = Number(raw);
  return Number.isInteger(hops) ? hops : raw;
}

/**
 * Whether this is the production build.
 *
 * @returns True when `NODE_ENV` is `production`.
 */
export function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

/**
 * The version in package.json, for /healthz and the MCP handshake.
 *
 * @returns The version string.
 */
export function version(): string {
  const file = new URL('../../package.json', import.meta.url);
  const pkg: { version?: unknown } = JSON.parse(readFileSync(file, 'utf-8'));
  return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
}
