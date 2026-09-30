import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  applyChatEvent,
  type ApprovalDecision,
  type ChatEvent,
  type ChatSnapshot,
  type TranscriptItem,
  type UsageTotals,
  type UserMessage,
} from '@shared/chat';
import type { UndoResult } from '@shared/ipc';
import type { ApprovalMode } from '@shared/settings';
import type { CompletionClient, Conversation, SerializedConversation } from '../llm/types';
import type { AgentTool, EditUndo, ToolContext } from '../tools/types';
import { compactionPrompt } from '../llm/compaction';
import { Agent, type DroppedFieldError } from './agent';

export interface SavedChat {
  version: 1;
  id: string;
  title: string;
  projectPath: string | null;
  createdAt: string;
  updatedAt: string;
  system: string;
  transcript: TranscriptItem[];
  usage: UsageTotals;
  conversation: SerializedConversation;
  readFiles: string[];
  pendingNotes?: string[];
  agentFile?: string | null;
  resumable?: boolean;
  // False for custom OpenAI-compatible endpoints, whose prices are unknown. Missing in chats saved by older versions.
  officialPricing?: boolean;
}

export interface ChatSessionOptions {
  id?: string;
  title?: string;
  createdAt?: string;
  projectPath: string | null;
  conversation: Conversation;
  officialPricing?: boolean;
  system: string;
  agentFile: string | null;
  tools: () => AgentTool[];
  transcript?: TranscriptItem[];
  usage?: UsageTotals;
  readFiles?: string[];
  pendingNotes?: string[];
  resumable?: boolean;
  approvalMode: () => ApprovalMode;
  isPreApproved?: (toolName: string, input: unknown) => boolean;
  toolContext: (base: Pick<ToolContext, 'signal' | 'readFiles' | 'onProgress'>) => ToolContext;
  smallModel: (conversation: Conversation) => CompletionClient | null;
  onDroppedFields?: (error: DroppedFieldError) => void;
  // Keeps what is needed to undo an approved edit. Throwing means the edit cannot be undone.
  onEditApplied?: (toolId: string, edit: EditUndo) => void;
  onEvent: (event: ChatEvent) => void;
  // immediate is true when a task just finished, so the chat can be saved right away.
  onChange: (immediate: boolean) => void;
}

// One chat: its model conversation, transcript, pending approvals and the files read in it.
export class ChatSession {
  readonly id: string;
  readonly createdAt: string;
  title: string;
  private transcript: TranscriptItem[];
  private readonly readFiles: Set<string>;
  private readonly agent: Agent;
  private readonly approvals = new Map<string, (decision: ApprovalDecision) => void>();
  private controller: AbortController | null = null;
  private titleController: AbortController | null = null;
  private disposed = false;
  private resumable: boolean;
  private stopRequested = false;
  private updatedAt: string;
  // Things that happened to the project outside the conversation, for the model's next message.
  private readonly notes: string[];

  constructor(private readonly options: ChatSessionOptions) {
    this.id = options.id ?? randomUUID();
    this.createdAt = options.createdAt ?? new Date().toISOString();
    this.updatedAt = this.createdAt;
    this.title = options.title ?? 'New chat';
    this.transcript = options.transcript ? closeStaleToolRows(options.transcript) : [];
    this.readFiles = new Set(options.readFiles ?? []);
    this.notes = [...(options.pendingNotes ?? [])];
    // A chat whose saved history ends in unanswered tool calls was interrupted by a crash; it resumes like a
    // user-stopped run.
    this.resumable = (options.resumable ?? false) || options.conversation.hasPendingToolCalls();
    this.agent = new Agent({
      conversation: options.conversation,
      system: options.system,
      tools: options.tools,
      approvalMode: options.approvalMode,
      isPreApproved: options.isPreApproved,
      requestApproval: (id, signal) => this.waitForApproval(id, signal),
      toolContext: (signal, onProgress) => options.toolContext({ signal, onProgress, readFiles: this.readFiles }),
      onCheckpoint: () => this.options.onChange(true),
      emit: (event) => this.emit(event),
      onDroppedFields: options.onDroppedFields,
      onEditApplied: options.onEditApplied,
    });
    if (options.usage) {
      const usage = { ...options.usage };
      // Older OpenAI totals included cache reads in input. Normalize once when loading the old shape.
      if (options.conversation.provider === 'openai' && usage.cacheWriteTokens === undefined) {
        usage.inputTokens = Math.max(0, usage.inputTokens - usage.cacheReadTokens);
      }
      this.agent.totals = usage;
    }
  }

  get busy(): boolean {
    return this.controller !== null;
  }

  get isEmpty(): boolean {
    return this.transcript.length === 0;
  }

  snapshot(): ChatSnapshot {
    return {
      id: this.id,
      title: this.title,
      projectPath: this.options.projectPath,
      model: this.options.conversation.model,
      officialPricing: this.options.officialPricing ?? this.options.conversation.provider === 'anthropic',
      transcript: this.transcript,
      busy: this.busy,
      resumable: this.resumable,
      usage: this.agent.totals,
      agentFile: this.options.agentFile,
    };
  }

  async send(message: UserMessage): Promise<void> {
    if (this.busy) throw new Error('The assistant is still working. Stop it or wait for it to finish.');
    const text = message.text.trim();
    if (!text && !message.images?.length) return;

    const isFirst = !this.transcript.some((item) => item.kind === 'user');
    this.setResumable(false);
    this.emit({ type: 'user', id: randomUUID(), text, imageCount: message.images?.length ?? 0 });
    if (isFirst) void this.generateTitle(text);

    // What the user did to the project since the last message (undone edits) is told to the model with this one.
    const note = this.takeNotes();
    const modelText = `${note}${text || '(see attached images)'}`;
    return this.run((signal) => this.agent.send({ text: modelText, images: message.images }, signal));
  }

  async resume(): Promise<void> {
    if (this.busy) throw new Error('The assistant is still working. Stop it or wait for it to finish.');
    if (!this.resumable) throw new Error('There is no stopped run to resume.');
    this.setResumable(false);
    const note = this.takeNotes().trim();
    return this.run((signal) => this.agent.resume(signal, note));
  }

  // The edit of a tool card was undone by the user (the file has already been put back). The model is told with the
  // next message, and must read the file again before it edits it: what it last read is no longer what is on disk.
  editUndone(toolId: string, result: UndoResult, absolutePath: string): void {
    this.readFiles.delete(absolutePath);
    this.notes.push(
      result.action === 'deleted'
        ? `The user undid your creation of ${result.path}: the file was deleted.`
        : `The user undid your edit to ${result.path}: the file is back to how it was before that edit. Read it again before editing it.`,
    );
    this.emit({ type: 'tool-undone', id: toolId });
  }

  private takeNotes(): string {
    if (this.notes.length === 0) return '';
    const text = `[Note from the app: ${this.notes.join(' ')}]\n\n`;
    this.notes.length = 0;
    return text;
  }

  private async run(work: (signal: AbortSignal) => Promise<boolean>): Promise<void> {
    const controller = new AbortController();
    this.controller = controller;
    this.stopRequested = false;
    let interrupted = false;
    this.emit({ type: 'busy', busy: true });
    try {
      interrupted = await work(controller.signal);
    } catch (error) {
      if (controller.signal.aborted) {
        interrupted = true;
        this.emit({ type: 'notice', id: randomUUID(), text: 'Stopped.' });
      } else {
        this.emit({ type: 'error', id: randomUUID(), text: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      // A stop that arrives as the run finishes on its own leaves nothing to resume.
      const stopped = this.stopRequested && interrupted;
      this.controller = null;
      this.rejectPendingApprovals();
      if (stopped) this.setResumable(true);
      this.emit({ type: 'busy', busy: false });
    }
  }

  // Replaces the older turns, in what is sent to the model, by a summary written by the small model. The stored
  // history is not changed. Nothing is done when there is too little history to be worth it.
  async compact(): Promise<void> {
    if (this.busy) throw new Error('The assistant is still working. Stop it or wait for it to finish.');
    const { conversation } = this.options;
    const plan = conversation.planCompaction();
    if (!plan) {
      this.emit({ type: 'notice', id: randomUUID(), text: 'There is not enough older history to compact yet.' });
      return;
    }
    const summarizer = this.options.smallModel(this.options.conversation);
    if (!summarizer) throw new Error('Compacting needs an API key for the summarizing model. Add one in Settings.');

    const controller = new AbortController();
    this.controller = controller;
    this.stopRequested = false;
    this.emit({ type: 'busy', busy: true });
    try {
      const { summary } = await summarizer.complete(
        compactionPrompt(plan.text),
        z.object({ summary: z.string() }),
        controller.signal,
      );
      // A stop that came in while the answer was being written wins: nothing is applied.
      if (controller.signal.aborted) throw new DOMException('aborted', 'AbortError');
      conversation.applyCompaction(summary, plan.keepFrom);
      this.agent.forgetContextSize();
      this.emit({
        type: 'notice',
        id: randomUUID(),
        text: `Compacted ${plan.messages} earlier messages into a summary. The next request re-reads the whole prompt once; the full history stays saved with this chat.`,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        this.emit({ type: 'notice', id: randomUUID(), text: 'Compacting stopped. The chat is unchanged.' });
      } else {
        this.emit({
          type: 'error',
          id: randomUUID(),
          text: `Compacting failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    } finally {
      this.controller = null;
      this.emit({ type: 'busy', busy: false });
    }
  }

  stop(): void {
    if (!this.controller) return;
    this.stopRequested = true;
    this.controller?.abort();
    this.rejectPendingApprovals();
  }

  dispose(): void {
    this.disposed = true;
    this.titleController?.abort();
    this.stop();
  }

  decide(approvalId: string, decision: ApprovalDecision): void {
    this.approvals.get(approvalId)?.(decision);
  }

  serialize(): SavedChat {
    return {
      version: 1,
      id: this.id,
      title: this.title,
      projectPath: this.options.projectPath,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      system: this.options.system,
      transcript: this.transcript,
      usage: this.agent.totals,
      conversation: this.options.conversation.serialize(),
      readFiles: [...this.readFiles],
      pendingNotes: [...this.notes],
      agentFile: this.options.agentFile,
      resumable: this.resumable,
      officialPricing: this.options.officialPricing ?? this.options.conversation.provider === 'anthropic',
    };
  }

  private emit(event: ChatEvent): void {
    if (this.disposed) return;
    this.transcript = applyChatEvent(this.transcript, event);
    this.updatedAt = new Date().toISOString();
    this.options.onEvent(event);
    if (event.type !== 'assistant-delta' && event.type !== 'thinking-delta' && event.type !== 'tool-progress') {
      this.options.onChange(event.type === 'busy' && !event.busy);
    }
  }

  private setResumable(resumable: boolean): void {
    if (this.resumable === resumable) return;
    this.resumable = resumable;
    this.emit({ type: 'resumable', resumable });
  }

  private waitForApproval(id: string, signal: AbortSignal): Promise<ApprovalDecision> {
    if (signal.aborted) return Promise.resolve({ approved: false });
    return new Promise((resolve) => {
      this.approvals.set(id, (decision) => {
        this.approvals.delete(id);
        resolve(decision);
      });
    });
  }

  private rejectPendingApprovals(): void {
    for (const resolve of [...this.approvals.values()]) resolve({ approved: false });
  }

  private async generateTitle(firstMessage: string): Promise<void> {
    const fallback =
      firstMessage.split(/\s+/).slice(0, 6).join(' ') + (firstMessage.split(/\s+/).length > 6 ? '…' : '');
    let title = fallback || 'New chat';
    const model = this.options.smallModel(this.options.conversation);
    if (model) {
      try {
        const controller = new AbortController();
        this.titleController = controller;
        const result = await model.complete(
          `Write a short title (2 to 5 words, no quotes or punctuation at the end) for a coding chat that starts with this request:\n\n${firstMessage.slice(0, 2000)}`,
          z.object({ title: z.string() }),
          controller.signal,
        );
        title = result.title.trim().slice(0, 80) || title;
      } catch {
        // Keep the fallback title; a missing title is not worth an error in the chat.
      } finally {
        this.titleController = null;
      }
    }
    if (this.disposed) return;
    this.title = title;
    this.emit({ type: 'title', title });
  }
}

// A chat saved while a crash interrupted it can hold tool rows that never finished (the crash happened before
// their end event was saved). No session is running while a chat is being loaded, so such rows are stale; mark
// them failed so they do not render as running forever.
function closeStaleToolRows(items: TranscriptItem[]): TranscriptItem[] {
  return items.map((item) => {
    if (item.kind !== 'tool' || (item.status !== 'running' && item.status !== 'awaiting-approval')) return item;
    return {
      ...item,
      status: 'error' as const,
      summary: `${item.name} was interrupted`,
      output: item.output ?? 'Interrupted by an app restart before this action finished.',
    };
  });
}
