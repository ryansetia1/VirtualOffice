import { useCallback, useState, useMemo } from 'react';
import { getAllAssets, ASSET_COUNT } from '../data/assetManifest';
import {
  assetCreateCategory,
  assetRenameCategory,
  assetDeleteCategory,
  assetMoveFile,
} from '../utils/assetFiles';
import { refreshAssetImage } from '../utils/imageLoader';

const LIBRARY_KEY = 'virtualOffice_library';
const TILE_OVERRIDES_KEY = 'virtualOffice_tileOverrides';

const OLD_KEYS = [
  'virtualOffice_assetOverrides',
  'virtualOffice_customCategories',
  'virtualOffice_categoryLabels',
  'virtualOffice_initialized',
];

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AssetLibraryState {
  rootLabel: string;
  assetBasePath: string;
  filePattern: string;
  totalAssets: number;
  categories: Record<string, number[]>;
  assetNames: Record<number, string>;
}

export interface TreeNode {
  name: string;
  path: string;
  children: TreeNode[];
  directAssetIds: number[];
  totalAssetCount: number;
}

// ─── Persistence helpers ─────────────────────────────────────────────────────

function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function saveJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch { /* ignore */ }
}

function createDefaultLibrary(): AssetLibraryState {
  return {
    rootLabel: 'My Assets',
    assetBasePath: '/tiles',
    filePattern: 'Modern_Office_Singles_48x48_{id}.png',
    totalAssets: ASSET_COUNT,
    categories: {},
    assetNames: {},
  };
}

function loadLibrary(): AssetLibraryState {
  for (const key of OLD_KEYS) localStorage.removeItem(key);
  return loadJson<AssetLibraryState>(LIBRARY_KEY, createDefaultLibrary());
}

function saveLibrary(lib: AssetLibraryState): void {
  saveJson(LIBRARY_KEY, lib);
}

// ─── Tree builder ────────────────────────────────────────────────────────────

function buildTree(categories: Record<string, number[]>, validIds?: Set<number>): TreeNode[] {
  const root: TreeNode[] = [];
  const nodeMap = new Map<string, TreeNode>();

  const ensureNode = (path: string): TreeNode => {
    const existing = nodeMap.get(path);
    if (existing) return existing;

    const parts = path.split('/');
    const name = parts[parts.length - 1];
    const rawIds = categories[path] ?? [];
    const node: TreeNode = {
      name,
      path,
      children: [],
      directAssetIds: validIds ? rawIds.filter((id) => validIds.has(id)) : rawIds,
      totalAssetCount: 0,
    };
    nodeMap.set(path, node);

    if (parts.length === 1) {
      root.push(node);
    } else {
      const parentPath = parts.slice(0, -1).join('/');
      const parent = ensureNode(parentPath);
      if (!parent.children.find((c) => c.path === path)) {
        parent.children.push(node);
      }
    }
    return node;
  };

  const sortedPaths = Object.keys(categories).sort();
  for (const path of sortedPaths) {
    ensureNode(path);
  }

  const computeTotals = (node: TreeNode): number => {
    let total = node.directAssetIds.length;
    for (const child of node.children) {
      total += computeTotals(child);
    }
    node.totalAssetCount = total;
    return total;
  };

  for (const node of root) computeTotals(node);
  return root;
}

// ─── Display name helper ─────────────────────────────────────────────────────

function deriveDefaultName(id: number, filePattern: string): string {
  return filePattern.replace('{id}', String(id)).replace(/\.png$/i, '');
}

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useAssetCategories(extraAssetIds?: number[]) {
  const [library, setLibrary] = useState<AssetLibraryState>(loadLibrary);
  const [tileOverrides, setTileOverridesState] = useState<Record<number, [number, number][]>>(
    () => loadJson<Record<number, [number, number][]>>(TILE_OVERRIDES_KEY, {})
  );

  const allAssetIds = useMemo(() => {
    const builtIn = getAllAssets().map((a) => a.id);
    return extraAssetIds ? [...builtIn, ...extraAssetIds] : builtIn;
  }, [extraAssetIds]);

  const validIdSet = useMemo(() => new Set(allAssetIds), [allAssetIds]);

  const assignedIds = useMemo(() => {
    const set = new Set<number>();
    for (const ids of Object.values(library.categories)) {
      for (const id of ids) {
        if (validIdSet.has(id)) set.add(id);
      }
    }
    return set;
  }, [library.categories, validIdSet]);

  const uncategorizedIds = useMemo(
    () => allAssetIds.filter((id) => !assignedIds.has(id)),
    [allAssetIds, assignedIds]
  );

  const categoryTree = useMemo(
    () => buildTree(library.categories, validIdSet),
    [library.categories, validIdSet]
  );

  // ── Library updater ────────────────────────────────────────────────────────

  const updateLibrary = useCallback((updater: (prev: AssetLibraryState) => AssetLibraryState) => {
    setLibrary((prev) => {
      const next = updater(prev);
      saveLibrary(next);
      return next;
    });
  }, []);

  // ── Root config ────────────────────────────────────────────────────────────

  const setRootLabel = useCallback((label: string) => {
    updateLibrary((prev) => ({ ...prev, rootLabel: label }));
  }, [updateLibrary]);

  // ── Category operations ────────────────────────────────────────────────────

  // Resolve the physical file name for a built-in asset. Custom assets (id >= 1000)
  // are in-memory data URLs and are never mirrored to disk.
  const filePatternRef = useMemo(() => library.filePattern, [library.filePattern]);
  const fileNameFor = useCallback(
    (id: number): string | null => {
      if (id >= 1000) return null;
      return filePatternRef.replace('{id}', String(id));
    },
    [filePatternRef]
  );

  const createCategory = useCallback((path: string) => {
    const normalized = path.replace(/\/+/g, '/').replace(/^\/|\/$/g, '').trim();
    if (!normalized) return;
    updateLibrary((prev) => {
      if (prev.categories[normalized] !== undefined) return prev;
      const cats = { ...prev.categories };
      // Ensure intermediate paths exist
      const parts = normalized.split('/');
      for (let i = 1; i <= parts.length; i++) {
        const sub = parts.slice(0, i).join('/');
        if (cats[sub] === undefined) cats[sub] = [];
      }
      return { ...prev, categories: cats };
    });
    // Mirror to disk (Tauri only). Creates all intermediate dirs automatically.
    void assetCreateCategory(normalized);
  }, [updateLibrary]);

  const renameCategory = useCallback((path: string, newName: string) => {
    const cleaned = newName.trim().replace(/\//g, '');
    if (!cleaned) return;
    let newPath: string | null = null;
    updateLibrary((prev) => {
      const cats = { ...prev.categories };
      const parts = path.split('/');
      parts[parts.length - 1] = cleaned;
      const candidate = parts.join('/');

      if (candidate === path) return prev;
      if (cats[candidate] !== undefined) return prev;

      const updated: Record<string, number[]> = {};
      for (const [key, val] of Object.entries(cats)) {
        if (key === path) {
          updated[candidate] = val;
        } else if (key.startsWith(path + '/')) {
          updated[candidate + key.slice(path.length)] = val;
        } else {
          updated[key] = val;
        }
      }
      newPath = candidate;
      return { ...prev, categories: updated };
    });
    if (newPath) {
      void assetRenameCategory(path, newPath);
    }
  }, [updateLibrary]);

  const deleteCategory = useCallback((path: string) => {
    updateLibrary((prev) => {
      const cats = { ...prev.categories };
      const keysToRemove = Object.keys(cats).filter(
        (k) => k === path || k.startsWith(path + '/')
      );
      for (const k of keysToRemove) delete cats[k];
      return { ...prev, categories: cats };
    });
    // Rust side moves any remaining files back to root before removing.
    void assetDeleteCategory(path);
  }, [updateLibrary]);

  const moveAssets = useCallback((assetIds: number[], targetPath: string) => {
    updateLibrary((prev) => {
      const cats = { ...prev.categories };
      const idsSet = new Set(assetIds);

      // Remove from current categories
      for (const [key, val] of Object.entries(cats)) {
        const filtered = val.filter((id) => !idsSet.has(id));
        if (filtered.length !== val.length) cats[key] = filtered;
      }

      // Add to target
      if (cats[targetPath] === undefined) cats[targetPath] = [];
      cats[targetPath] = [...cats[targetPath], ...assetIds];

      return { ...prev, categories: cats };
    });

    // Mirror each built-in asset file to the new category folder (Tauri only).
    (async () => {
      await assetCreateCategory(targetPath);
      const base = library.assetBasePath;
      const encodedCat = encodeURI(targetPath);
      for (const id of assetIds) {
        const fileName = fileNameFor(id);
        if (!fileName) continue;
        await assetMoveFile(fileName, targetPath);
        // Re-fetch the image from the new URL so the browser cache matches the
        // on-disk layout. Rendering keeps the previous bitmap until this completes.
        void refreshAssetImage(id, `${base}/${encodedCat}/${fileName}`);
      }
    })();
  }, [updateLibrary, fileNameFor, library.assetBasePath]);

  const uncategorizeAssets = useCallback((assetIds: number[]) => {
    updateLibrary((prev) => {
      const cats = { ...prev.categories };
      const idsSet = new Set(assetIds);
      for (const [key, val] of Object.entries(cats)) {
        const filtered = val.filter((id) => !idsSet.has(id));
        if (filtered.length !== val.length) cats[key] = filtered;
      }
      return { ...prev, categories: cats };
    });

    (async () => {
      const base = library.assetBasePath;
      for (const id of assetIds) {
        const fileName = fileNameFor(id);
        if (!fileName) continue;
        await assetMoveFile(fileName, null);
        void refreshAssetImage(id, `${base}/${fileName}`);
      }
    })();
  }, [updateLibrary, fileNameFor, library.assetBasePath]);

  // ── Asset rename operations ────────────────────────────────────────────────

  const getAssetDisplayName = useCallback((id: number): string => {
    if (library.assetNames[id]) return library.assetNames[id];
    return deriveDefaultName(id, library.filePattern);
  }, [library.assetNames, library.filePattern]);

  const renameAsset = useCallback((id: number, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    updateLibrary((prev) => ({
      ...prev,
      assetNames: { ...prev.assetNames, [id]: trimmed },
    }));
  }, [updateLibrary]);

  const clearAssetName = useCallback((id: number) => {
    updateLibrary((prev) => {
      const names = { ...prev.assetNames };
      delete names[id];
      return { ...prev, assetNames: names };
    });
  }, [updateLibrary]);

  const batchRenameAssets = useCallback((find: string, replace: string): number => {
    if (!find) return 0;
    let count = 0;
    setLibrary((prev) => {
      const names = { ...prev.assetNames };
      for (let id = 1; id <= prev.totalAssets; id++) {
        const current = names[id] ?? deriveDefaultName(id, prev.filePattern);
        if (current.includes(find)) {
          names[id] = current.replaceAll(find, replace);
          count++;
        }
      }
      const next = { ...prev, assetNames: names };
      saveLibrary(next);
      return next;
    });
    return count;
  }, []);

  // ── Tile overrides ─────────────────────────────────────────────────────────

  const setTileOverride = useCallback((id: number, tiles: [number, number][]) => {
    setTileOverridesState((prev) => {
      const next = { ...prev, [id]: tiles };
      saveJson(TILE_OVERRIDES_KEY, next);
      return next;
    });
  }, []);

  const clearTileOverride = useCallback((id: number) => {
    setTileOverridesState((prev) => {
      const next = { ...prev };
      delete next[id];
      saveJson(TILE_OVERRIDES_KEY, next);
      return next;
    });
  }, []);

  // Asset -> category path lookup
  const assetCategoryMap = useMemo(() => {
    const m = new Map<number, string>();
    for (const [path, ids] of Object.entries(library.categories)) {
      for (const id of ids) m.set(id, path);
    }
    return m;
  }, [library.categories]);

  const getCategoryForAsset = useCallback(
    (id: number): string | null => assetCategoryMap.get(id) ?? null,
    [assetCategoryMap]
  );

  /**
   * URL where the physical asset file currently lives. Reflects the user's
   * current category assignment, so that `<img src={resolveAssetUrl(id)}>` and
   * the pre-loader both hit the correct on-disk location under Tauri.
   *
   * In web-only mode files never move, so this always collapses to the root URL.
   */
  const resolveAssetUrl = useCallback(
    (id: number): string => {
      if (id >= 1000) return ''; // custom assets don't live on disk
      const file = library.filePattern.replace('{id}', String(id));
      const cat = assetCategoryMap.get(id);
      const base = library.assetBasePath;
      if (!cat) return `${base}/${file}`;
      // encodeURI preserves '/' between segments but escapes spaces etc.
      return `${base}/${encodeURI(cat)}/${file}`;
    },
    [library.assetBasePath, library.filePattern, assetCategoryMap]
  );

  return {
    library,
    categoryTree,
    uncategorizedIds,
    assignedIds,
    tileOverrides,

    setRootLabel,
    createCategory,
    renameCategory,
    deleteCategory,
    moveAssets,
    uncategorizeAssets,

    getAssetDisplayName,
    getCategoryForAsset,
    resolveAssetUrl,
    renameAsset,
    clearAssetName,
    batchRenameAssets,

    setTileOverride,
    clearTileOverride,
  };
}
