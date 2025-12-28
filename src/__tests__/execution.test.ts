import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../services/perplexity.js', () => ({
  perplexitySearch: vi.fn(async () => ({ content: 'ok', sources: [] })),
}));

vi.mock('../services/arxiv.js', () => ({
  arxivSearch: vi.fn(async () => ({ papers: [], totalResults: 0 })),
}));

// Prevent loading Context7 client dependencies (spawn helpers) during unit tests.
vi.mock('../clients/context7.js', () => ({
  searchLibraryDocs: vi.fn(async () => 'docs'),
}));

import { perplexitySearch } from '../services/perplexity.js';
import { arxivSearch } from '../services/arxiv.js';
import { executeResearchPlan } from '../execution.js';

describe('executeResearchPlan', () => {
  beforeEach(() => {
    (perplexitySearch as unknown as ReturnType<typeof vi.fn>).mockClear();
    (arxivSearch as unknown as ReturnType<typeof vi.fn>).mockClear();
  });

  it('runs arXiv at depth 4 even if plan steps do not mention it (unless explicitly skipped)', async () => {
    await executeResearchPlan({
      query: 'q',
      enrichedContext: '',
      depth: 4,
      actionPlan: {
        complexity: 4,
        reasoning: 'test',
        steps: ['perplexity_search'],
        modelVotes: [],
        toolsToUse: ['perplexity_search'],
        toolsToSkip: [],
      },
      context7Client: null,
      options: {},
      env: {},
    });

    expect(perplexitySearch).toHaveBeenCalledTimes(1);
    expect(arxivSearch).toHaveBeenCalledTimes(1);
  });

  it('does not run arXiv below depth 4', async () => {
    await executeResearchPlan({
      query: 'q',
      enrichedContext: '',
      depth: 3,
      actionPlan: {
        complexity: 3,
        reasoning: 'test',
        steps: ['perplexity_search'],
        modelVotes: [],
        toolsToUse: ['perplexity_search'],
        toolsToSkip: [],
      },
      context7Client: null,
      options: {},
      env: {},
    });

    expect(arxivSearch).not.toHaveBeenCalled();
  });

  it('respects toolsToSkip for arxiv_search', async () => {
    await executeResearchPlan({
      query: 'q',
      enrichedContext: '',
      depth: 4,
      actionPlan: {
        complexity: 4,
        reasoning: 'test',
        steps: ['perplexity_search'],
        modelVotes: [],
        toolsToUse: ['perplexity_search'],
        toolsToSkip: ['arxiv_search'],
      },
      context7Client: null,
      options: {},
      env: {},
    });

    expect(arxivSearch).not.toHaveBeenCalled();
  });
});


