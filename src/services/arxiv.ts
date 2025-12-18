/**
 * Direct arXiv API integration
 * Uses the arXiv API for academic paper search
 * 
 * Rate limiting: arXiv recommends max 1 request per 3 seconds
 */

import { callLLM } from '../clients/llm.js';

// CS/AI/ML categories for filtering
const CS_CATEGORIES = ['cs.AI', 'cs.LG', 'cs.CL', 'cs.CV', 'cs.NE', 'stat.ML'];

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
 * Extract core academic keywords from natural language query
 */
async function extractArxivKeywords(query: string, apiKey: string): Promise<string[]> {
  try {
    const response = await callLLM(
      `Extract 3-5 core academic keywords from this query for arXiv search. Return only comma-separated keywords, no explanation.\n\nQuery: ${query}`,
      { 
        provider: 'gemini', 
        model: 'gemini-3-flash-preview', 
        apiKey, 
        timeout: 10000 
      }
    );
    const keywords = response.content.split(',').map(k => k.trim()).filter(k => k.length > 0);
    // #region agent log
    fetch('http://127.0.0.1:7243/ingest/cc739506-e25d-45e2-b543-cb8ae30e3ecd',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'arxiv.ts:extractArxivKeywords',message:'H1: Keywords extracted',data:{query,rawResponse:response.content,keywords},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H1'})}).catch(()=>{});
    // #endregion
    return keywords;
  } catch (error) {
    console.error('[arXiv] Keyword extraction failed, using raw query:', error);
    // Fallback: split query into words
    return query.split(/\s+/).filter(w => w.length > 3).slice(0, 5);
  }
}

/**
 * Build optimized arXiv query with field scoping and category filtering
 */
function buildArxivQuery(keywords: string[]): string {
  // Field scoping: search only titles and abstracts
  const kwQuery = keywords.map(k => `ti:"${k}" OR abs:"${k}"`).join(' OR ');
  
  // Category filtering: restrict to CS/AI/ML domains
  const catQuery = CS_CATEGORIES.map(c => `cat:${c}`).join(' OR ');
  
  // Exclude physics papers
  const finalQuery = `(${kwQuery}) AND (${catQuery}) ANDNOT cat:physics.*`;
  // #region agent log
  fetch('http://127.0.0.1:7243/ingest/cc739506-e25d-45e2-b543-cb8ae30e3ecd',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'arxiv.ts:buildArxivQuery',message:'H2: Built query syntax',data:{keywords,kwQuery,catQuery,finalQuery},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H2'})}).catch(()=>{});
  // #endregion
  return finalQuery;
}

/**
 * Validate paper relevance using LLM
 */
async function validatePaperRelevance(
  papers: ArxivPaper[], 
  originalQuery: string, 
  apiKey: string
): Promise<ArxivPaper[]> {
  if (papers.length === 0) return [];
  
  try {
    const prompt = `For each paper, answer YES if it directly addresses this research query, NO otherwise.

Query: ${originalQuery}

Papers:
${papers.map((p, i) => `${i+1}. ${p.title}\nAbstract: ${p.summary.slice(0, 300)}`).join('\n\n')}

Return only numbers of YES papers, comma-separated (e.g., "1, 3, 5"):`;

    const response = await callLLM(prompt, {
      provider: 'gemini',
      model: 'gemini-3-flash-preview',
      apiKey,
      timeout: 30000
    });
    
    const validIndices = response.content.match(/\d+/g)?.map(n => parseInt(n) - 1) || [];
    const validPapers = papers.filter((_, i) => validIndices.includes(i));
    
    console.error(`[arXiv] Validation: ${validPapers.length}/${papers.length} papers relevant`);
    return validPapers;
  } catch (error) {
    console.error('[arXiv] Validation failed, returning all papers:', error);
    return papers;
  }
}

/**
 * Search arXiv for papers matching the query
 * Includes retry logic for rate limiting (429 errors)
 */
export async function arxivSearch(
  query: string,
  maxResults: number = 5,
  retries: number = 3,
  apiKey?: string
): Promise<ArxivResult> {
  let searchQuery: string;
  
  // Stage 1: Extract keywords and build optimized query if API key available
  if (apiKey) {
    console.error('[arXiv] Extracting keywords for optimized search...');
    const keywords = await extractArxivKeywords(query, apiKey);
    searchQuery = buildArxivQuery(keywords);
    console.error(`[arXiv] Keywords: ${keywords.join(', ')}`);
  } else {
    // Fallback: use simple query with category filtering
    searchQuery = `(all:${query}) AND (${CS_CATEGORIES.map(c => `cat:${c}`).join(' OR ')}) ANDNOT cat:physics.*`;
    console.error('[arXiv] Using fallback query (no API key for keyword extraction)');
  }
  
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      // Wait for rate limit before making request
      await waitForRateLimit();
      
      // Build arXiv API query URL with optimized search
      const encodedQuery = encodeURIComponent(searchQuery);
      const url = `http://export.arxiv.org/api/query?search_query=${encodedQuery}&start=0&max_results=${maxResults}&sortBy=relevance&sortOrder=descending`;

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
      let papers = parseArxivXML(xmlText);
      // #region agent log
      fetch('http://127.0.0.1:7243/ingest/cc739506-e25d-45e2-b543-cb8ae30e3ecd',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'arxiv.ts:arxivSearch:initialParse',message:'H2/H3: Initial search results',data:{url,papersFound:papers.length,paperTitles:papers.slice(0,3).map(p=>p.title)},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H2,H3'})}).catch(()=>{});
      // #endregion

      console.error(`[arXiv] Found ${papers.length} papers from search`);
      
      // Stage 2: Validate relevance if API key available
      const papersBeforeValidation = papers.length;
      if (apiKey && papers.length > 0) {
        papers = await validatePaperRelevance(papers, query, apiKey);
        // #region agent log
        fetch('http://127.0.0.1:7243/ingest/cc739506-e25d-45e2-b543-cb8ae30e3ecd',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'arxiv.ts:arxivSearch:afterValidation',message:'H5: After LLM validation',data:{before:papersBeforeValidation,after:papers.length,retained:papers.map(p=>p.title)},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H5'})}).catch(()=>{});
        // #endregion
      }
      
      // Fallback: if optimized search returns 0 results, try broader search
      if (papers.length === 0 && apiKey) {
        // #region agent log
        fetch('http://127.0.0.1:7243/ingest/cc739506-e25d-45e2-b543-cb8ae30e3ecd',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'arxiv.ts:arxivSearch:fallbackTriggered',message:'H4: Fallback triggered',data:{reason:'0 papers after initial search/validation'},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H4'})}).catch(()=>{});
        // #endregion
        console.error('[arXiv] No results with strict filtering, trying broader search...');
        const broaderQuery = `(all:${query}) AND (${CS_CATEGORIES.map(c => `cat:${c}`).join(' OR ')}) ANDNOT cat:physics.*`;
        const broaderUrl = `http://export.arxiv.org/api/query?search_query=${encodeURIComponent(broaderQuery)}&start=0&max_results=${maxResults}&sortBy=relevance&sortOrder=descending`;
        
        await waitForRateLimit();
        const broaderResponse = await fetch(broaderUrl);
        
        if (broaderResponse.ok) {
          const broaderXml = await broaderResponse.text();
          papers = parseArxivXML(broaderXml);
          // #region agent log
          fetch('http://127.0.0.1:7243/ingest/cc739506-e25d-45e2-b543-cb8ae30e3ecd',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'arxiv.ts:arxivSearch:fallbackResults',message:'H4: Fallback search results',data:{broaderQuery,papersFound:papers.length,paperTitles:papers.slice(0,3).map(p=>p.title)},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H4'})}).catch(()=>{});
          // #endregion
          console.error(`[arXiv] Broader search found ${papers.length} papers`);
          
          if (papers.length > 0) {
            papers = await validatePaperRelevance(papers, query, apiKey);
          }
        }
      }

      // #region agent log
      fetch('http://127.0.0.1:7243/ingest/cc739506-e25d-45e2-b543-cb8ae30e3ecd',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'arxiv.ts:arxivSearch:finalReturn',message:'Final result',data:{totalPapers:papers.length,paperTitles:papers.map(p=>p.title)},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'ALL'})}).catch(()=>{});
      // #endregion
      return {
        papers,
        totalResults: papers.length,
      };
    } catch (error: any) {
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