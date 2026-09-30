import { existsSync, realpathSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import type { ProjectInfo, ProjectSettings } from '@shared/project';
import { readJson, writeJson } from './storage/json_file';

const MAX_RECENT = 20;
const MAX_SETTING_CHARS = 50_000;

// Recent projects and their custom instructions, stored in userData/projects.json.
export class ProjectStore {
  private projects: ProjectInfo[];
  private currentPath: string | null = null;
  private readonly openProjects = new Map<string, ProjectInfo>();

  constructor(private readonly file: string) {
    this.projects = readJson<ProjectInfo[]>(file, []).filter((project) => typeof project?.path === 'string');
  }

  list(): ProjectInfo[] {
    return [...this.projects].sort((a, b) => b.lastOpened.localeCompare(a.lastOpened));
  }

  current(): ProjectInfo | null {
    return this.openProjects.get(this.currentPath ?? '') ?? null;
  }

  opened(): ProjectInfo[] {
    return [...this.openProjects.values()].map((project) => ({ ...project }));
  }

  close(path: string): void {
    this.openProjects.delete(path);
    if (this.currentPath === path) this.currentPath = this.openProjects.keys().next().value ?? null;
  }

  open(path: string): ProjectInfo {
    const absolute = resolve(path);
    if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
      throw new Error(`Folder not found: ${path}`);
    }
    const real = realpathSync(absolute);
    let project = this.openProjects.get(real) ?? this.projects.find((candidate) => candidate.path === real);
    if (!project) {
      project = { path: real, name: basename(real) || real, instructions: '', lastOpened: '' };
    } else {
      this.projects = this.projects.filter((candidate) => candidate !== project);
    }
    project.lastOpened = new Date().toISOString();
    this.projects.unshift(project);
    this.currentPath = real;
    this.openProjects.set(real, project);
    this.projects = this.list().filter(
      (candidate, index) => index < MAX_RECENT || this.openProjects.has(candidate.path),
    );
    this.persist();
    return { ...project };
  }

  setInstructions(path: string, instructions: string): ProjectInfo {
    return this.update(path, { instructions });
  }

  // The instructions and the project's own allow-lists, from the Project settings dialog. The values come from the
  // renderer, so only these three fields are taken, each must be text, and each is capped in size.
  updateSettings(path: string, settings: ProjectSettings): ProjectInfo {
    const text = (value: unknown, name: string) => {
      if (typeof value !== 'string') throw new Error(`Invalid project setting: ${name}`);
      return value.slice(0, MAX_SETTING_CHARS);
    };
    return this.update(path, {
      instructions: text(settings?.instructions, 'instructions'),
      allowedCommands: text(settings?.allowedCommands, 'allowedCommands').trim(),
      allowedNetworkHosts: text(settings?.allowedNetworkHosts, 'allowedNetworkHosts').trim(),
    });
  }

  // The project as it is now, or null. Read on every tool call, so a change applies to open chats at once.
  get(path: string): ProjectInfo | null {
    const project = this.openProjects.get(path) ?? this.projects.find((candidate) => candidate.path === path);
    return project ? { ...project } : null;
  }

  private update(path: string, patch: Partial<ProjectSettings>): ProjectInfo {
    const project = this.openProjects.get(path) ?? this.projects.find((candidate) => candidate.path === path);
    if (!project) throw new Error(`Unknown project: ${path}`);
    Object.assign(project, patch);
    this.persist();
    return { ...project };
  }

  remove(path: string): void {
    this.close(path);
    this.projects = this.projects.filter((project) => project.path !== path);
    this.persist();
  }

  private persist(): void {
    writeJson(this.file, this.projects);
  }
}
