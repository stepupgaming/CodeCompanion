import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchApp, type RunningApp } from './app';
import { MockClaude } from './mock_claude';

const captureDir = process.env.E2E_DOC_SCREENSHOTS;

type ContrastSample = { name: string; ratio: number; foreground: string; background: string };

describe('documentation visuals and text contrast', () => {
  let running: RunningApp;
  let claude: MockClaude;
  let project: string;

  beforeAll(async () => {
    project = mkdtempSync(join(tmpdir(), 'patch-visuals-project-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: project });
    git('init', '-q');
    git('config', 'user.email', 'docs@example.test');
    git('config', 'user.name', 'Documentation');
    writeFileSync(join(project, 'README.md'), '# Sample project\n\nA small Patch demo.\n');
    git('add', '.');
    git('commit', '-qm', 'Initial project');
    writeFileSync(
      join(project, 'preview.html'),
      `<!doctype html>
<style>
  body { font: 16px system-ui; margin: 48px; color: #243047; }
  h1 { color: #5145cd; }
  .card { padding: 24px; border: 1px solid #d8dbea; border-radius: 12px; max-width: 480px; }
</style>
<div class="card">
  <h1>Preview ready</h1>
  <p>Your application is running successfully.</p>
  <button>Get started</button>
</div>
<script>console.log('Preview loaded')</script>
`,
    );

    claude = new MockClaude();
    running = await launchApp({ PATCH_TEST_ANTHROPIC_URL: await claude.start() });
    await running.page.evaluate((path) => window.api.invoke('project:open', path), project);
    await running.page.evaluate(() => window.api.invoke('settings:set-secret', 'anthropicApiKey', 'sk-ant-docs-test'));
    if (captureDir) mkdirSync(resolve(captureDir), { recursive: true });
  });

  afterAll(async () => {
    await running?.close();
    await claude?.stop();
    rmSync(project, { recursive: true, force: true });
  });

  it('captures the rendered Settings, Git, and Browser panels when requested', async () => {
    await running.page.setViewportSize({ width: 1440, height: 900 });
    await running.page.getByTitle('Settings (Ctrl+,)').click();
    const dialog = running.page.locator('.app-dialog');
    const editor = running.page.getByLabel('Editor command');
    await editor.scrollIntoViewIfNeeded();

    // The field is in a deliberately scrollable body, but must be fully reachable above the fixed footer.
    const geometry = await editor.evaluate((input) => {
      const footer = document.querySelector('.app-dialog .dialog-footer');
      if (!footer) return null;
      const a = input.getBoundingClientRect();
      const b = footer.getBoundingClientRect();
      return { top: a.top, bottom: a.bottom, footerTop: b.top };
    });
    expect(geometry).not.toBeNull();
    expect(geometry!.bottom).toBeLessThanOrEqual(geometry!.footerTop);
    expect(geometry!.top).toBeGreaterThanOrEqual(0);
    await running.page.locator('.dialog-body').evaluate((body) => (body.scrollTop = 0));
    if (captureDir) await dialog.screenshot({ path: join(captureDir, 'settings.png') });
    await running.page.getByRole('button', { name: 'Cancel' }).click();

    await running.page.getByRole('tab', { name: 'Git' }).click();
    await running.page.locator('.git-file', { hasText: 'preview.html' }).waitFor();
    await running.page.locator('.git-diff', { hasText: 'Preview ready' }).waitFor();
    if (captureDir) await running.page.locator('.panel-host').screenshot({ path: join(captureDir, 'git.png') });

    const url = pathToFileURL(join(project, 'preview.html')).href;
    claude.script(
      { blocks: [{ type: 'tool_use', id: 'toolu_preview', name: 'browser', input: { url } }], stopReason: 'tool_use' },
      { blocks: [{ type: 'text', text: 'The preview is ready.' }], stopReason: 'end_turn' },
    );
    await running.page.getByLabel('Message', { exact: true }).fill('Open the app preview');
    await running.page.getByLabel('Message', { exact: true }).press('Enter');
    await running.page.getByText('The preview is ready.', { exact: true }).waitFor({ timeout: 30_000 });
    await running.page.getByLabel('Address').fill('https://preview.example.test');
    await running.page.waitForFunction(() =>
      (document.querySelector('webview') as any)
        ?.executeJavaScript('document.body.innerText')
        .then((text: string) => text.includes('Preview ready')),
    );
    await running.page.waitForTimeout(300);
    if (captureDir) {
      // Chromium does not composite a webview's GPU surface into element screenshots under Xvfb. Capture that real
      // guest surface through Electron, then place it over the webview only for the panel screenshot.
      const preview = await running.app.evaluate(async ({ webContents }) => {
        const guest = webContents.getAllWebContents().find((contents) => contents.getType() === 'webview');
        if (!guest) throw new Error('Browser guest was not found');
        return (await guest.capturePage()).toDataURL();
      });
      await running.page.evaluate((src) => {
        const webview = document.querySelector<HTMLElement>('.browser-view');
        const image = document.createElement('img');
        image.className = 'browser-view e2e-browser-capture';
        image.src = src;
        image.style.objectFit = 'cover';
        webview?.before(image);
        if (webview) webview.hidden = true;
      }, preview);
      await running.page.locator('.e2e-browser-capture').waitFor();
      await running.page.locator('.panel-host').screenshot({ path: join(captureDir, 'browser.png') });
    }
  });

  it('meets WCAG AA text contrast in light and dark themes', async () => {
    claude.script(
      {
        blocks: [{ type: 'tool_use', id: 'toolu_read', name: 'read_file', input: { path: 'README.md' } }],
        stopReason: 'tool_use',
      },
      {
        blocks: [
          {
            type: 'tool_use',
            id: 'toolu_contrast',
            name: 'edit_file',
            input: { path: 'README.md', old_string: 'small', new_string: 'focused' },
          },
        ],
        stopReason: 'tool_use',
      },
    );
    await running.page.evaluate(() => window.api.invoke('chat:send', { text: 'Improve the README description' }));
    await running.page
      .locator('.tool-card.awaiting')
      .waitFor({ timeout: 10_000 })
      .catch(async (error) => {
        const snapshot = await running.page.evaluate(() => window.api.invoke('chat:snapshot'));
        throw new Error(`${error.message}\nSnapshot: ${JSON.stringify(snapshot.transcript)}`);
      });

    for (const theme of ['light', 'dark'] as const) {
      await running.page.mouse.move(0, 0);
      await running.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await running.page.evaluate((value) => window.api.invoke('settings:update', { theme: value }), theme);
      await running.page.locator(`html[data-bs-theme="${theme}"]`).waitFor();
      expect(await running.page.locator('html').getAttribute('data-bs-theme')).toBe(theme);
      const samples = await measureContrast(running, [
        ['footer status', '.app-footer'],
        ['approval summary', '.tool-card.awaiting .tool-header'],
        ['approve control', '.tool-card.awaiting .btn-primary'],
        ['reject control', '.tool-card.awaiting .btn-outline-secondary'],
        ['active panel tab', '.panel-tab.active'],
      ]);
      console.info(`${theme} contrast: ${JSON.stringify(samples)}`);
      for (const sample of samples) {
        expect(sample.ratio, `${theme} ${sample.name} text contrast`).toBeGreaterThanOrEqual(4.5);
      }
      const decline = running.page.locator('.tool-card.awaiting .btn-outline-secondary');
      await decline.hover();
      await running.page.waitForTimeout(200);
      for (const sample of await measureContrast(running, [
        ['decline hover', '.tool-card.awaiting .btn-outline-secondary'],
      ])) {
        expect(sample.ratio, `${theme} ${sample.name}`).toBeGreaterThanOrEqual(4.5);
      }
      await running.page.mouse.move(0, 0);
      await decline.focus();
      await running.page.waitForTimeout(200);
      for (const sample of await measureContrast(running, [
        ['decline focus', '.tool-card.awaiting .btn-outline-secondary'],
      ])) {
        expect(sample.ratio, `${theme} ${sample.name}`).toBeGreaterThanOrEqual(4.5);
      }
      if (process.env.E2E_SCREENSHOTS) {
        await running.page
          .locator('.tool-card.awaiting')
          .screenshot({ path: join(process.env.E2E_SCREENSHOTS, `approval-${theme}.png`) });
      }
    }
  });
});

async function measureContrast(running: RunningApp, targets: [string, string][]): Promise<ContrastSample[]> {
  // Measure settled states, not intermediate colors in Bootstrap's theme/focus transitions.
  await running.page.waitForFunction(
    () =>
      !document
        .getAnimations()
        .some((animation) => animation instanceof CSSTransition && animation.playState === 'running'),
  );
  return running.page.evaluate((entries) => {
    const parse = (value: string) => (value.match(/[\d.]+/g) ?? []).map(Number);
    const blend = (foreground: number[], background: number[]) => {
      const alpha = foreground[3] ?? 1;
      return foreground.slice(0, 3).map((channel, index) => channel * alpha + (background[index] ?? 0) * (1 - alpha));
    };
    const background = (element: Element) => {
      let result = [255, 255, 255];
      const layers: number[][] = [];
      for (let node: Element | null = element; node; node = node.parentElement)
        layers.push(parse(getComputedStyle(node).backgroundColor));
      for (const layer of layers.reverse()) if (layer.length >= 3) result = blend(layer, result);
      return result;
    };
    const luminance = (rgb: number[]) => {
      const channels = rgb.map((channel) => {
        const value = channel / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
    };
    return entries.map(([name, selector]) => {
      const element = document.querySelector(selector);
      if (!element) throw new Error(`Missing contrast target: ${selector}`);
      const bg = background(element);
      const style = getComputedStyle(element);
      const fg = blend(parse(style.color), bg);
      const [lighter, darker] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
      return {
        name,
        ratio: (lighter! + 0.05) / (darker! + 0.05),
        foreground: style.color,
        background: style.backgroundColor,
      };
    });
  }, targets);
}
