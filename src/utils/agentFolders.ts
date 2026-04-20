import { isTauri, invokeSafe } from './tauri';

export function isFolderNameValid(name: string): string | null {
  if (!name) return 'Folder name cannot be empty.';
  if (name.length > 64) return 'Folder name too long (max 64).';
  if (!/^[a-z0-9_-]+$/.test(name)) return 'Use only a-z, 0-9, "-" or "_".';
  if (name.includes('..')) return 'Folder name cannot contain "..".';
  return null;
}

export async function getProjectsRoot(): Promise<string> {
  return invokeSafe<string>('get_projects_root');
}

export async function createAgentFolder(folderName: string): Promise<string> {
  return invokeSafe<string>('create_agent_folder', { folderName });
}

export async function deleteAgentFolder(folderName: string): Promise<void> {
  return invokeSafe<void>('delete_agent_folder', { folderName });
}

export async function listAgentFolders(): Promise<string[]> {
  if (!isTauri()) return [];
  return invokeSafe<string[]>('list_agent_folders');
}

export async function agentFolderPath(folderName: string): Promise<string> {
  return invokeSafe<string>('agent_folder_path', { folderName });
}
