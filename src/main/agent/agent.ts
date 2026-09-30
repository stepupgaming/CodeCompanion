import { randomUUID } from 'node:crypto';
import type { ApprovalDecision, ChatEvent, UsageTotals } from '@shared/chat';
import type { ApprovalMode } from '@shared/settings';
import type { Conversation, ToolCall, ToolResult, UserInput } from '../llm/types';
import { toToolSpecs } from '../tools/registry';
import { ToolError, type AgentTool, type EditUndo, type ToolContext, type ToolPreview } from '../tools/types';
import { abortableSleep, MAX_RETRIES, retryDecision } from './retry';

// Safety net against a model that never stops calling tools.
const MAX_TURNS = 200;
const RESUME_INSTRUCTION =
  'Continue the task that I stopped. Use the completed conversation and tool results above; do not repeat the original request. Some interrupted tool actions may have completed even when their result says they were stopped, so inspect the current state before repeating any action with side effects.';

// A tool call whose input left out required fields. Field names only, never their values (they can hold file contents).
export interface DroppedFieldError {
  tool: string;
  model: string;
  missing: string[];
  // Other fields that failed validation, e.g. a number where a string was expected.
  invalid: string[];
  received: string[];
}

export interface AgentOptions {
  conversation: Conversation;
  system: string;
  // Asked for on every turn, so tools that become available mid-chat (e.g. after an API key is saved) are offered.
  tools: () => AgentTool[];
  approvalMode: () => ApprovalMode;
  // True for a call the user allowed in advance (see the allowedCommands setting); it then skips the approval card.
  isPreApproved?: (toolName: string, input: unknown) => boolean;
  requestApproval: (id: string, signal: AbortSignal) => Promise<ApprovalDecision>;
  toolContext: (signal: AbortSignal, onProgress: (text: string) => void) => ToolContext;
  // Called after every tool-result batch is appended to the conversation, so a crash mid-task can be resumed
  // from the last completed batch instead of losing the whole run.
  onCheckpoint?: () => void;
  emit: (event: ChatEvent) => void;
  // Called when a tool call is rejected because required fields are missing, so the failure rate can be measured.
  onDroppedFields?: (error: DroppedFieldError) => void;
  // Called with what is needed to undo an edit that was just made. Throwing means no backup was kept.
  onEditApplied?: (toolId: string, edit: EditUndo) => void;
  // Test hooks for the retry backoff: how to wait, and the jitter (0 to 1).
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
}

// Runs the model/tool loop for one user message: call the model, run the tools it asks for (with approval where
// needed), send the results back, and repeat until the model answers without tool calls.
export class Agent {
  private usage: UsageTotals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

  constructor(private readonly options: AgentOptions) {}

  get totals(): UsageTotals {
    return { ...this.usage, ...(this.usage.longContext ? { longContext: { ...this.usage.longContext } } : {}) };
  }

  set totals(value: UsageTotals) {
    this.usage = { ...value, cacheWriteTokens: value.cacheWriteTokens ?? 0 };
  }

  // The size of the prompt is not known any more after the history was compacted; the next request reports it.
  forgetContextSize(): void {
    delete this.usage.contextTokens;
    this.options.emit({ type: 'usage', totals: this.totals });
  }

  // send and resume resolve to true when the run was cut short by a stop, and false when it finished on its own.
  async send(input: UserInput, signal: AbortSignal): Promise<boolean> {
    this.options.conversation.addUserMessage(input);
    return this.run(signal);
  }

  // `note` is anything the model must be told that happened while the task was stopped, e.g. an undone edit.
  async resume(signal: AbortSignal, note = ''): Promise<boolean> {
    this.options.conversation.addUserMessage({ text: note ? `${note}\n\n${RESUME_INSTRUCTION}` : RESUME_INSTRUCTION });
    return this.run(signal);
  }

  private async run(signal: AbortSignal): Promise<boolean> {
    const { conversation, emit } = this.options;

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      if (signal.aborted) return true;
      const tools = this.options.tools();
      const { result, messageId } = await this.runTurnWithRetries(tools, signal);
      emit({ type: 'assistant-end', id: messageId, text: result.text });

      this.usage.inputTokens += result.usage.inputTokens;
      this.usage.outputTokens += result.usage.outputTokens;
      this.usage.cacheReadTokens += result.usage.cacheReadTokens;
      this.usage.cacheWriteTokens = (this.usage.cacheWriteTokens ?? 0) + (result.usage.cacheWriteTokens ?? 0);
      this.usage.contextTokens = result.contextTokens;
      if (result.usage.longContext) {
        const long = this.usage.longContext
          ? { ...this.usage.longContext }
          : {
              inputTokens: 0,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
            };
        long.inputTokens += result.usage.inputTokens;
        long.outputTokens += result.usage.outputTokens;
        long.cacheReadTokens += result.usage.cacheReadTokens;
        long.cacheWriteTokens += result.usage.cacheWriteTokens ?? 0;
        this.usage.longContext = long;
      }
      emit({ type: 'usage', totals: this.totals });

      if (result.stopReason === 'refusal') {
        emit({ type: 'notice', id: randomUUID(), text: result.refusal ?? 'The model declined this request.' });
      }
      if (result.stopReason === 'context_exceeded') {
        emit({
          type: 'notice',
          id: randomUUID(),
          text: 'The conversation is too long for the model. Start a new chat.',
        });
      }
      if (result.stopReason === 'refusal') {
        // Tool calls that came with a refusal are not run, but each still gets a result: the history would otherwise
        // hold a call without one, and every later request in the chat would be rejected.
        if (result.toolCalls.length > 0) {
          conversation.addToolResults(
            result.toolCalls.map((call) => ({
              id: call.id,
              content: 'Not run: the response was stopped by a refusal.',
              isError: true,
            })),
          );
        }
        return false;
      }
      if (result.toolCalls.length === 0) {
        if (result.stopReason === 'max_tokens') {
          emit({ type: 'notice', id: randomUUID(), text: 'The response hit the output limit and may be incomplete.' });
        }
        return false;
      }

      // A response cut off by the output limit or by a full context window may have cut off a tool input too.
      const truncated = result.stopReason === 'max_tokens' || result.stopReason === 'context_exceeded';
      const { results, stop } = await this.runTools(tools, result.toolCalls, truncated, signal);
      conversation.addToolResults(results);
      this.options.onCheckpoint?.();
      if (stop || signal.aborted) return signal.aborted;
    }

    emit({ type: 'notice', id: randomUUID(), text: `Stopped after ${MAX_TURNS} steps.` });
    return false;
  }

  // Repeats a model request that failed for a reason that usually passes (rate limit, server error, dropped
  // connection), after a backoff, and says so in the chat. The conversation only records a turn once it has
  // succeeded, so repeating the request cannot duplicate anything in the history.
  //
  // Each attempt streams into its own message. A failed attempt that is retried is discarded, so the notice comes
  // before the answer; one that is not retried keeps whatever text it streamed.
  private async runTurnWithRetries(tools: AgentTool[], signal: AbortSignal) {
    const { conversation, emit } = this.options;
    for (let retries = 0; ; retries++) {
      const messageId = randomUUID();
      emit({ type: 'assistant-start', id: messageId });
      try {
        const result = await conversation.runTurn({
          system: this.options.system,
          tools: toToolSpecs(tools),
          signal,
          callbacks: {
            onText: (text) => emit({ type: 'assistant-delta', id: messageId, text }),
            onThinking: (text) => emit({ type: 'thinking-delta', id: messageId, text }),
            onRestart: () => emit({ type: 'assistant-restart', id: messageId }),
          },
        });
        return { result, messageId };
      } catch (error) {
        const decision = signal.aborted ? null : retryDecision(error, retries, this.options.random);
        if (!decision) {
          emit({ type: 'assistant-end', id: messageId });
          throw error;
        }

        emit({ type: 'assistant-restart', id: messageId });
        emit({ type: 'assistant-end', id: messageId });
        const seconds = Math.max(1, Math.round(decision.delayMs / 1000));
        emit({
          type: 'notice',
          id: randomUUID(),
          text: `${decision.reason}. Retrying in ${seconds} s (retry ${retries + 1} of ${MAX_RETRIES})…`,
        });
        await (this.options.sleep ?? abortableSleep)(decision.delayMs, signal);
      }
    }
  }

  // True when the backup of an approved edit was kept, which is what makes the card offer Undo. A backup that cannot
  // be kept only means there is no Undo; the edit itself is already done and is reported as usual.
  private keepUndo(toolId: string, edit: EditUndo): boolean {
    if (!this.options.onEditApplied) return false;
    try {
      this.options.onEditApplied(toolId, edit);
      return true;
    } catch {
      return false;
    }
  }

  // Every tool call gets a result, even when skipped, because the API requires one per call.
  private async runTools(
    tools: AgentTool[],
    calls: ToolCall[],
    truncated: boolean,
    signal: AbortSignal,
  ): Promise<{ results: ToolResult[]; stop: boolean }> {
    const results: ToolResult[] = [];
    let stop = false;

    for (const call of calls) {
      if (signal.aborted) {
        results.push({ id: call.id, content: 'Not run: the user stopped the task.', isError: true });
        continue;
      }
      if (stop) {
        results.push({ id: call.id, content: 'Not run: the user declined an earlier action.', isError: true });
        continue;
      }
      if (truncated) {
        results.push({
          id: call.id,
          content:
            'Not run: your response hit the output limit and this tool input may be cut off. Retry with smaller changes.',
          isError: true,
        });
        continue;
      }

      const outcome = await this.runTool(tools, call, signal);
      results.push(outcome.result);
      if (outcome.declinedWithoutFeedback) stop = true;
    }
    return { results, stop };
  }

  private async runTool(
    tools: AgentTool[],
    call: ToolCall,
    signal: AbortSignal,
  ): Promise<{ result: ToolResult; declinedWithoutFeedback?: boolean }> {
    const { emit } = this.options;
    const tool = tools.find((candidate) => candidate.name === call.name);
    // Provider IDs pair API results only; compatible servers can reuse them across turns.
    const eventId = randomUUID();

    if (!tool) {
      return { result: { id: call.id, content: `Unknown tool: ${call.name}`, isError: true } };
    }

    // Streamed tool inputs are not validated by the API, so check them here before doing anything. Zod for
    // built-in tools; for MCP tools (JSON Schema only) a structural check, since the server validates the rest.
    const parsed = tool.schema?.safeParse(call.input);
    if (parsed && !parsed.success) {
      const missing: string[] = [];
      const invalid: string[] = [];
      const issues = parsed.error.issues
        .map((issue) => {
          const name = issue.path.join('.') || 'input';
          const isMissing = /received undefined/.test(issue.message);
          (isMissing ? missing : invalid).push(name);
          return isMissing ? `${name}: required but missing` : `${name}: ${issue.message}`;
        })
        .join('; ');
      const receivedFields =
        call.input && typeof call.input === 'object' && !Array.isArray(call.input) ? Object.keys(call.input) : null;
      if (missing.length > 0) {
        this.options.onDroppedFields?.({
          tool: call.name,
          model: this.options.conversation.model,
          missing,
          invalid,
          received: receivedFields ?? [],
        });
      }
      const received = receivedFields ? ` Received fields: ${receivedFields.join(', ') || '(none)'}.` : '';
      return {
        result: {
          id: call.id,
          content: `Invalid input for ${tool.name}: ${issues}.${received} Send every required field and try again.`,
          isError: true,
        },
      };
    }
    const schemaProblem = parsed ? undefined : jsonSchemaProblem(tool, call.input);
    if (schemaProblem) {
      return {
        result: {
          id: call.id,
          content: `Invalid input for ${tool.name}: ${schemaProblem} Send every required field and try again.`,
          isError: true,
        },
      };
    }
    const input = (parsed?.success ? parsed.data : call.input) as Record<string, unknown>;
    const onProgress = (text: string) => emit({ type: 'tool-progress', id: eventId, text });
    const context = this.options.toolContext(signal, onProgress);

    const needsApproval =
      tool.requiresApproval && this.options.approvalMode() === 'ask' && !this.options.isPreApproved?.(tool.name, input);
    let preview: ToolPreview | undefined;
    if (tool.preview) {
      try {
        preview = await tool.preview(input, context);
      } catch (error) {
        // A preview that cannot be built (e.g. edit target missing) means the call would fail anyway.
        const message = error instanceof Error ? error.message : String(error);
        emit({ type: 'tool-start', id: eventId, name: tool.name, awaitingApproval: false });
        emit({ type: 'tool-end', id: eventId, status: 'error', summary: `${tool.name} failed`, output: message });
        return { result: { id: call.id, content: message, isError: true } };
      }
    }

    emit({ type: 'tool-start', id: eventId, name: tool.name, preview, awaitingApproval: needsApproval });

    if (needsApproval) {
      const decision = await this.options.requestApproval(eventId, signal);
      if (signal.aborted) {
        const content =
          'Stopped by the user before this action was approved. Do not assume it ran; inspect the current state before attempting it again.';
        emit({ type: 'tool-end', id: eventId, status: 'error', summary: 'Stopped', output: content });
        return { result: { id: call.id, content, isError: true } };
      }
      if (!decision.approved) {
        const feedback = decision.feedback?.trim();
        emit({ type: 'tool-end', id: eventId, status: 'declined', summary: 'Declined', output: feedback });
        return {
          result: {
            id: call.id,
            content: feedback
              ? `The user declined this action and said: ${feedback}`
              : 'The user declined this action. Wait for further instructions.',
            isError: true,
          },
          declinedWithoutFeedback: !feedback,
        };
      }
      emit({ type: 'tool-running', id: eventId });
    }

    try {
      const output = await tool.run(input, context);
      emit({
        type: 'tool-end',
        id: eventId,
        status: output.isError ? 'error' : 'done',
        summary: output.summary ?? tool.name,
        path: output.path,
        output: tool.name === 'run_command' || tool.name === 'command_output' ? output.content : undefined,
        undoable: output.undo && !output.isError ? this.keepUndo(eventId, output.undo) : undefined,
      });
      return { result: { id: call.id, content: output.content, isError: output.isError, images: output.images } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const expected = error instanceof ToolError;
      emit({ type: 'tool-end', id: eventId, status: 'error', summary: `${tool.name} failed`, output: message });
      return { result: { id: call.id, content: expected ? message : `Error: ${message}`, isError: true } };
    }
  }
}

// Structural check for tools that only declare a JSON Schema (MCP): the server validates the input fully when the
// call arrives, but catching obviously broken input here saves a round trip and reads better in the transcript.
function jsonSchemaProblem(tool: AgentTool, input: unknown): string | null {
  if (!tool.jsonSchema) return null;
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return 'input must be a JSON object.';
  }
  const missing = (tool.jsonSchema.required ?? []).filter(
    (key) => (input as Record<string, unknown>)[key] === undefined,
  );
  return missing.length > 0 ? `${missing.join(', ')}: required but missing.` : null;
}
