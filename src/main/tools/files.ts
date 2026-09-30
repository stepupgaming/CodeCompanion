import { existsSync, statSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createTwoFilesPatch } from 'diff';
import { z } from 'zod';
import { detectEol, fileSize, isBinaryFile, MAX_READ_BYTES, sha256, withLineNumbers } from './text_files';
import { defineTool, MAX_OUTPUT_CHARS, ToolError, type ToolContext } from './types';

const DEFAULT_READ_LINES = 2000;

export const readFileTool = defineTool({
  name: 'read_file',
  description:
    'Read a text file from the project with line numbers. Pages default to 2,000 lines and contain at most 30,000 characters of numbered text. Use offset and limit for whole-line ranges. If a line exceeds the character budget, follow the returned offset and char_offset to read its remainder without losing text. Read a file before editing or overwriting it.',
  schema: z.object({
    path: z.string().describe('File path, relative to the project root.'),
    offset: z.number().int().min(1).optional().describe('First line to read (1-based).'),
    limit: z.number().int().min(1).optional().describe(`Number of lines to read (default ${DEFAULT_READ_LINES}).`),
    char_offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        'Zero-based UTF-16 code-unit offset within the first requested line (default 0). Use the returned continuation value for an overlong line; subsequent lines start at 0. Must not split a Unicode surrogate pair.',
      ),
  }),
  requiresApproval: false,
  async run({ path, offset = 1, limit = DEFAULT_READ_LINES, char_offset = 0 }, context) {
    const file = context.workspace.resolve(path);
    if (!existsSync(file)) throw new ToolError(`File not found: ${path}`);
    if (statSync(file).isDirectory()) throw new ToolError(`${path} is a directory. Use list_directory.`);
    if (await isBinaryFile(file)) throw new ToolError(`${path} is a binary file.`);
    if ((await fileSize(file)) > MAX_READ_BYTES * 8) throw new ToolError(`${path} is too large to read.`);

    const lines = (await readFile(file, 'utf8')).split(/\r?\n/);
    const selected = lines.slice(offset - 1, offset - 1 + limit);
    const first = selected[0] ?? '';
    if (char_offset > first.length || splitsSurrogatePair(first, char_offset)) {
      throw new ToolError(
        'char_offset must be within the first requested line and must not split a Unicode surrogate pair.',
      );
    }
    if (selected.length > 0) selected[0] = first.slice(char_offset);
    context.readFiles.add(file);

    const rel = context.workspace.relative(file);
    const page = fitLines(withLineNumbers(selected, offset).split('\n'), MAX_OUTPUT_CHARS);
    const last = offset + page.lines - 1;
    const notes: string[] = [];
    if (page.cutLine) {
      const prefixLength = String(offset + selected.length - 1).length + 1;
      const nextChar = char_offset + page.text.length - prefixLength;
      notes.push(`Line ${offset} continues. Use offset=${offset} and char_offset=${nextChar} to read more.`);
    } else if (last < lines.length) {
      const reason =
        page.lines < selected.length ? ` (cut to fit ${MAX_OUTPUT_CHARS.toLocaleString('en-US')} characters)` : '';
      notes.push(
        `Showing lines ${offset}-${last} of ${lines.length}${reason}. Use offset=${last + 1}${char_offset > 0 ? ' and char_offset=0' : ''} to read more.`,
      );
    }
    return {
      content: page.text + (notes.length > 0 ? `\n\n(${notes.join(' ')})` : ''),
      summary:
        page.cutLine || last < lines.length || offset > 1 || char_offset > 0
          ? `Read ${rel} (lines ${offset}-${last} of ${lines.length})`
          : `Read ${rel} (${lines.length} lines)`,
      path: rel,
    };
  },
});

export const listDirectoryTool = defineTool({
  name: 'list_directory',
  description: 'List files and folders in a project directory, skipping files ignored by .gitignore.',
  schema: z.object({
    path: z.string().optional().describe('Directory, relative to the project root. Defaults to the root.'),
    recursive: z.boolean().optional().describe('List all files below the directory (up to 500).'),
  }),
  requiresApproval: false,
  async run({ path = '.', recursive = false }, context) {
    const dir = context.workspace.resolve(path);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new ToolError(`Not a directory: ${path}`);
    const rel = context.workspace.relative(dir);

    if (recursive) {
      const files = await context.workspace.listFiles(dir, 501);
      const shown = files.slice(0, 500).map((file) => context.workspace.relative(file));
      const note = files.length > 500 ? '\n(More than 500 files; list a subdirectory to see the rest.)' : '';
      return { content: (shown.join('\n') || '(empty)') + note, summary: `Listed ${rel} (${shown.length} files)` };
    }

    const entries = (await readdir(dir, { withFileTypes: true }))
      .filter((entry) => !context.workspace.isIgnored(join(dir, entry.name), entry.isDirectory()))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name));
    return { content: entries.join('\n') || '(empty)', summary: `Listed ${rel}` };
  },
});

export const grepTool = defineTool({
  name: 'grep',
  description:
    'Search file contents in the project with a regular expression. Returns matching lines as path:line: text. Use for exact names and strings; use search_code for questions about behavior.',
  schema: z.object({
    pattern: z.string().describe('JavaScript regular expression.'),
    path: z.string().optional().describe('Directory or file to search, relative to the project root.'),
    ignore_case: z.boolean().optional(),
  }),
  requiresApproval: false,
  async run({ pattern, path = '.', ignore_case = false }, context) {
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, ignore_case ? 'i' : '');
    } catch (error) {
      throw new ToolError(`Invalid regular expression: ${(error as Error).message}`);
    }
    const target = context.workspace.resolve(path);
    const files = statSync(target).isDirectory() ? await context.workspace.listFiles(target) : [target];

    const matches: string[] = [];
    for (const file of files) {
      if (context.signal.aborted || matches.length >= 200) break;
      if ((await fileSize(file)) > MAX_READ_BYTES || (await isBinaryFile(file))) continue;
      const lines = (await readFile(file, 'utf8')).split(/\r?\n/);
      lines.forEach((line, index) => {
        if (matches.length < 200 && regex.test(line)) {
          matches.push(`${context.workspace.relative(file)}:${index + 1}: ${line.trim().slice(0, 300)}`);
        }
      });
    }
    const note = matches.length >= 200 ? '\n(Stopped at 200 matches; narrow the pattern or path.)' : '';
    return {
      content: (matches.join('\n') || 'No matches.') + note,
      summary: `Searched for /${pattern}/ (${matches.length} matches)`,
    };
  },
});

export const writeFileTool = defineTool({
  name: 'write_file',
  description:
    'Create a new file or replace an entire file. Existing files must be read first. Prefer edit_file for changes to existing files.',
  schema: z.object({
    path: z.string().describe('File path, relative to the project root.'),
    content: z.string().describe('The complete file content.'),
  }),
  requiresApproval: true,
  async preview({ path, content }, context) {
    const file = context.workspace.resolve(path);
    if (existsSync(file)) requireRead(file, path, context);
    const before = existsSync(file) ? await readFile(file, 'utf8') : '';
    const rel = context.workspace.relative(file);
    return { title: existsSync(file) ? `Overwrite ${rel}` : `Create ${rel}`, diff: unifiedDiff(rel, before, content) };
  },
  async run({ path, content }, context) {
    const file = context.workspace.resolve(path);
    const exists = existsSync(file);
    if (exists) requireRead(file, path, context);
    // The exact bytes, so undoing restores the file as it was even if it was not valid UTF-8.
    const previous = exists ? await readFile(file) : null;
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content, 'utf8');
    context.readFiles.add(file);
    if (path.endsWith('.gitignore')) context.workspace.invalidateIgnoreRules();
    const rel = context.workspace.relative(file);
    return {
      content: `${exists ? 'Updated' : 'Created'} ${rel}.`,
      summary: `${exists ? 'Wrote' : 'Created'} ${rel}`,
      path: rel,
      undo: { path: rel, before: previous, afterHash: sha256(content) },
    };
  },
});

export const editFileTool = defineTool({
  name: 'edit_file',
  description:
    'Replace an exact string in a file. old_string must match the file exactly (including indentation) and be unique unless replace_all is true. Read the file first with read_file (in an earlier step, not in the same batch as the edit). Always send path, old_string and new_string. Include enough surrounding lines to make old_string unique.',
  schema: z.object({
    path: z.string().describe('File path, relative to the project root.'),
    old_string: z.string().min(1).describe('Exact text to replace.'),
    new_string: z.string().describe('Replacement text.'),
    replace_all: z.boolean().optional().describe('Replace every occurrence instead of requiring a unique match.'),
  }),
  requiresApproval: true,
  async preview(input, context) {
    const file = context.workspace.resolve(input.path);
    const rel = context.workspace.relative(file);
    // Fail before asking for approval, not after the user has approved a diff that cannot be applied.
    requireRead(file, input.path, context);
    const before = await readFile(file, 'utf8');
    return { title: `Edit ${rel}`, diff: unifiedDiff(rel, before, applyEdit(before, input)) };
  },
  async run(input, context) {
    const file = context.workspace.resolve(input.path);
    if (!existsSync(file)) throw new ToolError(`File not found: ${input.path}`);
    requireRead(file, input.path, context);
    const bytes = await readFile(file);
    const before = bytes.toString('utf8');
    const after = applyEdit(before, input);
    await writeFile(file, after, 'utf8');
    const rel = context.workspace.relative(file);
    return {
      content: `Edited ${rel}.\n${unifiedDiff(rel, before, after)}`,
      summary: `Edited ${rel}`,
      path: rel,
      undo: { path: rel, before: bytes, afterHash: sha256(after) },
    };
  },
});

// Keep whole lines when possible. An overlong first line is split at a Unicode-safe boundary and continued explicitly.
export function fitLines(lines: string[], budget: number): { text: string; lines: number; cutLine: boolean } {
  let size = 0;
  let count = 0;
  for (const line of lines) {
    const next = size + line.length + (count > 0 ? 1 : 0);
    if (next > budget) break;
    size = next;
    count++;
  }
  if (count === 0 && lines.length > 0) {
    const line = lines[0] ?? '';
    const end = splitsSurrogatePair(line, budget) ? budget - 1 : budget;
    return { text: line.slice(0, end), lines: 1, cutLine: true };
  }
  return { text: lines.slice(0, count).join('\n'), lines: count, cutLine: false };
}

function splitsSurrogatePair(text: string, offset: number): boolean {
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

function requireRead(file: string, path: string, context: ToolContext): void {
  if (!context.readFiles.has(file)) {
    throw new ToolError(
      `${path} has not been read in this chat. Call read_file on it first, and wait for the result before editing (do not send the read and the edit in the same batch).`,
    );
  }
}

// Exported for tests. Matching tolerates the file using CRLF while the model sends LF.
export function applyEdit(
  content: string,
  { old_string, new_string, replace_all = false }: { old_string: string; new_string: string; replace_all?: boolean },
): string {
  const eol = detectEol(content);
  const find = eol === '\r\n' ? old_string.replace(/\r?\n/g, '\r\n') : old_string;
  const replacement = eol === '\r\n' ? new_string.replace(/\r?\n/g, '\r\n') : new_string;

  const count = content.split(find).length - 1;
  if (count === 0) {
    throw new ToolError('old_string was not found in the file. Read the file again and copy the text exactly.');
  }
  if (count > 1 && !replace_all) {
    throw new ToolError(
      `old_string appears ${count} times. Add surrounding lines to make it unique, or set replace_all.`,
    );
  }
  return replace_all ? content.split(find).join(replacement) : content.replace(find, () => replacement);
}

export function unifiedDiff(path: string, before: string, after: string): string {
  return createTwoFilesPatch(`a/${path}`, `b/${path}`, before, after, '', '', { context: 3 });
}
