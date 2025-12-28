import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../clients/llm.js', () => ({
  callLLM: vi.fn(),
}));

import { callLLM } from '../clients/llm.js';
import { synthesizeFindings } from '../synthesis.js';

describe('synthesizeFindings', () => {
  const callLLMMock = callLLM as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    callLLMMock.mockReset();
  });

  it('uses a constrained token budget for summary outputs', async () => {
    callLLMMock.mockResolvedValue({ content: '<!-- SECTION:overview -->\n## Overview\nHello' });

    const execution: any = { perplexityResult: { content: 'x', sources: [] } };
    const out = await synthesizeFindings('key', 'q', undefined, execution, {
      outputFormat: 'summary',
      includeCodeExamples: false,
      depth: 4,
    });

    expect(out.overview).toBe('Hello');
    expect(callLLMMock).toHaveBeenCalledTimes(1);

    const [_prompt, opts] = callLLMMock.mock.calls[0] as any[];
    expect(opts.maxOutputTokens).toBe(1200);
  });

  it('builds a strict-format prompt for direct outputs and avoids section delimiters', async () => {
    callLLMMock.mockResolvedValue({ content: 'Just the answer.' });

    const execution: any = { perplexityResult: { content: 'x', sources: [] } };
    const out = await synthesizeFindings('key', 'q', undefined, execution, {
      outputFormat: 'direct',
      includeCodeExamples: false,
      depth: 4,
    });

    expect(out.overview).toBe('Just the answer.');
    expect(callLLMMock).toHaveBeenCalledTimes(1);

    const [prompt, opts] = callLLMMock.mock.calls[0] as any[];
    expect(String(prompt)).toContain('CRITICAL FORMAT RULES');
    expect(String(prompt)).not.toContain('<!-- SECTION:overview -->');
    expect(opts.maxOutputTokens).toBe(1200);
  });

  it('increases token budget when code examples are requested (depth >= 3)', async () => {
    callLLMMock.mockResolvedValue({ content: '<!-- SECTION:overview -->\n## Overview\nHello' });

    const execution: any = { perplexityResult: { content: 'x', sources: [] } };
    await synthesizeFindings('key', 'q', undefined, execution, {
      outputFormat: 'summary',
      includeCodeExamples: true,
      depth: 3,
    });

    const [_prompt, opts] = callLLMMock.mock.calls[0] as any[];
    expect(opts.maxOutputTokens).toBe(6000);
  });
});


