import { useState, useCallback, useMemo, useRef, type PointerEvent as RPointerEvent } from 'react';
import type { RoomState, Placement, LayerType, PlacementGroup } from '../hooks/useGrid';
import type { SortAnchorApi } from '../hooks/useSortAnchorOverrides';
import ContextMenu, { type MenuItem } from './ContextMenu';
import { buildSortAnchorMenuItems } from '../utils/sortAnchorMenu';

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
  onRemovePlacementsFromGroup: (placementIds: string[]) => void;
  /** Opens the per-placement collision editor for the given placement. */
  onEditCollision?: (placementId: string) => void;
  /** Render-order (auto/above/below-agent) API. Passed through from App so
   *  the Layers panel context menu can mirror the canvas right-click menu. */
  renderOrderApi?: {
    getOrder: (p: { id: string; assetId: number }) => 'auto' | 'above' | 'below';
    getAssetOrder: (assetId: number) => 'auto' | 'above' | 'below';
    hasPlacementOverride: (placementId: string) => boolean;
    setPlacementOrder: (placementId: string, order: 'auto' | 'above' | 'below') => void;
    setAssetOrder: (assetId: number, order: 'auto' | 'above' | 'below') => void;
    clearPlacementOverride: (placementId: string) => void;
  };
  /** Sort-anchor API (parallel to `renderOrderApi`). Read-only here — the
   *  numeric editor lives in `App` so we can reuse its dialog. The panel
   *  only needs the four methods `buildSortAnchorMenuItems` consumes
   *  (effective/default labels + "reset" shortcut). */
  sortAnchorApi?: Pick<SortAnchorApi,
    'getAnchor' | 'getAssetAnchor' | 'hasPlacementOverride' | 'clearPlacementOverride'>;
  /** Called when the user picks "Sort anchor..." in the panel's context
   *  menu. `App` owns the actual dialog state + resolves spanH, so we just
   *  forward the target and scope. */
  onOpenSortAnchorDialog?: (placementId: string, scope: 'placement' | 'asset') => void;
  /** Resolves a placement id → placement. Used by the Layers panel context
   *  menu to look up asset ids + bbox info for asset-scoped actions. */
  getPlacementById?: (id: string) => { id: string; assetId: number; spanH: number } | undefined;
  onModeChange?: (mode: 'select' | 'draw' | 'place') => void;
  onToggleCollapsed: () => void;
}


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
  onRemovePlacementsFromGroup,
  onEditCollision,
  renderOrderApi,
  sortAnchorApi,
  onOpenSortAnchorDialog,
  getPlacementById,
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
  // 'placement' = anchor is a placement row; 'group' = anchor is a group
  // header (dragged item is inserted before/after the whole group block).
  const [insertTargetKind, setInsertTargetKind] = useState<'placement' | 'group' | null>(null);
  const [insertAbove, setInsertAbove] = useState(true);
  const [dropTargetLayer, setDropTargetLayer] = useState<LayerType | null>(null);
  const [dropTargetGroupId, setDropTargetGroupId] = useState<string | null>(null);
  const dragStartPos = useRef<{ x: number; y: number } | null>(null);
  const DRAG_THRESHOLD = 5;
  const scrollRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const layerHeaderRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const groupHeaderRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  // Panel resize state
  const [panelWidth, setPanelWidth] = useState(220);
  const [isResizing, setIsResizing] = useState(false);
  const resizeStartRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const toggleLayerCollapsed = useCallback((layer: string) => {
    setLayerCollapsed((prev) => ({ ...prev, [layer]: !prev[layer] }));
  }, []);

  const groups = useMemo(() => room.groups ?? [], [room.groups]);
  const groupMap = useMemo(() => new Map(groups.map((g) => [g.id, g])), [groups]);

  // Effective zIndex helper (shared).
  const zOf = useCallback((p: Placement): number => {
    return p.zIndex ?? (p.row + p.spanH) * 1000;
  }, []);

  // Interleaved per-layer panel entries. Each layer is a single ordered list
  // of "entries" sorted by effective zIndex desc; an entry is either a group
  // (with its members, kept in z-desc order for render under the header) or a
  // single ungrouped placement. A group's effective z = max member z so that
  // an ungrouped placement with higher z than a group's topmost member slots
  // above the group, matching the canvas draw order.
  type GroupEntry = { kind: 'group'; group: PlacementGroup; members: Placement[]; effectiveZ: number };
  type PlaceEntry = { kind: 'placement'; placement: Placement; effectiveZ: number };
  type PanelEntry = GroupEntry | PlaceEntry;

  const entriesByLayer = useMemo(() => {
    const groupMembers = new Map<string, Placement[]>();
    const ungroupedByLayer: Record<LayerType, Placement[]> = {
      floor: [], wall: [], object: [],
    };
    for (const p of room.placements) {
      if (p.groupId && groupMap.has(p.groupId)) {
        if (!groupMembers.has(p.groupId)) groupMembers.set(p.groupId, []);
        groupMembers.get(p.groupId)!.push(p);
      } else {
        ungroupedByLayer[p.layer].push(p);
      }
    }
    const result: Record<LayerType, PanelEntry[]> = { floor: [], wall: [], object: [] };
    for (const layer of LAYER_ORDER_REVERSED) {
      const entries: PanelEntry[] = [];
      for (const g of groups) {
        if (g.layer !== layer) continue;
        const members = (groupMembers.get(g.id) ?? []).slice().sort((a, b) => zOf(b) - zOf(a));
        const effectiveZ = members.length > 0
          ? Math.max(...members.map(zOf))
          : Number.NEGATIVE_INFINITY;
        entries.push({ kind: 'group', group: g, members, effectiveZ });
      }
      for (const p of ungroupedByLayer[layer]) {
        entries.push({ kind: 'placement', placement: p, effectiveZ: zOf(p) });
      }
      entries.sort((a, b) => b.effectiveZ - a.effectiveZ);
      result[layer] = entries;
    }
    return result;
  }, [room.placements, groupMap, groups, zOf]);

  // Flatten a layer's entries into a placement-ID sequence. Group members
  // stay contiguous (group block), in their current z-desc order.
  const flattenEntriesToPlacementIds = useCallback((entries: PanelEntry[]): string[] => {
    const ids: string[] = [];
    for (const entry of entries) {
      if (entry.kind === 'group') {
        for (const m of entry.members) ids.push(m.id);
      } else {
        ids.push(entry.placement.id);
      }
    }
    return ids;
  }, []);

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

  // Flat list of all visible placement IDs in display order (for Shift+click range selection).
  const flatPlacementIds = useMemo(() => {
    const ids: string[] = [];
    for (const layer of LAYER_ORDER_REVERSED) {
      if (layerCollapsed[layer]) continue;
      for (const entry of entriesByLayer[layer]) {
        if (entry.kind === 'group') {
          if (!entry.group.collapsed) {
            for (const p of entry.members) ids.push(p.id);
          }
        } else {
          ids.push(entry.placement.id);
        }
      }
    }
    return ids;
  }, [entriesByLayer, layerCollapsed]);

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
      const singlePlacement = getPlacementById?.(singleId);
      if (onEditCollision) {
        items.push({ label: 'Edit Collision…', onClick: () => onEditCollision(singleId) });
      }
      if (renderOrderApi && singlePlacement) {
        const effective = renderOrderApi.getOrder(singlePlacement);
        const assetDefault = renderOrderApi.getAssetOrder(singlePlacement.assetId);
        const orders: Array<{ value: 'auto' | 'above' | 'below'; label: string }> = [
          { value: 'auto', label: 'Auto (depth-sorted)' },
          { value: 'above', label: 'Always in front' },
          { value: 'below', label: 'Always behind' },
        ];
        for (const { value, label } of orders) {
          items.push({
            label: `${effective === value ? '●' : '○'} ${label} — this object`,
            onClick: () => renderOrderApi.setPlacementOrder(singleId, value),
          });
        }
        if (renderOrderApi.hasPlacementOverride(singleId)) {
          items.push({
            label: 'Follow type default (clear per-object override)',
            onClick: () => renderOrderApi.clearPlacementOverride(singleId),
          });
        }
        for (const { value, label } of orders) {
          items.push({
            label: `${assetDefault === value ? '●' : '○'} ${label} — all of this type`,
            onClick: () => renderOrderApi.setAssetOrder(singlePlacement.assetId, value),
          });
        }
      }
      if (sortAnchorApi && singlePlacement && onOpenSortAnchorDialog) {
        for (const item of buildSortAnchorMenuItems(
          singlePlacement,
          sortAnchorApi,
          (p, scope) => onOpenSortAnchorDialog(p.id, scope),
        )) {
          items.push(item);
        }
      }
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
  }, [selectedIds, room.layerNames, onEditCollision, renderOrderApi, sortAnchorApi, onOpenSortAnchorDialog, getPlacementById, onBringToFront, onSendToBack, onMovePlacementsToLayer, onCreateGroup, onDeletePlacements]);

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
  // NOTE: We intentionally do NOT call `setPointerCapture` on pointerdown.
  // Capturing the pointer causes the browser to retarget subsequent `click`
  // and `dblclick` events to the capturing element, which breaks the
  // double-click-to-rename handler attached to the inner `<span>`. Instead,
  // capture is taken lazily inside `handleDragPointerMove` once the drag
  // threshold has been crossed — a real drag is underway at that point, and
  // the follow-up pointerup naturally maps to a drop (not a click).
  const pendingCaptureRef = useRef<{ el: HTMLElement; pointerId: number } | null>(null);

  const handleDragPointerDown = useCallback((e: RPointerEvent<HTMLDivElement>, placementId: string) => {
    if (e.button !== 0) return;
    const ids = selectedIds.has(placementId) && selectedIds.size > 1 ? new Set(selectedIds) : new Set([placementId]);
    setDragIds(ids);
    setDragGroupId(null);
    setIsDragActive(false);
    dragStartPos.current = { x: e.clientX, y: e.clientY };
    pendingCaptureRef.current = { el: e.currentTarget as HTMLElement, pointerId: e.pointerId };
  }, [selectedIds]);

  const handleGroupDragPointerDown = useCallback((e: RPointerEvent<HTMLDivElement>, groupId: string) => {
    if (e.button !== 0) return;
    setDragGroupId(groupId);
    setDragIds(null);
    setIsDragActive(false);
    dragStartPos.current = { x: e.clientX, y: e.clientY };
    pendingCaptureRef.current = { el: e.currentTarget as HTMLElement, pointerId: e.pointerId };
  }, []);

  const handleDragPointerMove = useCallback((e: RPointerEvent<HTMLDivElement>) => {
    const hasDragIntent = dragIds || dragGroupId;
    if (!hasDragIntent) return;

    // Check if past drag threshold.
    if (!isDragActive) {
      if (!dragStartPos.current) return;
      const dx = e.clientX - dragStartPos.current.x;
      const dy = e.clientY - dragStartPos.current.y;
      if (Math.sqrt(dx * dx + dy * dy) < DRAG_THRESHOLD) return;
      setIsDragActive(true);
      // Now that a real drag has started, claim pointer capture so we still
      // receive move/up events if the pointer leaves the drag source element.
      const pending = pendingCaptureRef.current;
      if (pending) {
        try { pending.el.setPointerCapture(pending.pointerId); } catch { /* ignore */ }
        pendingCaptureRef.current = null;
      }
    }

    // Cross-layer move: dropping on a layer header.
    for (const [layer, el] of layerHeaderRefs.current.entries()) {
      const rect = el.getBoundingClientRect();
      if (e.clientY >= rect.top && e.clientY <= rect.bottom) {
        setDropTargetLayer(layer as LayerType);
        setDropTargetGroupId(null);
        setInsertIndicator(null);
        setInsertTargetId(null);
        setInsertTargetKind(null);
        return;
      }
    }
    setDropTargetLayer(null);

    // First try: pointer *inside* a group header. Group headers get three
    // zones — top (insert above group block), middle (insert into group —
    // placement drag only), bottom (insert below group block).
    for (const [gid, el] of groupHeaderRefs.current.entries()) {
      const rect = el.getBoundingClientRect();
      if (e.clientY < rect.top || e.clientY > rect.bottom) continue;
      if (dragGroupId === gid) continue; // can't drop onto itself
      const h = rect.height;
      const edgeZone = Math.max(6, h * 0.3);
      const relY = e.clientY - rect.top;
      if (relY <= edgeZone) {
        setInsertIndicator({ y: rect.top });
        setInsertTargetId(gid);
        setInsertTargetKind('group');
        setInsertAbove(true);
        setDropTargetGroupId(null);
        return;
      }
      if (relY >= h - edgeZone) {
        setInsertIndicator({ y: rect.bottom });
        setInsertTargetId(gid);
        setInsertTargetKind('group');
        setInsertAbove(false);
        setDropTargetGroupId(null);
        return;
      }
      // Middle zone: only makes sense for placement drags (add into group).
      if (dragIds) {
        setDropTargetGroupId(gid);
        setInsertIndicator(null);
        setInsertTargetId(null);
        setInsertTargetKind(null);
      } else {
        // Group drag over group body middle — fall back to above/below based on midpoint.
        const above = e.clientY < rect.top + h / 2;
        setInsertIndicator({ y: above ? rect.top : rect.bottom });
        setInsertTargetId(gid);
        setInsertTargetKind('group');
        setInsertAbove(above);
        setDropTargetGroupId(null);
      }
      return;
    }
    setDropTargetGroupId(null);

    // Pointer *inside* a placement row.
    for (const [id, el] of itemRefs.current.entries()) {
      if (dragIds && dragIds.has(id)) continue;
      const rect = el.getBoundingClientRect();
      if (e.clientY < rect.top || e.clientY > rect.bottom) continue;
      const midY = rect.top + rect.height / 2;
      const above = e.clientY < midY;
      setInsertIndicator({ y: above ? rect.top : rect.bottom });
      setInsertTargetId(id);
      setInsertTargetKind('placement');
      setInsertAbove(above);
      return;
    }

    // Not over any row: pick nearest anchor by midY (groups + placements).
    let closest: { id: string; kind: 'placement' | 'group'; above: boolean; lineY: number } | null = null;
    let minDist = Infinity;
    for (const [id, el] of itemRefs.current.entries()) {
      if (dragIds && dragIds.has(id)) continue;
      const rect = el.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      const dist = Math.abs(e.clientY - midY);
      if (dist < minDist) {
        minDist = dist;
        const above = e.clientY < midY;
        closest = { id, kind: 'placement', above, lineY: above ? rect.top : rect.bottom };
      }
    }
    for (const [gid, el] of groupHeaderRefs.current.entries()) {
      if (dragGroupId === gid) continue;
      const rect = el.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      const dist = Math.abs(e.clientY - midY);
      if (dist < minDist) {
        minDist = dist;
        const above = e.clientY < midY;
        closest = { id: gid, kind: 'group', above, lineY: above ? rect.top : rect.bottom };
      }
    }
    if (closest) {
      setInsertIndicator({ y: closest.lineY });
      setInsertTargetId(closest.id);
      setInsertTargetKind(closest.kind);
      setInsertAbove(closest.above);
    } else {
      setInsertIndicator(null);
      setInsertTargetId(null);
      setInsertTargetKind(null);
    }
  }, [dragIds, dragGroupId, isDragActive]);

  const handleDragPointerUp = useCallback((_e: RPointerEvent<HTMLDivElement>) => {
    const wasActive = isDragActive;

    const resetState = () => {
      setDragIds(null);
      setDragGroupId(null);
      setIsDragActive(false);
      dragStartPos.current = null;
      pendingCaptureRef.current = null;
      setInsertIndicator(null);
      setInsertTargetId(null);
      setInsertTargetKind(null);
      setDropTargetLayer(null);
      setDropTargetGroupId(null);
    };

    // Resolve the anchor's layer and position within the current entries list
    // for that layer. Returns null if anchor is stale.
    const resolveAnchor = (): { layer: LayerType; anchorIdx: number } | null => {
      if (!insertTargetId || !insertTargetKind) return null;
      if (insertTargetKind === 'group') {
        const g = (room.groups ?? []).find((g) => g.id === insertTargetId);
        if (!g) return null;
        const entries = entriesByLayer[g.layer];
        const idx = entries.findIndex((e) => e.kind === 'group' && e.group.id === insertTargetId);
        return idx >= 0 ? { layer: g.layer, anchorIdx: idx } : null;
      }
      const p = room.placements.find((p) => p.id === insertTargetId);
      if (!p) return null;
      const entries = entriesByLayer[p.layer];
      // If the anchor placement is a group member, its row's *parent* entry is
      // the group. We resolve to the group's entry index so the dragged item
      // slots either side of the whole group block.
      if (p.groupId) {
        const gi = entries.findIndex((e) => e.kind === 'group' && e.group.id === p.groupId);
        return gi >= 0 ? { layer: p.layer, anchorIdx: gi } : null;
      }
      const idx = entries.findIndex((e) => e.kind === 'placement' && e.placement.id === insertTargetId);
      return idx >= 0 ? { layer: p.layer, anchorIdx: idx } : null;
    };

    // ── Group drag ────────────────────────────────────────────────────────
    if (dragGroupId) {
      if (wasActive && dropTargetLayer) {
        onMoveGroupToLayer(dragGroupId, dropTargetLayer);
      } else if (wasActive) {
        const anchor = resolveAnchor();
        const dragGroup = (room.groups ?? []).find((g) => g.id === dragGroupId);
        if (anchor && dragGroup) {
          const { layer: targetLayer, anchorIdx } = anchor;
          const entries = entriesByLayer[targetLayer];

          // Build the new entries list: remove the dragged group entry (if it
          // currently lives in this layer) and re-insert at anchor position.
          const dragEntry = entries.find(
            (e) => e.kind === 'group' && e.group.id === dragGroupId,
          );
          const withoutDrag = entries.filter(
            (e) => !(e.kind === 'group' && e.group.id === dragGroupId),
          );
          // The dragged group may be in a different layer (cross-layer move).
          const members = dragEntry
            ? (dragEntry as GroupEntry).members
            : room.placements
                .filter((p) => p.groupId === dragGroupId)
                .sort((a, b) => zOf(b) - zOf(a));
          const newGroupEntry: GroupEntry = {
            kind: 'group',
            group: { ...dragGroup, layer: targetLayer },
            members,
            effectiveZ: 0,
          };
          const adjustedIdx = dragEntry
            ? (entries.indexOf(dragEntry) < anchorIdx ? anchorIdx - 1 : anchorIdx)
            : anchorIdx;
          const insertAt = insertAbove ? adjustedIdx : adjustedIdx + 1;
          withoutDrag.splice(insertAt, 0, newGroupEntry);

          if (dragGroup.layer !== targetLayer) {
            onMoveGroupToLayer(dragGroupId, targetLayer);
          }

          // Emit new groups-array ordering (for metadata) and new layer z-order.
          const newLayerGroupIds = withoutDrag
            .filter((e): e is GroupEntry => e.kind === 'group')
            .map((e) => e.group.id);
          onReorderGroups(newLayerGroupIds);
          onReorderPlacementsBulk(flattenEntriesToPlacementIds(withoutDrag));
        }
      }
      resetState();
      return;
    }

    // ── Placement drag ────────────────────────────────────────────────────
    if (!dragIds) {
      resetState();
      return;
    }

    if (wasActive && dropTargetGroupId) {
      // "Drop into group" — addPlacementsToGroup re-parents regardless of
      // previous group membership (it also syncs the layer).
      onAddPlacementsToGroup(dropTargetGroupId, [...dragIds]);
    } else if (wasActive && dropTargetLayer) {
      onMovePlacementsToLayer(dragIds, dropTargetLayer);
    } else if (wasActive) {
      const anchor = resolveAnchor();
      if (anchor) {
        const { layer: targetLayer, anchorIdx } = anchor;
        const entries = entriesByLayer[targetLayer];

        const draggedPlacements = [...dragIds]
          .map((id) => room.placements.find((p) => p.id === id))
          .filter((p): p is Placement => !!p)
          .sort((a, b) => zOf(b) - zOf(a));

        // Decide whether dragged placements should leave their current
        // group(s). Rules:
        //  - Reorder *inside the same group* only when the anchor is a
        //    placement AND every dragged placement shares that placement's
        //    groupId (so it's clearly "sort within this group"). In that
        //    case we keep the membership.
        //  - Any other drop (above/below a group header, above/below an
        //    ungrouped placement, above/below a placement in a different
        //    group) => dragged placements leave their current group and
        //    become standalone items at the new position.
        let shouldUngroup = true;
        if (insertTargetKind === 'placement') {
          const anchorP = room.placements.find((p) => p.id === insertTargetId);
          if (
            anchorP &&
            anchorP.groupId &&
            draggedPlacements.every((p) => p.groupId === anchorP.groupId)
          ) {
            shouldUngroup = false;
          }
        }

        // Cross-layer move (clears groupId + zIndex as a side effect).
        const needsLayerMove = draggedPlacements.some((p) => p.layer !== targetLayer);

        // Perform membership / layer changes before the bulk reorder so
        // reorderPlacementsBulk works against an up-to-date placement set.
        if (needsLayerMove) {
          onMovePlacementsToLayer(dragIds, targetLayer);
        } else if (shouldUngroup) {
          const toUngroup = draggedPlacements
            .filter((p) => p.groupId !== undefined)
            .map((p) => p.id);
          if (toUngroup.length > 0) {
            onRemovePlacementsFromGroup(toUngroup);
          }
        }

        // Build the new entries list. In the "reorder inside the same group"
        // path we just rearrange group members (zIndex only; no top-level
        // entry changes) and fall through via the flattener. In all other
        // cases, dragged items become top-level placement entries.
        const dragSet = dragIds;

        let withoutDrag: PanelEntry[];
        let insertAt: number;
        let draggedEntries: PlaceEntry[];

        if (!shouldUngroup && insertTargetKind === 'placement') {
          // Same-group reorder: operate only on the group's member ordering,
          // keep top-level entry list untouched.
          const anchorP = room.placements.find((p) => p.id === insertTargetId);
          if (!anchorP || !anchorP.groupId) {
            resetState();
            return;
          }
          const groupId = anchorP.groupId;
          const groupEntryIdx = entries.findIndex(
            (e) => e.kind === 'group' && e.group.id === groupId,
          );
          if (groupEntryIdx < 0) {
            resetState();
            return;
          }
          const groupEntry = entries[groupEntryIdx] as GroupEntry;
          const membersSansDrag = groupEntry.members.filter((m) => !dragSet.has(m.id));
          const anchorMemberIdx = membersSansDrag.findIndex((m) => m.id === insertTargetId);
          const insertMemberAt = insertAbove ? anchorMemberIdx : anchorMemberIdx + 1;
          const newMembers = [...membersSansDrag];
          newMembers.splice(
            insertMemberAt < 0 ? newMembers.length : insertMemberAt,
            0,
            ...draggedPlacements,
          );
          const newGroupEntry: GroupEntry = { ...groupEntry, members: newMembers };
          const newEntries = entries.slice();
          newEntries[groupEntryIdx] = newGroupEntry;
          onReorderPlacementsBulk(flattenEntriesToPlacementIds(newEntries));
          resetState();
          return;
        }

        // Otherwise: dragged placements become top-level entries at the
        // anchor position. Build a fresh entries list where:
        //  - dragged placements are removed from any group they were part of
        //    (so group entries still exist but with reduced members), and
        //  - dragged placements are inserted as standalone placement entries.
        withoutDrag = entries.map((e) => {
          if (e.kind === 'group') {
            const filtered = e.members.filter((m) => !dragSet.has(m.id));
            if (filtered.length === e.members.length) return e;
            return { ...e, members: filtered };
          }
          return e;
        }).filter((e) => !(e.kind === 'placement' && dragSet.has(e.placement.id)));

        draggedEntries = draggedPlacements.map((p) => ({
          kind: 'placement',
          placement: p,
          effectiveZ: 0,
        }));

        // Adjust anchor index for any top-level dragged placements removed
        // before it.
        const removedTopLevelBefore = entries
          .slice(0, anchorIdx)
          .filter(
            (e) => e.kind === 'placement' && dragSet.has((e as PlaceEntry).placement.id),
          ).length;
        const adjustedIdx = anchorIdx - removedTopLevelBefore;
        insertAt = insertAbove ? adjustedIdx : adjustedIdx + 1;
        withoutDrag.splice(insertAt, 0, ...draggedEntries);

        onReorderPlacementsBulk(flattenEntriesToPlacementIds(withoutDrag));
      }
    }

    resetState();
  }, [
    dragIds, dragGroupId, isDragActive, dropTargetLayer, dropTargetGroupId,
    insertTargetId, insertTargetKind, insertAbove,
    room.placements, room.groups, entriesByLayer, flattenEntriesToPlacementIds, zOf,
    onMovePlacementsToLayer, onReorderPlacementsBulk, onMoveGroupToLayer,
    onReorderGroups, onAddPlacementsToGroup, onRemovePlacementsFromGroup,
  ]);

  // ── Panel resize handlers ──────────────────────────────────────────────
  const handleResizeStart = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsResizing(true);
    resizeStartRef.current = { startX: e.clientX, startWidth: panelWidth };
    document.body.style.cursor = 'ew-resize';
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, [panelWidth]);

  const handleResizeMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!isResizing || !resizeStartRef.current) return;
    const dx = e.clientX - resizeStartRef.current.startX;
    const newWidth = Math.max(180, Math.min(600, resizeStartRef.current.startWidth + dx));
    setPanelWidth(newWidth);
  }, [isResizing]);

  const handleResizeEnd = useCallback((_e: React.PointerEvent<HTMLDivElement>) => {
    setIsResizing(false);
    resizeStartRef.current = null;
    document.body.style.cursor = '';
  }, []);

  // Horizontal scroll with trackpad
  const handleWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    if (!scrollRef.current) return;
    const { deltaX, deltaY } = e;
    if (Math.abs(deltaX) > Math.abs(deltaY)) {
      e.preventDefault();
      scrollRef.current.scrollLeft += deltaX;
    }
  }, []);

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
            ...(isDraggingGroup ? { ...styles.placementItemDragging, ...styles.groupHeaderDragging } : {}),
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
              style={{ ...styles.groupName, cursor: 'text', ...(isGroupSelected ? { color: 'var(--accent)' } : {}) }}
              title="Double-click to rename"
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
      style={{ ...styles.container, width: panelWidth, minWidth: panelWidth }}
      onPointerMove={handleDragPointerMove}
      onPointerUp={handleDragPointerUp}
      onWheel={handleWheel}
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
          const entries = entriesByLayer[layer];
          const layerName = (room.layerNames ?? {})[layer] ?? layer.charAt(0).toUpperCase() + layer.slice(1);
          const totalCount = entries.reduce(
            (s, e) => s + (e.kind === 'group' ? e.members.length : 1),
            0,
          );
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
                  {entries.map((entry) => {
                    if (entry.kind === 'group') {
                      return renderGroup(entry.group, entry.members, layer);
                    }
                    return renderPlacement(entry.placement, layer);
                  })}
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

      {/* Resize handle */}
      <div
        style={styles.resizeHandle}
        onPointerDown={handleResizeStart}
        onPointerMove={isResizing ? handleResizeMove : undefined}
        onPointerUp={isResizing ? handleResizeEnd : undefined}
      />

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
    background: 'var(--bg-secondary)',
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
  scrollArea: { 
    flex: 1, 
    overflowY: 'auto', 
    overflowX: 'auto',
    minWidth: 0,
  },
  resizeHandle: {
    position: 'absolute',
    top: 0,
    right: -3,
    width: 6,
    height: '100%',
    cursor: 'ew-resize',
    background: 'transparent',
    zIndex: 10,
  },

  layerGroup: { borderBottom: '1px solid var(--border)' },
  layerHeader: {
    display: 'flex', alignItems: 'center', gap: 4, padding: '6px 8px',
    cursor: 'pointer', background: 'var(--bg-surface)', fontSize: 12,
    minWidth: 'fit-content',
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
    flex: 1, fontWeight: 500, color: 'var(--text-primary)',
    whiteSpace: 'nowrap', minWidth: 0,
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
    cursor: 'grab', fontSize: 11, background: 'var(--bg-primary)',
    borderTop: '1px solid var(--border)', touchAction: 'none',
    minWidth: 'fit-content',
  },
  groupHeaderDragging: {
    cursor: 'grabbing',
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
    flex: 1, fontWeight: 500, color: 'var(--text-secondary)',
    whiteSpace: 'nowrap', fontStyle: 'italic', minWidth: 0,
  },

  itemList: { padding: '1px 0' },
  placementItem: {
    display: 'flex', alignItems: 'center', padding: '3px 8px 3px 32px',
    cursor: 'pointer', fontSize: 11, color: 'var(--text-secondary)',
    touchAction: 'none', minWidth: 'fit-content',
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
    whiteSpace: 'nowrap', flex: 1, minWidth: 0,
  },
};
