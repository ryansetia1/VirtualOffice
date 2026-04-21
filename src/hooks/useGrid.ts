import { useCallback, useRef, useState } from 'react';
import { getAssetSize } from '../data/assetManifest';

export type LayerType = 'floor' | 'wall' | 'object';

export interface PlacementGroup {
  id: string;
  name: string;
  layer: LayerType;
  visible: boolean;
  locked: boolean;
  collapsed: boolean;
}

export interface Placement {
  id: string;
  assetId: number;
  row: number;
  col: number;
  layer: LayerType;
  spanW: number;
  spanH: number;
  rotation: number;
  flipH: boolean;
  flipV: boolean;
  zIndex?: number;
  groupId?: string;
}

export interface RoomState {
  width: number;
  height: number;
  cellSize: number;
  placements: Placement[];
  groups: PlacementGroup[];
  layerVisibility: Record<LayerType, boolean>;
  layerLocked: Record<LayerType, boolean>;
  layerNames: Record<LayerType, string>;
}

let nextId = 1;
function genId(): string {
  return `p${nextId++}`;
}

let nextGroupId = 1;
function genGroupId(): string {
  return `g${Date.now()}_${nextGroupId++}`;
}

function syncCounters(room: RoomState) {
  for (const p of room.placements) {
    const m = p.id?.match(/^p(\d+)$/);
    if (m) nextId = Math.max(nextId, parseInt(m[1], 10) + 1);
  }
  for (const g of room.groups ?? []) {
    const m = g.id?.match(/^g\d+_(\d+)$/);
    if (m) nextGroupId = Math.max(nextGroupId, parseInt(m[1], 10) + 1);
  }
}

const DEFAULT_VISIBILITY: Record<LayerType, boolean> = { floor: true, wall: true, object: true };
const DEFAULT_LOCKED: Record<LayerType, boolean> = { floor: false, wall: false, object: false };
const DEFAULT_NAMES: Record<LayerType, string> = { floor: 'Floor', wall: 'Wall', object: 'Object' };

export function createDefaultRoom(width = 20, height = 15): RoomState {
  return {
    width, height, cellSize: 48, placements: [], groups: [],
    layerVisibility: { ...DEFAULT_VISIBILITY },
    layerLocked: { ...DEFAULT_LOCKED },
    layerNames: { ...DEFAULT_NAMES },
  };
}

function placementCovers(p: Placement, row: number, col: number): boolean {
  return row >= p.row && row < p.row + p.spanH && col >= p.col && col < p.col + p.spanW;
}

const MAX_HISTORY = 100;

export function useGrid(initial?: RoomState) {
  const [room, setRoom] = useState<RoomState>(() => {
    const r = initial ?? createDefaultRoom();
    syncCounters(r);
    return r;
  });
  const [version, setVersion] = useState(0);
  const bumpVersion = useCallback(() => setVersion((v) => v + 1), []);
  const roomRef = useRef(room);
  roomRef.current = room;

  // ── Undo / Redo history ──────────────────────────────────────────────────
  const undoStack = useRef<RoomState[]>([]);
  const redoStack = useRef<RoomState[]>([]);
  const batchDepth = useRef(0);
  const batchSnapshot = useRef<RoomState | null>(null);

  const pushUndo = useCallback((snapshot: RoomState) => {
    if (batchDepth.current > 0) {
      if (!batchSnapshot.current) batchSnapshot.current = snapshot;
      return;
    }
    undoStack.current.push(snapshot);
    if (undoStack.current.length > MAX_HISTORY) undoStack.current.shift();
    redoStack.current = [];
  }, []);

  const beginUndoBatch = useCallback(() => {
    if (batchDepth.current === 0) batchSnapshot.current = null;
    batchDepth.current++;
  }, []);

  const endUndoBatch = useCallback(() => {
    batchDepth.current--;
    if (batchDepth.current <= 0) {
      batchDepth.current = 0;
      if (batchSnapshot.current) {
        undoStack.current.push(batchSnapshot.current);
        if (undoStack.current.length > MAX_HISTORY) undoStack.current.shift();
        redoStack.current = [];
        batchSnapshot.current = null;
      }
    }
  }, []);

  const canUndo = undoStack.current.length > 0;
  const canRedo = redoStack.current.length > 0;

  const undo = useCallback(() => {
    const prev = undoStack.current.pop();
    if (!prev) return;
    redoStack.current.push(roomRef.current);
    setRoom(prev);
    bumpVersion();
  }, [bumpVersion]);

  const redo = useCallback(() => {
    const next = redoStack.current.pop();
    if (!next) return;
    undoStack.current.push(roomRef.current);
    setRoom(next);
    bumpVersion();
  }, [bumpVersion]);

  // ── Mutating helpers (push undo before change) ───────────────────────────

  const addPlacement = useCallback(
    (assetId: number, row: number, col: number, layer: LayerType, rotation = 0, flipH = false, flipV = false, replace = true) => {
      const [rawW, rawH] = getAssetSize(assetId);
      const isRotated = rotation === 90 || rotation === 270;
      const spanW = isRotated ? rawH : rawW;
      const spanH = isRotated ? rawW : rawH;

      const cur = roomRef.current;
      if (row < 0 || col < 0 || row + spanH > cur.height || col + spanW > cur.width) return;

      pushUndo(cur);
      const newId = genId();
      setRoom((prev) => {
        let base = prev.placements;
        if (replace) {
          base = base.filter((p) => {
            if (p.layer !== layer) return true;
            for (let r = row; r < row + spanH; r++) {
              for (let c = col; c < col + spanW; c++) {
                if (placementCovers(p, r, c)) return false;
              }
            }
            return true;
          });
        }

        const placement: Placement = { id: newId, assetId, row, col, layer, spanW, spanH, rotation, flipH, flipV };
        return { ...prev, placements: [...base, placement] };
      });
      bumpVersion();
    },
    [bumpVersion, pushUndo]
  );

  const removePlacementAt = useCallback(
    (row: number, col: number, layer?: LayerType) => {
      const cur = roomRef.current;
      const filtered = cur.placements.filter((p) => {
        if (layer && p.layer !== layer) return true;
        return !placementCovers(p, row, col);
      });
      if (filtered.length === cur.placements.length) return;
      pushUndo(cur);
      setRoom((prev) => ({ ...prev, placements: prev.placements.filter((p) => {
        if (layer && p.layer !== layer) return true;
        return !placementCovers(p, row, col);
      }) }));
      bumpVersion();
    },
    [bumpVersion, pushUndo]
  );

  const removePlacementById = useCallback(
    (placementId: string) => {
      pushUndo(roomRef.current);
      setRoom((prev) => ({
        ...prev,
        placements: prev.placements.filter((p) => p.id !== placementId),
      }));
      bumpVersion();
    },
    [bumpVersion, pushUndo]
  );

  const getPlacementAt = useCallback(
    (row: number, col: number, layer?: LayerType): Placement | null => {
      const r = roomRef.current;
      const placements = r.placements;
      const groups = r.groups ?? [];
      const groupMap = new Map(groups.map((g) => [g.id, g]));
      const LAYER_PRIORITY: LayerType[] = ['object', 'wall', 'floor'];
      for (const l of LAYER_PRIORITY) {
        if (layer && l !== layer) continue;
        if ((r.layerVisibility ?? {})[l] === false || (r.layerLocked ?? {})[l]) continue;
        for (let i = placements.length - 1; i >= 0; i--) {
          const p = placements[i];
          if (p.layer !== l || !placementCovers(p, row, col)) continue;
          if (p.groupId) {
            const g = groupMap.get(p.groupId);
            if (g && (!g.visible || g.locked)) continue;
          }
          return p;
        }
      }
      return null;
    },
    []
  );

  const clearAll = useCallback(() => {
    pushUndo(roomRef.current);
    setRoom((prev) => ({ ...prev, placements: [] }));
    bumpVersion();
  }, [bumpVersion, pushUndo]);

  const resize = useCallback(
    (newWidth: number, newHeight: number) => {
      pushUndo(roomRef.current);
      setRoom((prev) => {
        const kept = prev.placements.filter(
          (p) => p.col + p.spanW <= newWidth && p.row + p.spanH <= newHeight
        );
        return { ...prev, width: newWidth, height: newHeight, placements: kept };
      });
      bumpVersion();
    },
    [bumpVersion, pushUndo]
  );

  const loadState = useCallback(
    (state: RoomState) => {
      pushUndo(roomRef.current);
      const fixed = state.placements.map((p) => {
        const [spanW, spanH] = getAssetSize(p.assetId);
        return {
          ...p,
          id: p.id || genId(),
          spanW: p.spanW || spanW,
          spanH: p.spanH || spanH,
          rotation: p.rotation ?? 0,
          flipH: p.flipH ?? false,
          flipV: p.flipV ?? false,
        };
      });
      const newRoom: RoomState = {
        ...state,
        placements: fixed,
        groups: state.groups ?? [],
        layerVisibility: state.layerVisibility ?? { ...DEFAULT_VISIBILITY },
        layerLocked: state.layerLocked ?? { ...DEFAULT_LOCKED },
        layerNames: state.layerNames ?? { ...DEFAULT_NAMES },
      };
      syncCounters(newRoom);
      setRoom(newRoom);
      bumpVersion();
    },
    [bumpVersion, pushUndo]
  );

  // ── Layer management ────────────────────────────────────────────────────

  const toggleLayerVisibility = useCallback((layer: LayerType) => {
    setRoom((prev) => ({
      ...prev,
      layerVisibility: { ...prev.layerVisibility, [layer]: !prev.layerVisibility[layer] },
    }));
    bumpVersion();
  }, [bumpVersion]);

  const toggleLayerLock = useCallback((layer: LayerType) => {
    setRoom((prev) => ({
      ...prev,
      layerLocked: { ...prev.layerLocked, [layer]: !prev.layerLocked[layer] },
    }));
    bumpVersion();
  }, [bumpVersion]);

  const renameLayer = useCallback((layer: LayerType, name: string) => {
    setRoom((prev) => ({
      ...prev,
      layerNames: { ...prev.layerNames, [layer]: name },
    }));
    bumpVersion();
  }, [bumpVersion]);

  // ── Z-index management ────────────────────────────────────────────────

  const bringToFront = useCallback((placementId: string) => {
    pushUndo(roomRef.current);
    setRoom((prev) => {
      const target = prev.placements.find((p) => p.id === placementId);
      if (!target) return prev;
      const sameLayer = prev.placements.filter((p) => p.layer === target.layer);
      const maxZ = Math.max(0, ...sameLayer.map((p) => p.zIndex ?? 0));
      return {
        ...prev,
        placements: prev.placements.map((p) =>
          p.id === placementId ? { ...p, zIndex: maxZ + 1 } : p
        ),
      };
    });
    bumpVersion();
  }, [bumpVersion, pushUndo]);

  const sendToBack = useCallback((placementId: string) => {
    pushUndo(roomRef.current);
    setRoom((prev) => {
      const target = prev.placements.find((p) => p.id === placementId);
      if (!target) return prev;
      const sameLayer = prev.placements.filter((p) => p.layer === target.layer);
      const minZ = Math.min(0, ...sameLayer.map((p) => p.zIndex ?? 0));
      return {
        ...prev,
        placements: prev.placements.map((p) =>
          p.id === placementId ? { ...p, zIndex: minZ - 1 } : p
        ),
      };
    });
    bumpVersion();
  }, [bumpVersion, pushUndo]);

  const movePlacementToLayer = useCallback((placementId: string, targetLayer: LayerType) => {
    pushUndo(roomRef.current);
    setRoom((prev) => ({
      ...prev,
      placements: prev.placements.map((p) =>
        p.id === placementId ? { ...p, layer: targetLayer, zIndex: undefined, groupId: undefined } : p
      ),
    }));
    bumpVersion();
  }, [bumpVersion, pushUndo]);

  const reorderPlacement = useCallback((placementId: string, newZIndex: number) => {
    pushUndo(roomRef.current);
    setRoom((prev) => ({
      ...prev,
      placements: prev.placements.map((p) =>
        p.id === placementId ? { ...p, zIndex: newZIndex } : p
      ),
    }));
    bumpVersion();
  }, [bumpVersion, pushUndo]);

  const reorderPlacementsBulk = useCallback((orderedIds: string[]) => {
    if (orderedIds.length === 0) return;
    pushUndo(roomRef.current);
    const zMap = new Map<string, number>();
    for (let i = 0; i < orderedIds.length; i++) {
      zMap.set(orderedIds[i], (orderedIds.length - i) * 10);
    }
    setRoom((prev) => ({
      ...prev,
      placements: prev.placements.map((p) =>
        zMap.has(p.id) ? { ...p, zIndex: zMap.get(p.id)! } : p
      ),
    }));
    bumpVersion();
  }, [bumpVersion, pushUndo]);

  const removePlacementsByIds = useCallback((ids: Set<string>) => {
    if (ids.size === 0) return;
    pushUndo(roomRef.current);
    setRoom((prev) => ({
      ...prev,
      placements: prev.placements.filter((p) => !ids.has(p.id)),
    }));
    bumpVersion();
  }, [bumpVersion, pushUndo]);

  const movePlacementsToLayer = useCallback((ids: Set<string>, targetLayer: LayerType) => {
    if (ids.size === 0) return;
    pushUndo(roomRef.current);
    setRoom((prev) => ({
      ...prev,
      placements: prev.placements.map((p) =>
        ids.has(p.id) ? { ...p, layer: targetLayer, zIndex: undefined, groupId: undefined } : p
      ),
    }));
    bumpVersion();
  }, [bumpVersion, pushUndo]);

  // ── Group management ─────────────────────────────────────────────────

  const createGroup = useCallback((name: string, layer: LayerType, placementIds: string[]) => {
    if (placementIds.length === 0) return;
    pushUndo(roomRef.current);
    const gid = genGroupId();
    setRoom((prev) => {
      const existingNames = new Set((prev.groups ?? []).map((g) => g.name));
      let finalName = name;
      if (existingNames.has(finalName)) {
        let i = 2;
        while (existingNames.has(`${name} ${i}`)) i++;
        finalName = `${name} ${i}`;
      }
      return {
        ...prev,
        groups: [...(prev.groups ?? []), { id: gid, name: finalName, layer, visible: true, locked: false, collapsed: false }],
        placements: prev.placements.map((p) =>
          placementIds.includes(p.id) ? { ...p, groupId: gid } : p
        ),
      };
    });
    bumpVersion();
  }, [bumpVersion, pushUndo]);

  const ungroupPlacements = useCallback((groupId: string) => {
    pushUndo(roomRef.current);
    setRoom((prev) => ({
      ...prev,
      groups: (prev.groups ?? []).filter((g) => g.id !== groupId),
      placements: prev.placements.map((p) =>
        p.groupId === groupId ? { ...p, groupId: undefined } : p
      ),
    }));
    bumpVersion();
  }, [bumpVersion, pushUndo]);

  const duplicateGroup = useCallback((groupId: string, offsetRow = 0, offsetCol = 0): string[] => {
    const cur = roomRef.current;
    const group = (cur.groups ?? []).find((g) => g.id === groupId);
    if (!group) return [];
    const members = cur.placements.filter((p) => p.groupId === groupId);
    if (members.length === 0) return [];

    pushUndo(cur);
    const newGid = genGroupId();
    const existingNames = new Set((cur.groups ?? []).map((g) => g.name));
    let baseName = group.name;
    let finalName = `${baseName} copy`;
    if (existingNames.has(finalName)) {
      let i = 2;
      while (existingNames.has(`${baseName} copy ${i}`)) i++;
      finalName = `${baseName} copy ${i}`;
    }

    const newPlacements = members.map((p) => ({
      id: genId(),
      assetId: p.assetId,
      row: p.row + offsetRow,
      col: p.col + offsetCol,
      layer: p.layer,
      spanW: p.spanW,
      spanH: p.spanH,
      rotation: p.rotation,
      flipH: p.flipH,
      flipV: p.flipV,
      groupId: newGid,
      zIndex: p.zIndex,
    }));
    const newIds = newPlacements.map((p) => p.id);

    setRoom((prev) => ({
      ...prev,
      groups: [...(prev.groups ?? []), { id: newGid, name: finalName, layer: group.layer, visible: true, locked: false, collapsed: false }],
      placements: [...prev.placements, ...newPlacements],
    }));
    bumpVersion();
    return newIds;
  }, [bumpVersion, pushUndo]);

  const deleteGroup = useCallback((groupId: string) => {
    pushUndo(roomRef.current);
    setRoom((prev) => ({
      ...prev,
      groups: (prev.groups ?? []).filter((g) => g.id !== groupId),
      placements: prev.placements.filter((p) => p.groupId !== groupId),
    }));
    bumpVersion();
  }, [bumpVersion, pushUndo]);

  const renameGroup = useCallback((groupId: string, name: string) => {
    setRoom((prev) => ({
      ...prev,
      groups: (prev.groups ?? []).map((g) => g.id === groupId ? { ...g, name } : g),
    }));
    bumpVersion();
  }, [bumpVersion]);

  const toggleGroupVisibility = useCallback((groupId: string) => {
    setRoom((prev) => ({
      ...prev,
      groups: (prev.groups ?? []).map((g) => g.id === groupId ? { ...g, visible: !g.visible } : g),
    }));
    bumpVersion();
  }, [bumpVersion]);

  const toggleGroupLock = useCallback((groupId: string) => {
    setRoom((prev) => ({
      ...prev,
      groups: (prev.groups ?? []).map((g) => g.id === groupId ? { ...g, locked: !g.locked } : g),
    }));
    bumpVersion();
  }, [bumpVersion]);

  const toggleGroupCollapsed = useCallback((groupId: string) => {
    setRoom((prev) => ({
      ...prev,
      groups: (prev.groups ?? []).map((g) => g.id === groupId ? { ...g, collapsed: !g.collapsed } : g),
    }));
    bumpVersion();
  }, [bumpVersion]);

  const addPlacementsToGroup = useCallback((groupId: string, placementIds: string[]) => {
    if (placementIds.length === 0) return;
    pushUndo(roomRef.current);
    setRoom((prev) => {
      const group = (prev.groups ?? []).find((g) => g.id === groupId);
      if (!group) return prev;
      return {
        ...prev,
        placements: prev.placements.map((p) =>
          placementIds.includes(p.id) ? { ...p, groupId, layer: group.layer } : p
        ),
      };
    });
    bumpVersion();
  }, [bumpVersion, pushUndo]);

  // Removes the given placements from any group they currently belong to.
  // Unlike `ungroupPlacements` (which deletes the whole group), this leaves
  // the group intact with its remaining members — useful for the drag-out
  // gesture in the Layers panel where a user drags one item out of a group
  // to exclude it without ungrouping the rest.
  const removePlacementsFromGroup = useCallback((placementIds: string[]) => {
    if (placementIds.length === 0) return;
    const idSet = new Set(placementIds);
    pushUndo(roomRef.current);
    setRoom((prev) => ({
      ...prev,
      placements: prev.placements.map((p) =>
        idSet.has(p.id) && p.groupId !== undefined ? { ...p, groupId: undefined } : p
      ),
    }));
    bumpVersion();
  }, [bumpVersion, pushUndo]);

  // Atomic batch move: relocate multiple placements by (dRow, dCol) in a single undo entry
  const bulkMovePlacements = useCallback((moves: { id: string; newRow: number; newCol: number }[]) => {
    if (moves.length === 0) return;
    pushUndo(roomRef.current);
    const moveMap = new Map(moves.map((m) => [m.id, m]));
    setRoom((prev) => ({
      ...prev,
      placements: prev.placements.map((p) => {
        const m = moveMap.get(p.id);
        return m ? { ...p, row: m.newRow, col: m.newCol } : p;
      }),
    }));
    bumpVersion();
  }, [bumpVersion, pushUndo]);

  // Atomic batch duplicate: copy placements at new positions in a single undo entry
  const bulkDuplicatePlacements = useCallback((sources: { assetId: number; row: number; col: number; layer: LayerType; spanW: number; spanH: number; rotation: number; flipH: boolean; flipV: boolean; groupId?: string; zIndex?: number }[]) => {
    if (sources.length === 0) return;
    pushUndo(roomRef.current);
    const newPlacements = sources.map((s) => ({
      id: genId(),
      assetId: s.assetId,
      row: s.row,
      col: s.col,
      layer: s.layer,
      spanW: s.spanW,
      spanH: s.spanH,
      rotation: s.rotation,
      flipH: s.flipH,
      flipV: s.flipV,
      groupId: s.groupId,
      zIndex: s.zIndex,
    }));
    setRoom((prev) => ({ ...prev, placements: [...prev.placements, ...newPlacements] }));
    bumpVersion();
  }, [bumpVersion, pushUndo]);

  // Reorders the `groups` array metadata only. The Layers-panel interleaves
  // groups and ungrouped placements by effective zIndex, so the visible order
  // is driven by each placement's `zIndex`. Callers that move groups around
  // (LayersPanel drag/drop) are responsible for pairing this with
  // `reorderPlacementsBulk` to update the zIndex values that actually drive
  // draw order.
  const reorderGroups = useCallback((orderedGroupIds: string[]) => {
    pushUndo(roomRef.current);
    const idSet = new Set(orderedGroupIds);
    setRoom((prev) => {
      const prevGroupMap = new Map((prev.groups ?? []).map((g) => [g.id, g]));
      const queue = [...orderedGroupIds];
      let qi = 0;
      const newGroups = (prev.groups ?? []).map((g) => {
        if (idSet.has(g.id)) return prevGroupMap.get(queue[qi++])!;
        return g;
      });
      return { ...prev, groups: newGroups };
    });
    bumpVersion();
  }, [bumpVersion, pushUndo]);

  const moveGroupToLayer = useCallback((groupId: string, targetLayer: LayerType) => {
    pushUndo(roomRef.current);
    setRoom((prev) => ({
      ...prev,
      groups: (prev.groups ?? []).map((g) =>
        g.id === groupId ? { ...g, layer: targetLayer } : g
      ),
      placements: prev.placements.map((p) =>
        p.groupId === groupId ? { ...p, layer: targetLayer, zIndex: undefined } : p
      ),
    }));
    bumpVersion();
  }, [bumpVersion, pushUndo]);

  return {
    room,
    roomRef,
    version,
    canUndo,
    canRedo,
    undo,
    redo,
    beginUndoBatch,
    endUndoBatch,
    addPlacement,
    removePlacementAt,
    removePlacementById,
    removePlacementsByIds,
    getPlacementAt,
    clearAll,
    resize,
    loadState,
    toggleLayerVisibility,
    toggleLayerLock,
    renameLayer,
    bringToFront,
    sendToBack,
    movePlacementToLayer,
    movePlacementsToLayer,
    reorderPlacement,
    reorderPlacementsBulk,
    createGroup,
    duplicateGroup,
    ungroupPlacements,
    deleteGroup,
    renameGroup,
    toggleGroupVisibility,
    toggleGroupLock,
    toggleGroupCollapsed,
    reorderGroups,
    moveGroupToLayer,
    addPlacementsToGroup,
    removePlacementsFromGroup,
    bulkMovePlacements,
    bulkDuplicatePlacements,
  };
}
