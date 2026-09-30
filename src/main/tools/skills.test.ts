import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Workspace } from './workspace';
import { listSkills, loadSkillTool, readSkill } from './skills';

describe('project skills', () => {
  let root: string;

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function projectWith(files: Record<string, string>): Workspace {
    root = mkdtempSync(join(tmpdir(), 'cc-skills-'));
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(root, path, '..'), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    return new Workspace(root);
  }

  it('lists markdown skills with their first non-heading line as description', () => {
    const workspace = projectWith({
      '.codecompanion/skills/deploy.md': '# Deploy\n\nRun the release checklist: bump versions, tag, publish.\n',
      '.codecompanion/skills/review.md': 'Review PRs against CONTRIBUTING.md first.\n\nMore detail below.\n',
    });
    expect(listSkills(workspace)).toEqual([
      { name: 'deploy', description: 'Run the release checklist: bump versions, tag, publish.' },
      { name: 'review', description: 'Review PRs against CONTRIBUTING.md first.' },
    ]);
  });

  it('returns no skills for a project without the folder', () => {
    expect(listSkills(projectWith({ 'README.md': 'hi\n' }))).toEqual([]);
  });

  it('reads a skill through the confined workspace', () => {
    const workspace = projectWith({ '.codecompanion/skills/deploy.md': 'Step one.\n' });
    expect(readSkill(workspace, 'deploy')).toContain('Step one.');
  });

  it('rejects traversal names and unknown skills with the available list', () => {
    const workspace = projectWith({ '.codecompanion/skills/deploy.md': 'Step one.\n' });
    expect(() => readSkill(workspace, '../secrets')).toThrow(/Invalid skill name/);
    expect(() => readSkill(workspace, '..\\secrets')).toThrow(/Invalid skill name/);
    expect(() => readSkill(workspace, 'missing')).toThrow(/No skill named "missing". Available skills: deploy/);
  });

  it('loads a skill through the tool', async () => {
    const workspace = projectWith({ '.codecompanion/skills/deploy.md': 'Bump, tag, publish.\n' });
    const output = await loadSkillTool.run({ name: 'deploy' }, { workspace } as never);
    expect(output.content).toContain('Bump, tag, publish.');
    expect(output.summary).toBe('Loaded skill deploy');
  });
});
