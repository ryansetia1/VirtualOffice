import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Per-asset / per-placement y-sort anchor overrides.
 *
 * The unified y-sort stream in `GridCanvas` normally sorts placements by
 * `(row + spanH) * 1000` — i.e. the bbox's bottom edge, which assumes the
 * asset's visual "foot" sits at the bottom of its bounding box. Tall assets
 * whose visual foot is somewhere else (chair backrest, desk-with-monitor
 * combo, tall back wall) keep occluding the agent for a row or two after
 * the agent has walked past them visually. This hook lets the user shift
 * the sort key from `spanH` to a custom `anchor`, so the sort line can be
 * tuned per-asset / per-placement without touching the asset's bbox.
 *
 *   sortY = (row + anchor) * 1000
 *
 *   - anchor === spanH   → current behaviour (no change). This is the
 *                          fallback when neither scope sets a value.
 *   - anchor  >  spanH   → asset sorts deeper than its bbox bottom, i.e.
 *                          draws later / occludes more. Useful for tall
 *                          back walls whose foot visually extends below
 *                          their bbox bottom.
 *   - anchor  <  spanH   → asset sorts shallower, i.e. draws earlier /
 *                          gets occluded more readily. Useful for floor-
 *                          level art on the object layer.
 *   - fractional values are allowed (e.g. 1.5) for sub-row tuning.
 *
 * Two scopes, paralleling `useRenderOrderOverrides`:
 *   - Asset-level (`Map<assetId, number>`): default for every placement of
 *     the asset.
 *   - Placement-level (`Map<placementId, number>`): per-instance override
 *     that wins over the asset default.
 *
 * Resolution order: placement → asset → `fallback` (passed in, typically
 * `p.spanH`).
 */

const ASSET_KEY = 'virtualOffice_assetSortAnchor';
const PLACEMENT_KEY = 'virtualOffice_placementSortAnchor';

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function loadAnchorMap(key: string): Record<string, number> {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (isFiniteNumber(v)) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function saveAnchorMap(key: string, map: Record<string, number>): void {
  try {
    const clean: Record<string, number> = {};
    for (const [k, v] of Object.entries(map)) {
      if (isFiniteNumber(v)) clean[k] = v;
    }
    localStorage.setItem(key, JSON.stringify(clean));
  } catch {
    /* ignore quota errors */
  }
}

export interface PlacementShape {
  id: string;
  assetId: number;
}

export interface SortAnchorApi {
  /** Raw asset-level anchors (by stringified asset id). Absence = inherit. */
  assetAnchors: Record<string, number>;
  /** Raw placement-level anchors. Absence = inherit. */
  placementAnchors: Record<string, number>;

  /**
   * Effective anchor for the given placement. Resolution order:
   * placement override → asset override → `fallback` (normally `p.spanH`).
   */
  getAnchor(p: PlacementShape, fallback: number): number;
  /**
   * Asset-level default anchor, or `null` when unset.
   */
  getAssetAnchor(assetId: number): number | null;
  /** `true` when this placement has a per-instance anchor override. */
  hasPlacementOverride(placementId: string): boolean;

  /** Set the placement-scope anchor. Pass `null` to clear the override. */
  setPlacementAnchor(placementId: string, anchor: number | null): void;
  /** Set the asset-scope default anchor. Pass `null` to clear it. */
  setAssetAnchor(assetId: number, anchor: number | null): void;
  /** Convenience: clear the placement override (same as `setPlacementAnchor(id, null)`). */
  clearPlacementOverride(placementId: string): void;

  /** Drop placement overrides whose placement no longer exists in the room. */
  prunePlacements(validIds: Set<string>): void;
}

export function useSortAnchorOverrides(): SortAnchorApi {
  const [assetAnchors, setAssetAnchorsState] = useState<Record<string, number>>(
    () => loadAnchorMap(ASSET_KEY),
  );
  const [placementAnchors, setPlacementAnchorsState] = useState<Record<string, number>>(
    () => loadAnchorMap(PLACEMENT_KEY),
  );

  const firstAsset = useRef(true);
  useEffect(() => {
    if (firstAsset.current) { firstAsset.current = false; return; }
    saveAnchorMap(ASSET_KEY, assetAnchors);
  }, [assetAnchors]);

  const firstPlace = useRef(true);
  useEffect(() => {
    if (firstPlace.current) { firstPlace.current = false; return; }
    saveAnchorMap(PLACEMENT_KEY, placementAnchors);
  }, [placementAnchors]);

  const getAssetAnchor = useCallback((assetId: number): number | null => {
    const v = assetAnchors[String(assetId)];
    return isFiniteNumber(v) ? v : null;
  }, [assetAnchors]);

  const getAnchor = useCallback((p: PlacementShape, fallback: number): number => {
    const placementV = placementAnchors[p.id];
    if (isFiniteNumber(placementV)) return placementV;
    const assetV = assetAnchors[String(p.assetId)];
    if (isFiniteNumber(assetV)) return assetV;
    return fallback;
  }, [assetAnchors, placementAnchors]);

  const hasPlacementOverride = useCallback((placementId: string) => {
    return isFiniteNumber(placementAnchors[placementId]);
  }, [placementAnchors]);

  const setPlacementAnchor = useCallback((placementId: string, anchor: number | null) => {
    setPlacementAnchorsState((prev) => {
      if (anchor === null || !isFiniteNumber(anchor)) {
        if (!(placementId in prev)) return prev;
        const next = { ...prev };
        delete next[placementId];
        return next;
      }
      if (prev[placementId] === anchor) return prev;
      return { ...prev, [placementId]: anchor };
    });
  }, []);

  const setAssetAnchor = useCallback((assetId: number, anchor: number | null) => {
    const key = String(assetId);
    setAssetAnchorsState((prev) => {
      if (anchor === null || !isFiniteNumber(anchor)) {
        if (!(key in prev)) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      }
      if (prev[key] === anchor) return prev;
      return { ...prev, [key]: anchor };
    });
  }, []);

  const clearPlacementOverride = useCallback((placementId: string) => {
    setPlacementAnchor(placementId, null);
  }, [setPlacementAnchor]);

  const prunePlacements = useCallback((validIds: Set<string>) => {
    setPlacementAnchorsState((prev) => {
      let changed = false;
      const next: Record<string, number> = {};
      for (const [k, v] of Object.entries(prev)) {
        if (validIds.has(k)) next[k] = v;
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, []);

  return {
    assetAnchors,
    placementAnchors,
    getAnchor,
    getAssetAnchor,
    hasPlacementOverride,
    setPlacementAnchor,
    setAssetAnchor,
    clearPlacementOverride,
    prunePlacements,
  };
}
