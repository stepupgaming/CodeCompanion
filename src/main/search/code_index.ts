import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { EMBEDDING_MODEL } from '@shared/models';
import { readJson, writeJson } from '../storage/json_file';
import { fileSize, isBinaryFile } from '../tools/text_files';
import { defineTool, type AgentTool, type CodeSearch } from '../tools/types';
import type { Workspace } from '../tools/workspace';
import { chunkFile } from './chunker';

// Bump when chunking or storage changes so existing indexes are rebuilt.
const INDEX_VERSION = 1;
const MAX_FILE_BYTES = 256 * 1024;
const EMBED_BATCH = 64;

export interface Embedder {
  readonly model: string;
  embed(texts: string[], signal?: AbortSignal): Promise<number[][]>;
}

interface IndexedChunk {
  startLine: number;
  endLine: number;
  // Float32 vector, base64 encoded to keep the index file small.
  vector: string;
}

interface IndexedFile {
  mtimeMs: number;
  size: number;
  chunks: IndexedChunk[];
}

interface StoredIndex {
  version: number;
  model: string;
  root: string;
  files: Record<string, IndexedFile>;
}

export interface SearchHit {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  text: string;
}

export interface UpdateProgress {
  embedded: number;
  total: number;
}

// Semantic index of one project. Stored in userData/indexes/<hash of project path>.json.
export class CodeIndex implements CodeSearch {
  private data: StoredIndex;
  private vectors = new Map<string, Float32Array[]>();
  private updating: Promise<void> | null = null;
  private progress: UpdateProgress | null = null;

  constructor(
    private readonly workspace: Workspace,
    private readonly embedder: Embedder,
    indexDir: string,
    private readonly maxFiles: () => number,
  ) {
    this.file = join(indexDir, `${createHash('sha1').update(workspace.root).digest('hex')}.json`);
    const stored = readJson<StoredIndex | null>(this.file, null);
    this.data =
      stored?.version === INDEX_VERSION && stored.model === embedder.model && stored.root === workspace.root
        ? stored
        : { version: INDEX_VERSION, model: embedder.model, root: workspace.root, files: {} };
  }

  private readonly file: string;

  // Re-embeds new and changed files and drops deleted ones. Concurrent callers share one update.
  update(signal?: AbortSignal, onProgress?: (progress: UpdateProgress) => void): Promise<void> {
    this.updating ??= this.runUpdate(signal, (progress) => {
      this.progress = progress;
      onProgress?.(progress);
    }).finally(() => {
      this.updating = null;
      this.progress = null;
    });
    return this.updating;
  }

  async search(query: string, limit: number, signal: AbortSignal): Promise<SearchHit[]> {
    await this.update(signal);
    const [queryVector] = await this.embedder.embed([query], signal);
    if (!queryVector) throw new Error('The embedding service returned no vector for the query.');
    const q = normalize(Float32Array.from(queryVector));

    const scored: Array<{ path: string; chunk: IndexedChunk; score: number }> = [];
    for (const [path, file] of Object.entries(this.data.files)) {
      const vectors = this.vectorsFor(path, file);
      file.chunks.forEach((chunk, i) => {
        const vector = vectors[i];
        if (vector) scored.push({ path, chunk, score: dot(q, vector) });
      });
    }
    scored.sort((a, b) => b.score - a.score);

    // At most two hits per file so one large file cannot crowd out the rest.
    const perFile = new Map<string, number>();
    const hits: SearchHit[] = [];
    for (const candidate of scored) {
      if (hits.length >= limit) break;
      const count = perFile.get(candidate.path) ?? 0;
      if (count >= 2) continue;
      perFile.set(candidate.path, count + 1);
      hits.push({
        path: candidate.path,
        startLine: candidate.chunk.startLine,
        endLine: candidate.chunk.endLine,
        score: candidate.score,
        text: await this.readLines(candidate.path, candidate.chunk.startLine, candidate.chunk.endLine),
      });
    }
    return hits;
  }

  // Throws away everything indexed so far and embeds the whole project again.
  async rebuild(signal?: AbortSignal, onProgress?: (progress: UpdateProgress) => void): Promise<void> {
    await this.updating?.catch(() => {});
    this.data.files = {};
    this.vectors.clear();
    writeJson(this.file, this.data);
    await this.update(signal, onProgress);
  }

  get fileCount(): number {
    return Object.keys(this.data.files).length;
  }

  get chunkCount(): number {
    return Object.values(this.data.files).reduce((sum, file) => sum + file.chunks.length, 0);
  }

  get isUpdating(): boolean {
    return this.updating !== null;
  }

  // Chunks embedded so far in the running update; null while idle or still scanning files.
  get updateProgress(): UpdateProgress | null {
    return this.progress;
  }

  private async runUpdate(signal?: AbortSignal, onProgress?: (progress: UpdateProgress) => void): Promise<void> {
    const files = await this.workspace.listFiles(this.workspace.root, this.maxFiles());
    const current = new Set<string>();
    const pending: Array<{ path: string; mtimeMs: number; size: number; content: string }> = [];

    for (const absolute of files) {
      const path = this.workspace.relative(absolute);
      current.add(path);
      const info = await stat(absolute);
      const existing = this.data.files[path];
      if (existing && existing.mtimeMs === info.mtimeMs && existing.size === info.size) continue;
      if (info.size > MAX_FILE_BYTES || info.size === 0 || (await isBinaryFile(absolute))) {
        delete this.data.files[path];
        continue;
      }
      pending.push({ path, mtimeMs: info.mtimeMs, size: info.size, content: await readFile(absolute, 'utf8') });
    }

    let changed = false;
    for (const path of Object.keys(this.data.files)) {
      if (!current.has(path)) {
        delete this.data.files[path];
        this.vectors.delete(path);
        changed = true;
      }
    }

    const work = pending.flatMap((file) => chunkFile(file.path, file.content).map((chunk) => ({ file, chunk })));
    const results = new Map<string, IndexedChunk[]>();
    for (let i = 0; i < work.length; i += EMBED_BATCH) {
      signal?.throwIfAborted();
      const batch = work.slice(i, i + EMBED_BATCH);
      const vectors = await this.embedder.embed(
        batch.map((item) => item.chunk.text),
        signal,
      );
      batch.forEach((item, j) => {
        const vector = vectors[j];
        if (!vector) return;
        const list = results.get(item.file.path) ?? [];
        list.push({
          startLine: item.chunk.startLine,
          endLine: item.chunk.endLine,
          vector: encode(normalize(Float32Array.from(vector))),
        });
        results.set(item.file.path, list);
      });
      onProgress?.({ embedded: Math.min(i + EMBED_BATCH, work.length), total: work.length });
    }

    for (const file of pending) {
      this.data.files[file.path] = { mtimeMs: file.mtimeMs, size: file.size, chunks: results.get(file.path) ?? [] };
      this.vectors.delete(file.path);
      changed = true;
    }
    if (changed) writeJson(this.file, this.data);
  }

  private vectorsFor(path: string, file: IndexedFile): Float32Array[] {
    let vectors = this.vectors.get(path);
    if (!vectors) {
      vectors = file.chunks.map((chunk) => decode(chunk.vector));
      this.vectors.set(path, vectors);
    }
    return vectors;
  }

  private async readLines(path: string, start: number, end: number): Promise<string> {
    try {
      const absolute = this.workspace.resolve(path);
      if ((await fileSize(absolute)) > MAX_FILE_BYTES) return '';
      return (await readFile(absolute, 'utf8'))
        .split(/\r?\n/)
        .slice(start - 1, end)
        .join('\n');
    } catch {
      return '';
    }
  }
}

function normalize(vector: Float32Array): Float32Array {
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm) || 1;
  return vector.map((value) => value / norm);
}

function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] ?? 0) * (b[i] ?? 0);
  return sum;
}

function encode(vector: Float32Array): string {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength).toString('base64');
}

function decode(base64: string): Float32Array {
  const buffer = Buffer.from(base64, 'base64');
  return new Float32Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
}

export function searchCodeTool(index: CodeIndex): AgentTool {
  return defineTool({
    name: 'search_code',
    description:
      'Semantic search over the project code. Describe what you are looking for in natural language (e.g. "where user sessions are validated"). Returns the most relevant code snippets with file paths and line numbers. Use grep for exact names.',
    schema: z.object({
      query: z.string().min(3),
      limit: z.number().int().min(1).max(20).optional().describe('Number of snippets (default 8).'),
    }),
    requiresApproval: false,
    async run({ query, limit = 8 }, context) {
      await index.update(context.signal, ({ embedded, total }) =>
        context.onProgress(`Indexing project: ${embedded}/${total} chunks\n`),
      );
      const hits = await index.search(query, limit, context.signal);
      const content = hits.map((hit) => `${hit.path}:${hit.startLine}-${hit.endLine}\n${hit.text}`).join('\n\n---\n\n');
      return {
        content: content || 'No matches.',
        summary: `Searched code for "${query}" (${hits.length} results)`,
      };
    },
  });
}

export function openAIEmbedder(client: {
  embeddings: {
    create(
      body: { model: string; input: string[] },
      options?: { signal?: AbortSignal },
    ): Promise<{ data: Array<{ embedding: number[]; index: number }> }>;
  };
}): Embedder {
  return {
    model: EMBEDDING_MODEL,
    async embed(texts, signal) {
      const response = await client.embeddings.create({ model: EMBEDDING_MODEL, input: texts }, { signal });
      return response.data.sort((a, b) => a.index - b.index).map((item) => item.embedding);
    },
  };
}
