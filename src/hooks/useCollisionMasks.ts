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
const PLACEMENT_STORAGE_KEY = 'virtualOffice_placementMasks';
const LEGACY_KEY = 'virtualOffice_blockingOverrides';

/** Stored shape: `{ [assetId]: encodedMask }`. */
type StoredOverrides = Record<number, string>;
/** Stored shape: `{ [placementId]: encodedMask }`. */
type StoredPlacementOverrides = Record<string, string>;

/** Minimal shape we need to resolve per-placement collision. */
export interface PlacementRef {
  id: string;
  assetId: number;
}

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
    if (next[id] !== undefined) continue;
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

function loadPlacementOverrides(): StoredPlacementOverrides {
  const current: StoredPlacementOverrides = {};
  try {
    const raw = localStorage.getItem(PLACEMENT_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof v !== 'string') continue;
          current[k] = v;
        }
      }
    }
  } catch { /* ignore */ }
  return current;
}

function saveOverrides(map: StoredOverrides): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch { /* ignore quota */ }
}

function savePlacementOverrides(map: StoredPlacementOverrides): void {
  try {
    localStorage.setItem(PLACEMENT_STORAGE_KEY, JSON.stringify(map));
  } catch { /* ignore quota */ }
}

export interface UseCollisionMasksApi {
  /** Raw encoded asset overrides, keyed by asset id. */
  overrides: StoredOverrides;
  /** Raw encoded placement overrides, keyed by placement id. */
  placementOverrides: StoredPlacementOverrides;

  // Asset-level API (default collision for every instance of the asset).
  /** Decoded asset override mask (may be cached), or undefined if none. */
  getOverrideMask(assetId: number): PixelMask | undefined;
  /** Effective asset-level mask: asset override ∪ auto. `null` if neither is
   *  ready yet (image still loading). */
  getMask(assetId: number): PixelMask | null;
  /** Persist a painted asset-level mask. */
  setMask(assetId: number, mask: PixelMask): void;
  /** Drop the asset-level override. */
  clearMask(assetId: number): void;
  /** Whether the asset has an asset-level override. */
  isOverridden(assetId: number): boolean;

  // Placement-level API (per-instance override, beats the asset default).
  /** Decoded placement override mask, or undefined. */
  getPlacementOverrideMask(placementId: string): PixelMask | undefined;
  /** Persist a painted mask for this specific placement. */
  setPlacementMask(placementId: string, mask: PixelMask): void;
  /** Drop a placement-level override (falls back to asset-level). */
  clearPlacementMask(placementId: string): void;
  /** Whether this specific placement has its own override. */
  isPlacementOverridden(placementId: string): boolean;

  // Combined lookup.
  /** Effective mask for a placement: placement override → asset override → auto. */
  getEffectiveMaskFor(placement: PlacementRef): PixelMask | null;

  // Housekeeping.
  /** Drop placement overrides whose placement no longer exists in the room. */
  prunePlacements(validIds: Set<string>): void;
}

export function useCollisionMasks(): UseCollisionMasksApi {
  const [overrides, setOverrides] = useState<StoredOverrides>(loadOverrides);
  const [placementOverrides, setPlacementOverrides] = useState<StoredPlacementOverrides>(loadPlacementOverrides);

  const isFirstAsset = useRef(true);
  useEffect(() => {
    if (isFirstAsset.current) { isFirstAsset.current = false; return; }
    saveOverrides(overrides);
  }, [overrides]);

  const isFirstPlacement = useRef(true);
  useEffect(() => {
    if (isFirstPlacement.current) { isFirstPlacement.current = false; return; }
    savePlacementOverrides(placementOverrides);
  }, [placementOverrides]);

  // Decoded caches — decoding a mask on every collision sample would be
  // wasteful, so memoize. Invalidate when the encoded map changes.
  const decodedAssetCache = useMemo(() => {
    const m = new Map<number, PixelMask>();
    for (const [k, v] of Object.entries(overrides)) {
      const id = Number(k);
      if (!Number.isFinite(id)) continue;
      const decoded = decodeMask(v);
      if (decoded) m.set(id, decoded);
    }
    return m;
  }, [overrides]);

  const decodedPlacementCache = useMemo(() => {
    const m = new Map<string, PixelMask>();
    for (const [k, v] of Object.entries(placementOverrides)) {
      const decoded = decodeMask(v);
      if (decoded) m.set(k, decoded);
    }
    return m;
  }, [placementOverrides]);

  const getOverrideMask = useCallback((assetId: number): PixelMask | undefined => {
    return decodedAssetCache.get(assetId);
  }, [decodedAssetCache]);

  const getMask = useCallback((assetId: number): PixelMask | null => {
    const override = decodedAssetCache.get(assetId);
    if (override) return override;
    const auto = getAutoMask(assetId);
    return auto ?? null;
  }, [decodedAssetCache]);

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

  const getPlacementOverrideMask = useCallback((placementId: string): PixelMask | undefined => {
    return decodedPlacementCache.get(placementId);
  }, [decodedPlacementCache]);

  const setPlacementMask = useCallback((placementId: string, mask: PixelMask) => {
    const encoded = encodeMask(mask);
    setPlacementOverrides((prev) => {
      if (prev[placementId] === encoded) return prev;
      return { ...prev, [placementId]: encoded };
    });
  }, []);

  const clearPlacementMask = useCallback((placementId: string) => {
    setPlacementOverrides((prev) => {
      if (!(placementId in prev)) return prev;
      const next = { ...prev };
      delete next[placementId];
      return next;
    });
  }, []);

  const isPlacementOverridden = useCallback((placementId: string) => {
    return placementId in placementOverrides;
  }, [placementOverrides]);

  const getEffectiveMaskFor = useCallback((placement: PlacementRef): PixelMask | null => {
    const perPlacement = decodedPlacementCache.get(placement.id);
    if (perPlacement) return perPlacement;
    const perAsset = decodedAssetCache.get(placement.assetId);
    if (perAsset) return perAsset;
    const auto = getAutoMask(placement.assetId);
    return auto ?? null;
  }, [decodedPlacementCache, decodedAssetCache]);

  const prunePlacements = useCallback((validIds: Set<string>) => {
    setPlacementOverrides((prev) => {
      let changed = false;
      const next: StoredPlacementOverrides = {};
      for (const [k, v] of Object.entries(prev)) {
        if (validIds.has(k)) next[k] = v;
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, []);

  return {
    overrides,
    placementOverrides,
    getOverrideMask,
    getMask,
    setMask,
    clearMask,
    isOverridden,
    getPlacementOverrideMask,
    setPlacementMask,
    clearPlacementMask,
    isPlacementOverridden,
    getEffectiveMaskFor,
    prunePlacements,
  };
}
