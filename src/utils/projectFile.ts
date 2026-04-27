/**
 * Export & import the entire project state as a single JSON file.
 * Keys bundled: room, asset library, tile overrides, custom assets.
 */

import { save, open } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';

const KEYS = [
  'virtualOffice_room',
  'virtualOffice_library',
  'virtualOffice_tileOverrides',
  'virtualOffice_customAssets',
  'virtualOffice_agents',
  // Current: pixel-mask collision overrides (painted in the Collision Editor).
  // Asset-level default masks (apply to every placement of an asset).
  'virtualOffice_collisionMasks',
  // Per-placement collision masks (override the asset default for a single
  // instance). Keyed by placement id, so they only make sense alongside the
  // room payload above.
  'virtualOffice_placementMasks',
  // Legacy walkable/blocking toggle — still bundled so old project files and
  // half-migrated installs round-trip cleanly. `useCollisionMasks` migrates
  // these into mask form on first load and removes the key.
  'virtualOffice_blockingOverrides',
  // Render-order overrides. Each entry is `'above' | 'below'` (absence = the
  // implicit `'auto'` value, following normal y-sort vs the agent's foot
  // row). Asset-level applies to every placement of an asset; placement-
  // level is a per-instance override that wins over the asset default.
  'virtualOffice_assetRenderOrder',
  'virtualOffice_placementRenderOrder',
  // Per-asset / per-placement y-sort anchor overrides (Plan B). Shifts where
  // an asset sits on the y-sort line — used e.g. to tune tall assets like
  // chairs or back walls that otherwise occlude agents one row past their
  // visual foot. See `useSortAnchorOverrides` for semantics.
  'virtualOffice_assetSortAnchor',
  'virtualOffice_placementSortAnchor',
  // Legacy above-agent flag keys — kept here so old project files still
  // round-trip cleanly. `useRenderOrderOverrides` migrates these into the
  // new storage on first load and removes them.
  'virtualOffice_assetAboveAgent',
  'virtualOffice_placementAboveAgent',
] as const;

const FILE_HEADER = 'virtualOffice_project';
const FILE_VERSION = 1;

interface ProjectFile {
  _header: string;
  _version: number;
  _exportedAt: string;
  data: Record<string, unknown>;
}

function buildProjectPayload(): string {
  const data: Record<string, unknown> = {};
  for (const key of KEYS) {
    const raw = localStorage.getItem(key);
    if (raw !== null) {
      try { data[key] = JSON.parse(raw); } catch { data[key] = raw; }
    }
  }
  const file: ProjectFile = {
    _header: FILE_HEADER,
    _version: FILE_VERSION,
    _exportedAt: new Date().toISOString(),
    data,
  };
  return JSON.stringify(file, null, 2);
}

function applyProjectPayload(parsed: ProjectFile): void {
  if (parsed._header !== FILE_HEADER) {
    throw new Error('Not a valid Virtual Office project file.');
  }
  for (const key of KEYS) {
    if (key in parsed.data) {
      localStorage.setItem(key, JSON.stringify(parsed.data[key]));
    }
  }
}

/**
 * Show a native save dialog and write the project JSON to the chosen path.
 * Returns the saved path, or `null` if the user cancelled.
 */
export async function exportProject(): Promise<string | null> {
  const defaultName = `virtual-office-${new Date().toISOString().slice(0, 10)}.json`;

  const path = await save({
    title: 'Export Virtual Office project',
    defaultPath: defaultName,
    filters: [{ name: 'Virtual Office project', extensions: ['json'] }],
  });

  if (!path) return null;

  const contents = buildProjectPayload();
  await invoke('write_text_file', { path, contents });
  return path;
}

/**
 * Show a native open dialog and load a project JSON from the chosen path.
 * Returns the loaded path, or `null` if the user cancelled.
 */
export async function importProject(): Promise<string | null> {
  const selected = await open({
    title: 'Import Virtual Office project',
    multiple: false,
    directory: false,
    filters: [{ name: 'Virtual Office project', extensions: ['json'] }],
  });

  if (!selected || Array.isArray(selected)) return null;

  const raw = await invoke<string>('read_text_file', { path: selected });
  let parsed: ProjectFile;
  try {
    parsed = JSON.parse(raw) as ProjectFile;
  } catch {
    throw new Error('Failed to parse project file.');
  }
  applyProjectPayload(parsed);
  return selected;
}
