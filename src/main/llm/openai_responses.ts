import type OpenAI from 'openai';
import type { Effort } from '@shared/models';
import {
  clip,
  MAX_TEXT_CHARS,
  MAX_TOOL_INPUT_CHARS,
  MAX_TOOL_RESULT_CHARS,
  nextState,
  planCompaction,
  summaryNote,
  type CompactionAdapter,
  type CompactionPlan,
  type CompactionState,
} from './compaction';
import { toolInputSchema } from './tool_schema';
import type {
  Conversation,
  SerializedConversation,
  StopReason,
  ToolCall,
  ToolResult,
  TurnRequest,
  TurnResult,
  UserInput,
} from './types';
import { INTERRUPTED_TOOL_RESULT } from './types';

type InputItem = OpenAI.Responses.ResponseInputItem;

interface LooseItem {
  type?: string;
  role?: string;
  content?: unknown;
  name?: string;
  arguments?: string;
  output?: unknown;
}

function partsText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part: { type?: string; text?: string; refusal?: string }) =>
      part.type === 'input_image' ? '[image]' : (part.text ?? part.refusal ?? ''),
    )
    .filter(Boolean)
    .join('\n');
}

// A cut is safe before a message or a reasoning item. Before a function call it is not: the call needs the reasoning
// item that precedes it, and before a call's output it would leave the output without its call. Nor is it right after
// a reasoning item: the message or call that item produced would be sent without it, which the API rejects without
// server-side storage (store: false).
const compactionAdapter: CompactionAdapter<InputItem> = {
  safeCut(item, index, all) {
    const { type } = item as LooseItem;
    const previous = all[index - 1] as LooseItem | undefined;
    return (
      (type === undefined || type === 'message' || type === 'reasoning') &&
      previous?.type !== 'function_call' &&
      previous?.type !== 'reasoning'
    );
  },
  describe(item) {
    const { type, role, content, name, arguments: args, output } = item as LooseItem;
    if (type === 'function_call') return [`Assistant called ${name}: ${clip(args ?? '', MAX_TOOL_INPUT_CHARS)}`];
    if (type === 'function_call_output') {
      return [
        `Tool result: ${clip(typeof output === 'string' ? output : JSON.stringify(output), MAX_TOOL_RESULT_CHARS)}`,
      ];
    }
    if (type === undefined || type === 'message') {
      const text = partsText(content);
      return text ? [`${role === 'user' ? 'User' : 'Assistant'}: ${clip(text, MAX_TEXT_CHARS)}`] : [];
    }
    // Reasoning items are encrypted and say nothing a summary could use.
    return [];
  },
};

// The SDK's stream helper adds its own fields to the final response: `parsed_arguments` on function calls and
// `parsed` on message text. They are not part of the API's input format, and the API rejects a history that contains
// them ("400 Unknown parameter: 'input[1].parsed_arguments'"), so they are removed before an output item is stored or
// sent back. Sending strips them too, which repairs chats saved before this was done.
export function toInputItem(item: InputItem): InputItem {
  const loose = item as unknown as Record<string, unknown>;
  if (loose.type === 'function_call' && 'parsed_arguments' in loose) {
    const { parsed_arguments: _parsed, ...rest } = loose;
    return rest as unknown as InputItem;
  }
  if ((loose.type === 'message' || loose.type === undefined) && Array.isArray(loose.content)) {
    const content = loose.content as Array<Record<string, unknown>>;
    if (content.some((part) => part && typeof part === 'object' && 'parsed' in part)) {
      return {
        ...loose,
        content: content.map((part) => {
          if (!part || typeof part !== 'object' || !('parsed' in part)) return part;
          const { parsed: _parsed, ...rest } = part;
          return rest;
        }),
      } as unknown as InputItem;
    }
  }
  return item;
}

// OpenAI's own API, through the Responses API. Used instead of Chat Completions because current OpenAI models
// (GPT-6) only support function calling there with reasoning enabled.
//
// Nothing is stored on OpenAI's side (store: false). Reasoning items come back encrypted and are sent back
// unchanged with the rest of the history, so the model keeps its reasoning across tool calls. When the history
// outgrows the context window, truncation: 'auto' drops the oldest items.
export class OpenAIResponsesConversation implements Conversation {
  readonly provider = 'openai' as const;

  constructor(
    private readonly client: OpenAI,
    readonly model: string,
    private readonly effort: Effort,
    private readonly items: InputItem[] = [],
    private compaction: CompactionState | null = null,
  ) {}

  planCompaction(): CompactionPlan | null {
    return planCompaction(this.items, this.compaction, compactionAdapter);
  }

  applyCompaction(summary: string, keepFrom: number): void {
    this.compaction = nextState(this.compaction, this.items.length, summary, keepFrom);
  }

  // What is sent: the whole history, or the summary followed by the items from the cut on.
  private requestItems(): InputItem[] {
    if (!this.compaction) return this.items.map(toInputItem);
    const note: InputItem = {
      role: 'user',
      content: [{ type: 'input_text', text: summaryNote(this.compaction.summary) }],
    };
    return [note, ...this.items.slice(this.compaction.keepFrom).map(toInputItem)];
  }

  addUserMessage(input: UserInput): void {
    // A history saved mid-task can end with function calls that never got outputs (an app crash); the API rejects
    // requests until they are closed, so answer them synthetically before appending the new message.
    this.closePendingToolCalls();
    this.items.push({
      role: 'user',
      content: [
        ...(input.images ?? []).map((image) => ({
          type: 'input_image' as const,
          image_url: `data:${image.mediaType};base64,${image.base64}`,
          detail: 'auto' as const,
        })),
        { type: 'input_text' as const, text: input.text },
      ],
    });
  }

  addToolResults(results: ToolResult[]): void {
    for (const result of results) {
      const prefix = result.isError ? 'Error: ' : '';
      this.items.push({
        type: 'function_call_output',
        call_id: result.id,
        output: prefix + (result.content || '(no output)'),
      });
    }
    const images = results.flatMap((result) => result.images ?? []);
    if (images.length > 0) {
      this.addUserMessage({ text: 'Images returned by the tool calls above.', images });
    }
  }

  hasPendingToolCalls(): boolean {
    return this.pendingCallIds().length > 0;
  }

  // Function calls without a matching output, in call order.
  private pendingCallIds(): string[] {
    const outputs = new Set(this.items.flatMap((item) => (item.type === 'function_call_output' ? [item.call_id] : [])));
    return this.items.flatMap((item) =>
      item.type === 'function_call' && !outputs.has(item.call_id) ? [item.call_id] : [],
    );
  }

  private closePendingToolCalls(): void {
    const pending = this.pendingCallIds();
    if (pending.length === 0) return;
    this.addToolResults(pending.map((id) => ({ id, content: INTERRUPTED_TOOL_RESULT, isError: true })));
  }

  async runTurn(request: TurnRequest): Promise<TurnResult> {
    const stream = this.client.responses.stream(
      {
        model: this.model,
        instructions: request.system,
        input: this.requestItems(),
        tools: request.tools.map((tool) => ({
          type: 'function' as const,
          name: tool.name,
          description: tool.description,
          parameters: toolInputSchema(tool),
          // Optional fields are allowed in tool inputs, which strict mode does not support.
          strict: false,
        })),
        reasoning: { effort: this.effort, summary: 'auto' },
        include: ['reasoning.encrypted_content'],
        store: false,
        truncation: 'auto',
      },
      { signal: request.signal },
    );
    stream.on('response.output_text.delta', (event) => request.callbacks.onText(event.delta));
    stream.on('response.reasoning_summary_text.delta', (event) => request.callbacks.onThinking?.(event.delta));

    const response = await stream.finalResponse();
    // Output items (reasoning, messages, function calls) are valid input for the next request once the SDK's own
    // fields are removed.
    this.items.push(...(response.output as unknown as InputItem[]).map(toInputItem));

    const toolCalls: ToolCall[] = response.output.flatMap((item) =>
      item.type === 'function_call'
        ? [{ id: item.call_id, name: item.name, input: parseArguments(item.arguments) }]
        : [],
    );

    const refusal = response.output
      .flatMap((item) => (item.type === 'message' ? item.content : []))
      .find((part) => part.type === 'refusal');

    const inputTokens = response.usage?.input_tokens ?? 0;
    const cacheReadTokens = response.usage?.input_tokens_details?.cached_tokens ?? 0;
    const cacheWriteTokens = response.usage?.input_tokens_details?.cache_write_tokens ?? 0;

    return {
      text: response.output_text ?? '',
      toolCalls,
      stopReason: stopReason(response, toolCalls.length > 0, Boolean(refusal)),
      usage: {
        inputTokens: Math.max(0, inputTokens - cacheReadTokens - cacheWriteTokens),
        outputTokens: response.usage?.output_tokens ?? 0,
        cacheReadTokens,
        cacheWriteTokens,
        longContext: inputTokens > 272_000,
      },
      contextTokens: inputTokens,
      refusal: refusal?.type === 'refusal' ? refusal.refusal : undefined,
    };
  }

  serialize(): SerializedConversation {
    return {
      provider: this.provider,
      api: 'responses',
      model: this.model,
      messages: this.items,
      ...(this.compaction ? { compaction: this.compaction } : {}),
    };
  }
}

function parseArguments(raw: string): unknown {
  try {
    return JSON.parse(raw || '{}');
  } catch {
    return { __invalidJson: raw };
  }
}

function stopReason(response: OpenAI.Responses.Response, hasToolCalls: boolean, refused: boolean): StopReason {
  if (response.status === 'incomplete') {
    const reason = response.incomplete_details?.reason;
    if (reason === 'max_output_tokens') return 'max_tokens';
    if (reason === 'content_filter') return 'refusal';
    return 'other';
  }
  if (refused) return 'refusal';
  if (hasToolCalls) return 'tool_use';
  return 'end_turn';
}
