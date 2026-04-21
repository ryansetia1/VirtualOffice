import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createEmptyMask,
  decodeMask,
  encodeMask,
  getAutoMask,
  type PixelMask,
} from '../utils/pixelMasks';
import { getAssetTileInfo } from '../data/assetManifest';

const STORAGE_KEY = 'virtualOffice_collisionMasks';
const LEGACY_KEY = 'virtualOffice_blockingOverrides';

/** Stored shape: `{ [assetId]: encodedMask }`. */
type StoredOverrides = Record<number, string>;

/**
 * Run the one-shot migration from the legacy walkable/blocking toggle into
 * the pixel-mask model. Walkable → empty mask for the asset (all zeros, i.e.
 * never blocks). Blocking → no entry (the auto mask is already the default).
 *
 * Idempotent: if the legacy key is missing, does nothing. Deletes the legacy
 * key on success so we don't keep reapplying.
 */
function migrateFromLegacy(current: StoredOverrides): StoredOverrides {
  let legacyRaw: string | null;
  try {
    legacyRaw = localStorage.getItem(LEGACY_KEY);
  } catch {
    return current;
  }
  if (!legacyRaw) return current;

  let legacy: unknown;
  try {
    legacy = JSON.parse(legacyRaw);
  } catch {
    try { localStorage.removeItem(LEGACY_KEY); } catch { /* ignore */ }
    return current;
  }
  if (!legacy || typeof legacy !== 'object') {
    try { localStorage.removeItem(LEGACY_KEY); } catch { /* ignore */ }
    return current;
  }

  const next: StoredOverrides = { ...current };
  let changed = false;
  for (const [k, v] of Object.entries(legacy as Record<string, unknown>)) {
    const id = Number(k);
    if (!Number.isFinite(id)) continue;
    if (v !== 'walkable') continue;
    // Skip if the user already has a mask for this asset.
    if (next[id] !== undefined) continue;
    // Build an empty mask sized to the asset's native span. For built-ins we
    // know the size from the tile manifest; for custom assets (ids >= 1000)
    // we can't know it here without the image, so we emit a tiny 48×48
    // placeholder that `useCollisionMasks` will lazily replace the first
    // time the correctly-sized auto mask resolves.
    let w = 48;
    let h = 48;
    if (id < 1000) {
      try {
        const info = getAssetTileInfo(id);
        w = info.spanW * 48;
        h = info.spanH * 48;
      } catch { /* fall back to 48×48 */ }
    }
    const mask = createEmptyMask(w, h);
    next[id] = encodeMask(mask);
    changed = true;
  }

  try {
    if (changed) localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    localStorage.removeItem(LEGACY_KEY);
  } catch { /* ignore quota */ }

  return next;
}

function loadOverrides(): StoredOverrides {
  let current: StoredOverrides = {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          const id = Number(k);
          if (!Number.isFinite(id)) continue;
          if (typeof v !== 'string') continue;
          current[id] = v;
        }
      }
    }
  } catch { /* ignore */ }
  current = migrateFromLegacy(current);
  return current;
}

function saveOverrides(map: StoredOverrides): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch { /* ignore quota */ }
}

export interface UseCollisionMasksApi {
  /** Raw encoded overrides, keyed by asset id. */
  overrides: StoredOverrides;
  /** Decoded override mask (may be cached), or undefined if none. */
  getOverrideMask(assetId: number): PixelMask | undefined;
  /** Effective mask: override ∪ auto. Returns null if neither exists yet. */
  getMask(assetId: number): PixelMask | null;
  /** Persist a painted mask for the given asset. */
  setMask(assetId: number, mask: PixelMask): void;
  /** Drop the override; subsequent reads return the auto mask. */
  clearMask(assetId: number): void;
  /** Whether the asset has a user-painted override. */
  isOverridden(assetId: number): boolean;
}

export function useCollisionMasks(): UseCollisionMasksApi {
  const [overrides, setOverrides] = useState<StoredOverrides>(loadOverrides);
  const isFirst = useRef(true);
  useEffect(() => {
    if (isFirst.current) { isFirst.current = false; return; }
    saveOverrides(overrides);
  }, [overrides]);

  // Decoded cache — decoding a mask on every collision sample would be
  // wasteful, so memoize. Invalidate by re-running whenever `overrides` changes.
  const decodedCache = useMemo(() => {
    const m = new Map<number, PixelMask>();
    for (const [k, v] of Object.entries(overrides)) {
      const id = Number(k);
      if (!Number.isFinite(id)) continue;
      const decoded = decodeMask(v);
      if (decoded) m.set(id, decoded);
    }
    return m;
  }, [overrides]);

  const getOverrideMask = useCallback((assetId: number): PixelMask | undefined => {
    return decodedCache.get(assetId);
  }, [decodedCache]);

  const getMask = useCallback((assetId: number): PixelMask | null => {
    const override = decodedCache.get(assetId);
    if (override) return override;
    const auto = getAutoMask(assetId);
    return auto ?? null;
  }, [decodedCache]);

  const setMask = useCallback((assetId: number, mask: PixelMask) => {
    const encoded = encodeMask(mask);
    setOverrides((prev) => {
      if (prev[assetId] === encoded) return prev;
      return { ...prev, [assetId]: encoded };
    });
  }, []);

  const clearMask = useCallback((assetId: number) => {
    setOverrides((prev) => {
      if (!(assetId in prev)) return prev;
      const next = { ...prev };
      delete next[assetId];
      return next;
    });
  }, []);

  const isOverridden = useCallback((assetId: number) => {
    return assetId in overrides;
  }, [overrides]);

  return { overrides, getOverrideMask, getMask, setMask, clearMask, isOverridden };
}
