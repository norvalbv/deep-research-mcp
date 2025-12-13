/**
 * Context7 MCP Client
 * Spawns Context7 MCP server as a subprocess for library documentation lookup
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export interface Context7Client {
  client: Client;
  close: () => Promise<void>;
}

/**
 * Create and connect to Context7 MCP server subprocess
 */
export async function createContext7Client(): Promise<Context7Client> {
  console.error('[Context7 Client] Spawning Context7 MCP subprocess...');

  const transport = new StdioClientTransport({
    command: 'npx',
    args: [
      '-y',
      '@smithery/cli@latest',
      'run',
      '@upstash/context7-mcp',
      '--key',
      'e3c9b4d4-fafe-464d-a1bf-8f520bfd5817',
    ],
  });

  const client = new Client({
    name: 'research-context7-client',
    version: '1.0.0',
  });

  await client.connect(transport);
  console.error('[Context7 Client] Connected successfully');

  return {
    client,
    close: async () => {
      await client.close();
      console.error('[Context7 Client] Closed');
    },
  };
}

/**
 * Resolve library ID from library name
 */
export async function resolveLibraryId(
  client: Client,
  libraryName: string
): Promise<string | null> {
  try {
    const result = await client.callTool({
      name: 'resolve-library-id',
      arguments: {
        libraryName,
      },
    });

    // Parse the result to extract library ID
    const content = result.content as any[];
    const textContent = content
      .filter((c: any) => c.type === 'text')
      .map((c: any) => c.text)
      .join('\n');

    // Extract the first library ID from the response
    const idMatch = textContent.match(/Context7-compatible library ID: (\/[^\s]+)/);
    return idMatch ? idMatch[1] : null;
  } catch (error) {
    console.error('[Context7 Resolve] Error:', error);
    return null;
  }
}

/**
 * Get library documentation
 */
export async function getLibraryDocs(
  client: Client,
  libraryId: string,
  topic?: string
): Promise<string> {
  try {
    const result = await client.callTool({
      name: 'get-library-docs',
      arguments: {
        context7CompatibleLibraryID: libraryId,
        topic: topic || '',
        tokens: 1000,
      },
    });

    const content = result.content as any[];
    const textContent = content
      .filter((c: any) => c.type === 'text')
      .map((c: any) => c.text)
      .join('\n');

    return textContent;
  } catch (error) {
    console.error('[Context7 Get Docs] Error:', error);
    throw error;
  }
}

/**
 * Search for library documentation by name and optional topic
 */
export async function searchLibraryDocs(
  client: Client,
  libraryName: string,
  topic?: string
): Promise<string> {
  // First resolve the library ID
  const libraryId = await resolveLibraryId(client, libraryName);
  
  if (!libraryId) {
    return `Could not find library: ${libraryName}`;
  }

  // Then get the docs
  return await getLibraryDocs(client, libraryId, topic);
}

