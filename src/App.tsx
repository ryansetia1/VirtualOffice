import { useState, useCallback, useEffect, useRef } from 'react';
import { useGrid, createDefaultRoom } from './hooks/useGrid';
import { useTool } from './hooks/useTool';
import { useAssetCategories } from './hooks/useAssetCategories';
import { useCustomAssets } from './hooks/useCustomAssets';
import { useAgents } from './hooks/useAgents';
import { useBlockingOverrides } from './hooks/useBlockingOverrides';
import { preloadAllAssets } from './utils/imageLoader';
import {
  preloadAllCharacters,
  CHAR_COUNT,
  CHAR_FRAME_W,
  CHAR_FRAME_H,
  FACING_ROW,
  getCachedCharacter,
} from './utils/characterImageLoader';
import type { Facing } from './utils/characterImageLoader';
import { canAgentStandAt, findNearestWalkable, resolveAgentMove } from './utils/agentCollision';
import { saveRoom, loadRoom } from './utils/roomStorage';
import { exportProject, importProject } from './utils/projectFile';
import { deleteAgentFolder } from './utils/agentFolders';
import { isTauri } from './utils/tauri';
import GridCanvas from './components/GridCanvas';
import AssetPalette from './components/AssetPalette';
import Toolbar from './components/Toolbar';
import AssetManager from './components/AssetManager';
import LayersPanel from './components/LayersPanel';
import DragOverlay from './components/DragOverlay';
import LiveHeader from './components/LiveHeader';
import AddAgentModal from './components/AddAgentModal';
import ContextMenu, { type MenuItem } from './components/ContextMenu';
import TerminalPanel, { FloatingTerminalWindow, TerminalView } from './components/TerminalPanel';

type AppTab = 'live' | 'build' | 'assets';

function loadInitialRoom() {
  const saved = loadRoom();
  if (!saved) return createDefaultRoom();
  return {
    ...saved,
    groups: saved.groups ?? [],
    layerVisibility: saved.layerVisibility ?? { floor: true, wall: true, object: true },
    layerLocked: saved.layerLocked ?? { floor: false, wall: false, object: false },
    layerNames: saved.layerNames ?? { floor: 'Floor', wall: 'Wall', object: 'Object' },
  };
}

const EMPTY_SET = new Set<string>();

export default function App() {
  const [loading, setLoading] = useState(true);
  const [loadProgress, setLoadProgress] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [liveZoom, setLiveZoom] = useState(1);
  const [activeTab, setActiveTab] = useState<AppTab>('build');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(EMPTY_SET);
  const [hoveredIds, setHoveredIds] = useState<Set<string>>(EMPTY_SET);
  const [layersPanelCollapsed, setLayersPanelCollapsed] = useState(false);
  const [addAgentModal, setAddAgentModal] = useState<{ adoptFolder: string | null } | null>(null);
  const [orphanRefreshKey, setOrphanRefreshKey] = useState(0);
  const [agentCtx, setAgentCtx] = useState<{ id: string; x: number; y: number } | null>(null);
  const [renameDialog, setRenameDialog] = useState<{ id: string; value: string } | null>(null);
  const [spriteDialog, setSpriteDialog] = useState<{ id: string } | null>(null);
  const [removeDialog, setRemoveDialog] = useState<{ id: string } | null>(null);
  const [openTerminalIds, setOpenTerminalIds] = useState<string[]>([]);
  // IDs in this set are shown as independent floating windows; the rest go into the docked panel.
  const [floatingTerminalIds, setFloatingTerminalIds] = useState<Set<string>>(new Set());
  // Hidden terminals stay mounted (PTY alive) but are invisible. Double-clicking the agent un-hides.
  const [hiddenTerminalIds, setHiddenTerminalIds] = useState<Set<string>>(new Set());
  const [activeDockedTerminalId, setActiveDockedTerminalId] = useState<string | null>(null);
  // Track which floating window was last clicked so it renders on top.
  const [focusedTerminalId, setFocusedTerminalId] = useState<string | null>(null);
  // Slots are chrome-owned DOM nodes that host xterm. Kept in state so
  // `<TerminalView>` re-renders with the right `target` when chrome mounts.
  const [dockedSlot, setDockedSlot] = useState<HTMLDivElement | null>(null);
  const [floatingSlots, setFloatingSlots] = useState<Map<string, HTMLDivElement>>(new Map());
  const setFloatingSlotEl = useCallback((id: string, el: HTMLDivElement | null) => {
    setFloatingSlots((prev) => {
      const existing = prev.get(id) ?? null;
      if (existing === el) return prev;
      const next = new Map(prev);
      if (el) next.set(id, el); else next.delete(id);
      return next;
    });
  }, []);

  const openAgentTerminal = useCallback((agentId: string) => {
    if (!isTauri()) {
      window.alert('Terminals require the desktop app. Run "npm run tauri:dev".');
      return;
    }
    setOpenTerminalIds((prev) => {
      if (prev.includes(agentId)) {
        // Already open — keep its docked/floating state, just un-hide it.
        return prev;
      }
      // First open → start as a floating window.
      setFloatingTerminalIds((f) => new Set([...f, agentId]));
      return [...prev, agentId];
    });
    setHiddenTerminalIds((prev) => { const n = new Set(prev); n.delete(agentId); return n; });
    setFocusedTerminalId(agentId);
  }, []);

  const closeAgentTerminal = useCallback((agentId: string) => {
    setOpenTerminalIds((prev) => prev.filter((id) => id !== agentId));
    setFloatingTerminalIds((prev) => { const n = new Set(prev); n.delete(agentId); return n; });
    setHiddenTerminalIds((prev) => { const n = new Set(prev); n.delete(agentId); return n; });
    setActiveDockedTerminalId((cur) => cur === agentId ? null : cur);
    setFocusedTerminalId((cur) => cur === agentId ? null : cur);
  }, []);

  const hideTerminal = useCallback((id: string) => {
    setHiddenTerminalIds((prev) => new Set([...prev, id]));
  }, []);

  const floatTerminal = useCallback((id: string) => {
    setFloatingTerminalIds((prev) => new Set([...prev, id]));
    setHiddenTerminalIds((prev) => { const n = new Set(prev); n.delete(id); return n; });
    setFocusedTerminalId(id);
  }, []);

  const dockTerminal = useCallback((id: string) => {
    setFloatingTerminalIds((prev) => { const n = new Set(prev); n.delete(id); return n; });
    setHiddenTerminalIds((prev) => { const n = new Set(prev); n.delete(id); return n; });
    setActiveDockedTerminalId(id);
  }, []);

  const [initialRoom] = useState(loadInitialRoom);
  const {
    room, version, canUndo, canRedo, undo, redo, beginUndoBatch, endUndoBatch,
    addPlacement, removePlacementAt, removePlacementById, removePlacementsByIds, getPlacementAt,
    clearAll, resize, loadState,
    toggleLayerVisibility, toggleLayerLock, renameLayer,
    bringToFront, sendToBack, movePlacementToLayer, movePlacementsToLayer, reorderPlacement, reorderPlacementsBulk,
    createGroup, duplicateGroup, ungroupPlacements, deleteGroup, renameGroup,
    toggleGroupVisibility, toggleGroupLock, toggleGroupCollapsed, reorderGroups, moveGroupToLayer, addPlacementsToGroup,
    bulkMovePlacements, bulkDuplicatePlacements,
  } = useGrid(initialRoom);
  const { toolState, setMode, setDrawSubTool, setTool, setActiveLayer, selectAsset, rotateAsset, flipHAsset, flipVAsset, resetTransform } = useTool();
  const agentsApi = useAgents();
  const blockingApi = useBlockingOverrides();
  const { customAssets, customAssetInfos, addCustomAssets, removeCustomAsset } = useCustomAssets();
  const customAssetIds = customAssets.map((a) => a.id);
  const {
    library, categoryTree, uncategorizedIds, tileOverrides,
    setRootLabel,
    createCategory, renameCategory, deleteCategory, moveAssets, uncategorizeAssets,
    getAssetDisplayName, getCategoryForAsset, resolveAssetUrl, renameAsset, clearAssetName, batchRenameAssets,
    setTileOverride, clearTileOverride,
  } = useAssetCategories(customAssetIds);

  // Keep a stable ref of the resolver so the one-shot preloader hits the
  // current on-disk location without re-running when categories change.
  const resolveAssetUrlRef = useRef(resolveAssetUrl);
  resolveAssetUrlRef.current = resolveAssetUrl;

  useEffect(() => {
    const assetTotal = 340;
    const totalAll = assetTotal + CHAR_COUNT;
    let assetLoaded = 0;
    let charLoaded = 0;
    const update = () => {
      setLoadProgress(Math.round(((assetLoaded + charLoaded) / totalAll) * 100));
    };
    (async () => {
      await preloadAllAssets(
        (loaded) => { assetLoaded = loaded; update(); },
        (id) => resolveAssetUrlRef.current(id),
      );
      await preloadAllCharacters((loaded) => { charLoaded = loaded; update(); });
      setLoading(false);
    })();
  }, []);

  const isFirstRender = useRef(true);
  useEffect(() => {
    if (isFirstRender.current) { isFirstRender.current = false; return; }
    saveRoom(room);
  }, [room]);

  const handleExport = useCallback(() => {
    saveRoom(room);
    exportProject();
  }, [room]);

  const handleImport = useCallback(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        await importProject(file);
        window.location.reload();
      } catch (err) {
        window.alert(err instanceof Error ? err.message : 'Import failed.');
      }
    };
    input.click();
  }, []);

  const handleClear = useCallback(() => {
    if (window.confirm('Clear the entire room?')) {
      clearAll();
    }
  }, [clearAll]);

  const handleDeletePlacements = useCallback((ids: Set<string>) => {
    removePlacementsByIds(ids);
    setSelectedIds(EMPTY_SET);
  }, [removePlacementsByIds]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;

      if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'z' && e.shiftKey) {
        e.preventDefault();
        redo();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'y') {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [undo, redo]);

  // Snap trapped agents to nearest walkable cell when they become active
  // (e.g., if the room was edited while the agent was off-screen).
  const snapGuardRef = useRef(false);
  useEffect(() => {
    if (snapGuardRef.current) return;
    if (activeTab !== 'live') return;
    const id = agentsApi.activeAgentId;
    if (!id) return;
    const a = agentsApi.agents.find((ag) => ag.id === id);
    if (!a) return;
    const ar = Math.round(a.row);
    const ac = Math.round(a.col);
    if (!canAgentStandAt(a.row, a.col, room, blockingApi.overrides)) {
      const spot = findNearestWalkable(ar, ac, room, blockingApi.overrides);
      if (spot) {
        snapGuardRef.current = true;
        agentsApi.moveAgent(id, spot.row, spot.col, a.facing, 1);
        window.setTimeout(() => { snapGuardRef.current = false; }, 200);
      }
    }
  }, [activeTab, agentsApi, room, blockingApi.overrides]);

  // ── Agent WASD movement loop (live tab only) ─────────────────────────────
  const roomRef = useRef(room);
  roomRef.current = room;
  const agentsApiRef = useRef(agentsApi);
  agentsApiRef.current = agentsApi;
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;
  const blockingRef = useRef(blockingApi.overrides);
  blockingRef.current = blockingApi.overrides;

  const heldKeysRef = useRef<Set<string>>(new Set());
  const rafRef = useRef<number | null>(null);
  const lastFrameRef = useRef<number>(0);
  const animClockRef = useRef<number>(0);

  const AGENT_SPEED = 4; // cells per second

  useEffect(() => {
    const startLoop = () => {
      if (rafRef.current !== null) return;
      lastFrameRef.current = performance.now();
      const loop = (now: number) => {
        const dt = Math.min(0.1, (now - lastFrameRef.current) / 1000);
        lastFrameRef.current = now;

        const held = heldKeysRef.current;
        const api = agentsApiRef.current;
        if (activeTabRef.current !== 'live' || !api.activeAgentId || held.size === 0) {
          rafRef.current = null;
          // Reset anim frame to idle when stopped
          if (api.activeAgentId) {
            const a = api.agents.find((ag) => ag.id === api.activeAgentId);
            if (a && a.animFrame !== 1) api.setAnimFrame(a.id, 1);
          }
          return;
        }

        const active = api.agents.find((a) => a.id === api.activeAgentId);
        if (!active) {
          rafRef.current = null;
          return;
        }

        let dx = 0;
        let dy = 0;
        if (held.has('w')) dy -= 1;
        if (held.has('s')) dy += 1;
        if (held.has('a')) dx -= 1;
        if (held.has('d')) dx += 1;

        if (dx === 0 && dy === 0) {
          if (active.animFrame !== 1) api.setAnimFrame(active.id, 1);
          rafRef.current = requestAnimationFrame(loop);
          return;
        }

        const len = Math.hypot(dx, dy) || 1;
        const stepX = (dx / len) * AGENT_SPEED * dt;
        const stepY = (dy / len) * AGENT_SPEED * dt;

        const next = resolveAgentMove(active.row, active.col, stepY, stepX, roomRef.current, blockingRef.current);

        // Facing based on dominant axis of requested movement
        let facing: Facing = active.facing;
        if (Math.abs(dx) > Math.abs(dy)) {
          facing = dx > 0 ? 'right' : 'left';
        } else if (dy !== 0) {
          facing = dy > 0 ? 'down' : 'up';
        }

        // Walk cycle: 0 → 1 → 2 → 1, driven by distance traveled
        const moved = Math.hypot(next.row - active.row, next.col - active.col) > 1e-4;
        let animFrame: 0 | 1 | 2 = active.animFrame;
        if (moved) {
          animClockRef.current += dt;
          const cyclePos = Math.floor((animClockRef.current * 6) % 4); // 0..3 @ 6 Hz
          animFrame = (cyclePos === 0 ? 0 : cyclePos === 2 ? 2 : 1) as 0 | 1 | 2;
        } else {
          animFrame = 1;
        }

        api.moveAgent(active.id, next.row, next.col, facing, animFrame);

        rafRef.current = requestAnimationFrame(loop);
      };
      rafRef.current = requestAnimationFrame(loop);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (activeTabRef.current !== 'live') return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key !== 'w' && key !== 'a' && key !== 's' && key !== 'd') return;
      if (!agentsApiRef.current.activeAgentId) return;
      e.preventDefault();
      heldKeysRef.current.add(key);
      startLoop();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      if (key === 'w' || key === 'a' || key === 's' || key === 'd') {
        heldKeysRef.current.delete(key);
      }
    };
    const onBlur = () => {
      heldKeysRef.current.clear();
    };
    const onVisibility = () => {
      if (document.hidden) heldKeysRef.current.clear();
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVisibility);
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, []);

  if (loading) {
    return (
      <div style={styles.loadingScreen}>
        <div style={styles.loadingContent}>
          <h1 style={styles.loadingTitle}>Virtual Office</h1>
          <p style={styles.loadingSubtitle}>Loading assets…</p>
          <div style={styles.progressBarOuter}>
            <div style={{ ...styles.progressBarInner, width: `${loadProgress}%` }} />
          </div>
          <span style={styles.progressText}>{loadProgress}%</span>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.app}>
      <div style={styles.tabBar}>
        <div style={styles.tabBarLeft}>
          <span style={styles.appTitle}>Virtual Office</span>
          <div style={styles.tabs}>
            {(['live', 'build', 'assets'] as AppTab[]).map((tab) => (
              <button
                key={tab}
                className={`app-tab${activeTab === tab ? ' active' : ''}`}
                onClick={(e) => { setActiveTab(tab); (e.currentTarget as HTMLElement).blur(); }}
              >
                {tab.charAt(0).toUpperCase() + tab.slice(1)}
              </button>
            ))}
          </div>
        </div>
      </div>

      {activeTab === 'live' && (
        <div style={styles.liveWrap}>
          <LiveHeader
            agents={agentsApi.agents}
            activeAgentId={agentsApi.activeAgentId}
            onAddAgent={() => setAddAgentModal({ adoptFolder: null })}
            onAdoptFolder={(folderName) => setAddAgentModal({ adoptFolder: folderName })}
            onActivate={agentsApi.setActive}
            refreshKey={orphanRefreshKey}
          />
          <div style={styles.body}>
            <GridCanvas
              room={room}
              version={version}
              toolState={toolState}
              zoom={liveZoom}
              tileOverrides={tileOverrides}
              customAssets={customAssets}
              readOnly
              onZoomChange={setLiveZoom}
              agents={agentsApi.agents}
              activeAgentId={agentsApi.activeAgentId}
              onActivateAgent={agentsApi.setActive}
              onOpenAgentTerminal={openAgentTerminal}
              onAgentContextMenu={(id, x, y) => setAgentCtx({ id, x, y })}
            />
          </div>
        </div>
      )}

      {activeTab === 'build' && (
        <>
          <Toolbar
            gridWidth={room.width}
            gridHeight={room.height}
            activeLayer={toolState.activeLayer}
            activeTool={toolState.tool}
            activeMode={toolState.mode}
            activeDrawSubTool={toolState.drawSubTool}
            rotation={toolState.rotation}
            flipH={toolState.flipH}
            flipV={toolState.flipV}
            canUndo={canUndo}
            canRedo={canRedo}
            onResize={resize}
            onToolChange={setTool}
            onModeChange={setMode}
            onDrawSubToolChange={setDrawSubTool}
            onRotate={rotateAsset}
            onFlipH={flipHAsset}
            onFlipV={flipVAsset}
            onResetTransform={resetTransform}
            onUndo={undo}
            onRedo={redo}
            onExport={handleExport}
            onImport={handleImport}
            onClear={handleClear}
          />
          <div style={styles.body}>
            <LayersPanel
              room={room}
              activeLayer={toolState.activeLayer}
              selectedIds={selectedIds}
              collapsed={layersPanelCollapsed}
              getAssetDisplayName={getAssetDisplayName}
              onSelectLayer={setActiveLayer}
              onSetSelectedIds={setSelectedIds}
              onHoverIds={setHoveredIds}
              onToggleVisibility={toggleLayerVisibility}
              onToggleLock={toggleLayerLock}
              onRenameLayer={renameLayer}
              onBringToFront={bringToFront}
              onSendToBack={sendToBack}
              onMovePlacementsToLayer={movePlacementsToLayer}
              onDeletePlacements={handleDeletePlacements}
              onReorderPlacement={reorderPlacement}
              onReorderPlacementsBulk={reorderPlacementsBulk}
              onCreateGroup={createGroup}
              onDuplicateGroup={duplicateGroup}
              onUngroupPlacements={ungroupPlacements}
              onDeleteGroup={deleteGroup}
              onRenameGroup={renameGroup}
              onToggleGroupVisibility={toggleGroupVisibility}
              onToggleGroupLock={toggleGroupLock}
              onToggleGroupCollapsed={toggleGroupCollapsed}
              onMoveGroupToLayer={moveGroupToLayer}
              onReorderGroups={reorderGroups}
              onAddPlacementsToGroup={addPlacementsToGroup}
              onModeChange={setMode}
              onToggleCollapsed={() => setLayersPanelCollapsed((v) => !v)}
            />
            <GridCanvas
              room={room}
              version={version}
              toolState={toolState}
              zoom={zoom}
              tileOverrides={tileOverrides}
              customAssets={customAssets}
              selectedPlacementIds={selectedIds}
              hoveredPlacementIds={hoveredIds}
              onAddPlacement={addPlacement}
              onRemovePlacementAt={removePlacementAt}
              onRemovePlacementById={removePlacementById}
              getPlacementAt={getPlacementAt}
              onBeginUndoBatch={beginUndoBatch}
              onEndUndoBatch={endUndoBatch}
              onSetSelectedIds={setSelectedIds}
              onDeletePlacements={handleDeletePlacements}
              onBulkMovePlacements={bulkMovePlacements}
              onBulkDuplicatePlacements={bulkDuplicatePlacements}
              onDuplicateGroup={duplicateGroup}
              onModeChange={setMode}
              onZoomChange={setZoom}
              onRotate={rotateAsset}
              onFlipH={flipHAsset}
              onFlipV={flipVAsset}
            />
            <AssetPalette
              selectedAssetId={toolState.selectedAssetId}
              categoryTree={categoryTree}
              uncategorizedIds={uncategorizedIds}
              tileOverrides={tileOverrides}
              customAssetInfos={customAssetInfos}
              getAssetDisplayName={getAssetDisplayName}
              getCategoryForAsset={getCategoryForAsset}
              resolveAssetUrl={resolveAssetUrl}
              onSelectAsset={selectAsset}
              onAutoLayer={setActiveLayer}
              onSetTileOverride={setTileOverride}
              onClearTileOverride={clearTileOverride}
              activeLayer={toolState.activeLayer}
              blockingOverrides={blockingApi.overrides}
              onSetBlocking={blockingApi.setBlocking}
              onClearBlocking={blockingApi.clearBlocking}
            />
          </div>
        </>
      )}

      {activeTab === 'assets' && (
        <AssetManager
          library={library}
          categoryTree={categoryTree}
          uncategorizedIds={uncategorizedIds}
          tileOverrides={tileOverrides}
          customAssets={customAssets}
          customAssetInfos={customAssetInfos}
          resolveAssetUrl={resolveAssetUrl}
          onSetRootLabel={setRootLabel}
          onCreateCategory={createCategory}
          onRenameCategory={renameCategory}
          onDeleteCategory={deleteCategory}
          onMoveAssets={moveAssets}
          onUncategorizeAssets={uncategorizeAssets}
          getAssetDisplayName={getAssetDisplayName}
          onRenameAsset={renameAsset}
          onClearAssetName={clearAssetName}
          onBatchRename={batchRenameAssets}
          onSetTileOverride={setTileOverride}
          onClearTileOverride={clearTileOverride}
          onAddCustomAssets={addCustomAssets}
          onRemoveCustomAsset={removeCustomAsset}
          blockingOverrides={blockingApi.overrides}
          onSetBlocking={blockingApi.setBlocking}
          onClearBlocking={blockingApi.clearBlocking}
        />
      )}
      <DragOverlay tileOverrides={tileOverrides} />

      {(() => {
        const openTerminals = openTerminalIds
          .map((id) => {
            const agent = agentsApi.agents.find((a) => a.id === id);
            return agent ? { id, agent } : null;
          })
          .filter((t): t is { id: string; agent: typeof agentsApi.agents[number] } => t !== null);
        if (openTerminals.length === 0) return null;

        const dockedTerminals = openTerminals.filter((t) => !floatingTerminalIds.has(t.id));
        const floatingTerminals = openTerminals.filter((t) => floatingTerminalIds.has(t.id));

        // Which docked terminal is *currently visible* in the docked slot.
        const visibleDocked = dockedTerminals.filter((t) => !hiddenTerminalIds.has(t.id));
        const activeDockedId =
          activeDockedTerminalId && visibleDocked.some((t) => t.id === activeDockedTerminalId)
            ? activeDockedTerminalId
            : visibleDocked.length > 0 ? visibleDocked[visibleDocked.length - 1].id : null;

        // Stagger initial positions so windows don't perfectly overlap
        const stagger = (i: number) => ({
          x: Math.max(20, Math.min(window.innerWidth  - 740, (window.innerWidth  - 720) / 2 + (i % 5) * 28)),
          y: Math.max(20, Math.min(window.innerHeight - 440, (window.innerHeight - 420) / 2 + (i % 5) * 28)),
        });

        // Focused window renders on top; others share the base z-index
        const zFor = (id: string, i: number) => id === focusedTerminalId ? 602 : 600 + (i % 2);

        // Compute the current DOM host for each terminal. Null = park offscreen.
        const targetFor = (id: string): HTMLElement | null => {
          if (hiddenTerminalIds.has(id)) return null;
          if (floatingTerminalIds.has(id)) return floatingSlots.get(id) ?? null;
          return id === activeDockedId ? dockedSlot : null;
        };
        const isActive = (id: string): boolean => {
          if (hiddenTerminalIds.has(id)) return false;
          if (floatingTerminalIds.has(id)) return true;
          return id === activeDockedId;
        };

        return (
          <>
            {/* Chrome: docked panel stays mounted whenever there's any docked
                terminal (even if hidden) so its slot ref stays registered. */}
            {dockedTerminals.length > 0 && (
              <TerminalPanel
                terminals={dockedTerminals}
                hiddenIds={hiddenTerminalIds}
                activeId={activeDockedId}
                onSetActive={setActiveDockedTerminalId}
                onHide={hideTerminal}
                onFloat={floatTerminal}
                setSlotEl={setDockedSlot}
              />
            )}
            {/* Chrome: every floating window stays mounted (hidden via CSS
                when `hidden` is true) so its slot stays registered. */}
            {floatingTerminals.map((t, i) => (
              <FloatingTerminalWindow
                key={t.id}
                terminal={t}
                hidden={hiddenTerminalIds.has(t.id)}
                zIndex={zFor(t.id, i)}
                initialPos={stagger(openTerminalIds.indexOf(t.id))}
                onHide={hideTerminal}
                onDock={dockTerminal}
                onFocus={setFocusedTerminalId}
                setSlotEl={setFloatingSlotEl}
              />
            ))}
            {/* Stable TerminalView list — one per open terminal. These never
                unmount on dock ↔ float transitions; only `target` changes, so
                xterm is reparented in the DOM without React remounting. */}
            {openTerminals.map((t) => (
              <TerminalView
                key={t.id}
                agent={t.agent}
                target={targetFor(t.id)}
                active={isActive(t.id)}
                onAutoClose={() => closeAgentTerminal(t.id)}
              />
            ))}
          </>
        );
      })()}

      {addAgentModal && (
        <AddAgentModal
          adoptFolder={addAgentModal.adoptFolder}
          usedSpriteIds={agentsApi.agents.map((a) => a.spriteId)}
          existingFolderNames={agentsApi.agents.map((a) => a.folderName)}
          onClose={() => setAddAgentModal(null)}
          onCreated={({ nickname, folderName, spriteId }) => {
            const cx = Math.floor(room.width / 2);
            const cy = Math.floor(room.height / 2);
            const spot = findNearestWalkable(cy, cx, room, blockingApi.overrides) ?? { row: cy, col: cx };
            agentsApi.addAgent({
              nickname,
              folderName,
              spriteId,
              row: spot.row,
              col: spot.col,
            });
            setAddAgentModal(null);
            setOrphanRefreshKey((k) => k + 1);
          }}
        />
      )}

      {agentCtx && (() => {
        const agent = agentsApi.agents.find((a) => a.id === agentCtx.id);
        if (!agent) return null;
        const items: MenuItem[] = [
          {
            label: 'Open Terminal',
            onClick: () => openAgentTerminal(agent.id),
          },
          {
            label: 'Rename nickname…',
            onClick: () => setRenameDialog({ id: agent.id, value: agent.nickname }),
          },
          {
            label: 'Change sprite…',
            onClick: () => setSpriteDialog({ id: agent.id }),
          },
          {
            label: 'Remove agent…',
            danger: true,
            onClick: () => setRemoveDialog({ id: agent.id }),
          },
        ];
        return (
          <ContextMenu
            x={agentCtx.x}
            y={agentCtx.y}
            items={items}
            onClose={() => setAgentCtx(null)}
          />
        );
      })()}

      {renameDialog && (() => {
        const agent = agentsApi.agents.find((a) => a.id === renameDialog.id);
        if (!agent) return null;
        const submit = () => {
          const v = renameDialog.value.trim();
          if (v.length === 0 || v.length > 20) return;
          agentsApi.renameAgent(agent.id, v);
          setRenameDialog(null);
        };
        return (
          <div style={dialogStyles.backdrop} onClick={() => setRenameDialog(null)}>
            <div style={dialogStyles.modal} onClick={(e) => e.stopPropagation()}>
              <h3 style={dialogStyles.title}>Rename agent</h3>
              <p style={dialogStyles.subtitle}>Folder <code>{agent.folderName}</code> will not change.</p>
              <input
                autoFocus
                style={dialogStyles.input}
                value={renameDialog.value}
                maxLength={20}
                onChange={(e) => setRenameDialog({ id: renameDialog.id, value: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submit();
                  if (e.key === 'Escape') setRenameDialog(null);
                }}
              />
              <div style={dialogStyles.actions}>
                <button style={dialogStyles.btnSecondary} onClick={() => setRenameDialog(null)}>Cancel</button>
                <button style={dialogStyles.btnPrimary} onClick={submit}>Save</button>
              </div>
            </div>
          </div>
        );
      })()}

      {spriteDialog && (() => {
        const agent = agentsApi.agents.find((a) => a.id === spriteDialog.id);
        if (!agent) return null;
        return (
          <div style={dialogStyles.backdrop} onClick={() => setSpriteDialog(null)}>
            <div style={{ ...dialogStyles.modal, width: 480 }} onClick={(e) => e.stopPropagation()}>
              <h3 style={dialogStyles.title}>Change sprite</h3>
              <div style={dialogStyles.spriteGrid}>
                {Array.from({ length: CHAR_COUNT }, (_, i) => i).map((id) => (
                  <button
                    key={id}
                    type="button"
                    style={{
                      ...dialogStyles.spriteTile,
                      ...(agent.spriteId === id ? dialogStyles.spriteTileSelected : {}),
                    }}
                    onClick={() => {
                      agentsApi.setSpriteId(agent.id, id);
                      setSpriteDialog(null);
                    }}
                    title={`Sprite ${id}`}
                  >
                    <SpriteTilePreview spriteId={id} />
                  </button>
                ))}
              </div>
              <div style={dialogStyles.actions}>
                <button style={dialogStyles.btnSecondary} onClick={() => setSpriteDialog(null)}>Close</button>
              </div>
            </div>
          </div>
        );
      })()}

      {removeDialog && (() => {
        const agent = agentsApi.agents.find((a) => a.id === removeDialog.id);
        if (!agent) return null;
        const removeKeepingFolder = () => {
          closeAgentTerminal(agent.id);
          agentsApi.removeAgent(agent.id);
          setRemoveDialog(null);
          setOrphanRefreshKey((k) => k + 1);
        };
        const removeWithFolder = async () => {
          try {
            await deleteAgentFolder(agent.folderName);
          } catch (err) {
            window.alert(err instanceof Error ? err.message : String(err));
            return;
          }
          closeAgentTerminal(agent.id);
          agentsApi.removeAgent(agent.id);
          setRemoveDialog(null);
          setOrphanRefreshKey((k) => k + 1);
        };
        return (
          <div style={dialogStyles.backdrop} onClick={() => setRemoveDialog(null)}>
            <div style={dialogStyles.modal} onClick={(e) => e.stopPropagation()}>
              <h3 style={dialogStyles.title}>Remove "{agent.nickname}"?</h3>
              <p style={dialogStyles.subtitle}>
                Folder <code>projects/{agent.folderName}</code> can be deleted with the agent,
                or kept as an orphan so another agent can adopt it later.
              </p>
              <div style={{ ...dialogStyles.actions, flexDirection: 'column', gap: 6 }}>
                <button style={dialogStyles.btnDanger} onClick={removeWithFolder}>
                  Delete agent and folder
                </button>
                <button style={dialogStyles.btnSecondary} onClick={removeKeepingFolder}>
                  Keep folder (agent becomes orphan)
                </button>
                <button style={dialogStyles.btnSecondary} onClick={() => setRemoveDialog(null)}>
                  Cancel
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

function SpriteTilePreview({ spriteId }: { spriteId: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = 48 * dpr;
    canvas.height = 64 * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, 48, 64);
    const img = getCachedCharacter(spriteId);
    if (img) {
      ctx.drawImage(img, CHAR_FRAME_W, FACING_ROW.down * CHAR_FRAME_H, CHAR_FRAME_W, CHAR_FRAME_H, 4, 0, 40, 64);
    }
  }, [spriteId]);
  return <canvas ref={ref} style={{ width: 48, height: 64, imageRendering: 'pixelated' as const, display: 'block' }} />;
}

const dialogStyles: Record<string, React.CSSProperties> = {
  backdrop: {
    position: 'fixed', inset: 0, background: 'rgba(0, 0, 0, 0.55)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1100,
  },
  modal: {
    width: 380, background: 'var(--bg-primary)', border: '1px solid var(--border)',
    borderRadius: 8, padding: 16, boxShadow: '0 18px 48px rgba(0, 0, 0, 0.45)',
  },
  title: { margin: '0 0 8px 0', fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' },
  subtitle: { margin: '0 0 14px 0', fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.45 },
  input: {
    width: '100%', padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 4,
    background: 'var(--bg-surface)', color: 'var(--text-primary)', fontSize: 13, marginBottom: 14,
    boxSizing: 'border-box' as const,
  },
  spriteGrid: {
    display: 'grid', gridTemplateColumns: 'repeat(8, 1fr)', gap: 4,
    padding: 8, background: 'var(--bg-surface)', borderRadius: 4,
    maxHeight: 280, overflowY: 'auto' as const, marginBottom: 14,
  },
  spriteTile: {
    aspectRatio: '3 / 4', padding: 4, display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'var(--bg-primary)', border: '1px solid transparent', borderRadius: 4, cursor: 'pointer',
  },
  spriteTileSelected: { borderColor: 'var(--accent)', background: 'var(--accent-dim)' },
  actions: { display: 'flex', justifyContent: 'flex-end', gap: 8 },
  btnSecondary: {
    padding: '6px 14px', background: 'var(--bg-surface)', color: 'var(--text-primary)',
    border: '1px solid var(--border)', borderRadius: 4, fontSize: 13, cursor: 'pointer',
  },
  btnPrimary: {
    padding: '6px 14px', background: 'var(--accent)', color: '#0d1117',
    border: '1px solid var(--accent)', borderRadius: 4, fontSize: 13, fontWeight: 600, cursor: 'pointer',
  },
  btnDanger: {
    padding: '8px 14px', background: '#ef5350', color: '#fff',
    border: '1px solid #ef5350', borderRadius: 4, fontSize: 13, fontWeight: 600, cursor: 'pointer',
  },
};

const styles: Record<string, React.CSSProperties> = {
  app: { display: 'flex', flexDirection: 'column', height: '100%', width: '100%' },
  tabBar: {
    height: 40, minHeight: 40, background: 'var(--bg-secondary)', borderBottom: '1px solid var(--border)',
    display: 'flex', alignItems: 'center', padding: '0 16px', userSelect: 'none',
  },
  tabBarLeft: { display: 'flex', alignItems: 'center', gap: 16 },
  appTitle: { fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '-0.3px' },
  tabs: { display: 'flex', gap: 2 },
  // tab styles are in index.css (.app-tab / .app-tab.active)
  body: { flex: 1, display: 'flex', overflow: 'hidden' },
  liveWrap: { flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' },
  loadingScreen: { height: '100%', width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-primary)' },
  loadingContent: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 },
  loadingTitle: { fontSize: 28, fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '-0.5px', margin: 0 },
  loadingSubtitle: { fontSize: 14, color: 'var(--text-muted)', margin: 0 },
  progressBarOuter: { width: 280, height: 6, borderRadius: 3, background: 'var(--bg-surface)', overflow: 'hidden' },
  progressBarInner: { height: '100%', background: 'var(--accent)', borderRadius: 3, transition: 'width 0.2s ease' },
  progressText: { fontSize: 12, color: 'var(--text-muted)' },
};
