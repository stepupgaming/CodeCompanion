import type { ToolSpec } from '../llm/types';
import { browserTool } from './browser';
import { editFileTool, grepTool, listDirectoryTool, readFileTool, writeFileTool } from './files';
import { commandOutputTool, runCommandTool } from './shell';
import type { AgentTool, ToolContext } from './types';
import { fetchUrlTool, webSearchTool } from './web';

const CORE_TOOLS: AgentTool[] = [
  readFileTool,
  listDirectoryTool,
  grepTool,
  editFileTool,
  writeFileTool,
  runCommandTool,
  commandOutputTool,
  fetchUrlTool,
];

// Tools offered to the model depend on what is configured, so it never calls one that cannot work.
export function availableTools(
  context: Pick<ToolContext, 'browser' | 'codeSearch' | 'webSearch'>,
  extra: AgentTool[] = [],
): AgentTool[] {
  return [
    ...CORE_TOOLS,
    ...(context.webSearch ? [webSearchTool] : []),
    ...(context.browser ? [browserTool] : []),
    ...extra,
  ];
}

export function toToolSpecs(tools: AgentTool[]): ToolSpec[] {
  return tools.map(({ name, description, schema, jsonSchema }) => ({ name, description, schema, jsonSchema }));
}
