import { z } from 'zod';
import type { JsonObjectSchema, ToolSpec } from './types';

export type { JsonObjectSchema };

// JSON Schema for a tool's input, shared by all providers. Tools declare either a Zod schema (built-in tools) or a
// ready-made JSON Schema (MCP tools); the latter wins when both are somehow present.
export function toolInputSchema(tool: ToolSpec): JsonObjectSchema {
  if (tool.jsonSchema) return tool.jsonSchema;
  const { $schema: _ignored, ...schema } = z.toJSONSchema(tool.schema!) as Record<string, unknown>;
  return { ...schema, type: 'object' };
}
