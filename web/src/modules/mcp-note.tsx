import { Alert } from '@/components/ui/alert';
import { CopyButton } from '@/components/ui/copy-button';
import { Bot } from '@/components/ui/icons';

/** The path the server's MCP door is at. */
const MCP_PATH = '/mcp';

/** Tells people that agents can write modules too, and where to point them. */
export function McpNote() {
  const url = `${window.location.origin}${MCP_PATH}`;
  return (
    <Alert
      variant="info"
      iconSlot={<Bot />}
      title="Agents can write modules too"
      description={`Point an agent at Symphony's MCP server, ${url}. It can read each upstream's schema, try queries, and submit modules, which then show up here.`}
      actionSlot={<CopyButton value={url} label="Copy MCP address" size="sm" variant="outline" />}
    />
  );
}
