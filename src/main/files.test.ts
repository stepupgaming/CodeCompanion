import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserWindow } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  showOpenDialog: vi.fn(),
  showSaveDialog: vi.fn(),
  spawn: vi.fn(),
  unref: vi.fn(),
}));

vi.mock('electron', () => ({ dialog: { showOpenDialog: mocks.showOpenDialog, showSaveDialog: mocks.showSaveDialog } }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));

import { openInEditor, pickImages, saveTextFile } from './files';

let dir: string;
const window = { id: 1 } as unknown as BrowserWindow;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cc-files-'));
  mocks.spawn.mockReturnValue({ on: vi.fn(), unref: mocks.unref });
});

afterEach(() => {
  vi.clearAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('pickImages', () => {
  it('returns nothing when the dialog is cancelled', async () => {
    mocks.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
    expect(await pickImages(window)).toEqual([]);
  });

  it('reads the chosen images with their media types, whatever the extension case', async () => {
    const png = join(dir, 'shot.png');
    const jpg = join(dir, 'PHOTO.JPG');
    writeFileSync(png, 'png-bytes');
    writeFileSync(jpg, 'jpg-bytes');
    mocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [png, jpg] });

    expect(await pickImages(window)).toEqual([
      { name: 'shot.png', mediaType: 'image/png', base64: Buffer.from('png-bytes').toString('base64') },
      { name: 'PHOTO.JPG', mediaType: 'image/jpeg', base64: Buffer.from('jpg-bytes').toString('base64') },
    ]);
  });

  it('allows several image files and attaches the dialog to the window when there is one', async () => {
    mocks.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
    await pickImages(window);
    await pickImages(null);

    const options = expect.objectContaining({
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }],
    });
    expect(mocks.showOpenDialog).toHaveBeenNthCalledWith(1, window, options);
    expect(mocks.showOpenDialog).toHaveBeenNthCalledWith(2, options);
  });

  it('rejects files that are not supported images', async () => {
    const file = join(dir, 'scan.bmp');
    writeFileSync(file, 'x');
    mocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [file] });
    await expect(pickImages(window)).rejects.toThrow('Unsupported image type: scan.bmp');
  });

  it('rejects images larger than 5 MB but accepts exactly 5 MB', async () => {
    const limit = 5 * 1024 * 1024;
    const exact = join(dir, 'exact.webp');
    const big = join(dir, 'big.gif');
    writeFileSync(exact, Buffer.alloc(limit));
    writeFileSync(big, Buffer.alloc(limit + 1));

    mocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [exact] });
    expect(await pickImages(window)).toHaveLength(1);

    mocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [big] });
    await expect(pickImages(window)).rejects.toThrow('big.gif is larger than 5 MB.');
  });
});

describe('saveTextFile', () => {
  it('writes the text to the chosen path and returns it', async () => {
    const target = join(dir, 'chat.md');
    mocks.showSaveDialog.mockResolvedValue({ canceled: false, filePath: target });

    expect(await saveTextFile(window, 'chat.md', '# Hello\n')).toBe(target);
    expect(mocks.showSaveDialog).toHaveBeenCalledWith(
      window,
      expect.objectContaining({ defaultPath: 'chat.md', filters: [{ name: 'Markdown', extensions: ['md'] }] }),
    );
    expect(readFileSync(target, 'utf8')).toBe('# Hello\n');
  });

  it('shows the dialog without a window when there is none', async () => {
    mocks.showSaveDialog.mockResolvedValue({ canceled: true });
    await saveTextFile(null, 'chat.md', 'text');
    expect(mocks.showSaveDialog).toHaveBeenCalledWith(expect.objectContaining({ defaultPath: 'chat.md' }));
  });

  it('returns null and writes nothing when cancelled or when no path comes back', async () => {
    const target = join(dir, 'never.md');
    mocks.showSaveDialog.mockResolvedValueOnce({ canceled: true, filePath: target });
    expect(await saveTextFile(window, 'never.md', 'text')).toBeNull();
    mocks.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: '' });
    expect(await saveTextFile(window, 'never.md', 'text')).toBeNull();
    expect(existsSync(target)).toBe(false);
  });
});

describe('openInEditor', () => {
  it('starts the editor detached with the file as one quoted argument', () => {
    const file = join(dir, 'src file.ts');
    writeFileSync(file, '');

    openInEditor('  cursor --reuse-window ', dir, 'src file.ts');

    expect(mocks.spawn).toHaveBeenCalledWith(
      `cursor --reuse-window "${realpathSync(file)}"`,
      expect.objectContaining({ shell: true, detached: true, stdio: 'ignore', windowsHide: true }),
    );
    expect(mocks.unref).toHaveBeenCalled();
  });

  it('falls back to "code" when no editor command is set', () => {
    const file = join(dir, 'a.txt');
    writeFileSync(file, '');
    openInEditor('   ', dir, 'a.txt');
    expect(mocks.spawn).toHaveBeenCalledWith(`code "${realpathSync(file)}"`, expect.any(Object));
  });

  it('refuses paths outside the project', () => {
    expect(() => openInEditor('code', dir, '../secret.txt')).toThrow(/outside the project/);
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('refuses file names that could break out of the quoted argument', () => {
    expect(() => openInEditor('code', dir, 'a" & calc & ".txt')).toThrow('Unsupported characters in file path.');
    expect(() => openInEditor('code', dir, 'a\nb.txt')).toThrow('Unsupported characters in file path.');
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it.runIf(process.platform !== 'win32')('refuses file names that the shell would expand on macOS and Linux', () => {
    for (const name of ['$(touch pwned).js', '`id`.js', '$HOME.js', 'a\\b.js']) {
      expect(() => openInEditor('code', dir, name)).toThrow('Unsupported characters in file path.');
    }
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('ignores errors from an editor that cannot be started', () => {
    const on = vi.fn();
    mocks.spawn.mockReturnValue({ on, unref: mocks.unref });
    openInEditor('missing-editor', dir, 'a.txt');
    expect(on).toHaveBeenCalledWith('error', expect.any(Function));
    expect(() => on.mock.calls[0]![1](new Error('spawn failed'))).not.toThrow();
  });
});
