export type LLMProvider = 'gemini' | 'openai';

export interface LLMConfig {
  provider: LLMProvider;
  model: string;
  apiKey: string;
  timeout?: number;  // Timeout in milliseconds (default: 30000)
  maxOutputTokens?: number;  // Max output tokens (default: 10000)
}

export interface LLMResponse {
  model: string;
  content: string;
  error?: string;
}

export interface LLMCallOptions {
  /** If true, throw error instead of returning empty content on failure */
  critical?: boolean;
  /** Minimum content length to consider response valid (default: 10) */
  minContentLength?: number;
}

export class LLMError extends Error {
  constructor(
    message: string,
    public readonly model: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'LLMError';
  }
}

/**
 * Call Gemini API directly using native fetch
 */
async function callGemini(
  prompt: string,
  model: string,
  apiKey: string,
  timeout: number = 30000,
  maxOutputTokens: number = 10000
): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  
  // #region agent log
  fetch('http://127.0.0.1:7243/ingest/cc739506-e25d-45e2-b543-cb8ae30e3ecd',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'llm.ts:callGemini',message:'Calling Gemini API',data:{promptLength:prompt.length,timeout,maxOutputTokens,model},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'F,H'})}).catch(()=>{});
  // #endregion
  
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.7, maxOutputTokens },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Gemini API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const finishReason = data.candidates?.[0]?.finishReason;
    
    // #region agent log
    fetch('http://127.0.0.1:7243/ingest/cc739506-e25d-45e2-b543-cb8ae30e3ecd',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'llm.ts:callGemini:response',message:'Gemini response received',data:{textLength:text.length,finishReason,hasText:!!text},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'F,G'})}).catch(()=>{});
    // #endregion
    
    return text;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Call OpenAI API directly using native fetch
 */
async function callOpenAI(
  prompt: string,
  model: string,
  apiKey: string,
  timeout: number = 30000,
  maxOutputTokens: number = 3000
): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        max_completion_tokens: maxOutputTokens,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content || '';
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Call a single LLM
 * @param options.critical - If true, throws LLMError on failure instead of returning empty content
 * @param options.minContentLength - Minimum content length to consider response valid (default: 10)
 */
export async function callLLM(
  prompt: string,
  config: LLMConfig,
  options?: LLMCallOptions
): Promise<LLMResponse> {
  const { critical = false, minContentLength = 10 } = options || {};
  const timeout = config.timeout || 30000;
  const maxOutputTokens = config.maxOutputTokens || 10000;
  
  try {
    let content: string;
    
    if (config.provider === 'gemini') {
      content = await callGemini(prompt, config.model, config.apiKey, timeout, maxOutputTokens);
    } else {
      content = await callOpenAI(prompt, config.model, config.apiKey, timeout, maxOutputTokens);
    }
    
    // Fail-fast: throw if content is too short and this is a critical call
    if (critical && (!content || content.length < minContentLength)) {
      throw new LLMError(
        `Critical LLM call returned insufficient content (${content?.length || 0} chars, need ${minContentLength})`,
        config.model
      );
    }
    
    return { model: config.model, content };
  } catch (error: any) {
    // If it's already an LLMError (from fail-fast), re-throw
    if (error instanceof LLMError) {
      throw error;
    }
    
    console.error(`[LLM] ${config.model} failed:`, error.message);
    
    // Fail-fast: throw on critical calls
    if (critical) {
      throw new LLMError(
        `Critical LLM call failed: ${error.message}`,
        config.model,
        error
      );
    }
    
    return { 
      model: config.model, 
      content: '', 
      error: error.message 
    };
  }
}

/**
 * Call multiple LLMs in TRUE parallel
 * @param options.critical - If true, throws if ALL calls fail
 * @param options.minSuccessful - Minimum successful responses required (default: 1)
 */
export async function callLLMsParallel(
  prompt: string,
  configs: LLMConfig[],
  options?: LLMCallOptions & { minSuccessful?: number }
): Promise<LLMResponse[]> {
  console.error(`[LLM] Calling ${configs.length} models in parallel...`);
  const start = Date.now();
  
  const results = await Promise.all(
    configs.map(config => callLLM(prompt, config))
  );
  
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  const successful = results.filter(r => !r.error).length;
  console.error(`[LLM] ${successful}/${configs.length} succeeded in ${elapsed}s`);
  
  // Fail-fast: throw if not enough successful responses
  const minSuccessful = options?.minSuccessful ?? 1;
  if (options?.critical && successful < minSuccessful) {
    throw new LLMError(
      `Critical parallel LLM calls failed: only ${successful}/${minSuccessful} required responses succeeded`,
      configs.map(c => c.model).join(', ')
    );
  }
  
  return results;
}

/**
 * Get default configs for parallel voting (5 calls)
 * Uses only Gemini for now since it's more reliable for structured outputs
 */
export function getVotingConfigs(geminiKey?: string): LLMConfig[] {
  const key = geminiKey || '';
  
  if (!key) {
    console.error('[LLM] ERROR: GEMINI_API_KEY not provided');
    return [];
  }
  
  // 5x Gemini Flash for consistent, fast voting
  // Using same model multiple times still provides diversity through temperature
  return [
    { provider: 'gemini', model: 'gemini-2.5-flash', apiKey: key },
    { provider: 'gemini', model: 'gemini-2.5-flash', apiKey: key },
    { provider: 'gemini', model: 'gemini-2.5-flash', apiKey: key },
    { provider: 'gemini', model: 'gemini-2.5-flash', apiKey: key },
    { provider: 'gemini', model: 'gemini-2.5-flash', apiKey: key },
  ];
}

export const compressText = async (text: string, maxWords: number, geminiKey?: string): Promise<string> => {
  // Quick check: if text is already short enough, return as-is
  const wordCount = text.split(/\s+/).filter(w => w.length > 0).length;
  if (wordCount <= maxWords) {
    return text;
  }

  const key = geminiKey || '';
  if (!key) {
    console.error('[Compress Text] ERROR: GEMINI_API_KEY not provided');
    // Fallback: extract first N words
    return text.split(/\s+/).slice(0, maxWords).join(' ') + '...';
  }

  // Summarize text to be approximately maxWords words
  const summary = await callLLM(
    `Summarize the following text to be approximately ${maxWords} words. Focus on the most important information and insights. Be concise but preserve key details.\n\nText to summarize:\n${text}`, 
    { provider: 'gemini', model: 'gemini-2.5-flash', apiKey: key }
  );
  
  // #region agent log
  fetch('http://127.0.0.1:7243/ingest/cc739506-e25d-45e2-b543-cb8ae30e3ecd',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'llm.ts:compressText',message:'Compressed text',data:{originalWords:wordCount,targetWords:maxWords,compressedWords:summary.content.split(/\s+/).length,compressedLength:summary.content.length},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'A_FIX'})}).catch(()=>{});
  // #endregion
  
  return summary.content;
};