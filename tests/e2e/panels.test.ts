import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchApp, type RunningApp } from './app';
import { MockClaude } from './mock_claude';

const screenshotDir = process.env.E2E_SCREENSHOTS;

describe('side panels', () => {
  let running: RunningApp;
  let claude: MockClaude;
  let project: string;

  beforeAll(async () => {
    project = mkdtempSync(join(tmpdir(), 'patch-panels-project-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: project });
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    writeFileSync(join(project, 'README.md'), '# Demo\n');
    git('add', '.');
    git('commit', '-qm', 'initial');
    writeFileSync(
      join(project, 'page.html'),
      '<!doctype html><title>Demo page</title><h1>Hi</h1><script>console.error("boom from page")</script>',
    );

    claude = new MockClaude();
    running = await launchApp({ PATCH_TEST_ANTHROPIC_URL: await claude.start() });
    await running.page.evaluate((path) => window.api.invoke('project:open', path), project);
    await running.page.evaluate(() => window.api.invoke('settings:set-secret', 'anthropicApiKey', 'sk-ant-panels'));
  });

  afterAll(async () => {
    await running?.close();
    await claude?.stop();
    rmSync(project, { recursive: true, force: true });
  });

  it('runs commands in the interactive terminal in the project folder', async () => {
    await running.page.locator('.panel-tab', { hasText: 'Terminal' }).click();
    await running.page.locator('.terminal-panel .xterm').click();
    await running.page.waitForTimeout(1500);
    await running.page.keyboard.type('echo terminal-works-$((20+22))');
    if (process.platform === 'win32') {
      await running.page.keyboard.press('Control+A');
      await running.page.keyboard.type('Write-Output "terminal-works-$(20+22)"');
    }
    await running.page.keyboard.press('Enter');
    await running.page
      .locator('.terminal-panel .xterm-rows', { hasText: 'terminal-works-42' })
      .waitFor({ timeout: 20_000 });
  });

  it('moves between panel tabs with the arrow keys and exposes them as tabs', async () => {
    const tabs = running.page.getByRole('tab');
    await expect(tabs.count()).resolves.toBe(3);
    await running.page.getByRole('tab', { name: 'Terminal' }).focus();
    await running.page.keyboard.press('ArrowRight');
    await expect(running.page.getByRole('tab', { name: 'Browser' }).getAttribute('aria-selected')).resolves.toBe(
      'true',
    );
    await running.page.keyboard.press('End');
    await expect(running.page.getByRole('tab', { name: 'Git' }).getAttribute('aria-selected')).resolves.toBe('true');
    await running.page.keyboard.press('Home');
    await expect(running.page.getByRole('tab', { name: 'Terminal' }).getAttribute('aria-selected')).resolves.toBe(
      'true',
    );
    // Only the selected tab is in the Tab order.
    await expect(running.page.getByRole('tab', { name: 'Git' }).getAttribute('tabindex')).resolves.toBe('-1');
    await expect(running.page.getByRole('tabpanel').count()).resolves.toBeGreaterThan(0);
  });

  it('shows changes in the Git tab and commits them', async () => {
    await running.page.locator('.panel-tab', { hasText: 'Git' }).click();
    const file = running.page.locator('.git-file', { hasText: 'page.html' });
    await file.waitFor();
    await expect(file.locator('.git-status').textContent()).resolves.toBe('U');
    await running.page.locator('.git-diff', { hasText: 'boom from page' }).waitFor();
    if (screenshotDir) await running.page.screenshot({ path: join(screenshotDir, '6-git.png') });

    await running.page.getByLabel('Commit message').fill('Add page');
    await running.page.getByRole('button', { name: 'Commit all' }).click();
    await running.page.getByText('No changes.').waitFor();
    const log = execFileSync('git', ['log', '--oneline'], { cwd: project, encoding: 'utf8' });
    expect(log).toContain('Add page');
  });

  it('lets the agent open a page in the browser panel and see console output and a screenshot', async () => {
    const url = pathToFileURL(join(project, 'page.html')).href;
    claude.script(
      {
        blocks: [{ type: 'tool_use', id: 'toolu_b', name: 'browser', input: { url, screenshot: true } }],
        stopReason: 'tool_use',
      },
      { blocks: [{ type: 'text', text: 'The page logs an error.' }], stopReason: 'end_turn' },
    );
    await running.page.getByLabel('Message', { exact: true }).fill('Check the page');
    await running.page.getByLabel('Message', { exact: true }).press('Enter');
    await running.page.getByText('The page logs an error.', { exact: true }).waitFor({ timeout: 30_000 });

    // The browser panel was brought to the front.
    await expect(running.page.locator('.panel-tab.active').textContent()).resolves.toContain('Browser');
    if (screenshotDir) await running.page.screenshot({ path: join(screenshotDir, '7-browser.png') });

    const result = claude.agentRequests[1].messages.at(-1).content[0];
    const text = result.content.find((block: any) => block.type === 'text').text;
    expect(text).toContain('Title: Demo page');
    expect(text).toContain('boom from page');
    const image = result.content.find((block: any) => block.type === 'image');
    expect(image.source.media_type).toBe('image/png');
    expect(image.source.data.length).toBeGreaterThan(1000);
  });

  it('keeps the browser guest away from Node', async () => {
    const guestGlobals = await running.page.evaluate(() =>
      (document.querySelector('webview') as any).executeJavaScript('typeof require + "/" + typeof process'),
    );
    expect(guestGlobals).toBe('undefined/undefined');
  });

  it('runs without renderer errors', () => {
    expect(running.errors.join('\n')).toBe('');
  });
});
