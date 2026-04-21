/**
 * Export & import the entire project state as a single JSON file.
 * Keys bundled: room, asset library, tile overrides, custom assets.
 */

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

export function exportProject(): void {
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

  const blob = new Blob([JSON.stringify(file)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `virtual-office-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function importProject(file: File): Promise<void> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result as string) as ProjectFile;
        if (parsed._header !== FILE_HEADER) {
          reject(new Error('Not a valid Virtual Office project file.'));
          return;
        }
        for (const key of KEYS) {
          if (key in parsed.data) {
            localStorage.setItem(key, JSON.stringify(parsed.data[key]));
          }
        }
        resolve();
      } catch {
        reject(new Error('Failed to parse project file.'));
      }
    };
    reader.onerror = () => reject(new Error('Failed to read file.'));
    reader.readAsText(file);
  });
}
