/**
 * Direct Perplexity API integration
 * Uses the Perplexity Sonar API for web search
 */

export interface PerplexityResult {
  content: string;
  sources?: string[];
  model: string;
}

export async function perplexitySearch(query: string, apiKey?: string): Promise<PerplexityResult> {
  const key = apiKey;
  
  if (!key) {
    throw new Error('PERPLEXITY_API_KEY is required');
  }

  try {
    const response = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
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
    
    // #region agent log
    fetch('http://127.0.0.1:7243/ingest/cc739506-e25d-45e2-b543-cb8ae30e3ecd',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'perplexity.ts:perplexitySearch',message:'H1/H2: Perplexity API response',data:{hasCitations:!!data.citations,citationsCount:data.citations?.length||0,citationsSample:data.citations?.slice(0,5)||[],contentLength:data.choices?.[0]?.message?.content?.length||0},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H1,H2'})}).catch(()=>{});
    // #endregion
    
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









