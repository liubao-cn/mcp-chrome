import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { setupTools } from './register-tools';

/**
 * Create one MCP Server per client session. The SDK refuses to connect an already-connected
 * Server to a second transport, so a shared singleton breaks every client after the first.
 */
export const createMcpServer = () => {
  const server = new Server(
    {
      name: 'ChromeMcpServer',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  setupTools(server);
  return server;
};
