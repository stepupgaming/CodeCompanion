import { describe, expect, it } from 'vitest';
import { parseMcpServers, sanitizeMcpServers } from './settings';

describe('parseMcpServers', () => {
  it('accepts valid stdio and http servers', () => {
    const servers = parseMcpServers(
      JSON.stringify([
        { name: 'fs', transport: 'stdio', command: 'npx', args: ['-y', 'server-fs'], env: { DEBUG: '1' } },
        { name: 'docs', transport: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer x' } },
      ]),
    );
    expect(servers).toHaveLength(2);
    expect(servers[0]).toMatchObject({ name: 'fs', transport: 'stdio' });
    expect(servers[1]).toMatchObject({ name: 'docs', transport: 'http' });
  });

  it('accepts an empty list', () => {
    expect(parseMcpServers('')).toEqual([]);
    expect(parseMcpServers('[]')).toEqual([]);
  });

  it('rejects broken JSON and invalid entries with a readable message', () => {
    expect(() => parseMcpServers('{')).toThrow(/valid JSON/);
    expect(() => parseMcpServers('{}')).toThrow(/JSON array/);
    expect(() => parseMcpServers('[{}]')).toThrow(/entry 1.*"name" is required/);
    expect(() => parseMcpServers('[{"name":"x","transport":"ws"}]')).toThrow(/"transport" must be/);
    expect(() => parseMcpServers('[{"name":"x","transport":"stdio"}]')).toThrow(/need a "command"/);
    expect(() => parseMcpServers('[{"name":"x","transport":"http","url":"ftp://x"}]')).toThrow(/http\(s\):\/\//);
    expect(() => parseMcpServers('[{"name":"x","transport":"stdio","command":"a","args":[1]}]')).toThrow(
      /"args" must be string arrays/,
    );
  });
});

describe('sanitizeMcpServers', () => {
  it('drops unusable entries instead of failing to start', () => {
    expect(
      sanitizeMcpServers([
        { name: 'ok', transport: 'stdio', command: 'run' },
        { name: '', transport: 'stdio', command: 'run' },
        'nonsense',
        { name: 'no-url', transport: 'http' },
      ]),
    ).toEqual([{ name: 'ok', transport: 'stdio', command: 'run' }]);
  });

  it('rejects non-arrays', () => {
    expect(sanitizeMcpServers(undefined)).toEqual([]);
    expect(sanitizeMcpServers({})).toEqual([]);
  });
});
