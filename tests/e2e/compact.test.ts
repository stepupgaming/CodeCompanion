import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChatSnapshot } from '../../src/shared/chat';
import { launchApp, type RunningApp } from './app';
import { MockClaude } from './mock_claude';

describe('compact chat (mock Claude API)', () => {
  let running: RunningApp;
  let claude: MockClaude;
  let project: string;

  beforeAll(async () => {
    project = mkdtempSync(join(tmpdir(), 'patch-compact-project-'));
    claude = new MockClaude();
    running = await launchApp({ PATCH_TEST_ANTHROPIC_URL: await claude.start() });
    await running.page.evaluate((path) => window.api.invoke('project:open', path), project);
    await running.page.evaluate(() => window.api.invoke('settings:set-secret', 'anthropicApiKey', 'sk-ant-e2e'));
  });

  afterAll(async () => {
    await running?.close();
    await claude?.stop();
    rmSync(project, { recursive: true, force: true });
  });

  const snapshot = () => running.page.evaluate(() => window.api.invoke('chat:snapshot'));

  async function waitFor<T>(check: (current: ChatSnapshot) => T, timeout = 20_000): Promise<NonNullable<T>> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const result = check(await snapshot());
      if (result) return result as NonNullable<T>;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error('Timed out waiting for the chat');
  }

  // Sends a message of about 15,000 characters and waits for the (scripted) answer.
  async function ask(label: string): Promise<void> {
    claude.script({ blocks: [{ type: 'text', text: `Answer to ${label}` }], stopReason: 'end_turn' });
    const before = (await snapshot()).transcript.filter((item) => item.kind === 'assistant').length;
    const text = `${label} ${'lorem ipsum '.repeat(1_250)}`;
    await running.page.evaluate((message) => window.api.invoke('chat:send', { text: message }), text);
    await waitFor(
      (current) => !current.busy && current.transcript.filter((item) => item.kind === 'assistant').length > before,
    );
  }

  it('summarizes older turns from the header button, and the next request sends the summary instead of them', async () => {
    for (const label of ['FIRST-QUESTION', 'SECOND-QUESTION', 'THIRD-QUESTION', 'FOURTH-QUESTION']) await ask(label);

    // The status bar shows how large the last prompt was, and the button is there to use.
    await running.page.getByText(/^Context: \d/).waitFor();
    const button = running.page.getByLabel('Compact chat');
    await button.waitFor();
    expect(await button.isEnabled()).toBe(true);

    await button.click();
    const done = await waitFor((current) =>
      current.transcript.find((item) => item.kind === 'notice' && item.text.includes('Compacted')),
    );
    expect(done).toMatchObject({ text: expect.stringContaining('Compacted 2 earlier messages') });
    expect(claude.summaryRequests).toHaveLength(1);
    // The summarizer was given the old turns as text, and only those.
    const asked = JSON.stringify(claude.summaryRequests[0]);
    expect(asked).toContain('FIRST-QUESTION');
    expect(asked).toContain('Answer to FIRST-QUESTION');
    expect(asked).not.toContain('SECOND-QUESTION');
    // The size of the prompt is not known until the next request.
    await running.page.getByText(/^Context: \d/).waitFor({ state: 'detached' });

    await ask('FIFTH-QUESTION');
    const sent = claude.agentRequests.at(-1).messages;
    const text = JSON.stringify(sent);
    expect(text).toContain('E2E SUMMARY of the earlier work.');
    expect(text).not.toContain('FIRST-QUESTION');
    expect(text).toContain('SECOND-QUESTION');
    expect(text).toContain('FIFTH-QUESTION');
    // 5 questions and 4 answers before it, minus the 2 messages replaced by the summary.
    expect(sent).toHaveLength(7);
    expect(sent[0].role).toBe('user');
    expect(sent[0].content[0].text).toContain('E2E SUMMARY');
  });

  it('keeps every message in the saved chat and restores the compaction when the chat is reopened', async () => {
    const chatsDir = join(running.userData, 'chats');
    let file: string | undefined;
    for (let attempt = 0; attempt < 30 && !file; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      file = existsSync(chatsDir)
        ? readdirSync(chatsDir).find((name) => name !== 'index.json' && name.endsWith('.json'))
        : undefined;
    }
    const saved = JSON.parse(readFileSync(join(chatsDir, file!), 'utf8'));

    // Ten messages: five questions and five answers. Nothing was removed.
    expect(saved.conversation.messages).toHaveLength(10);
    expect(JSON.stringify(saved.conversation.messages[0])).toContain('FIRST-QUESTION');
    expect(saved.conversation.compaction).toEqual({ summary: 'E2E SUMMARY of the earlier work.', keepFrom: 2 });
    // The visible chat keeps the whole conversation too, plus the notice about the compaction.
    expect(saved.transcript.filter((item: { kind: string }) => item.kind === 'user')).toHaveLength(5);

    // Reopen it in a new chat: the next request still sends the summary, not the first question.
    await running.page.evaluate(() => window.api.invoke('chat:new'));
    await running.page.evaluate((id) => window.api.invoke('history:open', id), saved.id);
    await ask('SIXTH-QUESTION');
    const text = JSON.stringify(claude.agentRequests.at(-1).messages);
    expect(text).toContain('E2E SUMMARY');
    expect(text).not.toContain('FIRST-QUESTION');
    expect(text).toContain('SIXTH-QUESTION');
  });

  it('shows the estimated cost of each chat in the chat history', async () => {
    await running.page.getByTitle('Chat history').click();
    // The mock API reports a few tokens per request, so the Opus 5.5 chat costs less than a cent.
    const cost = running.page.locator('.history-list').getByText('≈ <$0.01').first();
    await cost.waitFor();
    expect(await cost.getAttribute('title')).toBe('Estimated from official list prices.');
    await running.page.keyboard.press('Escape');
  });

  it('says so instead of summarizing a short chat', async () => {
    await running.page.evaluate(() => window.api.invoke('chat:new'));
    await ask('ONLY-QUESTION');
    const before = claude.summaryRequests.length;
    await running.page.getByLabel('Compact chat').click();
    await waitFor((current) =>
      current.transcript.find((item) => item.kind === 'notice' && item.text.includes('not enough older history')),
    );
    expect(claude.summaryRequests.length).toBe(before);
  });
});
