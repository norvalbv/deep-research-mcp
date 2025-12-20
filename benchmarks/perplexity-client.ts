/**
 * Perplexity API Client
 * 
 * Simple wrapper for Perplexity's chat completions API.
 * Uses the 'sonar' model optimized for search/research queries.
 */

export interface PerplexityResponse {
  content: string;
  citations?: string[];
}

interface PerplexityAPIResponse {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
  citations?: string[];
}

export async function queryPerplexity(
  query: string,
  apiKey: string,
  options: { model?: string; temperature?: number } = {}
): Promise<PerplexityResponse> {
  const { model = 'sonar', temperature = 0.1 } = options;
  
  const response = await fetch('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'user',
          content: query,
        },
      ],
      temperature,
    }),
  });
  
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Perplexity API error (${response.status}): ${error}`);
  }
  
  const data = await response.json() as PerplexityAPIResponse;
  
  return {
    content: data.choices[0]?.message?.content || '',
    citations: data.citations,
  };
}


