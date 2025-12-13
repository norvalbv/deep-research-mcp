/**
 * Direct arXiv API integration
 * Uses the arXiv API for academic paper search
 * 
 * Rate limiting: arXiv recommends max 1 request per 3 seconds
 */

// Track last request time for rate limiting
let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL = 3000; // 3 seconds between requests

async function waitForRateLimit(): Promise<void> {
  const now = Date.now();
  const timeSinceLastRequest = now - lastRequestTime;
  
  if (timeSinceLastRequest < MIN_REQUEST_INTERVAL) {
    const waitTime = MIN_REQUEST_INTERVAL - timeSinceLastRequest;
    console.error(`[arXiv] Rate limit: waiting ${waitTime}ms before next request`);
    await new Promise(resolve => setTimeout(resolve, waitTime));
  }
  
  lastRequestTime = Date.now();
}

export interface ArxivPaper {
  id: string;
  title: string;
  authors: string[];
  summary: string;
  published: string;
  url: string;
  pdfUrl: string;
}

export interface ArxivResult {
  papers: ArxivPaper[];
  totalResults: number;
}

/**
 * Search arXiv for papers matching the query
 * Includes retry logic for rate limiting (429 errors)
 */
export async function arxivSearch(
  query: string,
  maxResults: number = 5,
  retries: number = 3
): Promise<ArxivResult> {
  let lastError: Error | null = null;
  
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      // Wait for rate limit before making request
      await waitForRateLimit();
      
      // Build arXiv API query URL
      const searchQuery = encodeURIComponent(query);
      const url = `http://export.arxiv.org/api/query?search_query=all:${searchQuery}&start=0&max_results=${maxResults}&sortBy=relevance&sortOrder=descending`;

      const response = await fetch(url);

      if (response.status === 429) {
        // Rate limited - wait longer and retry
        const waitTime = Math.min(5000 * (attempt + 1), 15000); // 5s, 10s, 15s max
        console.error(`[arXiv] Rate limited (429), waiting ${waitTime}ms before retry ${attempt + 1}/${retries}`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        continue;
      }

      if (!response.ok) {
        throw new Error(`arXiv API error (${response.status}): ${response.statusText}`);
      }

      const xmlText = await response.text();
      
      // Parse XML response (simple parsing for key fields)
      const papers = parseArxivXML(xmlText);

      console.error(`[arXiv] Found ${papers.length} papers`);
      return {
        papers,
        totalResults: papers.length,
      };
    } catch (error: any) {
      lastError = error;
      console.error(`[arXiv] Attempt ${attempt + 1}/${retries} failed:`, error.message);
      
      // Don't retry on non-rate-limit errors
      if (!error.message?.includes('429')) {
        break;
      }
    }
  }
  
  // All retries failed - return empty result instead of throwing
  console.error('[arXiv] All attempts failed, returning empty result');
  return { papers: [], totalResults: 0 };
}

/**
 * Simple XML parser for arXiv API response
 */
function parseArxivXML(xml: string): ArxivPaper[] {
  const papers: ArxivPaper[] = [];
  
  // Match each <entry> block
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  let match;

  while ((match = entryRegex.exec(xml)) !== null) {
    const entry = match[1];
    
    // Extract fields
    const id = extractTag(entry, 'id');
    const title = extractTag(entry, 'title').replace(/\s+/g, ' ').trim();
    const summary = extractTag(entry, 'summary').replace(/\s+/g, ' ').trim();
    const published = extractTag(entry, 'published');
    
    // Extract authors
    const authorRegex = /<author>[\s\S]*?<name>(.*?)<\/name>[\s\S]*?<\/author>/g;
    const authors: string[] = [];
    let authorMatch;
    while ((authorMatch = authorRegex.exec(entry)) !== null) {
      authors.push(authorMatch[1].trim());
    }

    // Build URLs
    const arxivId = id.split('/abs/')[1] || id;
    const url = `https://arxiv.org/abs/${arxivId}`;
    const pdfUrl = `https://arxiv.org/pdf/${arxivId}.pdf`;

    papers.push({
      id: arxivId,
      title,
      authors,
      summary,
      published,
      url,
      pdfUrl,
    });
  }

  return papers;
}

/**
 * Extract content from XML tag
 */
function extractTag(xml: string, tag: string): string {
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const match = xml.match(regex);
  return match ? match[1].trim() : '';
}