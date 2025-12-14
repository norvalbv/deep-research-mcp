/**
 * arXiv MCP Client
 * Spawns arXiv MCP server as a subprocess for read_paper / download_paper
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface ArxivClient {
  client: Client;
  close: () => Promise<void>;
}

export async function createArxivClient(storagePath?: string): Promise<ArxivClient> {
  console.error('[arXiv Client] Spawning arXiv MCP subprocess...');

  // Default to home directory if not provided
  const path = storagePath || join(homedir(), '.arxiv-mcp');

  const transport = new StdioClientTransport({
    command: 'uv',
    args: [
      'tool',
      'run',
      'arxiv-mcp-server',
      '--storage-path',
      path,
    ],
  });

  const client = new Client({
    name: 'research-arxiv-client',
    version: '1.0.0',
  });

  await client.connect(transport);
  console.error('[arXiv Client] Connected successfully');

  return {
    client,
    close: async () => {
      await client.close();
      console.error('[arXiv Client] Closed');
    },
  };
}

