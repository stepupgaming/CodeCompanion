import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChatSnapshot } from '../../src/shared/chat';
import { launchApp, type RunningApp } from './app';
import { MockOpenAI } from './mock_openai';

describe('OpenAI Responses API end to end (mock OpenAI API)', () => {
  let running: RunningApp;
  let openai: MockOpenAI;
  let project: string;

  beforeAll(async () => {
    project = mkdtempSync(join(tmpdir(), 'patch-e2e-openai-'));
    writeFileSync(join(project, 'notes.txt'), 'The secret word is pineapple.\n');
    openai = new MockOpenAI();
    running = await launchApp({ PATCH_TEST_OPENAI_URL: await openai.start() });
  });

  afterAll(async () => {
    await running?.close();
    await openai?.stop();
    rmSync(project, { recursive: true, force: true });
  });

  const snapshot = (): Promise<ChatSnapshot> => running.page.evaluate(() => window.api.invoke('chat:snapshot'));

  async function waitForIdle(timeout = 20_000): Promise<ChatSnapshot> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const current = await snapshot();
      if (!current.busy && current.transcript.length > 1) return current;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error('Timed out waiting for the chat');
  }

  it('runs a tool-using conversation through /responses and sends the encrypted reasoning back', async () => {
    await running.page.evaluate((path) => window.api.invoke('project:open', path), project);
    await running.page.evaluate(() => window.api.invoke('settings:set-secret', 'openaiApiKey', 'sk-openai-e2e'));
    await running.page.evaluate(() => window.api.invoke('settings:update', { model: 'gpt-6-sol' }));

    openai.script(
      {
        reasoning: { summary: 'I should read the notes.', encrypted: 'ENC-E2E' },
        text: 'Let me read the notes.',
        call: { id: 'call_e2e', name: 'read_file', input: { path: 'notes.txt' } },
      },
      { text: 'The secret word is pineapple.' },
    );
    await running.page.evaluate(() => window.api.invoke('chat:send', { text: 'What is the secret word?' }));
    const done = await waitForIdle();

    expect(done.transcript.map((item) => item.kind)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(done.transcript[2]).toMatchObject({
      name: 'read_file',
      status: 'done',
      summary: 'Read notes.txt (2 lines)',
    });
    expect(done.transcript[3]).toMatchObject({ text: 'The secret word is pineapple.' });
    expect(done.usage.cacheReadTokens).toBeGreaterThan(0);

    const [first, second] = openai.agentRequests;
    expect(first.path).toContain('/responses');
    expect(first.body).toMatchObject({
      model: 'gpt-6-sol',
      store: false,
      include: ['reasoning.encrypted_content'],
      reasoning: { summary: 'auto' },
    });
    expect(first.body.instructions).toContain(project.split(/[\\/]/).pop());

    // The second request carries the reasoning item unchanged and the tool result.
    const kinds = second.body.input.map((item: any) => item.type ?? item.role);
    expect(kinds).toEqual(['user', 'reasoning', 'message', 'function_call', 'function_call_output']);
    expect(second.body.input[1].encrypted_content).toBe('ENC-E2E');
    expect(second.body.input[4]).toMatchObject({ call_id: 'call_e2e' });
    expect(second.body.input[4].output).toContain('pineapple');
  });

  it('runs without errors', () => {
    expect(running.errors.join('\n')).toBe('');
    expect(running.mainErrors.join('')).toBe('');
  });
});
