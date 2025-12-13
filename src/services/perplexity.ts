/**
 * Direct Perplexity API integration
 * Uses the Perplexity Sonar API for web search
 */

export interface PerplexityResult {
  content: string;
  sources?: string[];
  model: string;
}

export async function perplexitySearch(query: string): Promise<PerplexityResult> {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  
  if (!apiKey) {
    throw new Error('PERPLEXITY_API_KEY environment variable is required');
  }

  try {
    const response = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'sonar',
        messages: [
          {
            role: 'system',
            content: 'You are a helpful research assistant. Provide comprehensive, accurate information with sources.',
          },
          {
            role: 'user',
            content: query,
          },
        ],
        temperature: 0.2,
        max_tokens: 3000,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Perplexity API error (${response.status}): ${errorText}`);
    }

    const data = await response.json();
    
    return {
      content: data.choices?.[0]?.message?.content || 'No response from Perplexity',
      sources: data.citations || [],
      model: data.model || 'sonar',
    };
  } catch (error) {
    console.error('[Perplexity] Error:', error);
    throw error;
  }
}









