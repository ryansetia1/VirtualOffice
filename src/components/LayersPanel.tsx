import { useState, useCallback, useMemo, useRef, type PointerEvent as RPointerEvent } from 'react';
import type { RoomState, Placement, LayerType, PlacementGroup } from '../hooks/useGrid';
import ContextMenu, { type MenuItem } from './ContextMenu';

const LAYER_ORDER_REVERSED: LayerType[] = ['object', 'wall', 'floor'];

interface Props {
  room: RoomState;
  activeLayer: LayerType;
  selectedIds: Set<string>;
  collapsed: boolean;
  getAssetDisplayName: (id: number) => string;
  onSelectLayer: (layer: LayerType) => void;
  onSetSelectedIds: (ids: Set<string>) => void;
  onHoverIds: (ids: Set<string>) => void;
  onToggleVisibility: (layer: LayerType) => void;
  onToggleLock: (layer: LayerType) => void;
  onRenameLayer: (layer: LayerType, name: string) => void;
  onBringToFront: (id: string) => void;
  onSendToBack: (id: string) => void;
  onMovePlacementsToLayer: (ids: Set<string>, layer: LayerType) => void;
  onDeletePlacements: (ids: Set<string>) => void;
  onReorderPlacement: (id: string, newZIndex: number) => void;
  onReorderPlacementsBulk: (orderedIds: string[]) => void;
  onCreateGroup: (name: string, layer: LayerType, ids: string[]) => void;
  onDuplicateGroup: (groupId: string, offsetRow?: number, offsetCol?: number) => string[];
  onUngroupPlacements: (groupId: string) => void;
  onDeleteGroup: (groupId: string) => void;
  onRenameGroup: (groupId: string, name: string) => void;
  onToggleGroupVisibility: (groupId: string) => void;
  onToggleGroupLock: (groupId: string) => void;
  onToggleGroupCollapsed: (groupId: string) => void;
  onMoveGroupToLayer: (groupId: string, layer: LayerType) => void;
  onReorderGroups: (orderedGroupIds: string[]) => void;
  onAddPlacementsToGroup: (groupId: string, placementIds: string[]) => void;
  onModeChange?: (mode: 'select' | 'draw' | 'place') => void;
  onToggleCollapsed: () => void;
}

type FlatItem =
  | { kind: 'layer-header'; layer: LayerType }
  | { kind: 'group-header'; group: PlacementGroup; layer: LayerType }
  | { kind: 'placement'; placement: Placement; layer: LayerType; groupId?: string };

export default function LayersPanel({
  room,
  activeLayer,
  selectedIds,
  collapsed: panelCollapsed,
  getAssetDisplayName,
  onSelectLayer,
  onSetSelectedIds,
  onHoverIds,
  onToggleVisibility,
  onToggleLock,
  onRenameLayer,
  onBringToFront,
  onSendToBack,
  onMovePlacementsToLayer,
  onDeletePlacements,
  onReorderPlacement: _onReorderPlacement,
  onReorderPlacementsBulk,
  onCreateGroup,
  onDuplicateGroup,
  onUngroupPlacements,
  onDeleteGroup,
  onRenameGroup,
  onToggleGroupVisibility,
  onToggleGroupLock,
  onToggleGroupCollapsed,
  onMoveGroupToLayer,
  onReorderGroups,
  onAddPlacementsToGroup,
  onModeChange,
  onToggleCollapsed,
}: Props) {
  const [layerCollapsed, setLayerCollapsed] = useState<Record<string, boolean>>({});
  const [renamingLayer, setRenamingLayer] = useState<LayerType | null>(null);
  const [renamingGroup, setRenamingGroup] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);

  const lastClickedId = useRef<string | null>(null);

  // Pointer-drag state
  const [dragIds, setDragIds] = useState<Set<string> | null>(null);
  const [dragGroupId, setDragGroupId] = useState<string | null>(null);
  const [isDragActive, setIsDragActive] = useState(false);
  const [insertIndicator, setInsertIndicator] = useState<{ y: number } | null>(null);
  const [insertTargetId, setInsertTargetId] = useState<string | null>(null);
  const [insertAbove, setInsertAbove] = useState(true);
  const [dropTargetLayer, setDropTargetLayer] = useState<LayerType | null>(null);
  const [dropTargetGroupId, setDropTargetGroupId] = useState<string | null>(null);
  const [insertGroupTargetId, setInsertGroupTargetId] = useState<string | null>(null);
  const [insertGroupAbove, setInsertGroupAbove] = useState(true);
  const dragStartPos = useRef<{ x: number; y: number } | null>(null);
  const DRAG_THRESHOLD = 5;
  const scrollRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const layerHeaderRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const groupHeaderRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  const toggleLayerCollapsed = useCallback((layer: string) => {
    setLayerCollapsed((prev) => ({ ...prev, [layer]: !prev[layer] }));
  }, []);

  const groups = useMemo(() => room.groups ?? [], [room.groups]);
  const groupMap = useMemo(() => new Map(groups.map((g) => [g.id, g])), [groups]);

  // Build sorted placements per layer, split by group
  const dataByLayer = useMemo(() => {
    const result: Record<LayerType, { grouped: Map<string, Placement[]>; ungrouped: Placement[] }> = {
      floor: { grouped: new Map(), ungrouped: [] },
      wall: { grouped: new Map(), ungrouped: [] },
      object: { grouped: new Map(), ungrouped: [] },
    };
    const sortFn = (a: Placement, b: Placement) => {
      const za = a.zIndex ?? (a.row + a.spanH) * 1000;
      const zb = b.zIndex ?? (b.row + b.spanH) * 1000;
      return zb - za;
    };
    for (const p of room.placements) {
      const bucket = result[p.layer];
      if (p.groupId && groupMap.has(p.groupId)) {
        if (!bucket.grouped.has(p.groupId)) bucket.grouped.set(p.groupId, []);
        bucket.grouped.get(p.groupId)!.push(p);
      } else {
        bucket.ungrouped.push(p);
      }
    }
    for (const layer of LAYER_ORDER_REVERSED) {
      result[layer].ungrouped.sort(sortFn);
      for (const arr of result[layer].grouped.values()) arr.sort(sortFn);
    }
    return result;
  }, [room.placements, groupMap]);

  // Build unique display names: append "#N" when multiple placements share the same asset name
  const placementDisplayNames = useMemo(() => {
    const nameMap = new Map<string, string>();
    const countByName = new Map<string, number>();
    for (const p of room.placements) {
      const base = getAssetDisplayName(p.assetId);
      countByName.set(base, (countByName.get(base) ?? 0) + 1);
    }
    const indexByName = new Map<string, number>();
    for (const p of room.placements) {
      const base = getAssetDisplayName(p.assetId);
      const total = countByName.get(base) ?? 1;
      if (total > 1) {
        const idx = (indexByName.get(base) ?? 0) + 1;
        indexByName.set(base, idx);
        nameMap.set(p.id, `${base} #${idx}`);
      } else {
        nameMap.set(p.id, base);
      }
    }
    return nameMap;
  }, [room.placements, getAssetDisplayName]);

  // Flat list of all placement IDs in display order (for Shift+click range selection)
  const flatPlacementIds = useMemo(() => {
    const ids: string[] = [];
    for (const layer of LAYER_ORDER_REVERSED) {
      if (layerCollapsed[layer]) continue;
      const data = dataByLayer[layer];
      const layerGroups = groups.filter((g) => g.layer === layer);
      for (const g of layerGroups) {
        if (!g.collapsed) {
          const gPlacements = data.grouped.get(g.id) ?? [];
          for (const p of gPlacements) ids.push(p.id);
        }
      }
      for (const p of data.ungrouped) ids.push(p.id);
    }
    return ids;
  }, [dataByLayer, groups, layerCollapsed]);

  // Selection handlers
  // Shift+click = range select, Ctrl/Cmd+click = toggle individual
  const handleItemClick = useCallback((e: React.MouseEvent, placementId: string) => {
    onModeChange?.('select');
    if (e.shiftKey && lastClickedId.current) {
      // Range select from last clicked to current
      const i1 = flatPlacementIds.indexOf(lastClickedId.current);
      const i2 = flatPlacementIds.indexOf(placementId);
      if (i1 >= 0 && i2 >= 0) {
        const start = Math.min(i1, i2);
        const end = Math.max(i1, i2);
        const range = new Set(flatPlacementIds.slice(start, end + 1));
        onSetSelectedIds(range);
        return;
      }
    }
    if (e.ctrlKey || e.metaKey) {
      // Toggle individual item in/out of selection
      const next = new Set(selectedIds);
      if (next.has(placementId)) {
        next.delete(placementId);
      } else {
        next.add(placementId);
      }
      onSetSelectedIds(next);
      lastClickedId.current = placementId;
      return;
    }
    lastClickedId.current = placementId;
    if (selectedIds.has(placementId) && selectedIds.size === 1) {
      onSetSelectedIds(new Set());
    } else {
      onSetSelectedIds(new Set([placementId]));
    }
  }, [flatPlacementIds, selectedIds, onSetSelectedIds, onModeChange]);

  // Hover
  const handleItemEnter = useCallback((ids: string[]) => {
    onHoverIds(new Set(ids));
  }, [onHoverIds]);
  const handleItemLeave = useCallback(() => {
    onHoverIds(new Set());
  }, [onHoverIds]);

  // Rename submit
  const handleLayerRenameSubmit = useCallback(() => {
    if (renamingLayer && renameValue.trim()) onRenameLayer(renamingLayer, renameValue.trim());
    setRenamingLayer(null);
    setRenameValue('');
  }, [renamingLayer, renameValue, onRenameLayer]);

  const handleGroupRenameSubmit = useCallback(() => {
    if (renamingGroup && renameValue.trim()) onRenameGroup(renamingGroup, renameValue.trim());
    setRenamingGroup(null);
    setRenameValue('');
  }, [renamingGroup, renameValue, onRenameGroup]);

  // Context menus
  const openPlacementCtx = useCallback((e: React.MouseEvent, placementId: string, layer: LayerType) => {
    e.preventDefault();
    const targetIds = selectedIds.has(placementId) && selectedIds.size > 1 ? selectedIds : new Set([placementId]);
    const items: MenuItem[] = [];
    if (targetIds.size === 1) {
      const singleId = [...targetIds][0];
      items.push({ label: 'Bring to Front', onClick: () => onBringToFront(singleId) });
      items.push({ label: 'Send to Back', onClick: () => onSendToBack(singleId) });
    }
    for (const l of LAYER_ORDER_REVERSED) {
      if (l !== layer) {
        const name = (room.layerNames ?? {})[l] ?? l;
        items.push({ label: `Move to ${name}`, onClick: () => onMovePlacementsToLayer(targetIds, l) });
      }
    }
    if (targetIds.size > 1) {
      items.push({
        label: 'Group Selected',
        onClick: () => onCreateGroup('Group', layer, [...targetIds]),
      });
    }
    items.push({ label: 'Delete', danger: true, onClick: () => onDeletePlacements(targetIds) });
    setCtxMenu({ x: e.clientX, y: e.clientY, items });
  }, [selectedIds, room.layerNames, onBringToFront, onSendToBack, onMovePlacementsToLayer, onCreateGroup, onDeletePlacements]);

  const openGroupCtx = useCallback((e: React.MouseEvent, groupId: string) => {
    e.preventDefault();
    const g = groupMap.get(groupId);
    const items: MenuItem[] = [
      { label: 'Rename', onClick: () => { setRenamingGroup(groupId); setRenameValue(g?.name ?? ''); } },
      { label: 'Duplicate Group', onClick: () => {
        const newIds = onDuplicateGroup(groupId, 1, 1);
        if (newIds.length > 0) {
          onModeChange?.('select');
          onSetSelectedIds(new Set(newIds));
        }
      }},
    ];
    if (g) {
      for (const l of LAYER_ORDER_REVERSED) {
        if (l !== g.layer) {
          const name = (room.layerNames ?? {})[l] ?? l.charAt(0).toUpperCase() + l.slice(1);
          items.push({ label: `Move to ${name}`, onClick: () => onMoveGroupToLayer(groupId, l) });
        }
      }
    }
    items.push({ label: 'Ungroup', onClick: () => onUngroupPlacements(groupId) });
    items.push({ label: 'Delete Group + Items', danger: true, onClick: () => onDeleteGroup(groupId) });
    setCtxMenu({ x: e.clientX, y: e.clientY, items });
  }, [groupMap, room.layerNames, onUngroupPlacements, onDeleteGroup, onMoveGroupToLayer, onDuplicateGroup, onModeChange, onSetSelectedIds]);

  // ── Pointer-based drag reorder ─────────────────────────────────────────
  const handleDragPointerDown = useCallback((e: RPointerEvent<HTMLDivElement>, placementId: string) => {
    if (e.button !== 0) return;
    const ids = selectedIds.has(placementId) && selectedIds.size > 1 ? new Set(selectedIds) : new Set([placementId]);
    setDragIds(ids);
    setDragGroupId(null);
    setIsDragActive(false);
    dragStartPos.current = { x: e.clientX, y: e.clientY };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }, [selectedIds]);

  const handleGroupDragPointerDown = useCallback((e: RPointerEvent<HTMLDivElement>, groupId: string) => {
    if (e.button !== 0) return;
    setDragGroupId(groupId);
    setDragIds(null);
    setIsDragActive(false);
    dragStartPos.current = { x: e.clientX, y: e.clientY };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  const handleDragPointerMove = useCallback((e: RPointerEvent<HTMLDivElement>) => {
    const hasDragIntent = dragIds || dragGroupId;
    if (!hasDragIntent) return;

    // Check if past drag threshold
    if (!isDragActive) {
      if (!dragStartPos.current) return;
      const dx = e.clientX - dragStartPos.current.x;
      const dy = e.clientY - dragStartPos.current.y;
      if (Math.sqrt(dx * dx + dy * dy) < DRAG_THRESHOLD) return;
      setIsDragActive(true);
    }

    // Check layer headers first -- for cross-layer move
    for (const [layer, el] of layerHeaderRefs.current.entries()) {
      const rect = el.getBoundingClientRect();
      if (e.clientY >= rect.top && e.clientY <= rect.bottom) {
        setDropTargetLayer(layer as LayerType);
        setDropTargetGroupId(null);
        setInsertIndicator(null);
        setInsertTargetId(null);
        setInsertGroupTargetId(null);
        return;
      }
    }
    setDropTargetLayer(null);

    // For placement drags, check group headers as drop targets
    if (dragIds) {
      for (const [gid, el] of groupHeaderRefs.current.entries()) {
        const rect = el.getBoundingClientRect();
        if (e.clientY >= rect.top && e.clientY <= rect.bottom) {
          setDropTargetGroupId(gid);
          setInsertIndicator(null);
          setInsertTargetId(null);
          return;
        }
      }
    }
    setDropTargetGroupId(null);

    // For group drag, check other group headers for insertion ordering
    if (dragGroupId) {
      let closestGroup: { id: string; above: boolean; lineY: number } | null = null;
      let minGroupDist = Infinity;
      for (const [gid, el] of groupHeaderRefs.current.entries()) {
        if (gid === dragGroupId) continue;
        const rect = el.getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        const dist = Math.abs(e.clientY - midY);
        if (dist < minGroupDist) {
          minGroupDist = dist;
          const above = e.clientY < midY;
          closestGroup = { id: gid, above, lineY: above ? rect.top : rect.bottom };
        }
      }
      if (closestGroup) {
        setInsertIndicator({ y: closestGroup.lineY });
        setInsertGroupTargetId(closestGroup.id);
        setInsertGroupAbove(closestGroup.above);
      } else {
        setInsertIndicator(null);
        setInsertGroupTargetId(null);
      }
      setInsertTargetId(null);
      return;
    }

    // Find closest placement item and determine above/below
    let closest: { id: string; above: boolean; lineY: number } | null = null;
    let minDist = Infinity;
    for (const [id, el] of itemRefs.current.entries()) {
      if (dragIds!.has(id)) continue;
      const rect = el.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      const dist = Math.abs(e.clientY - midY);
      if (dist < minDist) {
        minDist = dist;
        const above = e.clientY < midY;
        closest = { id, above, lineY: above ? rect.top : rect.bottom };
      }
    }
    if (closest) {
      setInsertIndicator({ y: closest.lineY });
      setInsertTargetId(closest.id);
      setInsertAbove(closest.above);
    } else {
      setInsertIndicator(null);
      setInsertTargetId(null);
    }
  }, [dragIds, dragGroupId, isDragActive]);

  const handleDragPointerUp = useCallback((_e: RPointerEvent<HTMLDivElement>) => {
    const wasActive = isDragActive;

    // Handle group drag
    if (dragGroupId) {
      if (wasActive && dropTargetLayer) {
        onMoveGroupToLayer(dragGroupId, dropTargetLayer);
      } else if (wasActive && insertGroupTargetId) {
        const groups = room.groups ?? [];
        const targetGroup = groups.find((g) => g.id === insertGroupTargetId);
        const dragGroup = groups.find((g) => g.id === dragGroupId);
        if (targetGroup && dragGroup) {
          const sameLayerGroups = groups.filter((g) => g.layer === targetGroup.layer);
          const otherIds = sameLayerGroups.filter((g) => g.id !== dragGroupId).map((g) => g.id);
          const targetIdx = otherIds.indexOf(insertGroupTargetId);
          const insertAt = insertGroupAbove ? targetIdx : targetIdx + 1;
          otherIds.splice(insertAt, 0, dragGroupId);
          if (dragGroup.layer !== targetGroup.layer) {
            onMoveGroupToLayer(dragGroupId, targetGroup.layer);
          }
          onReorderGroups(otherIds);
        }
      }
      setDragGroupId(null);
      setIsDragActive(false);
      dragStartPos.current = null;
      setInsertIndicator(null);
      setInsertTargetId(null);
      setInsertGroupTargetId(null);
      setDropTargetLayer(null);
      setDropTargetGroupId(null);
      return;
    }

    if (!dragIds) return;

    if (wasActive && dropTargetGroupId) {
      onAddPlacementsToGroup(dropTargetGroupId, [...dragIds]);
    } else if (wasActive && dropTargetLayer) {
      onMovePlacementsToLayer(dragIds, dropTargetLayer);
    } else if (wasActive && insertTargetId) {
      const targetP = room.placements.find((p) => p.id === insertTargetId);
      if (targetP) {
        const layer = targetP.layer;
        const sortFn = (a: Placement, b: Placement) => {
          const za = a.zIndex ?? (a.row + a.spanH) * 1000;
          const zb = b.zIndex ?? (b.row + b.spanH) * 1000;
          return zb - za;
        };
        const layerPlacements = room.placements
          .filter((p) => p.layer === layer)
          .sort(sortFn);
        const orderedIds = layerPlacements.map((p) => p.id);

        const draggedIds = [...dragIds].filter((id) => orderedIds.includes(id));
        const filtered = orderedIds.filter((id) => !dragIds.has(id));

        const targetIdx = filtered.indexOf(insertTargetId);
        if (targetIdx >= 0) {
          const insertIdx = insertAbove ? targetIdx : targetIdx + 1;
          filtered.splice(insertIdx, 0, ...draggedIds);
        }

        onReorderPlacementsBulk(filtered);
      }
    }

    setDragIds(null);
    setIsDragActive(false);
    dragStartPos.current = null;
    setInsertIndicator(null);
    setInsertTargetId(null);
    setInsertGroupTargetId(null);
    setDropTargetLayer(null);
    setDropTargetGroupId(null);
  }, [dragIds, dragGroupId, isDragActive, dropTargetLayer, dropTargetGroupId, insertTargetId, insertAbove, insertGroupTargetId, insertGroupAbove, room.placements, room.groups, onMovePlacementsToLayer, onReorderPlacementsBulk, onMoveGroupToLayer, onReorderGroups, onAddPlacementsToGroup]);

  // ── Collapsed view ─────────────────────────────────────────────────────
  if (panelCollapsed) {
    return (
      <div style={styles.collapsedContainer} onClick={onToggleCollapsed} title="Expand layers">
        <span style={styles.collapsedLabel}>L</span>
        <span style={styles.collapsedLabel}>A</span>
        <span style={styles.collapsedLabel}>Y</span>
        <span style={styles.collapsedLabel}>E</span>
        <span style={styles.collapsedLabel}>R</span>
        <span style={styles.collapsedLabel}>S</span>
      </div>
    );
  }

  // ── Render helpers ────────────────────────────────────────────────────
  const renderPlacement = (p: Placement, layer: LayerType, inGroup = false) => {
    const isSelected = selectedIds.has(p.id);
    const isDragging = isDragActive && (dragIds?.has(p.id) ?? false);
    return (
      <div
        key={p.id}
        ref={(el) => { if (el) itemRefs.current.set(p.id, el); else itemRefs.current.delete(p.id); }}
        onPointerDown={(e) => handleDragPointerDown(e, p.id)}
        onClick={(e) => handleItemClick(e, p.id)}
        onContextMenu={(e) => openPlacementCtx(e, p.id, layer)}
        onMouseEnter={() => handleItemEnter([p.id])}
        onMouseLeave={handleItemLeave}
        style={{
          ...styles.placementItem,
          ...(inGroup ? styles.placementItemInGroup : {}),
          ...(isSelected ? styles.placementItemSelected : {}),
          ...(isDragging ? styles.placementItemDragging : {}),
        }}
      >
        <span style={styles.placementName}>{placementDisplayNames.get(p.id) ?? getAssetDisplayName(p.assetId)}</span>
      </div>
    );
  };

  const renderGroup = (g: PlacementGroup, placements: Placement[], layer: LayerType) => {
    const isDraggingGroup = isDragActive && dragGroupId === g.id;
    const isGroupDropTarget = isDragActive && dropTargetGroupId === g.id;
    const isGroupSelected = placements.length > 0 && placements.every((p) => selectedIds.has(p.id));
    return (
      <div key={g.id}>
        <div
          ref={(el) => { if (el) groupHeaderRefs.current.set(g.id, el); else groupHeaderRefs.current.delete(g.id); }}
          style={{
            ...styles.groupHeader,
            ...(isGroupSelected ? styles.groupHeaderSelected : {}),
            ...(isDraggingGroup ? styles.placementItemDragging : {}),
            ...(isGroupDropTarget ? styles.groupHeaderDropTarget : {}),
          }}
          onPointerDown={(e) => handleGroupDragPointerDown(e, g.id)}
          onClick={(e) => {
            e.stopPropagation();
            onModeChange?.('select');
            const ids = new Set(placements.map((p) => p.id));
            onSetSelectedIds(ids);
          }}
          onContextMenu={(e) => openGroupCtx(e, g.id)}
          onMouseEnter={() => handleItemEnter(placements.map((p) => p.id))}
          onMouseLeave={handleItemLeave}
        >
          <button
            style={styles.chevronBtn}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); onToggleGroupCollapsed(g.id); }}
            title={g.collapsed ? 'Expand group' : 'Collapse group'}
          >
            {g.collapsed ? '▸' : '▾'}
          </button>
          <button
            style={{ ...styles.iconBtn, opacity: g.visible ? 1 : 0.3 }}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); onToggleGroupVisibility(g.id); }}
            title={g.visible ? 'Hide group' : 'Show group'}
          >
            {g.visible ? '👁' : '👁'}
          </button>
          <button
            style={{ ...styles.iconBtn, opacity: g.locked ? 1 : 0.3 }}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); onToggleGroupLock(g.id); }}
            title={g.locked ? 'Unlock group' : 'Lock group'}
          >
            {g.locked ? '🔒' : '🔓'}
          </button>
          {renamingGroup === g.id ? (
            <input
              autoFocus
              style={styles.renameInput}
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleGroupRenameSubmit();
                if (e.key === 'Escape') { setRenamingGroup(null); setRenameValue(''); }
              }}
              onBlur={handleGroupRenameSubmit}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <span
              style={{ ...styles.groupName, ...(isGroupSelected ? { color: 'var(--accent)' } : {}) }}
              onPointerDown={(e) => e.stopPropagation()}
              onDoubleClick={(e) => {
                e.stopPropagation();
                setRenamingGroup(g.id);
                setRenameValue(g.name);
              }}
            >
              {g.name}
            </span>
          )}
          <span style={styles.layerCount}>{placements.length}</span>
        </div>
        {!g.collapsed && placements.map((p) => renderPlacement(p, layer, true))}
      </div>
    );
  };

  return (
    <div
      style={styles.container}
      onPointerMove={handleDragPointerMove}
      onPointerUp={handleDragPointerUp}
    >
      <div style={styles.header}>
        <span style={styles.title}>Layers</span>
        <button style={styles.collapseBtn} onClick={onToggleCollapsed} title="Collapse panel">
          ‹‹
        </button>
      </div>
      <div style={styles.scrollArea} ref={scrollRef}>
        {LAYER_ORDER_REVERSED.map((layer) => {
          const isActive = activeLayer === layer;
          const isVisible = (room.layerVisibility ?? {})[layer] !== false;
          const isLocked = (room.layerLocked ?? {})[layer] === true;
          const isCollapsed = layerCollapsed[layer] ?? false;
          const data = dataByLayer[layer];
          const layerName = (room.layerNames ?? {})[layer] ?? layer.charAt(0).toUpperCase() + layer.slice(1);
          const totalCount = (data.ungrouped.length) + [...data.grouped.values()].reduce((s, a) => s + a.length, 0);
          const layerGroups = groups.filter((g) => g.layer === layer);
          const isDropTarget = isDragActive && dropTargetLayer === layer;

          return (
            <div key={layer} style={styles.layerGroup}>
              <div
                ref={(el) => { if (el) layerHeaderRefs.current.set(layer, el); else layerHeaderRefs.current.delete(layer); }}
                style={{
                  ...styles.layerHeader,
                  ...(isActive ? styles.layerHeaderActive : {}),
                  ...(isDropTarget ? styles.layerHeaderDropTarget : {}),
                }}
                onClick={() => onSelectLayer(layer)}
              >
                <button
                  style={styles.chevronBtn}
                  onClick={(e) => { e.stopPropagation(); toggleLayerCollapsed(layer); }}
                >
                  {isCollapsed ? '▸' : '▾'}
                </button>

                <button
                  style={{ ...styles.iconBtn, opacity: isVisible ? 1 : 0.3 }}
                  onClick={(e) => { e.stopPropagation(); onToggleVisibility(layer); }}
                  title={isVisible ? 'Hide layer' : 'Show layer'}
                >
                  {isVisible ? '👁' : '👁'}
                </button>

                <button
                  style={{ ...styles.iconBtn, opacity: isLocked ? 1 : 0.3 }}
                  onClick={(e) => { e.stopPropagation(); onToggleLock(layer); }}
                  title={isLocked ? 'Unlock layer' : 'Lock layer'}
                >
                  {isLocked ? '🔒' : '🔓'}
                </button>

                {renamingLayer === layer ? (
                  <input
                    autoFocus
                    style={styles.renameInput}
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleLayerRenameSubmit();
                      if (e.key === 'Escape') { setRenamingLayer(null); setRenameValue(''); }
                    }}
                    onBlur={handleLayerRenameSubmit}
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <span
                    style={styles.layerName}
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      setRenamingLayer(layer);
                      setRenameValue(layerName);
                    }}
                  >
                    {layerName}
                  </span>
                )}

                <span style={styles.layerCount}>{totalCount}</span>
              </div>

              {!isCollapsed && (
                <div style={styles.itemList}>
                  {layerGroups.map((g) => {
                    const gPlacements = data.grouped.get(g.id) ?? [];
                    return renderGroup(g, gPlacements, layer);
                  })}
                  {data.ungrouped.map((p) => renderPlacement(p, layer))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Insertion line indicator */}
      {insertIndicator && isDragActive && (dragIds || dragGroupId) && (
        <div style={{
          position: 'fixed',
          left: 0, width: 220,
          top: insertIndicator.y - 1,
          height: 2,
          background: 'var(--accent)',
          pointerEvents: 'none',
          zIndex: 9998,
        }} />
      )}

      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={ctxMenu.items}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    width: 220, minWidth: 220, background: 'var(--bg-secondary)',
    borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column',
    height: '100%', userSelect: 'none', position: 'relative',
  },
  collapsedContainer: {
    width: 32, minWidth: 32, background: 'var(--bg-secondary)',
    borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column',
    alignItems: 'center', paddingTop: 12, gap: 2, cursor: 'pointer',
    height: '100%', userSelect: 'none',
  },
  collapsedLabel: {
    fontSize: 10, fontWeight: 600, color: 'var(--text-muted)', letterSpacing: '1px',
  },
  header: {
    padding: '8px 8px 8px 12px', borderBottom: '1px solid var(--border)',
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  },
  title: { fontWeight: 600, fontSize: 13, color: 'var(--text-primary)' },
  collapseBtn: {
    background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: 12,
    cursor: 'pointer', padding: '2px 4px', borderRadius: 3,
  },
  scrollArea: { flex: 1, overflowY: 'auto' },

  layerGroup: { borderBottom: '1px solid var(--border)' },
  layerHeader: {
    display: 'flex', alignItems: 'center', gap: 4, padding: '6px 8px',
    cursor: 'pointer', background: 'var(--bg-surface)', fontSize: 12,
  },
  layerHeaderActive: {
    background: 'var(--accent-dim)',
    borderLeft: '3px solid var(--accent)',
    paddingLeft: 5,
  },
  layerHeaderDropTarget: {
    outline: '2px solid var(--accent)',
    outlineOffset: -2,
  },
  chevronBtn: {
    background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: 10,
    cursor: 'pointer', width: 14, padding: 0, flexShrink: 0,
  },
  iconBtn: {
    background: 'none', border: 'none', fontSize: 11, cursor: 'pointer',
    padding: 0, flexShrink: 0, lineHeight: 1,
  },
  layerName: {
    flex: 1, fontWeight: 500, color: 'var(--text-primary)', overflow: 'hidden',
    textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  layerCount: {
    fontSize: 10, color: 'var(--text-muted)', fontFamily: 'monospace', flexShrink: 0,
  },
  renameInput: {
    flex: 1, padding: '2px 4px', border: '1px solid var(--accent)', borderRadius: 3,
    background: 'var(--bg-primary)', fontSize: 12, color: 'var(--text-primary)', outline: 'none',
  },

  groupHeader: {
    display: 'flex', alignItems: 'center', gap: 4, padding: '4px 8px 4px 20px',
    cursor: 'pointer', fontSize: 11, background: 'var(--bg-primary)',
    borderTop: '1px solid var(--border)', touchAction: 'none',
  },
  groupHeaderSelected: {
    background: 'rgba(79, 195, 247, 0.2)',
    outline: '1px solid var(--accent)',
    outlineOffset: -1,
  },
  groupHeaderDropTarget: {
    outline: '2px solid var(--accent)',
    outlineOffset: -2,
    background: 'var(--accent-dim)',
  },
  groupName: {
    flex: 1, fontWeight: 500, color: 'var(--text-secondary)', overflow: 'hidden',
    textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontStyle: 'italic',
  },

  itemList: { padding: '1px 0' },
  placementItem: {
    display: 'flex', alignItems: 'center', padding: '3px 8px 3px 32px',
    cursor: 'pointer', fontSize: 11, color: 'var(--text-secondary)',
    touchAction: 'none',
  },
  placementItemInGroup: {
    paddingLeft: 44,
  },
  placementItemSelected: {
    background: 'var(--accent-dim)', color: 'var(--accent)',
  },
  placementItemDragging: {
    opacity: 0.4,
  },
  placementName: {
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1,
  },
};
