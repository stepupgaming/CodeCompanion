// Runs before `npm run pack` / `npm run dist`. On Windows, electron-builder cannot replace dist/win-unpacked while
// an app started from it is running (EBUSY), so stop early with a clear message instead.
import { execFileSync } from 'node:child_process';
import { resolve, sep } from 'node:path';

if (process.platform === 'win32') {
  const dist = resolve('dist').toLowerCase() + sep;
  const script = 'Get-Process -ErrorAction SilentlyContinue | ForEach-Object { $_.Path }';
  let paths = [];
  try {
    paths = execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8' })
      .split(/\r?\n/)
      .filter(Boolean);
  } catch {
    // Could not list processes; let electron-builder run and report its own error.
  }
  const running = [...new Set(paths.filter((path) => path.toLowerCase().startsWith(dist)))];
  if (running.length > 0) {
    console.error(`Close Patch first; it is running from the build folder:\n  ${running.join('\n  ')}`);
    process.exit(1);
  }
}
