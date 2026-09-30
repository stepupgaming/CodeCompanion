import { readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { listSkills } from '../tools/skills';
import type { Workspace } from '../tools/workspace';
import type { AgentFile } from './agent_file';

export interface SystemPromptInput {
  workspace: Workspace;
  shell: string;
  platform: string;
  date: string;
  customInstructions: string;
  agentFile: AgentFile | null;
}

// Built once when a chat starts and kept byte-identical afterwards so the prompt prefix stays cached.
export function buildSystemPrompt(input: SystemPromptInput): string {
  const sections = [
    `You are Patch, a coding assistant working directly in the user's project on their computer. You can read and change files, run commands and look things up, using the tools provided.`,

    `# Environment
- Project: ${basename(input.workspace.root)} at ${input.workspace.root}
- Operating system: ${platformName(input.platform)}
- Shell for run_command: ${input.shell}
- Date: ${input.date}`,

    `# How to work
- Understand the code before changing it. Explore with list_directory and grep, use search_code when it is in the currently offered tools, and read the relevant files. Follow the project's existing conventions, libraries and style. Optional tools can become available during the chat; the current tool list is authoritative.
- Make focused changes with edit_file; use write_file for new files. Do not change code unrelated to the task.
- Verify your work: run the project's tests, build or linter with run_command when they exist, and check web UIs with the browser tool when offered. If something fails, fix it or explain why you could not.
- Commands run non-interactively in a fresh shell in the project root. Start servers and watchers with background=true.
- Changes to files and commands may need the user's approval. If the user declines an action, adjust based on their feedback rather than retrying the same thing.
- When a request is ambiguous and the choice matters, ask the user instead of guessing.
- Keep the user informed in a few words as you go. When finished, summarize what you changed and how you verified it.`,

    `# Project overview (top level)\n${topLevelListing(input.workspace)}`,
  ];

  if (input.agentFile) {
    const { name, content, truncated } = input.agentFile;
    sections.push(`# Instructions from ${name} in the project\n${content}${truncated ? '\n(truncated)' : ''}`);
  }
  if (input.customInstructions.trim()) {
    sections.push(`# Project instructions from the user\n${input.customInstructions.trim()}`);
  }
  const skills = listSkills(input.workspace);
  if (skills.length > 0) {
    sections.push(
      `# Project skills\nShort instruction files for recurring tasks, loaded on demand with the load_skill tool. Load the matching skill before doing work it covers:\n${skills
        .map((skill) => `- ${skill.name}: ${skill.description}`)
        .join('\n')}`,
    );
  }
  return sections.join('\n\n');
}

function platformName(platform: string): string {
  return platform === 'win32' ? 'Windows' : platform === 'darwin' ? 'macOS' : 'Linux';
}

function topLevelListing(workspace: Workspace): string {
  try {
    const entries = readdirSync(workspace.root, { withFileTypes: true })
      .filter((entry) => !workspace.isIgnored(join(workspace.root, entry.name), entry.isDirectory()))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name));
    const shown = entries.slice(0, 100);
    return (
      shown.join('\n') + (entries.length > shown.length ? `\n(${entries.length - shown.length} more)` : '') || '(empty)'
    );
  } catch {
    return '(could not list the project directory)';
  }
}
