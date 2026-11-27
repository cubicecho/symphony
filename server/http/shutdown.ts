import type { Server } from 'node:http';
import { HTTP_DEFAULTS, type HttpSettings } from '../core/defaults.ts';
import { errorMessage } from '../core/errors.ts';
import { MS_PER_SECOND } from '../core/wire.ts';

const STOP_SIGNALS = ['SIGTERM', 'SIGINT'] as const;

/** What runs around the HTTP drain. */
export interface ShutdownSteps {
  /** Runs first: stop timers and anything that starts new work. */
  before?: () => void | Promise<void>;
  /** Runs at the drain deadline, and is awaited before open connections are cut: end long-lived streams cleanly. */
  cutOff?: () => void | Promise<void>;
  /** Runs once no request is in flight: close what requests were using. */
  after?: () => void | Promise<void>;
}

/**
 * Stops the server cleanly on SIGTERM or SIGINT. A second signal exits at once.
 *
 * @param server - The listening server.
 * @param [steps] - What to run before and after the drain.
 * @param [overrides] - HTTP settings to replace.
 *
 * @remarks
 * Open connections, an SSE subscription among them, are cut off after `drainSeconds`. `cutOff` runs and is awaited
 * first, so the proxy closes its upstream streams and ends their responses; the process exits 1 at
 * `shutdownDeadlineSeconds` whatever is still pending.
 */
export function stopOnSignals(server: Server, steps: ShutdownSteps = {}, overrides: Partial<HttpSettings> = {}): void {
  const { drainSeconds, shutdownDeadlineSeconds } = { ...HTTP_DEFAULTS, ...overrides };
  let isStopping = false;

  const stop = async (signal: string): Promise<void> => {
    if (isStopping) {
      console.warn(`[shutdown] second ${signal}, exiting now`);
      process.exit(1);
    }
    isStopping = true;
    console.log(`[shutdown] ${signal} received, draining`);
    const deadline = setTimeout(() => {
      console.error('[shutdown] deadline passed, exiting');
      process.exit(1);
    }, shutdownDeadlineSeconds * MS_PER_SECOND);
    deadline.unref();
    try {
      await steps.before?.();
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeIdleConnections();
      const cutOff = setTimeout(async () => {
        try {
          await steps.cutOff?.();
        } catch (error) {
          console.error(`[shutdown] ${errorMessage(error)}`);
        }
        server.closeAllConnections();
      }, drainSeconds * MS_PER_SECOND);
      await closed;
      clearTimeout(cutOff);
      await steps.after?.();
      process.exit(0);
    } catch (error) {
      console.error(`[shutdown] ${errorMessage(error)}`);
      process.exit(1);
    }
  };

  for (const signal of STOP_SIGNALS) {
    process.on(signal, () => void stop(signal));
  }
}
