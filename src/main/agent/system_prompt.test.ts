import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Workspace } from '../tools/workspace';
import { buildSystemPrompt, type SystemPromptInput } from './system_prompt';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-prompt-'));
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'node_modules'));
  writeFileSync(join(root, 'package.json'), '{}');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function input(overrides: Partial<SystemPromptInput> = {}): SystemPromptInput {
  return {
    workspace: new Workspace(root),
    shell: 'PowerShell',
    platform: 'win32',
    date: '2026-09-29',
    customInstructions: '',
    agentFile: null,
    ...overrides,
  };
}

describe('buildSystemPrompt', () => {
  it('describes the environment and lists the project top level', () => {
    const prompt = buildSystemPrompt(input());
    expect(prompt).toContain('Operating system: Windows');
    expect(prompt).toContain('Shell for run_command: PowerShell');
    expect(prompt).toContain('src/\npackage.json');
    expect(prompt).not.toContain('node_modules');
  });

  it('defers optional tool availability to the current tool list without changing the cached prompt', () => {
    const prompt = buildSystemPrompt(input());
    expect(prompt).toContain('search_code when it is in the currently offered tools');
    expect(prompt).toContain('browser tool when offered');
    expect(prompt).toContain('current tool list is authoritative');
  });

  it('appends project instructions', () => {
    const prompt = buildSystemPrompt(input({ customInstructions: 'Use tabs.' }));
    expect(prompt.endsWith('# Project instructions from the user\nUse tabs.')).toBe(true);
  });

  it('injects the agent file before the user instructions', () => {
    const prompt = buildSystemPrompt(
      input({
        agentFile: { name: 'AGENTS.md', content: 'Run tests.', truncated: false },
        customInstructions: 'Use tabs.',
      }),
    );
    expect(prompt).toContain('# Instructions from AGENTS.md in the project\nRun tests.');
    expect(prompt.indexOf('Run tests.')).toBeLessThan(prompt.indexOf('Use tabs.'));
  });

  it('is deterministic for the same input so the prefix stays cached', () => {
    expect(buildSystemPrompt(input())).toBe(buildSystemPrompt(input()));
  });
});
