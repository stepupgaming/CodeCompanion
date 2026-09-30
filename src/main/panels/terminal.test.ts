import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

interface FakePty {
  onData: (callback: (data: string) => void) => void;
  onExit: (callback: () => void) => void;
  write: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  emitData: (data: string) => void;
  emitExit: () => void;
}

const created: Array<{ file: string; args: string[]; options: Record<string, unknown>; pty: FakePty }> = [];

vi.mock('node-pty', () => ({
  spawn: (file: string, args: string[], options: Record<string, unknown>) => {
    let dataCallback: (data: string) => void = () => {};
    let exitCallback: () => void = () => {};
    const pty: FakePty = {
      onData: (callback) => {
        dataCallback = callback;
      },
      onExit: (callback) => {
        exitCallback = callback;
      },
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      emitData: (data) => dataCallback(data),
      emitExit: () => exitCallback(),
    };
    created.push({ file, args, options, pty });
    return pty;
  },
}));

import { TerminalService } from './terminal';

let onData: Mock<(data: string) => void>;
let onExit: Mock<() => void>;
let service: TerminalService;

beforeEach(() => {
  created.length = 0;
  onData = vi.fn();
  onExit = vi.fn();
  service = new TerminalService(onData, onExit);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TerminalService', () => {
  it('starts a shell in the given folder with a sane minimum size', () => {
    service.start('/project', 1, 0);
    expect(created).toHaveLength(1);
    expect(created[0]!.options).toMatchObject({ cwd: '/project', cols: 2, rows: 2 });
  });

  it('uses the bundled ConPTY implementation on Windows only', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    service.start('C:\\project', 80, 24);
    expect(created[0]!.options).toMatchObject({ useConptyDll: true });

    service.stop();
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    service.start('/project', 80, 24);
    expect(created[1]!.options).not.toHaveProperty('useConptyDll');
  });

  it('forwards shell output and user input', () => {
    service.start('/project', 80, 24);
    created[0]!.pty.emitData('hello');
    expect(onData).toHaveBeenCalledWith('hello');
    service.write('ls\r');
    expect(created[0]!.pty.write).toHaveBeenCalledWith('ls\r');
  });

  it('keeps the running shell for the same folder and only resizes it', () => {
    service.start('/project', 80, 24);
    service.start('/project', 100, 30);
    expect(created).toHaveLength(1);
    expect(created[0]!.pty.resize).toHaveBeenCalledWith(100, 30);
  });

  it('replaces the shell when the folder changes', () => {
    service.start('/one', 80, 24);
    service.start('/two', 80, 24);
    expect(created).toHaveLength(2);
    expect(created[0]!.pty.kill).toHaveBeenCalled();
    expect(created[1]!.options).toMatchObject({ cwd: '/two' });
  });

  it('ignores resizes to tiny sizes and rounds fractional sizes', () => {
    service.start('/project', 80, 24);
    service.resize(1, 24);
    service.resize(80, 1);
    expect(created[0]!.pty.resize).not.toHaveBeenCalled();
    service.resize(80.7, 24.2);
    expect(created[0]!.pty.resize).toHaveBeenCalledWith(80, 24);
  });

  it('reports when the shell exits by itself, but not when it is stopped or replaced', () => {
    service.start('/project', 80, 24);
    created[0]!.pty.emitExit();
    expect(onExit).toHaveBeenCalledTimes(1);

    service.start('/project', 80, 24);
    service.stop();
    created[1]!.pty.emitExit();
    expect(onExit).toHaveBeenCalledTimes(1);

    service.start('/one', 80, 24);
    service.start('/two', 80, 24);
    created[2]!.pty.emitExit();
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('survives a shell that is already gone when stopped', () => {
    service.start('/project', 80, 24);
    created[0]!.pty.kill.mockImplementation(() => {
      throw new Error('already exited');
    });
    expect(() => service.stop()).not.toThrow();
    expect(() => service.write('x')).not.toThrow();
  });

  it('can rapidly stop and restart without stale exits clearing the active shell', () => {
    for (let i = 0; i < 20; i++) {
      service.start(`/project-${i}`, 80, 24);
      service.stop();
      created[i]!.pty.emitExit();
    }

    service.start('/active', 80, 24);
    created[19]!.pty.emitExit();
    service.write('still active');

    expect(created).toHaveLength(21);
    expect(created.slice(0, 20).every(({ pty }) => pty.kill.mock.calls.length === 1)).toBe(true);
    expect(created[20]!.pty.write).toHaveBeenCalledWith('still active');
    expect(onExit).not.toHaveBeenCalled();
  });
});
