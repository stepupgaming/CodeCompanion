import OpenAI from 'openai';
import { zodResponseFormat } from 'openai/helpers/zod';
import type { z } from 'zod';
import {
  clip,
  estimateChars,
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
  CompletionClient,
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

type MessageParam = OpenAI.Chat.ChatCompletionMessageParam;

// OpenAI-compatible endpoints have no server-side compaction, so the oldest turns are dropped once the history
// passes this rough size (characters / 4 is close enough to tokens for a budget check).
const MAX_HISTORY_TOKENS = 100_000;

// Conversations pass 0 retries: the agent loop retries their requests itself and shows each retry in the chat.
// Background calls (chat titles) keep the SDK's silent retries.
export function createOpenAIClient(apiKey: string, baseURL?: string, maxRetries = 0): OpenAI {
  return new OpenAI({ apiKey, baseURL: baseURL || undefined, maxRetries });
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (part?.type === 'text' ? part.text : part?.type === 'image_url' ? '[image]' : ''))
    .filter(Boolean)
    .join('\n');
}

// A cut is safe anywhere except before a tool message, whose call would be left behind.
const compactionAdapter: CompactionAdapter<MessageParam> = {
  safeCut: (message) => message.role !== 'tool',
  describe(message) {
    switch (message.role) {
      case 'user':
        return [`User: ${clip(textOf(message.content), MAX_TEXT_CHARS)}`];
      case 'assistant':
        return [
          ...(textOf(message.content) ? [`Assistant: ${clip(textOf(message.content), MAX_TEXT_CHARS)}`] : []),
          ...(message.tool_calls ?? []).flatMap((call) =>
            call.type === 'function'
              ? [`Assistant called ${call.function.name}: ${clip(call.function.arguments, MAX_TOOL_INPUT_CHARS)}`]
              : [],
          ),
        ];
      case 'tool':
        return [`Tool result: ${clip(textOf(message.content), MAX_TOOL_RESULT_CHARS)}`];
      default:
        return [];
    }
  },
};

export class OpenAIConversation implements Conversation {
  readonly provider = 'openai' as const;

  constructor(
    private readonly client: OpenAI,
    readonly model: string,
    private readonly messages: MessageParam[] = [],
    private compaction: CompactionState | null = null,
  ) {}

  planCompaction(): CompactionPlan | null {
    return planCompaction(this.messages, this.compaction, compactionAdapter);
  }

  applyCompaction(summary: string, keepFrom: number): void {
    this.compaction = nextState(this.compaction, this.messages.length, summary, keepFrom);
  }

  // What is sent before trimming: the whole history, or the summary joined to the messages from the cut on.
  private requestMessages(): MessageParam[] {
    if (!this.compaction) return this.messages;
    const note = summaryNote(this.compaction.summary);
    const [first, ...rest] = this.messages.slice(this.compaction.keepFrom);
    if (first?.role !== 'user') return [{ role: 'user', content: note }, ...(first ? [first] : []), ...rest];
    const content =
      typeof first.content === 'string'
        ? `${note}\n\n${first.content}`
        : [{ type: 'text' as const, text: note }, ...first.content];
    return [{ ...first, content }, ...rest];
  }

  addUserMessage(input: UserInput): void {
    // A history saved mid-task can end with tool calls that never got results (an app crash); the API rejects
    // requests until they are closed, so answer them synthetically before appending the new message.
    this.closePendingToolCalls();
    if (!input.images?.length) {
      this.messages.push({ role: 'user', content: input.text });
      return;
    }
    this.messages.push({
      role: 'user',
      content: [
        ...input.images.map((image) => ({
          type: 'image_url' as const,
          image_url: { url: `data:${image.mediaType};base64,${image.base64}` },
        })),
        { type: 'text' as const, text: input.text },
      ],
    });
  }

  addToolResults(results: ToolResult[]): void {
    for (const result of results) {
      const prefix = result.isError ? 'Error: ' : '';
      this.messages.push({
        role: 'tool',
        tool_call_id: result.id,
        content: prefix + (result.content || '(no output)'),
      });
    }
    // Tool messages cannot carry images; screenshots follow as a user message.
    const images = results.flatMap((result) => result.images ?? []);
    if (images.length > 0) {
      this.addUserMessage({ text: 'Images returned by the tool calls above.', images });
    }
  }

  hasPendingToolCalls(): boolean {
    const last = this.messages[this.messages.length - 1];
    return last?.role === 'assistant' && 'tool_calls' in last && (last.tool_calls?.length ?? 0) > 0;
  }

  private closePendingToolCalls(): void {
    if (!this.hasPendingToolCalls()) return;
    const last = this.messages[this.messages.length - 1];
    if (!last || last.role !== 'assistant' || !('tool_calls' in last)) return;
    const ids = (last.tool_calls ?? []).flatMap((call) => (call.id ? [call.id] : []));
    this.addToolResults(ids.map((id) => ({ id, content: INTERRUPTED_TOOL_RESULT, isError: true })));
  }

  async runTurn(request: TurnRequest): Promise<TurnResult> {
    const stream = this.client.chat.completions.stream(
      {
        model: this.model,
        messages: [{ role: 'system', content: request.system }, ...trimHistory(this.requestMessages())],
        tools: request.tools.map((tool) => ({
          type: 'function' as const,
          function: { name: tool.name, description: tool.description, parameters: toolInputSchema(tool) },
        })),
        stream_options: { include_usage: true },
      },
      { signal: request.signal },
    );
    stream.on('content', (delta) => request.callbacks.onText(delta));

    const completion = await stream.finalChatCompletion();
    const choice = completion.choices[0];
    if (!choice) throw new Error('The model response contained no choices.');
    const message = choice.message;

    const toolCalls: ToolCall[] = (message.tool_calls ?? [])
      .filter((call) => call.type === 'function')
      .map((call) => ({ id: call.id, name: call.function.name, input: parseArguments(call.function.arguments) }));

    this.messages.push({
      role: 'assistant',
      content: message.content ?? '',
      ...(message.tool_calls?.length ? { tool_calls: message.tool_calls } : {}),
    });

    const inputTokens = completion.usage?.prompt_tokens ?? 0;
    const details = completion.usage?.prompt_tokens_details as
      { cached_tokens?: number; cache_write_tokens?: number } | undefined;
    const cacheReadTokens = details?.cached_tokens ?? 0;
    const cacheWriteTokens = details?.cache_write_tokens ?? 0;

    return {
      text: message.content ?? '',
      toolCalls,
      stopReason: mapFinishReason(choice.finish_reason, toolCalls.length > 0),
      usage: {
        inputTokens: Math.max(0, inputTokens - cacheReadTokens - cacheWriteTokens),
        outputTokens: completion.usage?.completion_tokens ?? 0,
        cacheReadTokens,
        cacheWriteTokens,
        longContext: inputTokens > 272_000,
      },
      contextTokens: inputTokens,
      refusal: message.refusal ?? undefined,
    };
  }

  serialize(): SerializedConversation {
    return {
      provider: this.provider,
      api: 'chat',
      model: this.model,
      messages: this.messages,
      ...(this.compaction ? { compaction: this.compaction } : {}),
    };
  }
}

// What is sent when the history is too large: messages are dropped from the front, keeping the first user message
// (the task) so the goal is never lost. Only the copy that is sent is shortened; the stored history is not.
// A tool message must follow the assistant message that called it, so the kept part never starts with one, and the
// last assistant message with its tool results (the step in progress) is always kept whole.
export function trimHistory(messages: MessageParam[]): MessageParam[] {
  if (estimateTokens(messages) <= MAX_HISTORY_TOKENS) return messages;
  const [first, ...rest] = messages;
  if (!first) return messages;
  let lastGroup = rest.length - 1;
  while (lastGroup > 0 && rest[lastGroup]?.role === 'tool') lastGroup--;
  let start = 0;
  while (start < lastGroup && estimateTokens([first, ...rest.slice(start)]) > MAX_HISTORY_TOKENS) {
    start++;
    while (start < lastGroup && rest[start]?.role === 'tool') start++;
  }
  if (start === 0) return messages;
  return [
    first,
    { role: 'user', content: '(Earlier messages were removed to fit the context window.)' },
    ...rest.slice(start),
  ];
}

function parseArguments(raw: string): unknown {
  try {
    return JSON.parse(raw || '{}');
  } catch {
    return { __invalidJson: raw };
  }
}

// Characters / 4, with images counted at a small fixed size: their base64 text would otherwise make one screenshot
// look like hundreds of thousands of tokens and push everything else out.
function estimateTokens(messages: MessageParam[]): number {
  return Math.ceil(estimateChars(messages) / 4);
}

function mapFinishReason(reason: string | null, hasToolCalls: boolean): StopReason {
  if (reason === 'length') return 'max_tokens';
  if (reason === 'content_filter') return 'refusal';
  if (hasToolCalls) return 'tool_use';
  switch (reason) {
    case 'stop':
      return 'end_turn';
    default:
      return 'other';
  }
}

export class OpenAICompletionClient implements CompletionClient {
  constructor(
    private readonly client: OpenAI,
    private readonly model: string,
  ) {}

  async complete<T extends z.ZodObject<z.ZodRawShape>>(
    prompt: string,
    schema: T,
    signal?: AbortSignal,
  ): Promise<z.infer<T>> {
    const completion = await this.client.chat.completions.parse(
      {
        model: this.model,
        messages: [{ role: 'user', content: prompt }],
        response_format: zodResponseFormat(schema, 'result'),
      },
      { signal },
    );
    const parsed = completion.choices[0]?.message.parsed;
    if (!parsed) {
      throw new Error('The model did not return a structured answer.');
    }
    return parsed as z.infer<T>;
  }
}
