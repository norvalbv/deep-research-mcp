/**
 * Shared test helpers for structural markdown checks.
 * Kept under __tests__/helpers to avoid cross-importing between test files.
 */

/**
 * Extracts and validates citation formats from synthesis output.
 * Structural check only: validates presence/format, not semantic relevance.
 */
export function extractCitations(text: string): {
  arxiv: string[];
  perplexity: string[];
  context7: string[];
  total: number;
} {
  const arxiv = text.match(/\[arxiv:[\w\d.]+v?\d*\]/g) || [];
  const perplexity = text.match(/\[perplexity:\d+\]/g) || [];
  const context7 = text.match(/\[context7:[\w-]+\]/g) || [];

  return {
    arxiv,
    perplexity,
    context7,
    total: arxiv.length + perplexity.length + context7.length,
  };
}

/**
 * Parses section delimiters from synthesis output.
 * Format: <!-- SECTION:name -->
 */
export function parseSections(markdown: string): {
  sections: Record<string, string>;
  sectionOrder: string[];
} {
  const sections: Record<string, string> = {};
  const sectionOrder: string[] = [];
  const delimiterRegex = /<!--\s*SECTION:(\w+)\s*-->/g;

  const matches: Array<{ name: string; index: number; fullMatch: string }> = [];
  let match;
  while ((match = delimiterRegex.exec(markdown)) !== null) {
    matches.push({
      name: match[1],
      index: match.index + match[0].length,
      fullMatch: match[0],
    });
    sectionOrder.push(match[1]);
  }

  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index;
    const end = i + 1 < matches.length
      ? markdown.indexOf(matches[i + 1].fullMatch)
      : markdown.length;
    sections[matches[i].name] = markdown.slice(start, end).trim();
  }

  return { sections, sectionOrder };
}

/**
 * Extracts code blocks from text.
 * Returns language and content for each block.
 */
export function extractCodeBlocks(text: string): Array<{
  language: string;
  content: string;
  isComplete: boolean;
}> {
  const blocks: Array<{ language: string; content: string; isComplete: boolean }> = [];

  // Match complete code blocks
  const completePattern = /```(\w*)\n([\s\S]*?)```/g;
  let match;
  let lastMatchEnd = 0;
  while ((match = completePattern.exec(text)) !== null) {
    blocks.push({
      language: match[1] || 'text',
      content: match[2],
      isComplete: true,
    });
    lastMatchEnd = match.index + match[0].length;
  }

  // Check for unclosed code block after the last complete match
  const remainingText = text.slice(lastMatchEnd);
  const unclosedMatch = remainingText.match(/```(\w*)\n([\s\S]+)$/);
  if (unclosedMatch) {
    blocks.push({
      language: unclosedMatch[1] || 'text',
      content: unclosedMatch[2],
      isComplete: false,
    });
  }

  return blocks;
}


