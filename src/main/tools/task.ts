import { z } from 'zod';
import type { ChatEvent } from '@shared/chat';
import type { Conversation, UserInput } from '../llm/types';
import { Agent, SUBAGENT_MAX_TURNS } from '../agent/agent';
import { defineTool, ToolError, type AgentTool, type ToolContext } from './types';

export interface TaskToolOptions {
  // A fresh conversation per subagent run, on the chat's current model.
  createConversation: () => Conversation;
  // The chat's system prompt (the subagent works on the same project with the same instructions).
  system: string;
  // The parent's tool list; only the read-only subset is offered to the subagent.
  tools: () => AgentTool[];
}

const READ_ONLY_TOOLS = new Set(['read_file', 'list_directory', 'grep', 'search_code']);

// Runs a read-only subagent: a nested agent that can inspect the project (read files, grep, semantic search) but
// cannot change anything, run commands or reach the network. Its answer comes back as the tool result; its
// progress streams into the parent transcript while it works. Read-only scope means no approval cards are needed
// inside the subagent, and no nesting: the task tool is not part of its tool list.
export function createTaskTool(options: TaskToolOptions): AgentTool {
  return defineTool({
    name: 'task',
    description:
      'Delegate a research question to a read-only subagent that has its own context window. It can read files, list directories, grep and use semantic code search in the current project, but cannot edit files, run commands or use the network. Give it a self-contained question and the paths or symbols to start from; its answer arrives as your tool result. Use it for broad surveys (find every caller, summarize a subsystem) so your own context stays small.',
    schema: z.object({
      task: z.string().describe('A self-contained research question, with concrete starting points (paths, symbols).'),
    }),
    requiresApproval: false,
    run: async ({ task }, context) => runSubagent(options, task, context),
  });
}

async function runSubagent(options: TaskToolOptions, task: string, context: ToolContext) {
  let answer = '';
  const agent = new Agent({
    conversation: options.createConversation(),
    system: options.system,
    tools: () => options.tools().filter((tool) => READ_ONLY_TOOLS.has(tool.name)),
    // Read-only tools never ask for approval; the subagent cannot escalate. The fallback declines, so even an
    // unexpected approval request cannot turn into a silent side effect.
    approvalMode: () => 'auto' as const,
    requestApproval: () => Promise.resolve({ approved: false }),
    toolContext: (signal, onProgress) => ({ ...context, signal, onProgress }),
    maxTurns: SUBAGENT_MAX_TURNS,
    emit: (event) => {
      // The last assistant text is the answer to the delegated question.
      if (event.type === 'assistant-end' && event.text) answer = event.text;
      forwardProgress(event, context.onProgress);
    },
  });

  const input: UserInput = { text: task };
  try {
    await agent.send(input, context.signal);
  } catch (error) {
    if (context.signal.aborted) throw new ToolError('The subagent was stopped.');
    throw new ToolError(`The subagent failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const usage = agent.totals;
  return {
    content: `${answer.trim() || '(The subagent returned no answer.)'}\n\n(Subagent token usage: ${usage.inputTokens} in / ${usage.outputTokens} out.)`,
    summary: `Subagent: ${truncate(task, 60)}`,
    isError: answer.trim().length === 0,
  };
}

// The nested events are not transcript items in the parent; the interesting parts stream as progress lines.
function forwardProgress(event: ChatEvent, onProgress: (text: string) => void): void {
  if (event.type === 'tool-end') onProgress(`[${event.status}] ${event.summary}`);
  if (event.type === 'assistant-end' && event.text) onProgress(truncate(event.text, 500));
  if (event.type === 'notice') onProgress(event.text);
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}
