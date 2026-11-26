// Secret references in an upstream's header values: `Bearer ${env:SYMPHONY_SHOP_TOKEN}`. The database and
// the API only ever hold the reference; it is replaced here, when a request is about to be sent, and what
// it resolved to is kept so every message that leaves a request can be scrubbed of it.
//
// A reference must name a variable starting with `secretEnvPrefix`, so a header can't send any variable
// of the server's environment to an address of someone's choosing.
import { UPSTREAM_DEFAULTS } from '../core/defaults.ts';
import { upstreamFailed } from '../core/errors.ts';

/** `${env:NAME}`. */
const SECRET_REFERENCE = /\$\{env:([^}]+)\}/g;
/** What stands in for a secret in a message. */
const REDACTED = '[secret]';

/** Fills in secret references, remembering what they resolved to. */
export interface SecretResolver {
  /**
   * Replaces the references in a text.
   *
   * @param text - The text as stored.
   * @returns The text with each reference replaced by the variable's value.
   * @throws UPSTREAM_FAILED naming the reference (never a value) when the variable is unset or not allowed.
   */
  resolve(text: string): string;
  /**
   * Takes every secret this resolver filled in out of a message.
   *
   * @param message - A message about the request.
   * @returns The message with each secret replaced by `[secret]`.
   */
  redact(message: string): string;
}

/**
 * Builds a resolver for one request.
 *
 * @param env - The environment, as `process.env`.
 * @param [envPrefix] - What a referenced variable's name must start with.
 * @returns The resolver.
 */
export function createSecretResolver(
  env: Readonly<Record<string, string | undefined>>,
  envPrefix: string = UPSTREAM_DEFAULTS.secretEnvPrefix,
): SecretResolver {
  const resolved: string[] = [];

  /**
   * Reads one variable.
   *
   * @param name - The variable's name.
   * @returns Its value.
   */
  const read = (name: string): string => {
    if (name.startsWith(envPrefix) === false) {
      throw upstreamFailed(
        `The header secret ${name} must be named ${envPrefix}…, so headers can't read other variables.`,
      );
    }
    const value = env[name] ?? '';
    if (value === '') {
      throw upstreamFailed(`The environment variable ${name} is not set on the Symphony server.`);
    }
    resolved.push(value);
    return value;
  };

  return {
    resolve: (text) => text.replace(SECRET_REFERENCE, (_reference, name: string) => read(name.trim())),
    redact: (message) => resolved.reduce((scrubbed, secret) => scrubbed.replaceAll(secret, REDACTED), message),
  };
}
