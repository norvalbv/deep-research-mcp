/**
 * Shared test helper for validating citations against a known set of sources.
 * This is a structural check used by e2e tests.
 */

export function validateSourceCitations(
  text: string,
  validSources: { arxivIds: string[]; perplexitySources: string[] }
): {
  validCitations: string[];
  invalidCitations: string[];
} {
  const validCitations: string[] = [];
  const invalidCitations: string[] = [];

  // Validate arXiv citations
  const arxivCitations = text.match(/\[arxiv:([\w\d.]+v?\d*)\]/g) || [];
  for (const citation of arxivCitations) {
    const id = citation.match(/\[arxiv:([\w\d.]+v?\d*)\]/)?.[1];
    if (id && validSources.arxivIds.includes(id)) {
      validCitations.push(citation);
    } else {
      invalidCitations.push(citation);
    }
  }

  // Validate perplexity citations
  const perplexityCitations = text.match(/\[perplexity:(\d+)\]/g) || [];
  for (const citation of perplexityCitations) {
    const num = parseInt(citation.match(/\[perplexity:(\d+)\]/)?.[1] || '0', 10);
    if (num > 0 && num <= validSources.perplexitySources.length) {
      validCitations.push(citation);
    } else {
      invalidCitations.push(citation);
    }
  }

  return {
    validCitations,
    invalidCitations,
  };
}


