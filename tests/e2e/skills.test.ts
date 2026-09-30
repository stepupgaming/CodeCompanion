import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChatSnapshot } from '../../src/shared/chat';
import { launchApp, type RunningApp } from './app';
import { MockClaude } from './mock_claude';

// A project with .codecompanion/skills/*.md lists them in the system prompt and the model loads one through the
// load_skill tool; the skill content must reach the model as the tool result.
describe('project skills end to end', () => {
  let running: RunningApp;
  let claude: MockClaude;
  let project: string;

  beforeAll(async () => {
    project = mkdtempSync(join(tmpdir(), 'cc-skills-e2e-'));
    mkdirSync(join(project, '.codecompanion', 'skills'), { recursive: true });
    writeFileSync(
      join(project, '.codecompanion', 'skills', 'release.md'),
      'Bump the version, tag v<n>, run npm run dist.\n',
    );
    claude = new MockClaude();
    running = await launchApp({ PATCH_TEST_ANTHROPIC_URL: await claude.start() });
    await running.page.evaluate((path) => window.api.invoke('project:open', path), project);
    await running.page.evaluate(() => window.api.invoke('settings:set-secret', 'anthropicApiKey', 'sk-ant-e2e'));

    claude.script(
      {
        blocks: [{ type: 'tool_use', id: 'skill-1', name: 'load_skill', input: { name: 'release' } }],
        stopReason: 'tool_use',
      },
      { blocks: [{ type: 'text', text: 'Following the release skill.' }], stopReason: 'end_turn' },
    );
  });

  afterAll(async () => {
    await running?.close();
    await claude?.stop();
    rmSync(project, { recursive: true, force: true });
  });

  async function snapshot(): Promise<ChatSnapshot> {
    return running.page.evaluate(() => window.api.invoke('chat:snapshot'));
  }

  async function waitFor(check: (chat: ChatSnapshot) => boolean): Promise<ChatSnapshot> {
    for (let index = 0; index < 100; index++) {
      const chat = await snapshot();
      if (check(chat)) return chat;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(
      `Timed out waiting for chat state: ${JSON.stringify(await snapshot())}; ${running.mainErrors.join(' ')}`,
    );
  }

  it('lists skills in the prompt and loads one on demand', async () => {
    await running.page.evaluate(() => window.api.invoke('chat:send', { text: 'Prepare a release' }));
    const finished = await waitFor((chat) => !chat.busy && chat.transcript.at(-1)?.kind === 'assistant');

    // The first request's system prompt lists the skill by name and description.
    const firstRequest = JSON.stringify(claude.agentRequests[0]);
    expect(firstRequest).toContain('Project skills');
    expect(firstRequest).toContain('release:');

    const skillRow = finished.transcript.find((item) => item.kind === 'tool' && item.name === 'load_skill');
    expect(skillRow).toMatchObject({ status: 'done', summary: 'Loaded skill release' });
    expect(JSON.stringify(claude.agentRequests.at(-1))).toContain('Bump the version, tag v<n>, run npm run dist.');
    expect(running.errors).toEqual([]);
  });
});
