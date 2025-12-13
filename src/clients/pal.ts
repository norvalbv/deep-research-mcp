/**
 * PAL MCP Client
 * Spawns PAL MCP server as a subprocess for deep thinking, consensus, and challenge
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export interface PalClient {
  client: Client;
  close: () => Promise<void>;
}

/**
 * Create and connect to PAL MCP server subprocess
 */
export async function createPalClient(): Promise<PalClient> {
  console.error('[PAL Client] Spawning PAL MCP subprocess...');

  const transport = new StdioClientTransport({
    command: 'bash',
    args: [
      '-c',
      'for p in $(which uvx 2>/dev/null) $HOME/.local/bin/uvx /opt/homebrew/bin/uvx /usr/local/bin/uvx uvx; do [ -x "$p" ] && exec "$p" --from git+https://github.com/BeehiveInnovations/pal-mcp-server.git pal-mcp-server; done; echo "uvx not found" >&2; exit 1',
    ],
    env: {
      PATH: '/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin:~/.local/bin',
      GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
      OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
      DEFAULT_MODEL: 'auto',
    },
  });

  const client = new Client(
    {
      name: 'research-pal-client',
      version: '1.0.0',
    },
    {
      capabilities: {
        sampling: {},
      },
    }
  );

  await client.connect(transport);
  console.error('[PAL Client] Connected successfully');

  return {
    client,
    close: async () => {
      await client.close();
      console.error('[PAL Client] Closed');
    },
  };
}

/**
 * Use PAL chat for deep thinking
 */
export async function palChat(
  client: Client,
  prompt: string,
  model: string = 'gemini-2.5-flash'
): Promise<string> {
  try {
    const result = await client.callTool({
      name: 'chat',
      arguments: {
        prompt,
        model,
        working_directory_absolute_path: process.cwd(),
      },
    });

    // Extract text content from result
    const textContent = (result.content as Array<{ type: string; text: string }>)
      .filter((c: any) => c.type === 'text')
      .map((c: any) => c.text)
      .join('\n');

    return textContent;
  } catch (error) {
    console.error('[PAL Chat] Error:', error);
    throw error;
  }
}

/**
 * Use PAL challenge to validate conclusions
 */
export async function palChallenge(
  client: Client,
  statement: string
): Promise<string> {
  try {
    const result = await client.callTool({
      name: 'challenge',
      arguments: {
        prompt: statement,
      },
    });

    const textContent = (result.content as Array<{ type: string; text: string }>)
      .filter((c: any) => c.type === 'text')
      .map((c: any) => c.text)
      .join('\n');

    return textContent;
  } catch (error) {
    console.error('[PAL Challenge] Error:', error);
    throw error;
  }
}

/**
 * Use PAL consensus for multi-model agreement
 */
export async function palConsensus(
  client: Client,
  prompt: string,
  models: Array<{ model: string; stance?: 'for' | 'against' | 'neutral' }>
): Promise<string> {
  try {
    const result = await client.callTool({
      name: 'consensus',
      arguments: {
        step: prompt,
        step_number: 1,
        total_steps: 1,
        next_step_required: false,
        findings: 'Seeking multi-model consensus on research findings',
        models,
      },
    });

    const textContent = (result.content as Array<{ type: string; text: string }>)
      .filter((c: any) => c.type === 'text')
      .map((c: any) => c.text)
      .join('\n');

    return textContent;
  } catch (error) {
    console.error('[PAL Consensus] Error:', error);
    throw error;
  }
}

