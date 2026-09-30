import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { defineTool, ToolError, truncateOutput, type AgentTool } from './types';
import type { Workspace } from './workspace';

// Markdown files in this project folder are "skills": short instructions for recurring tasks. They are listed in
// the system prompt and loaded on demand with the load_skill tool, so the prompt prefix stays small and cached.
const SKILLS_DIR = '.codecompanion/skills';
const MAX_SKILLS = 20;
const MAX_SKILL_CHARS = 20_000;
const MAX_DESCRIPTION_CHARS = 120;

export interface SkillSummary {
  name: string;
  description: string;
}

export function skillsDir(workspace: Workspace): string {
  return join(workspace.root, SKILLS_DIR);
}

// Lists the project's skills in file-name order. A broken or unreadable folder yields no skills, never an error.
export function listSkills(workspace: Workspace): SkillSummary[] {
  const dir = skillsDir(workspace);
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, MAX_SKILLS)
      .map((entry) => ({
        name: entry.name.replace(/\.md$/, ''),
        description: describe(readFileSync(join(dir, entry.name), 'utf8')),
      }));
  } catch {
    return [];
  }
}

// The description is the first line that is not a heading, capped so the prompt listing stays scannable.
function describe(content: string): string {
  const line = content
    .split('\n')
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.length > 0 && !candidate.startsWith('#'));
  const description = (line ?? '(no description)').slice(0, MAX_DESCRIPTION_CHARS);
  return description.length < (line ?? '').trim().length ? `${description}…` : description;
}

// Reads one skill by name. The name is restricted to file-name characters and resolved inside the project, so a
// model-supplied name cannot reach outside the skills folder (Workspace.resolve is the backstop).
export function readSkill(workspace: Workspace, name: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) throw new ToolError(`Invalid skill name: ${name}`);
  const path = workspace.resolve(join(SKILLS_DIR, `${name}.md`));
  if (!existsSync(path)) {
    const available = listSkills(workspace)
      .map((skill) => skill.name)
      .join(', ');
    throw new ToolError(`No skill named "${name}". Available skills: ${available || '(none)'}`);
  }
  return truncateOutput(readFileSync(path, 'utf8'), MAX_SKILL_CHARS);
}

export const loadSkillTool: AgentTool = defineTool({
  name: 'load_skill',
  description:
    'Load a project skill: a markdown file with instructions for a recurring task in this project. The available skills and what they are for are listed in your system prompt; load one before doing work it covers.',
  schema: z.object({ name: z.string().describe('The skill name, as listed in the system prompt.') }),
  requiresApproval: false,
  run: async ({ name }, context) => {
    const content = readSkill(context.workspace, name);
    return { content, summary: `Loaded skill ${name}` };
  },
});
