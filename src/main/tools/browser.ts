import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import { defineTool, ToolError, truncateOutput } from './types';
import type { Workspace } from './workspace';

export interface PageLoadResult {
  url: string;
  title: string;
  status: number | null;
  console: string[];
  error?: string;
}

// Drives the built-in browser panel. Implemented in the main process on the <webview> guest's webContents.
export interface BrowserController {
  open(url: string, signal: AbortSignal, isNavigationAllowed?: (url: string) => boolean): Promise<PageLoadResult>;
  screenshot(): Promise<string>; // base64 PNG
}

// A file:// URL must not reach outside the project (for example a private key that the model could then screenshot).
export function confineFileUrl(url: string, workspace: Workspace): string {
  if (!/^file:/i.test(url)) return url;
  let path: string;
  try {
    path = fileURLToPath(url);
  } catch {
    throw new ToolError('Invalid file:// URL.');
  }
  const inside = workspace.resolve(path);
  return pathToFileURL(inside).href;
}

export const browserTool = defineTool({
  name: 'browser',
  description:
    "Open a URL in the app's built-in browser, which the user can see. Returns the page title, HTTP status and console messages; optionally a screenshot. Use it to check web apps you build (start the dev server first with run_command background=true). Local files inside the project: use a file:// URL with an absolute path (files outside the project are refused).",
  schema: z.object({
    url: z.string().min(1),
    screenshot: z.boolean().optional().describe('Attach a screenshot. Only when you need to see the page.'),
  }),
  requiresApproval: true,
  async preview({ url }) {
    return { title: `Open ${url}` };
  },
  async run({ url, screenshot }, context) {
    if (!context.browser) throw new ToolError('The browser panel is not available.');
    if (!/^(https?|file):\/\//i.test(url))
      throw new ToolError('Use a full URL including http://, https:// or file://.');
    url = confineFileUrl(url, context.workspace);

    const approved = new URL(url);
    const page = await context.browser.open(url, context.signal, (destination) => {
      try {
        const next = new URL(destination);
        if (approved.protocol === 'file:') {
          if (next.protocol !== 'file:') return false;
          confineFileUrl(next.href, context.workspace);
          return true;
        }
        return ['http:', 'https:'].includes(next.protocol) && next.hostname === approved.hostname;
      } catch {
        return false;
      }
    });
    const lines = [
      `URL: ${page.url}`,
      `Title: ${page.title || '(none)'}`,
      `Status: ${page.status ?? 'unknown'}`,
      page.error ? `Load error: ${page.error}` : '',
      `Console (${page.console.length} messages):`,
      truncateOutput(page.console.join('\n'), 10_000) || '(empty)',
    ].filter(Boolean);

    const images = screenshot
      ? [{ mediaType: 'image/png' as const, base64: await context.browser.screenshot() }]
      : undefined;
    return {
      content: lines.join('\n'),
      images,
      isError: Boolean(page.error),
      summary: `Opened ${url}${screenshot ? ' and took a screenshot' : ''}`,
    };
  },
});
