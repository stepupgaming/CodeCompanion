import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyEdit, editFileTool, grepTool, listDirectoryTool, readFileTool, writeFileTool } from './files';
import { browserTool } from './browser';
import { availableTools } from './registry';
import { commandOutputTool, runCommandTool, ShellRunner } from './shell';
import { ToolError, truncateOutput, type AgentTool, type ToolContext } from './types';
import { extractArticle, fetchUrlTool, fetchWithoutCrossHostRedirect } from './web';
import { Workspace } from './workspace';

let root: string;
let context: ToolContext;

function makeContext(): ToolContext {
  const workspace = new Workspace(root);
  return {
    workspace,
    signal: new AbortController().signal,
    readFiles: new Set(),
    shell: new ShellRunner(() => workspace.root),
    browser: null,
    codeSearch: null,
    webSearch: null,
    onProgress: () => {},
  };
}

// Runs a tool the way the agent does: validate the input first.
async function call(tool: AgentTool, input: unknown, ctx = context) {
  return tool.run(tool.schema!.parse(input), ctx);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-tools-'));
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(root, 'src', 'app.ts'), 'const a = 1;\nconst b = 2;\nexport { a, b };\n');
  writeFileSync(join(root, 'src', 'dist.log'), 'ignored');
  writeFileSync(join(root, 'node_modules', 'pkg', 'index.js'), 'const a = 1;');
  writeFileSync(join(root, '.gitignore'), '*.log\n');
  context = makeContext();
});

afterEach(() => {
  context.shell.stopAll();
  rmSync(root, { recursive: true, force: true });
});

describe('Workspace', () => {
  it('rejects paths outside the project', () => {
    expect(() => context.workspace.resolve('../outside.txt')).toThrow(ToolError);
    expect(() => context.workspace.resolve(join(tmpdir(), 'x.txt'))).toThrow(/outside the project/);
    expect(context.workspace.resolve('src/app.ts')).toBe(join(context.workspace.root, 'src', 'app.ts'));
  });

  it('follows a folder link for a file that does not exist yet, so nothing is written outside the project', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'cc-outside-'));
    try {
      // A junction needs no special rights on Windows; elsewhere it is a plain directory symlink.
      symlinkSync(outside, join(root, 'link'), 'junction');
      expect(() => context.workspace.resolve('link/new.txt')).toThrow(/outside the project/);
      expect(() => context.workspace.resolve('link/deeper/new.txt')).toThrow(/outside the project/);
      await expect(call(writeFileTool, { path: 'link/new.txt', content: 'escaped' })).rejects.toThrow(
        /outside the project/,
      );
      expect(existsSync(join(outside, 'new.txt'))).toBe(false);

      // A link that stays inside the project is fine, and so are new files in new folders.
      symlinkSync(join(root, 'src'), join(root, 'inner'), 'junction');
      expect(context.workspace.resolve('inner/new.ts')).toBe(join(context.workspace.root, 'src', 'new.ts'));
      expect(context.workspace.resolve('brand/new/dir/file.ts')).toBe(
        join(context.workspace.root, 'brand', 'new', 'dir', 'file.ts'),
      );
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('skips .gitignore matches and node_modules when listing', async () => {
    const files = (await context.workspace.listFiles()).map((file) => context.workspace.relative(file));
    expect(files).toEqual(['.gitignore', 'src/app.ts']);
  });

  it.for(['.gitignore', '.ccignore'])('ignores external %s links without applying their rules', async (name, test) => {
    const outside = mkdtempSync(join(tmpdir(), 'cc-ignore-outside-'));
    try {
      const target = join(outside, 'rules');
      writeFileSync(target, 'src/app.ts\n');
      rmSync(join(root, name), { force: true });
      try {
        symlinkSync(target, join(root, name), 'file');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EPERM') return test.skip();
        throw error;
      }
      const ordinary = name === '.gitignore' ? '.ccignore' : '.gitignore';
      writeFileSync(join(root, ordinary), '*.log\n');
      const files = (await context.workspace.listFiles()).map((file) => context.workspace.relative(file));
      expect(files).toContain('src/app.ts');
      expect(files).not.toContain('src/dist.log');
      expect(files).not.toContain(name);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it.each(['.gitignore', '.ccignore'])('ignores external %s junctions without trying to read them', async (name) => {
    const outside = mkdtempSync(join(tmpdir(), 'cc-ignore-junction-'));
    try {
      rmSync(join(root, name), { force: true });
      symlinkSync(outside, join(root, name), 'junction');
      const files = (await context.workspace.listFiles()).map((file) => context.workspace.relative(file));
      expect(files).toContain('src/app.ts');
      expect(files).not.toContain(name);
    } finally {
      rmSync(join(root, name), { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('file tools', () => {
  it('reads with line numbers and ranges', async () => {
    const full = await call(readFileTool, { path: 'src/app.ts' });
    expect(full.content).toContain('1\tconst a = 1;');
    const range = await call(readFileTool, { path: 'src/app.ts', offset: 2, limit: 1 });
    expect(range.content.split('\n')[0]).toBe('2\tconst b = 2;');
    expect(range.content).toContain('Showing lines 2-2 of 4');
  });

  it('reads a large file page by page, in whole lines, with nothing missing in between', async () => {
    // 1,500 lines of about 50 characters: too much for one read, well under the 2,000-line default.
    const lines = Array.from({ length: 1500 }, (_, index) => `line ${index + 1}: the quick brown fox jumps over`);
    writeFileSync(join(root, 'big.txt'), lines.join('\n'));

    const seen: string[] = [];
    let offset = 1;
    for (let page = 0; page < 10; page++) {
      const result = await call(readFileTool, { path: 'big.txt', offset });
      const [text, note] = result.content.split('\n\n(');
      expect(text!.length).toBeLessThanOrEqual(30_000);
      seen.push(...text!.split('\n').map((line) => line.split('\t')[1]!));
      if (!note) break;
      const next = Number(/Use offset=(\d+)/.exec(note)![1]);
      expect(next).toBeGreaterThan(offset);
      offset = next;
    }

    // Every line exactly once, in order: no hole in the middle.
    expect(seen).toEqual(lines);
    expect(offset).toBeGreaterThan(1);
  });

  it('honors the requested whole-line limit', async () => {
    writeFileSync(join(root, 'short-lines.txt'), Array.from({ length: 50 }, (_, index) => `${index}`).join('\n'));
    const result = await call(readFileTool, { path: 'short-lines.txt', limit: 10 });
    const [text, note] = result.content.split('\n\n(');
    expect(text!.split('\n').map((line) => line.split('\t')[1])).toEqual(
      Array.from({ length: 10 }, (_, index) => `${index}`),
    );
    expect(Number(/Use offset=(\d+)/.exec(note!)![1])).toBe(11);
  });

  it.each(['x'.repeat(29_998), 'x'.repeat(29_999), `${'x'.repeat(29_997)}😀${'é漢😀'.repeat(20_000)}`])(
    'reconstructs long lines through the returned continuation without losing Unicode',
    async (line) => {
      const original = [line, '', 'last 😀 line'];
      writeFileSync(join(root, 'min.js'), original.join('\n'));
      const reconstructed = ['', '', ''];
      let offset = 1;
      let char_offset = 0;
      for (let page = 0; page < 20; page++) {
        const result = await call(readFileTool, { path: 'min.js', offset, char_offset, limit: 1 });
        const [text, note] = result.content.split('\n\n(');
        expect(text!.length).toBeLessThanOrEqual(30_000);
        for (const numbered of text!.split('\n')) {
          const tab = numbered.indexOf('\t');
          const fragment = numbered.slice(tab + 1);
          expect(fragment).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u);
          reconstructed[Number(numbered.slice(0, tab)) - 1] += fragment;
        }
        if (!note) break;
        const next = /Use offset=(\d+)(?: and char_offset=(\d+))?/.exec(note)!;
        const nextLine = Number(next[1]);
        const nextChar = Number(next[2] ?? 0);
        expect(nextLine > offset || (nextLine === offset && nextChar > char_offset)).toBe(true);
        offset = nextLine;
        char_offset = nextChar;
      }
      expect(reconstructed).toEqual(original);
    },
  );

  it('validates character offsets and applies them only to the first line', async () => {
    writeFileSync(join(root, 'unicode.txt'), 'a😀b\nnext');
    await expect(call(readFileTool, { path: 'unicode.txt', char_offset: 2 })).rejects.toThrow(/surrogate pair/);
    await expect(call(readFileTool, { path: 'unicode.txt', char_offset: 5 })).rejects.toThrow(/within/);
    const result = await call(readFileTool, { path: 'unicode.txt', char_offset: 3 });
    expect(result.content).toBe('1\tb\n2\tnext');
    const end = await call(readFileTool, { path: 'unicode.txt', char_offset: 4 });
    expect(end.content).toBe('1\t\n2\tnext');
  });

  it('reads a small file whole, with no note', async () => {
    const result = await call(readFileTool, { path: 'src/app.ts' });
    expect(result.content).not.toContain('(Showing');
    expect(result.summary).toBe('Read src/app.ts (4 lines)');
  });

  it('refuses to edit or overwrite a file that was not read', async () => {
    await expect(call(editFileTool, { path: 'src/app.ts', old_string: 'a = 1', new_string: 'a = 9' })).rejects.toThrow(
      /src\/app.ts has not been read/,
    );
    await expect(call(writeFileTool, { path: 'src/app.ts', content: 'x' })).rejects.toThrow(/has not been read/);
    // Also rejected while building the approval preview, so the user is never asked to approve it.
    await expect(
      editFileTool.preview?.({ path: 'src/app.ts', old_string: 'a = 1', new_string: 'a = 9' }, context),
    ).rejects.toThrow(/has not been read/);
  });

  it('edits after reading and reports a diff', async () => {
    await call(readFileTool, { path: 'src/app.ts' });
    const result = await call(editFileTool, {
      path: 'src/app.ts',
      old_string: 'const a = 1;',
      new_string: 'const a = 10;',
    });
    expect(readFileSync(join(root, 'src', 'app.ts'), 'utf8')).toContain('const a = 10;');
    expect(result.content).toContain('+const a = 10;');
  });

  it('creates new files and folders without a prior read', async () => {
    await call(writeFileTool, { path: 'lib/new/util.ts', content: 'export {};\n' });
    expect(readFileSync(join(root, 'lib', 'new', 'util.ts'), 'utf8')).toBe('export {};\n');
  });

  it('keeps what is needed to undo an edit: the exact previous bytes and a fingerprint of the result', async () => {
    const original = readFileSync(join(root, 'src', 'app.ts'));
    await call(readFileTool, { path: 'src/app.ts' });
    const result = await call(editFileTool, {
      path: 'src/app.ts',
      old_string: 'const a = 1;',
      new_string: 'const a = 10;',
    });

    expect(result.undo).toEqual({
      path: 'src/app.ts',
      before: original,
      afterHash: createHash('sha256')
        .update(readFileSync(join(root, 'src', 'app.ts')))
        .digest('hex'),
    });
  });

  it('marks a created file as one that did not exist, and keeps the previous content of an overwritten one', async () => {
    const created = await call(writeFileTool, { path: 'lib/new.ts', content: 'export {};\n' });
    expect(created.undo).toEqual({
      path: 'lib/new.ts',
      before: null,
      afterHash: createHash('sha256').update('export {};\n').digest('hex'),
    });

    const original = readFileSync(join(root, 'src', 'app.ts'));
    await call(readFileTool, { path: 'src/app.ts' });
    const replaced = await call(writeFileTool, { path: 'src/app.ts', content: 'replaced\n' });
    expect(replaced.undo?.before).toEqual(original);
  });

  it('keeps the exact bytes of a file that is not valid UTF-8', async () => {
    const bytes = Buffer.from([0x63, 0x6f, 0x6e, 0xff, 0xfe, 0x0d, 0x0a, 0x73, 0x74]);
    writeFileSync(join(root, 'legacy.txt'), bytes);
    await call(readFileTool, { path: 'legacy.txt' });
    const result = await call(writeFileTool, { path: 'legacy.txt', content: 'utf8 now\n' });
    expect(result.undo?.before?.equals(bytes)).toBe(true);
  });

  it('previews writes as a diff', async () => {
    const preview = await writeFileTool.preview!(
      writeFileTool.schema!.parse({ path: 'new.txt', content: 'hello\n' }),
      context,
    );
    expect(preview.title).toBe('Create new.txt');
    expect(preview.diff).toContain('+hello');
  });

  it('lists a directory without ignored entries', async () => {
    const result = await call(listDirectoryTool, {});
    expect(result.content.split('\n')).toEqual(['src/', '.gitignore']);
  });

  it('greps across non-ignored files', async () => {
    const result = await call(grepTool, { pattern: 'const a' });
    expect(result.content).toBe('src/app.ts:1: const a = 1;');
  });
});

describe('applyEdit', () => {
  it('requires a unique match unless replace_all is set', () => {
    expect(() => applyEdit('x x', { old_string: 'x', new_string: 'y' })).toThrow(/appears 2 times/);
    expect(applyEdit('x x', { old_string: 'x', new_string: 'y', replace_all: true })).toBe('y y');
  });

  it('reports a missing match', () => {
    expect(() => applyEdit('abc', { old_string: 'zzz', new_string: 'y' })).toThrow(/not found/);
  });

  it('matches LF input against CRLF files and keeps CRLF', () => {
    expect(applyEdit('a\r\nb\r\n', { old_string: 'a\nb', new_string: 'c\nd' })).toBe('c\r\nd\r\n');
  });

  it('does not interpret $ patterns in the replacement', () => {
    expect(applyEdit('price', { old_string: 'price', new_string: '$&$1' })).toBe('$&$1');
  });
});

describe('browser tool', () => {
  const opened: string[] = [];
  let navigationPolicy: ((url: string) => boolean) | undefined;
  const browser = {
    open: async (url: string, _signal: AbortSignal, policy?: (url: string) => boolean) => {
      opened.push(url);
      navigationPolicy = policy;
      return { url, title: 'T', status: 200, console: [] };
    },
    screenshot: async () => '',
  };

  it('opens http pages and files inside the project', async () => {
    opened.length = 0;
    writeFileSync(join(root, 'index.html'), '<p>hi</p>');
    const ctx = { ...context, browser };
    await call(browserTool, { url: 'http://localhost:3000' }, ctx);
    await call(browserTool, { url: pathToFileURL(join(root, 'index.html')).href }, ctx);
    expect(opened[0]).toBe('http://localhost:3000');
    expect(opened[1]!.toLowerCase()).toContain('index.html');
  });

  it('confines later browser navigation to the approved exact hostname', async () => {
    await call(browserTool, { url: 'https://EXAMPLE.test/start' }, { ...context, browser });
    expect(navigationPolicy?.('https://example.test/next')).toBe(true);
    expect(navigationPolicy?.('https://sub.example.test/')).toBe(false);
    expect(navigationPolicy?.('https://example.test.evil/')).toBe(false);
    expect(navigationPolicy?.('https://example.test@evil.test/')).toBe(false);
  });

  it('is approval gated and previews the complete URL', async () => {
    const url = 'https://example.test/private?token=value';
    expect(browserTool.requiresApproval).toBe(true);
    expect((await browserTool.preview!({ url }, context)).title).toContain(url);
    expect(fetchUrlTool.requiresApproval).toBe(true);
    expect((await fetchUrlTool.preview!({ url }, context)).title).toContain(url);
  });

  it('refuses file URLs outside the project', async () => {
    opened.length = 0;
    const outside = pathToFileURL(join(root, '..', 'secret.txt')).href;
    await expect(call(browserTool, { url: outside }, { ...context, browser })).rejects.toThrow('outside the project');
    expect(opened).toEqual([]);
  });
});

describe('fetch redirects', () => {
  it('blocks a cross-host redirect before contacting its destination', async () => {
    const originalFetch = globalThis.fetch;
    const contacted: string[] = [];
    globalThis.fetch = (async (input: URL | RequestInfo) => {
      contacted.push(String(input));
      return new Response(null, { status: 302, headers: { location: 'https://evil.test/secret' } });
    }) as typeof fetch;
    try {
      await expect(
        fetchWithoutCrossHostRedirect(new URL('https://allowed.test/start'), new AbortController().signal),
      ).rejects.toThrow(/Blocked redirect.*request that URL separately/);
      expect(contacted).toEqual(['https://allowed.test/start']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('follows same-host redirects', async () => {
    const originalFetch = globalThis.fetch;
    const contacted: string[] = [];
    globalThis.fetch = (async (input: URL | RequestInfo) => {
      contacted.push(String(input));
      return contacted.length === 1
        ? new Response(null, { status: 302, headers: { location: '/next' } })
        : new Response('ok');
    }) as typeof fetch;
    try {
      expect(
        await (
          await fetchWithoutCrossHostRedirect(new URL('https://allowed.test/start'), new AbortController().signal)
        ).text(),
      ).toBe('ok');
      expect(contacted).toEqual(['https://allowed.test/start', 'https://allowed.test/next']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('shell tools', () => {
  it('returns output and exit code', async () => {
    const result = await call(runCommandTool, { command: 'echo hello-from-shell' });
    expect(result.content).toContain('Exit code: 0');
    expect(result.content).toContain('hello-from-shell');
    expect(result.isError).toBe(false);
  });

  it('flags non-zero exit codes', async () => {
    const result = await call(runCommandTool, { command: 'exit 3' });
    expect(result.content).toContain('Exit code: 3');
    expect(result.isError).toBe(true);
  });

  it('runs in the project root', async () => {
    const command = process.platform === 'win32' ? '(Get-Location).Path' : 'pwd';
    const result = await call(runCommandTool, { command });
    // The shell may print the long form of a Windows 8.3 short path (RUNNER~1) or the real path of a symlink.
    const output = result.content.toLowerCase();
    const candidates = [context.workspace.root, realpathSync.native(context.workspace.root)];
    expect(candidates.some((path) => output.includes(path.toLowerCase()))).toBe(true);
  });

  it('stops commands that run past the timeout', async () => {
    const shell = new ShellRunner(() => root);
    const command = process.platform === 'win32' ? 'Start-Sleep -Seconds 30' : 'sleep 30';
    const started = Date.now();
    const result = await shell.run(command, { timeoutSeconds: 1 });
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 20_000);

  it('returns when the command exits even if a leftover child keeps the output pipe open', async () => {
    const shell = new ShellRunner(() => tmpdir());
    const command =
      process.platform === 'win32'
        ? `Start-Process node -ArgumentList '-e','setTimeout(()=>{},20000)' -NoNewWindow; Write-Output finished`
        : 'sleep 20 & echo finished';
    const started = Date.now();
    const result = await shell.run(command, { timeoutSeconds: 60 });
    expect(result.output).toContain('finished');
    expect(result.timedOut).toBe(false);
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 30_000);

  it('stops commands when the chat is stopped', async () => {
    const controller = new AbortController();
    const command = process.platform === 'win32' ? 'Start-Sleep -Seconds 30' : 'sleep 30';
    const pending = context.shell.run(command, { signal: controller.signal });
    setTimeout(() => controller.abort(), 500);
    const result = await pending;
    expect(result.aborted).toBe(true);
  }, 20_000);

  it('does not start a command when the chat was stopped before it could run', async () => {
    const controller = new AbortController();
    controller.abort();
    const marker = join(root, 'should-not-exist.txt');
    const result = await context.shell.run(`node -e "require('fs').writeFileSync('should-not-exist.txt','x')"`, {
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(result.aborted).toBe(true);
    expect(existsSync(marker)).toBe(false);
  }, 20_000);

  it('starts background commands and reads their output', async () => {
    const command =
      process.platform === 'win32'
        ? 'Write-Output background-ready; Start-Sleep -Seconds 30'
        : 'echo background-ready; sleep 30';
    const started = await call(runCommandTool, { command, background: true });
    expect(started.content).toContain('still running');
    expect(started.content).toContain('background-ready');

    const output = await call(commandOutputTool, { id: 1, stop: true });
    expect(output.content).toContain('Status: stopped');
  }, 20_000);
});

describe('helpers', () => {
  it('truncates the middle of long output', () => {
    const text = 'a'.repeat(100) + 'b'.repeat(100);
    const result = truncateOutput(text, 50);
    expect(result.startsWith('a'.repeat(25))).toBe(true);
    expect(result.endsWith('b'.repeat(25))).toBe(true);
    expect(result).toContain('150 characters omitted');
  });

  it('extracts readable text from HTML', () => {
    const html = `<html><head><title>Docs</title></head><body><nav>menu</nav><article><h1>Install</h1><p>${'Run npm install to set up the project. '.repeat(20)}</p></article></body></html>`;
    const text = extractArticle(html);
    expect(text).toContain('Run npm install');
  });

  it('only offers tools that are configured', () => {
    const names = (ctx: Partial<ToolContext>) =>
      availableTools({ browser: null, codeSearch: null, webSearch: null, ...ctx }).map((tool) => tool.name);
    expect(names({})).not.toContain('web_search');
    expect(names({})).not.toContain('browser');
    expect(names({ webSearch: { googleApiKey: 'k', googleSearchEngineId: 'c' } })).toContain('web_search');
  });
});
