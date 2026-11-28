// GraphQL APIs on the LAN, offered as upstreams. The watcher (@cubicecho/graphql-mdns-discovery) finds `_graphql._tcp`
// hosts and reads their services documents; this keeps what it found, says where each stands against the stored
// upstreams, adds one when the operator asks, and moves a linked upstream's URL when its API moves.
import type { GraphqlServiceWatchHandlers, LanGraphqlService } from '@cubicecho/graphql-mdns-discovery/mdns';
import { badInput, conflict, errorMessage, notFound } from '../core/errors.ts';
import {
  type DiscoveredUpstream,
  DiscoveredUpstreamState,
  type LanUpstreamService,
  type Upstream,
  type UpstreamService,
} from '../core/services.ts';

/** The `_meta` key a Symphony puts on the API it advertises; Symphony never offers another Symphony's unified API. */
export const SYMPHONY_ROLE_META = 'io.github.cubicecho.symphony/role';

/** A running watch, as the service needs it. */
export interface LanWatch {
  stop: () => Promise<void>;
}

/** Starts watching the LAN; `watchGraphqlServices`, or a fake in tests. */
export type StartLanWatch = (handlers: GraphqlServiceWatchHandlers) => Promise<LanWatch>;

/** What the service is built from. */
export interface LanUpstreamDeps {
  /** The stored upstreams (not the built-in one). */
  upstreams: UpstreamService;
  /** Whether to watch at all; `lanDiscover()`. */
  isWanted: () => boolean;
  /** Starts the watch. Default: `watchGraphqlServices`, loaded only when wanted, since it needs bonjour-service. */
  startWatch?: StartLanWatch;
  /** Where to say what happened. */
  log?: (message: string) => void;
}

/** The service, and the boot-time controls that the shared `LanUpstreamService` interface leaves out. */
export interface LanUpstreams extends LanUpstreamService {
  /** Starts watching, when wanted. A failure to start is logged and leaves discovery off. */
  start(): Promise<void>;
  /** Stops watching. */
  stop(): Promise<void>;
}

/** What the service remembers about one found API. */
interface Sighting {
  found: LanGraphqlService;
  isOnline: boolean;
}

/**
 * Loads the real watcher.
 *
 * @param handlers - Told about APIs coming and going.
 * @returns The watch.
 */
const watchLan: StartLanWatch = async (handlers) => {
  const { watchGraphqlServices } = await import('@cubicecho/graphql-mdns-discovery/mdns');
  return watchGraphqlServices(handlers);
};

/**
 * Whether a found API is another Symphony's own, which must not be wrapped (it would wrap its upstreams twice).
 *
 * @param found - What the watcher reported.
 * @returns True to skip it.
 */
function isSymphony(found: LanGraphqlService): boolean {
  return found.service._meta?.[SYMPHONY_ROLE_META] !== undefined;
}

/**
 * Builds the service. It watches nothing until `start`.
 *
 * @param deps - The upstreams, the setting, and optionally the watcher and the log.
 * @returns The service.
 */
export function createLanUpstreamService(deps: LanUpstreamDeps): LanUpstreams {
  const startWatch = deps.startWatch ?? watchLan;
  const log = deps.log ?? ((message: string) => console.log(`[discovery] ${message}`));
  const sightings = new Map<string, Sighting>();
  let watch: LanWatch | null = null;
  let isWatching = false;

  /**
   * Finds the stored upstream added from a key.
   *
   * @param key - The discovery key.
   * @returns The upstream, or undefined.
   */
  const linkedTo = async (key: string): Promise<Upstream | undefined> =>
    (await deps.upstreams.list()).find((upstream) => upstream.discoveredKey === key);

  /**
   * Moves a linked upstream to the API's new URL; its name and headers stay the operator's.
   *
   * @param found - The API as it was just read.
   */
  const follow = async (found: LanGraphqlService): Promise<void> => {
    const linked = await linkedTo(found.key);
    const url = found.connection.url;
    const hasMoved = linked !== undefined && linked.url !== url;
    if (linked === undefined || hasMoved === false) {
      return;
    }
    try {
      await deps.upstreams.update(linked.id, {
        name: linked.name,
        url,
        headers: linked.headers,
        discoveredKey: found.key,
      });
      log(`${linked.name} moved to ${url}`);
    } catch (error) {
      log(`${linked.name} moved to ${url}, but could not be updated: ${errorMessage(error)}`);
    }
  };

  const handlers: GraphqlServiceWatchHandlers = {
    onUp: (found) => {
      if (isSymphony(found)) {
        return;
      }
      sightings.set(found.key, { found, isOnline: true });
      void follow(found);
    },
    onDown: (found) => {
      const sighting = sightings.get(found.key);
      if (sighting) {
        sighting.isOnline = false;
      }
    },
    onError: (error) => log(error.message),
  };

  /**
   * Where one found API stands.
   *
   * @param sighting - What was found, and whether it is still there.
   * @param linked - The upstream added from it, if any.
   * @returns The state.
   */
  const stateOf = (sighting: Sighting, linked: Upstream | undefined): DiscoveredUpstreamState => {
    if (sighting.isOnline === false) {
      return DiscoveredUpstreamState.Offline;
    }
    if (linked) {
      return DiscoveredUpstreamState.Linked;
    }
    const needsHeaders = sighting.found.connection.requiredHeaders.length > 0;
    return needsHeaders ? DiscoveredUpstreamState.NeedsToken : DiscoveredUpstreamState.New;
  };

  return {
    enabled: () => isWatching,

    list: async () => {
      const stored = await deps.upstreams.list();
      return [...sightings.values()].map((sighting): DiscoveredUpstream => {
        const { key, host, service, connection } = sighting.found;
        const linked = stored.find((upstream) => upstream.discoveredKey === key);
        return {
          key,
          serviceName: service.name,
          title: service.title ?? null,
          description: service.description ?? null,
          url: connection.url,
          requiredHeaders: connection.requiredHeaders,
          host: host.name,
          state: stateOf(sighting, linked),
          upstreamId: linked?.id ?? null,
        };
      });
    },

    add: async ({ key, name, headers }) => {
      const sighting = sightings.get(key);
      if (sighting === undefined) {
        throw notFound(`Nothing called "${key}" has been found on the network.`);
      }
      if (sighting.isOnline === false) {
        throw badInput(`${key} has left the network; add it when it is back.`);
      }
      const linked = await linkedTo(key);
      if (linked) {
        throw conflict(`${key} is already the upstream ${linked.name}.`);
      }
      const given = new Set(headers.filter((header) => header.value.trim() !== '').map((header) => header.name.trim()));
      const missing = sighting.found.connection.requiredHeaders.filter((header) => given.has(header) === false);
      if (missing.length > 0) {
        throw badInput(`${key} needs ${missing.join(', ')}: give a value for each.`);
      }
      return deps.upstreams.add({ name, url: sighting.found.connection.url, headers, discoveredKey: key });
    },

    start: async () => {
      const isWanted = deps.isWanted();
      if (isWanted === false || watch !== null) {
        return;
      }
      try {
        watch = await startWatch(handlers);
        isWatching = true;
        log('watching the network for GraphQL APIs (_graphql._tcp)');
      } catch (error) {
        log(`could not watch the network: ${errorMessage(error)}`);
      }
    },

    stop: async () => {
      const stopping = watch;
      watch = null;
      isWatching = false;
      await stopping?.stop();
    },
  };
}
