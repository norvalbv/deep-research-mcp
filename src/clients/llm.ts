export type LLMProvider = 'gemini' | 'openai';

export interface LLMConfig {
  provider: LLMProvider;
  model: string;
  apiKey: string;
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
  apiKey: string
): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.7, maxOutputTokens: 2048 },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Gemini API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Call OpenAI API directly using native fetch
 */
async function callOpenAI(
  prompt: string,
  model: string,
  apiKey: string
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

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
        max_completion_tokens: 3000,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content || '';
  } finally {
    clearTimeout(timeout);
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
  
  try {
    let content: string;
    
    if (config.provider === 'gemini') {
      content = await callGemini(prompt, config.model, config.apiKey);
    } else {
      content = await callOpenAI(prompt, config.model, config.apiKey);
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
export function getVotingConfigs(): LLMConfig[] {
  const geminiKey = process.env.GEMINI_API_KEY || '';
  
  if (!geminiKey) {
    console.error('[LLM] ERROR: GEMINI_API_KEY not found in environment');
    return [];
  }
  
  // 5x Gemini Flash for consistent, fast voting
  // Using same model multiple times still provides diversity through temperature
  return [
    { provider: 'gemini', model: 'gemini-2.5-flash', apiKey: geminiKey },
    { provider: 'gemini', model: 'gemini-2.5-flash', apiKey: geminiKey },
    { provider: 'gemini', model: 'gemini-2.5-flash', apiKey: geminiKey },
    { provider: 'gemini', model: 'gemini-2.5-flash', apiKey: geminiKey },
    { provider: 'gemini', model: 'gemini-2.5-flash', apiKey: geminiKey },
  ];
}

export const compressText = async (text: string, maxLength: number): Promise<string> => {
  if (text.length <= maxLength) {
    return text;
  }

  const geminiKey = process.env.GEMINI_API_KEY || '';
  if (!geminiKey) {
    console.error('[Compress Text] ERROR: GEMINI_API_KEY not found in environment');
    return text;
  }

  // Summarize paper to be max length.
  const summary = await callLLM(`You must summarize the following text to be ${maxLength} characters. Aim to keep the text as close to the original as possible by only stripping out non-essential information. ${text}`, { provider: 'gemini', model: 'gemini-2.5-flash', apiKey: geminiKey });
  return summary.content;
};