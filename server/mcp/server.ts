// One MCP server over the shared services: every tool and resource an agent gets.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Services } from '../core/services.ts';
import { registerComponentTools } from './component-tools.ts';
import { registerModuleTools } from './module-tools.ts';
import { registerProposalTools } from './proposal-tools.ts';
import { registerResources } from './resources.ts';
import { registerUnifiedTools } from './unified-tools.ts';
import { registerUpstreamTools } from './upstream-tools.ts';

/** The name this server gives itself to MCP clients. */
const SERVER_NAME = 'symphony';

/** What a client is told on connecting, so an agent knows where to start. */
const INSTRUCTIONS = [
  'Symphony wraps GraphQL APIs (upstreams) and shows React modules written against them on pages.',
  'To write a module: `get_module_contract`, then `list_upstreams` and `get_schema` / `search_schema`, `run_query` to see real data,',
  '`list_components` and `get_component_docs` for the UI, then `submit_module` and resubmit with the returned id until ok is true.',
  'Concepts merge one entity across upstreams into the unified API: `list_concepts`, `save_concept`, `get_wiring`, `get_unified_status`.',
  'To propose one: `propose_concepts`, refine a draft, then `submit_concept` and resubmit with the returned id until ok is true; a person accepts it.',
].join(' ');

/**
 * Makes an MCP server with Symphony's tools and resources.
 *
 * @param services - The shared services.
 * @param version - Symphony's version, for the handshake.
 * @returns The server, not yet connected to a transport.
 */
export function createSymphonyMcpServer(services: Services, version: string): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version }, { instructions: INSTRUCTIONS });
  registerUpstreamTools(server, services);
  registerComponentTools(server, services);
  registerModuleTools(server, services);
  registerUnifiedTools(server, services);
  registerProposalTools(server, services);
  registerResources(server, services);
  return server;
}
