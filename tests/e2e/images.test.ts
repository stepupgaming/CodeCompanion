import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchApp, type RunningApp } from './app';
import { MockClaude } from './mock_claude';

describe('image attachments follow the model (mock Claude API)', () => {
  let running: RunningApp;
  let claude: MockClaude;
  let project: string;

  beforeAll(async () => {
    project = mkdtempSync(join(tmpdir(), 'patch-images-project-'));
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

  const attach = () => running.page.getByLabel('Attach images');
  const image = { mediaType: 'image/png' as const, base64: 'iVBORw0KGgo=' };

  it('offers attaching for a model that accepts images, and sends the image', async () => {
    expect(await attach().isEnabled()).toBe(true);

    claude.script({ blocks: [{ type: 'text', text: 'A tiny image.' }], stopReason: 'end_turn' });
    await running.page.evaluate(
      (img) => window.api.invoke('chat:send', { text: 'What is this?', images: [img] }),
      image,
    );
    const deadline = Date.now() + 15_000;
    while (claude.agentRequests.length === 0 && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 100));

    const content = claude.agentRequests[0].messages[0].content;
    expect(content[0]).toMatchObject({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: image.base64 },
    });
  });

  it('turns attaching off for a Claude model that is not known to accept images, and refuses to send one', async () => {
    await running.page.evaluate(() => window.api.invoke('settings:update', { model: 'claude-custom' }));
    await running.page.evaluate(() => window.api.invoke('chat:new'));

    await expect.poll(() => attach().isDisabled()).toBe(true);
    expect(await attach().getAttribute('title')).toContain('claude-custom does not accept images');

    const before = claude.agentRequests.length;
    const refused = await running.page.evaluate(
      (img) =>
        window.api.invoke('chat:send', { text: 'Look', images: [img] }).then(
          () => 'sent',
          (error: Error) => error.message,
        ),
      image,
    );
    expect(refused).toContain('does not accept images');
    expect(claude.agentRequests.length).toBe(before);
  });

  it('turns it back on when a model that accepts images is chosen', async () => {
    await running.page.evaluate(() => window.api.invoke('settings:update', { model: 'claude-sonnet-5-5' }));
    await expect.poll(() => attach().isEnabled()).toBe(true);
  });
});
