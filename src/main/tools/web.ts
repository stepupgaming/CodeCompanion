import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import { z } from 'zod';
import { defineTool, ToolError, truncateOutput } from './types';

const FETCH_TIMEOUT_MS = 15_000;
const MAX_PAGE_CHARS = 20_000;
const MAX_REDIRECTS = 10;

export const webSearchTool = defineTool({
  name: 'web_search',
  description:
    'Search the web (Google). Use for current information such as new library versions, error messages or documentation. Returns titles, links and snippets; use fetch_url to read a page.',
  schema: z.object({ query: z.string().min(1) }),
  requiresApproval: false,
  async run({ query }, context) {
    if (!context.webSearch) {
      throw new ToolError(
        'Web search is not configured. The user can add a Google API key and search engine id in Settings.',
      );
    }
    const url = new URL('https://www.googleapis.com/customsearch/v1');
    url.searchParams.set('key', context.webSearch.googleApiKey);
    url.searchParams.set('cx', context.webSearch.googleSearchEngineId);
    url.searchParams.set('q', query);
    url.searchParams.set('num', '8');

    const response = await fetch(url, { signal: withTimeout(context.signal) });
    if (!response.ok) throw new ToolError(`Search failed: HTTP ${response.status}`);
    const data = (await response.json()) as { items?: Array<{ title: string; link: string; snippet?: string }> };
    const items = data.items ?? [];
    return {
      content:
        items.map((item, i) => `${i + 1}. ${item.title}\n   ${item.link}\n   ${item.snippet ?? ''}`).join('\n') ||
        'No results.',
      summary: `Searched the web for "${query}"`,
    };
  },
});

export const fetchUrlTool = defineTool({
  name: 'fetch_url',
  description: 'Fetch a web page and return its main text content (for documentation, articles, issues).',
  schema: z.object({ url: z.string().url() }),
  requiresApproval: true,
  async preview({ url }) {
    return { title: `Fetch ${url}` };
  },
  async run({ url }, context) {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new ToolError('Only http and https URLs can be fetched.');
    const response = await fetchWithoutCrossHostRedirect(parsed, context.signal);
    if (!response.ok) throw new ToolError(`HTTP ${response.status} for ${url}`);
    const type = response.headers.get('content-type') ?? '';
    const body = await response.text();
    const text = type.includes('html') ? extractArticle(body) : body;
    return { content: truncateOutput(text, MAX_PAGE_CHARS), summary: `Fetched ${url}` };
  },
});

export async function fetchWithoutCrossHostRedirect(initial: URL, signal: AbortSignal): Promise<Response> {
  let current = initial;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    const response = await fetch(current, {
      redirect: 'manual',
      signal: withTimeout(signal),
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; Patch)' },
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    if (!location) return response;
    await response.body?.cancel();
    const destination = new URL(location, current);
    if (!['http:', 'https:'].includes(destination.protocol) || destination.hostname !== initial.hostname) {
      throw new ToolError(
        `Blocked redirect to ${destination.href}. The destination host was not approved; request that URL separately.`,
      );
    }
    current = destination;
  }
  throw new ToolError(`Too many redirects for ${initial.href}`);
}

export function extractArticle(html: string): string {
  const { document } = parseHTML(html);
  const article = new Readability(document as unknown as Document).parse();
  const text = article?.textContent ?? document.body?.textContent ?? '';
  const title = article?.title ? `${article.title}\n\n` : '';
  return title + text.replace(/\n{3,}/g, '\n\n').trim();
}

function withTimeout(signal: AbortSignal): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]);
}
