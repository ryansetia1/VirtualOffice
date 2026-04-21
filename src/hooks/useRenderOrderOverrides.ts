import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Render-order override for object-layer placements.
 *
 *   - `'auto'`   — follow the normal y-sort (placement's bottom edge vs agent's
 *                  foot row). This matches how Godot's YSort / Unity's 2D
 *                  Transparency Sort / Stardew Valley handle depth. An agent
 *                  that is visually "in front of" the object will render on
 *                  top of it; an agent "behind" it will be occluded. This is
 *                  the sensible default for every placement.
 *   - `'above'`  — always render after any agent, regardless of y-sort. Useful
 *                  for tall back walls, overhead signage, etc.
 *   - `'below'`  — always render before any agent. Useful for floor-level art
 *                  that the agent must stand on top of (rugs drawn on the
 *                  object layer, ground shadows, etc.).
 *
 * Two scopes are tracked, paralleling the collision-mask API:
 *   - Asset-level (`Map<assetId, RenderOrder>`): default for every placement
 *     of the asset.
 *   - Placement-level (`Map<placementId, RenderOrder>`): per-instance
 *     override that wins over the asset default.
 *
 * Resolution order: placement → asset → `'auto'`.
 *
 * ### Migration
 * The previous implementation (`useAboveAgentOverrides`) stored a simple
 * boolean under `virtualOffice_assetAboveAgent` / `virtualOffice_placementAboveAgent`.
 * Those keys are migrated into the new storage on first load and then
 * removed, so saved projects keep their intent.
 */

export type RenderOrder = 'auto' | 'above' | 'below';

const ASSET_KEY = 'virtualOffice_assetRenderOrder';
const PLACEMENT_KEY = 'virtualOffice_placementRenderOrder';

// Legacy keys — migrated once on load, then deleted.
const LEGACY_ASSET_KEY = 'virtualOffice_assetAboveAgent';
const LEGACY_PLACEMENT_KEY = 'virtualOffice_placementAboveAgent';

function isOrder(v: unknown): v is RenderOrder {
  return v === 'auto' || v === 'above' || v === 'below';
}

function loadOrderMap(key: string): Record<string, RenderOrder> {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, RenderOrder> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (isOrder(v) && v !== 'auto') out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function saveOrderMap(key: string, map: Record<string, RenderOrder>): void {
  try {
    // We don't persist 'auto' entries (they mean "no override"); callers
    // already avoid writing them, but guard here too.
    const clean: Record<string, RenderOrder> = {};
    for (const [k, v] of Object.entries(map)) {
      if (v !== 'auto') clean[k] = v;
    }
    localStorage.setItem(key, JSON.stringify(clean));
  } catch {
    /* ignore quota errors */
  }
}

function migrateLegacyAsset(): Record<string, RenderOrder> | null {
  const raw = localStorage.getItem(LEGACY_ASSET_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const out: Record<string, RenderOrder> = {};
    for (const v of parsed) {
      const n = Number(v);
      if (Number.isFinite(n)) out[String(n)] = 'above';
    }
    return out;
  } catch {
    return null;
  } finally {
    // Either way, drop the legacy key so we don't migrate twice.
    try { localStorage.removeItem(LEGACY_ASSET_KEY); } catch { /* ignore */ }
  }
}

function migrateLegacyPlacement(): Record<string, RenderOrder> | null {
  const raw = localStorage.getItem(LEGACY_PLACEMENT_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const out: Record<string, RenderOrder> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'boolean') out[k] = v ? 'above' : 'below';
    }
    return out;
  } catch {
    return null;
  } finally {
    try { localStorage.removeItem(LEGACY_PLACEMENT_KEY); } catch { /* ignore */ }
  }
}

function loadAssetInitial(): Record<string, RenderOrder> {
  const current = loadOrderMap(ASSET_KEY);
  const legacy = migrateLegacyAsset();
  if (legacy) {
    // Current wins over legacy when both exist, since a user may have opted
    // into the new system already.
    return { ...legacy, ...current };
  }
  return current;
}

function loadPlacementInitial(): Record<string, RenderOrder> {
  const current = loadOrderMap(PLACEMENT_KEY);
  const legacy = migrateLegacyPlacement();
  if (legacy) return { ...legacy, ...current };
  return current;
}

export interface PlacementShape {
  id: string;
  assetId: number;
}

export interface RenderOrderApi {
  /** Raw asset-level overrides. `'auto'` is represented as absence. */
  assetOrder: Record<string, RenderOrder>;
  /** Raw placement-level overrides. `'auto'` is represented as absence. */
  placementOrder: Record<string, RenderOrder>;

  /** Effective render order: placement override → asset default → `'auto'`. */
  getOrder(p: PlacementShape): RenderOrder;
  /** Asset-level default (or `'auto'`). */
  getAssetOrder(assetId: number): RenderOrder;
  /** `true` when the placement has an explicit per-instance override. */
  hasPlacementOverride(placementId: string): boolean;

  /** Set the placement-scope order. Passing `'auto'` clears the override so
   *  the placement follows the asset default. */
  setPlacementOrder(placementId: string, order: RenderOrder): void;
  /** Set the asset-scope default. `'auto'` clears it. */
  setAssetOrder(assetId: number, order: RenderOrder): void;
  /** Convenience: clears the placement override (same as `setPlacementOrder(id, 'auto')`). */
  clearPlacementOverride(placementId: string): void;

  /** Drop placement overrides whose placement no longer exists in the room. */
  prunePlacements(validIds: Set<string>): void;
}

export function useRenderOrderOverrides(): RenderOrderApi {
  const [assetOrder, setAssetOrderState] = useState<Record<string, RenderOrder>>(loadAssetInitial);
  const [placementOrder, setPlacementOrderState] = useState<Record<string, RenderOrder>>(loadPlacementInitial);

  const firstAsset = useRef(true);
  useEffect(() => {
    if (firstAsset.current) { firstAsset.current = false; return; }
    saveOrderMap(ASSET_KEY, assetOrder);
  }, [assetOrder]);

  const firstPlace = useRef(true);
  useEffect(() => {
    if (firstPlace.current) { firstPlace.current = false; return; }
    saveOrderMap(PLACEMENT_KEY, placementOrder);
  }, [placementOrder]);

  const getAssetOrder = useCallback((assetId: number): RenderOrder => {
    const v = assetOrder[String(assetId)];
    return isOrder(v) ? v : 'auto';
  }, [assetOrder]);

  const getOrder = useCallback((p: PlacementShape): RenderOrder => {
    const explicit = placementOrder[p.id];
    if (isOrder(explicit)) return explicit;
    const byAsset = assetOrder[String(p.assetId)];
    return isOrder(byAsset) ? byAsset : 'auto';
  }, [assetOrder, placementOrder]);

  const hasPlacementOverride = useCallback((placementId: string) => {
    return isOrder(placementOrder[placementId]);
  }, [placementOrder]);

  const setPlacementOrder = useCallback((placementId: string, order: RenderOrder) => {
    setPlacementOrderState((prev) => {
      if (order === 'auto') {
        if (!(placementId in prev)) return prev;
        const next = { ...prev };
        delete next[placementId];
        return next;
      }
      if (prev[placementId] === order) return prev;
      return { ...prev, [placementId]: order };
    });
  }, []);

  const setAssetOrder = useCallback((assetId: number, order: RenderOrder) => {
    const key = String(assetId);
    setAssetOrderState((prev) => {
      if (order === 'auto') {
        if (!(key in prev)) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      }
      if (prev[key] === order) return prev;
      return { ...prev, [key]: order };
    });
  }, []);

  const clearPlacementOverride = useCallback((placementId: string) => {
    setPlacementOrder(placementId, 'auto');
  }, [setPlacementOrder]);

  const prunePlacements = useCallback((validIds: Set<string>) => {
    setPlacementOrderState((prev) => {
      let changed = false;
      const next: Record<string, RenderOrder> = {};
      for (const [k, v] of Object.entries(prev)) {
        if (validIds.has(k)) next[k] = v;
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, []);

  return {
    assetOrder,
    placementOrder,
    getOrder,
    getAssetOrder,
    hasPlacementOverride,
    setPlacementOrder,
    setAssetOrder,
    clearPlacementOverride,
    prunePlacements,
  };
}
