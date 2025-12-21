export type LLMProvider = 'gemini' | 'openai' | 'anthropic';

export interface LLMConfig {
  provider: LLMProvider;
  model: string;
  apiKey: string;
  timeout?: number;  // Timeout in milliseconds (default: 30000)
  maxOutputTokens?: number;  // Max output tokens (default: 10000)
  temperature?: number;  // Temperature for sampling (default: 0.7)
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
  maxOutputTokens: number = 10000,
  temperature: number = 0.7
): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature, maxOutputTokens },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Gemini API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    const content = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    
    return content;
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
 * Call Anthropic API directly using native fetch
 */
async function callAnthropic(
  prompt: string,
  model: string,
  apiKey: string,
  timeout: number = 30000,
  maxOutputTokens: number = 4096,
  temperature: number = 0.7
): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: maxOutputTokens,
        temperature,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Anthropic API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    return data.content?.[0]?.text || '';
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
  const temperature = config.temperature ?? 0.7;
  
  try {
    let content: string;
    
    if (config.provider === 'gemini') {
      content = await callGemini(prompt, config.model, config.apiKey, timeout, maxOutputTokens, temperature);
    } else if (config.provider === 'openai') {
      content = await callOpenAI(prompt, config.model, config.apiKey, timeout, maxOutputTokens);
    } else if (config.provider === 'anthropic') {
      content = await callAnthropic(prompt, config.model, config.apiKey, timeout, maxOutputTokens, temperature);
    } else {
      throw new Error(`Unknown provider: ${config.provider}`);
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
 * Get default configs for parallel voting (3-5 calls with diverse models)
 * Research: Diverse LLM ensembles outperform same-model ensembles (R-212511, R-214931)
 * - Multiple small diverse models > single large model (accuracy-to-cost ratio)
 * - Ensemble power mitigates individual biases and hallucinations
 * - >98.8% success rate vs same-model ensembles
 */
export function getVotingConfigs(
  geminiKey?: string,
  openaiKey?: string,
  anthropicKey?: string
): LLMConfig[] {
  const configs: LLMConfig[] = [];
  
  // Research: Diverse small models > same model instances (R-214931)
  // Research: Diverse models > single large model (R-212511)
  if (geminiKey) {
    configs.push({ provider: 'gemini', model: 'gemini-2.5-flash-lite', apiKey: geminiKey });
  }
  if (openaiKey) {
    configs.push({ provider: 'openai', model: 'gpt-5-nano', apiKey: openaiKey });
  }
  if (anthropicKey) {
    configs.push({ provider: 'anthropic', model: 'claude-haiku-4.5', apiKey: anthropicKey });
  }
  
  // Add second Gemini variant if only one provider available
  if (configs.length < 3 && geminiKey) {
    configs.push({ provider: 'gemini', model: 'gemini-3-flash-preview', apiKey: geminiKey });
  }
  
  // Fill remaining slots with Gemini if we have fewer than 3 models
  while (configs.length < 3 && geminiKey) {
    configs.push({ provider: 'gemini', model: 'gemini-2.5-flash-lite', apiKey: geminiKey });
  }
  
  if (configs.length === 0) {
    console.error('[LLM] ERROR: No API keys provided for voting');
  }
  
  return configs;
}

export const compressText = async (text: string, maxWords: number, geminiKey?: string): Promise<string> => {
  // Count words excluding markdown link URLs (which inflate word count)
  // [[domain.com]](https://...) should count as ~2 words, not 5+
  const textWithoutUrls = text.replace(/\]\]\([^)]+\)/g, ']]'); // Remove URL parts of links
  const wordCount = textWithoutUrls.split(/\s+/).filter(w => w.length > 0).length;
  
  const endsComplete = /[.!?]\s*$/.test(text.trim());
  
  // Short content handling (no LLM needed)
  if (wordCount <= maxWords) {
    if (endsComplete) {
      return text; // Already short and complete
    }
    // Short but incomplete: extract complete sentences (no LLM call)
    const sentences = text.match(/[^.!?]+[.!?]+/g) || [];
    const extracted = sentences.join('').trim();
    return extracted || text; // Fallback to original if no sentences found
  }

  const key = geminiKey || '';
  if (!key) {
    console.error('[Compress Text] ERROR: GEMINI_API_KEY not provided');
    // Fallback: extract complete sentences up to N words
    const sentences = text.split(/(?<=[.!?])\s+/);
    let result = '';
    let count = 0;
    for (const sentence of sentences) {
      const sentenceWords = sentence.split(/\s+/).length;
      if (count + sentenceWords > maxWords && count > 0) break;
      result += (result ? ' ' : '') + sentence;
      count += sentenceWords;
    }
    return result || text.split(/\s+/).slice(0, maxWords).join(' ') + '...';
  }

  // Use character limit (more concrete than word count for LLMs)
  // ~100 words ≈ 500 characters
  const maxChars = maxWords * 5;

  // Summarize - complete sentences only, no length constraint in prompt
  const summary = await callLLM(
    `${maxChars? `Write a ${maxChars} character summary of this text.`: 'Write a short summary of this text, ideally keeping it around 3-4 sentences or less.'} Each sentence must be grammatically complete.

Text:
${text}`, 
    { 
      provider: 'gemini', 
      model: 'gemini-2.5-flash-lite', 
      apiKey: key, 
      maxOutputTokens: 8000,  // Higher to account for internal reasoning tokens
      timeout: 60000  // 60s timeout for compression (thinking tokens can take time)
    }
  );
  
  return summary.content;
};