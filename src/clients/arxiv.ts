/**
 * arXiv MCP Client
 * Spawns arXiv MCP server as a subprocess for read_paper / download_paper
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { access } from 'fs/promises';
import { constants } from 'fs';

export interface ArxivClient {
  client: Client;
  close: () => Promise<void>;
}

/**
 * Discover the path to the uv binary.
 * Checks in order:
 * 1. UV_BINARY_PATH environment variable
 * 2. Common installation paths
 * 3. System PATH (via 'uv' command)
 */
async function discoverUvPath(): Promise<string> {
  // Check environment variable first
  const envPath = process.env.UV_BINARY_PATH;
  if (envPath) {
    try {
      await access(envPath, constants.F_OK);
      console.error(`[arXiv Client] Using uv from UV_BINARY_PATH: ${envPath}`);
      return envPath;
    } catch {
      console.error(`[arXiv Client] UV_BINARY_PATH set but file not found: ${envPath}`);
    }
  }

  // Check common installation paths
  const commonPaths = [
    '/opt/homebrew/bin/uv', // Apple Silicon Homebrew
    '/usr/local/bin/uv',    // Intel Mac Homebrew / Linux
    join(homedir(), '.local/bin/uv'), // User-local installation
    join(homedir(), '.cargo/bin/uv'), // Cargo installation
  ];

  for (const path of commonPaths) {
    try {
      await access(path, constants.F_OK);
      console.error(`[arXiv Client] Found uv at: ${path}`);
      return path;
    } catch {
      // Continue to next path
    }
  }

  // Fallback to 'uv' command (relies on PATH)
  console.error('[arXiv Client] Using uv from PATH');
  return 'uv';
}

export async function createArxivClient(storagePath?: string): Promise<ArxivClient> {
  console.error('[arXiv Client] Spawning arXiv MCP subprocess...');

  try {
    // Default to home directory if not provided
    const path = storagePath || join(homedir(), '.arxiv-mcp');

    // Discover uv binary path
    const uvPath = await discoverUvPath();

    const transport = new StdioClientTransport({
      command: uvPath,
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
  } catch (error: any) {
    const errorMessage = error.message || String(error);
    const isPathError = errorMessage.includes('ENOENT') || 
                       errorMessage.includes('spawn') ||
                       errorMessage.includes('not found');

    if (isPathError) {
      const helpfulError = new Error(
        `Failed to spawn arxiv-mcp-server: uv binary not found.\n` +
        `\n` +
        `Solutions:\n` +
        `1. Install uv: curl -LsSf https://astral.sh/uv/install.sh | sh\n` +
        `2. Set UV_BINARY_PATH environment variable in your MCP config:\n` +
        `   "env": { "UV_BINARY_PATH": "/opt/homebrew/bin/uv" }\n` +
        `3. Ensure uv is in your PATH (restricted environments may need explicit path)\n` +
        `\n` +
        `Original error: ${errorMessage}`
      );
      console.error(`[arXiv Client] ${helpfulError.message}`);
      throw helpfulError;
    }

    // Re-throw other errors with context
    console.error(`[arXiv Client] Connection failed: ${errorMessage}`);
    throw error;
  }
}

