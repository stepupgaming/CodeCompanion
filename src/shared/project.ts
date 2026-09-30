export interface ProjectInfo {
  path: string;
  name: string;
  // Added to the system prompt of every chat in this project.
  instructions: string;
  // Added to the global lists in Settings, for this project only (same format: one entry per line). Kept in the app's
  // data folder, not in the project, so a repository cannot allow its own commands. Missing in files written before
  // these existed.
  allowedCommands?: string;
  allowedNetworkHosts?: string;
  lastOpened: string;
}

// What the Project settings dialog changes.
export type ProjectSettings = Pick<ProjectInfo, 'instructions'> &
  Required<Pick<ProjectInfo, 'allowedCommands' | 'allowedNetworkHosts'>>;

// An allow-list made of the global one and the project's own: an entry in either counts.
export function mergeAllowLists(global: string, project: string | undefined): string {
  return project?.trim() ? `${global}\n${project}` : global;
}
