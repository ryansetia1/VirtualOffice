import { useState, useCallback, useEffect, useRef } from 'react';
import { useGrid, createDefaultRoom, type Placement } from './hooks/useGrid';
import { useTool } from './hooks/useTool';
import { useAssetCategories } from './hooks/useAssetCategories';
import { useCustomAssets } from './hooks/useCustomAssets';
import { useAgents } from './hooks/useAgents';
import { useWanderLoop } from './hooks/useWanderLoop';
import { useCollisionMasks } from './hooks/useCollisionMasks';
import { useRenderOrderOverrides, type RenderOrder } from './hooks/useRenderOrderOverrides';
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
import { ptyKill } from './utils/pty';
import { isTauri } from './utils/tauri';
import GridCanvas from './components/GridCanvas';
import AssetPalette from './components/AssetPalette';
import Toolbar from './components/Toolbar';
import AssetManager from './components/AssetManager';
import LayersPanel from './components/LayersPanel';
import LiveHeader from './components/LiveHeader';
import AddAgentModal from './components/AddAgentModal';
import ContextMenu, { type MenuItem } from './components/ContextMenu';
import CollisionEditor from './components/CollisionEditor';
import TerminalPanel, { FloatingTerminalWindow, TerminalView } from './components/TerminalPanel';
import { getAssetTileInfo } from './data/assetManifest';
import { getAutoMask } from './utils/pixelMasks';

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
  const [collisionDebug, setCollisionDebug] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(EMPTY_SET);
  const [hoveredIds, setHoveredIds] = useState<Set<string>>(EMPTY_SET);
  const [layersPanelCollapsed, setLayersPanelCollapsed] = useState(false);
  const [addAgentModal, setAddAgentModal] = useState<{ adoptFolder: string | null } | null>(null);
  const [orphanRefreshKey, setOrphanRefreshKey] = useState(0);
  const [agentCtx, setAgentCtx] = useState<{ id: string; x: number; y: number } | null>(null);
  // Collision editor target. `assetId` is always known; `placement` is only
  // set when the editor was opened from build-tab (a specific instance).
  // `scope` controls which mask is currently being edited — the user can flip
  // it inside the editor to switch between placement-level and asset-level
  // without closing the dialog.
  const [collisionTarget, setCollisionTarget] = useState<
    | { assetId: number; placement: Placement | null; scope: 'placement' | 'asset' }
    | null
  >(null);
  const [placementCtx, setPlacementCtx] = useState<{
    ids: Set<string>;
    layer: 'floor' | 'wall' | 'object';
    // First selected placement — used to target the collision editor when
    // exactly one placement is selected.
    placement: Placement | null;
    x: number;
    y: number;
  } | null>(null);
  const [renameDialog, setRenameDialog] = useState<{ id: string; value: string } | null>(null);
  const [spriteDialog, setSpriteDialog] = useState<{ id: string } | null>(null);
  const [removeDialog, setRemoveDialog] = useState<{ id: string } | null>(null);
  const [commandsDialog, setCommandsDialog] = useState<{
    id: string;
    startCommand: string;
    continueCommand: string;
    noConversationPattern: string;
  } | null>(null);
  // Agent hovered in the live grid. Used both for the visual glow and for
  // suspending the wander loop while the pointer is over the sprite so the
  // user can line up a click / double-click / context-menu without chasing
  // a moving target.
  const [hoveredAgentId, setHoveredAgentId] = useState<string | null>(null);
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

  // Wander hook API is populated below via useWanderLoop; these handlers
  // reach it through a ref set further down so the callbacks stay stable.
  const wanderApiRef = useRef<{
    pauseAgent: (id: string) => void;
    resumeAgent: (id: string, delayMs?: number) => void;
  } | null>(null);

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
    // Freeze wandering for as long as the terminal is open — letting the
    // agent drift away from the cursor while the user is actively reading
    // their terminal would be more jarring than useful.
    wanderApiRef.current?.pauseAgent(agentId);
  }, []);

  const closeAgentTerminal = useCallback((agentId: string) => {
    setOpenTerminalIds((prev) => prev.filter((id) => id !== agentId));
    setFloatingTerminalIds((prev) => { const n = new Set(prev); n.delete(agentId); return n; });
    setHiddenTerminalIds((prev) => { const n = new Set(prev); n.delete(agentId); return n; });
    setActiveDockedTerminalId((cur) => cur === agentId ? null : cur);
    setFocusedTerminalId((cur) => cur === agentId ? null : cur);
    wanderApiRef.current?.resumeAgent(agentId, 600);
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

  // Pending reset flags: when the user clicks the "restart fresh" button in
  // a terminal's chrome we kill the PTY *and* want to skip the default
  // "session ended → mark has-previous" side-effect. The ref-set tracks
  // agent IDs whose next PTY exit should be treated as user-initiated.
  const pendingResetsRef = useRef<Set<string>>(new Set());

  const [initialRoom] = useState(loadInitialRoom);
  const {
    room, version, canUndo, canRedo, undo, redo, beginUndoBatch, endUndoBatch,
    addPlacement, removePlacementAt, removePlacementById, removePlacementsByIds, getPlacementAt,
    clearAll, resize, loadState,
    toggleLayerVisibility, toggleLayerLock, renameLayer,
    bringToFront, sendToBack, movePlacementToLayer, movePlacementsToLayer, reorderPlacement, reorderPlacementsBulk,
    createGroup, duplicateGroup, ungroupPlacements, deleteGroup, renameGroup,
    toggleGroupVisibility, toggleGroupLock, toggleGroupCollapsed, reorderGroups, moveGroupToLayer, addPlacementsToGroup, removePlacementsFromGroup,
    bulkMovePlacements, bulkDuplicatePlacements,
  } = useGrid(initialRoom);
  const { toolState, setMode, setDrawSubTool, setTool, setActiveLayer, selectAsset, rotateAsset, flipHAsset, flipVAsset, resetTransform } = useTool();
  const agentsApi = useAgents();
  const collisionApi = useCollisionMasks();
  const renderOrderApi = useRenderOrderOverrides();
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

  const resetAgentConversation = useCallback((agentId: string) => {
    pendingResetsRef.current.add(agentId);
    agentsApi.setHasPreviousConversation(agentId, false);
    ptyKill(`agent:${agentId}`).catch(() => { /* ignore */ });
  }, [agentsApi]);

  const handleSessionEnded = useCallback((agentId: string) => {
    // A user-initiated reset already flipped the flag to false and we don't
    // want the natural exit to then flip it back to true. One-shot consume.
    if (pendingResetsRef.current.has(agentId)) {
      pendingResetsRef.current.delete(agentId);
      return;
    }
    agentsApi.setHasPreviousConversation(agentId, true);
  }, [agentsApi]);

  const handlePatternFallback = useCallback((agentId: string) => {
    agentsApi.setHasPreviousConversation(agentId, false);
  }, [agentsApi]);

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

  // Keep placement-level overrides (collision masks + render order) in sync
  // with the room. When a placement is removed (via delete, clear, undo,
  // ungroup, etc.) we drop its saved entries so storage doesn't leak.
  const prunePlacementMasks = collisionApi.prunePlacements;
  const prunePlacementOrder = renderOrderApi.prunePlacements;
  useEffect(() => {
    const valid = new Set(room.placements.map((p) => p.id));
    prunePlacementMasks(valid);
    prunePlacementOrder(valid);
  }, [room.placements, prunePlacementMasks, prunePlacementOrder]);

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
      // 'C' in live mode toggles the collision-debug overlay so users can
      // *see* why an agent refuses to walk into an apparently-empty cell
      // (usually: faint shadow pixels on an object asset).
      if (
        !e.metaKey && !e.ctrlKey && !e.altKey &&
        (e.key === 'c' || e.key === 'C') &&
        activeTab === 'live'
      ) {
        e.preventDefault();
        setCollisionDebug((v) => !v);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [undo, redo, activeTab]);

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
    if (!canAgentStandAt(a.row, a.col, room, collisionApi)) {
      const spot = findNearestWalkable(ar, ac, room, collisionApi);
      if (spot) {
        snapGuardRef.current = true;
        agentsApi.moveAgent(id, spot.row, spot.col, a.facing, 1);
        window.setTimeout(() => { snapGuardRef.current = false; }, 200);
      }
    }
  }, [activeTab, agentsApi, room, collisionApi]);

  // ── Agent WASD movement loop (live tab only) ─────────────────────────────
  const roomRef = useRef(room);
  roomRef.current = room;
  const agentsApiRef = useRef(agentsApi);
  agentsApiRef.current = agentsApi;
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;
  const collisionRef = useRef(collisionApi);
  collisionRef.current = collisionApi;

  // ── Autonomous wandering ────────────────────────────────────────────────
  // The wander hook owns its own RAF loop and only moves agents with
  // `autonomous === true`. It gates on `enabledRef` so nothing animates
  // off the live tab, and exposes pause/resume/kick hooks that this
  // component wires into hover, WASD, and open-terminal events below.
  const wanderEnabledRef = useRef(activeTab === 'live');
  wanderEnabledRef.current = activeTab === 'live';
  const wander = useWanderLoop({
    agentsApi,
    roomRef,
    masksRef: collisionRef,
    enabledRef: wanderEnabledRef,
  });
  // The WASD effect mounts once with an empty dep array to keep the RAF
  // loop alive across re-renders; surface wander through a ref so that
  // closure can always reach the current pause/resume functions.
  const wanderRef = useRef(wander);
  wanderRef.current = wander;
  // openAgentTerminal / closeAgentTerminal are defined above (so they can be
  // wrapped in stable `useCallback`s) — mirror the wander api into their
  // shared ref now that `wander` exists.
  wanderApiRef.current = wander;

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

        const next = resolveAgentMove(active.row, active.col, stepY, stepX, roomRef.current, collisionRef.current);

        // Refresh the wander-pause window every frame the user is steering,
        // so letting go of WASD starts a clean 5-second countdown rather
        // than racing the keydown we kicked at press time.
        wanderRef.current?.kickTakeoverTimer(active.id);

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
      const activeId = agentsApiRef.current.activeAgentId;
      if (!activeId) return;
      e.preventDefault();
      heldKeysRef.current.add(key);
      // Suspend the wander loop for this agent. Every WASD keydown refreshes
      // the grace window so wander stays paused for as long as the user is
      // actively driving — then resumes 5s after the last input.
      wanderRef.current?.kickTakeoverTimer(activeId);
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
              hoveredAgentId={hoveredAgentId}
              onActivateAgent={agentsApi.setActive}
              onOpenAgentTerminal={openAgentTerminal}
              onAgentContextMenu={(id, x, y) => setAgentCtx({ id, x, y })}
              onAgentHover={(id) => {
                setHoveredAgentId((prev) => {
                  if (prev === id) return prev;
                  // Un-hover the previous agent with a short grace so the
                  // sprite doesn't twitch away from the cursor the instant
                  // it slides off a pixel-imperfect boundary.
                  if (prev) wander.resumeAgent(prev, 400);
                  if (id) wander.pauseAgent(id);
                  return id;
                });
              }}
              getRenderOrder={renderOrderApi.getOrder}
              collisionDebug={collisionDebug}
              getPlacementCollisionMask={collisionApi.getEffectiveMaskFor}
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
              onRemovePlacementsFromGroup={removePlacementsFromGroup}
              onEditCollision={(placementId) => {
                const p = room.placements.find((pp) => pp.id === placementId);
                if (p) setCollisionTarget({ assetId: p.assetId, placement: p, scope: 'placement' });
              }}
              renderOrderApi={{
                getOrder: renderOrderApi.getOrder,
                getAssetOrder: renderOrderApi.getAssetOrder,
                hasPlacementOverride: renderOrderApi.hasPlacementOverride,
                setPlacementOrder: renderOrderApi.setPlacementOrder,
                setAssetOrder: renderOrderApi.setAssetOrder,
                clearPlacementOverride: renderOrderApi.clearPlacementOverride,
              }}
              getPlacementById={(id) => room.placements.find((p) => p.id === id)}
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
              getRenderOrder={renderOrderApi.getOrder}
              onPlacementContextMenu={(placement, x, y) => {
                // If the right-clicked placement is part of the current
                // selection, act on the whole selection. Otherwise, select
                // and target just the clicked placement.
                const inSelection = selectedIds.has(placement.id);
                const ids = inSelection ? new Set(selectedIds) : new Set([placement.id]);
                if (!inSelection) setSelectedIds(ids);
                const targetPlacements = room.placements.filter((p) => ids.has(p.id));
                const firstLayer = targetPlacements[0]?.layer ?? placement.layer;
                const sameLayer = targetPlacements.every((p) => p.layer === firstLayer);
                setPlacementCtx({
                  ids,
                  layer: sameLayer ? firstLayer : placement.layer,
                  placement: ids.size === 1 ? placement : null,
                  x,
                  y,
                });
              }}
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
          isCollisionOverridden={collisionApi.isOverridden}
          getCollisionMask={collisionApi.getMask}
          onSetCollisionMask={collisionApi.setMask}
          onClearCollisionMask={collisionApi.clearMask}
        />
      )}
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
                onReset={resetAgentConversation}
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
                onReset={resetAgentConversation}
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
                onSessionEnded={() => handleSessionEnded(t.id)}
                onPatternFallback={() => handlePatternFallback(t.id)}
              />
            ))}
          </>
        );
      })()}

      {addAgentModal && (
        <AddAgentModal
          adoptFolder={addAgentModal.adoptFolder}
          usedSpriteIds={agentsApi.agents.map((a) => a.spriteId)}
          existingAgents={agentsApi.agents.map((a) => ({ nickname: a.nickname, folderName: a.folderName }))}
          onClose={() => setAddAgentModal(null)}
          onCreated={({ nickname, folderName, spriteId, startCommand, continueCommand, noConversationPattern }) => {
            const cx = Math.floor(room.width / 2);
            const cy = Math.floor(room.height / 2);
            const spot = findNearestWalkable(cy, cx, room, collisionApi) ?? { row: cy, col: cx };
            agentsApi.addAgent({
              nickname,
              folderName,
              spriteId,
              row: spot.row,
              col: spot.col,
              startCommand,
              continueCommand,
              noConversationPattern,
            });
            setAddAgentModal(null);
            setOrphanRefreshKey((k) => k + 1);
          }}
        />
      )}

      {placementCtx && (() => {
        const { ids, layer, placement, x, y } = placementCtx;
        const items: MenuItem[] = [];
        if (ids.size === 1 && placement) {
          items.push({
            label: 'Edit Collision…',
            onClick: () => setCollisionTarget({ assetId: placement.assetId, placement, scope: 'placement' }),
          });
          if (collisionApi.isPlacementOverridden(placement.id)) {
            items.push({
              label: 'Reset collision to asset default',
              onClick: () => collisionApi.clearPlacementMask(placement.id),
            });
          }
          const effective = renderOrderApi.getOrder(placement);
          const assetDefault = renderOrderApi.getAssetOrder(placement.assetId);
          const hasPlacementOverride = renderOrderApi.hasPlacementOverride(placement.id);
          // Per-placement render order — 3 radio-style entries. A filled dot
          // marks the currently effective value. Clicking one writes the
          // placement-level override.
          const placementOrders: Array<{ value: RenderOrder; label: string }> = [
            { value: 'auto', label: 'Auto (depth-sorted)' },
            { value: 'above', label: 'Always in front' },
            { value: 'below', label: 'Always behind' },
          ];
          for (const { value, label } of placementOrders) {
            items.push({
              label: `${effective === value ? '●' : '○'} ${label} — this object`,
              onClick: () => renderOrderApi.setPlacementOrder(placement.id, value),
            });
          }
          if (hasPlacementOverride) {
            items.push({
              label: 'Follow type default (clear per-object override)',
              onClick: () => renderOrderApi.clearPlacementOverride(placement.id),
            });
          }
          for (const { value, label } of placementOrders) {
            items.push({
              label: `${assetDefault === value ? '●' : '○'} ${label} — all of this type`,
              onClick: () => renderOrderApi.setAssetOrder(placement.assetId, value),
            });
          }
        }
        if (ids.size > 1) {
          items.push({
            label: 'Group Selected',
            onClick: () => createGroup('Group', layer, [...ids]),
          });
        }
        items.push({
          label: 'Delete',
          danger: true,
          onClick: () => handleDeletePlacements(ids),
        });
        return (
          <ContextMenu
            x={x}
            y={y}
            items={items}
            onClose={() => setPlacementCtx(null)}
          />
        );
      })()}

      {collisionTarget !== null && (() => {
        // Resolve the asset id (same for both scopes) and the source tiles /
        // anchor used to composite the preview inside the editor.
        const { assetId, placement, scope } = collisionTarget;
        const custom = customAssets.find((a) => a.id === assetId);
        let tiles: [number, number][];
        let srcCol = 0;
        let srcRow = 0;
        if (custom) {
          tiles = custom.tiles;
        } else {
          const override = tileOverrides[assetId];
          if (override && override.length > 0) {
            const minC = Math.min(...override.map((t) => t[0]));
            const minR = Math.min(...override.map((t) => t[1]));
            tiles = override;
            srcCol = minC;
            srcRow = minR;
          } else {
            const info = getAssetTileInfo(assetId);
            tiles = info.tiles;
            srcCol = info.srcCol;
            srcRow = info.srcRow;
          }
        }
        // Scope toggle is available only when a specific placement is known
        // (i.e., the editor was opened from build-tab context menu).
        const scopeControl = placement
          ? {
              scope,
              onScopeChange: (next: 'placement' | 'asset') => {
                setCollisionTarget((prev) => (prev ? { ...prev, scope: next } : prev));
              },
            }
          : undefined;
        if (scope === 'asset') {
          // Asset-level edit: start from the current asset mask; reset falls
          // back to the auto mask.
          const effective = collisionApi.getMask(assetId) ?? undefined;
          const auto = getAutoMask(assetId);
          return (
            <CollisionEditor
              // Remount when scope flips so the in-memory painting is replaced
              // with the scope's freshly resolved initial mask.
              key={`asset:${assetId}`}
              assetId={assetId}
              displayName={getAssetDisplayName(assetId)}
              initialMask={effective}
              autoMask={auto}
              hasOverride={collisionApi.isOverridden(assetId)}
              tiles={tiles}
              srcCol={srcCol}
              srcRow={srcRow}
              onSave={(m) => collisionApi.setMask(assetId, m)}
              onReset={() => collisionApi.clearMask(assetId)}
              onClose={() => setCollisionTarget(null)}
              scopeControl={scopeControl}
            />
          );
        }
        // Placement-level edit: start from this placement's override if any,
        // else the asset-effective mask. "Auto mask" for the editor's reset
        // button becomes the asset-effective mask, so "reset" means "fall
        // back to the asset default".
        if (!placement) return null;
        const placementId = placement.id;
        const placementOverride = collisionApi.getPlacementOverrideMask(placementId);
        const assetEffective = collisionApi.getMask(assetId);
        const initial = placementOverride ?? assetEffective ?? undefined;
        return (
          <CollisionEditor
            key={`placement:${placementId}`}
            assetId={assetId}
            displayName={`${getAssetDisplayName(assetId)} — this object only`}
            initialMask={initial}
            autoMask={assetEffective ?? undefined}
            hasOverride={collisionApi.isPlacementOverridden(placementId)}
            tiles={tiles}
            srcCol={srcCol}
            srcRow={srcRow}
            onSave={(m) => collisionApi.setPlacementMask(placementId, m)}
            onReset={() => collisionApi.clearPlacementMask(placementId)}
            onClose={() => setCollisionTarget(null)}
            scopeControl={scopeControl}
          />
        );
      })()}

      {agentCtx && (() => {
        const agent = agentsApi.agents.find((a) => a.id === agentCtx.id);
        if (!agent) return null;
        const isAutonomous = agent.autonomous === true;
        const items: MenuItem[] = [
          {
            label: 'Open Terminal',
            onClick: () => openAgentTerminal(agent.id),
          },
          {
            // Radio-style indicator mirrors the render-order menu entries.
            label: `${isAutonomous ? '●' : '○'} Wander otomatis`,
            onClick: () => agentsApi.setAgentAutonomous(agent.id, !isAutonomous),
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
            label: 'Edit auto-run commands…',
            onClick: () => setCommandsDialog({
              id: agent.id,
              startCommand: agent.startCommand ?? '',
              continueCommand: agent.continueCommand ?? '',
              noConversationPattern: agent.noConversationPattern ?? '',
            }),
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

      {commandsDialog && (() => {
        const agent = agentsApi.agents.find((a) => a.id === commandsDialog.id);
        if (!agent) return null;
        const submit = () => {
          agentsApi.setAgentCommands(agent.id, {
            startCommand: commandsDialog.startCommand,
            continueCommand: commandsDialog.continueCommand,
            noConversationPattern: commandsDialog.noConversationPattern,
          });
          setCommandsDialog(null);
        };
        const resetConversation = () => {
          agentsApi.setHasPreviousConversation(agent.id, false);
        };
        return (
          <div style={dialogStyles.backdrop} onClick={() => setCommandsDialog(null)}>
            <div style={{ ...dialogStyles.modal, width: 460 }} onClick={(e) => e.stopPropagation()}>
              <h3 style={dialogStyles.title}>Auto-run commands — {agent.nickname}</h3>
              <p style={dialogStyles.subtitle}>
                These commands run automatically when the terminal opens for this agent.
                Leave blank to disable.
              </p>
              <label style={dialogStyles.fieldLabel}>
                Start command
                <input
                  autoFocus
                  style={{ ...dialogStyles.input, marginBottom: 0 }}
                  placeholder='e.g. claude'
                  value={commandsDialog.startCommand}
                  onChange={(e) => setCommandsDialog({ ...commandsDialog, startCommand: e.target.value })}
                  onKeyDown={(e) => { if (e.key === 'Escape') setCommandsDialog(null); }}
                />
              </label>
              <label style={dialogStyles.fieldLabel}>
                Continue command
                <input
                  style={{ ...dialogStyles.input, marginBottom: 0 }}
                  placeholder='e.g. --continue'
                  value={commandsDialog.continueCommand}
                  onChange={(e) => setCommandsDialog({ ...commandsDialog, continueCommand: e.target.value })}
                />
                <span style={dialogStyles.hint}>
                  Appended to the start command when this agent has a previous conversation.
                </span>
              </label>
              <label style={dialogStyles.fieldLabel}>
                No-conversation pattern (regex)
                <input
                  style={{ ...dialogStyles.input, marginBottom: 0 }}
                  placeholder='leave blank to use the default'
                  value={commandsDialog.noConversationPattern}
                  onChange={(e) => setCommandsDialog({ ...commandsDialog, noConversationPattern: e.target.value })}
                />
                <span style={dialogStyles.hint}>
                  If this pattern appears in the terminal after the continue command,
                  the agent falls back to the plain start command.
                </span>
              </label>
              <div style={dialogStyles.conversationRow}>
                <span style={dialogStyles.conversationLabel}>
                  Conversation state:{' '}
                  <strong style={{ color: agent.hasPreviousConversation ? '#4fc3f7' : 'var(--text-muted)' }}>
                    {agent.hasPreviousConversation ? 'has previous' : 'fresh'}
                  </strong>
                </span>
                {agent.hasPreviousConversation && (
                  <button style={dialogStyles.btnSecondarySmall} onClick={resetConversation}>
                    Reset to fresh
                  </button>
                )}
              </div>
              <div style={dialogStyles.actions}>
                <button style={dialogStyles.btnSecondary} onClick={() => setCommandsDialog(null)}>Cancel</button>
                <button style={dialogStyles.btnPrimary} onClick={submit}>Save</button>
              </div>
            </div>
          </div>
        );
      })()}

      {removeDialog && (() => {
        const agent = agentsApi.agents.find((a) => a.id === removeDialog.id);
        if (!agent) return null;
        // Detect folder-sharing: when another agent still points at the same
        // directory, deleting the folder would yank the ground out from under
        // it — so we hide the destructive option entirely in that case.
        const sharingAgents = agentsApi.agents.filter(
          (other) => other.id !== agent.id && other.folderName.toLowerCase() === agent.folderName.toLowerCase()
        );
        const folderIsShared = sharingAgents.length > 0;
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
                {folderIsShared
                  ? <>Folder <code>projects/{agent.folderName}</code> is also used by{' '}
                      <strong>{sharingAgents.map((a) => a.nickname).join(', ')}</strong>.
                      Only this agent will be removed — the folder stays on disk.</>
                  : <>Folder <code>projects/{agent.folderName}</code> can be deleted with the agent,
                      or kept as an orphan so another agent can adopt it later.</>}
              </p>
              <div style={{ ...dialogStyles.actions, flexDirection: 'column', gap: 6 }}>
                {!folderIsShared && (
                  <button style={dialogStyles.btnDanger} onClick={removeWithFolder}>
                    Delete agent and folder
                  </button>
                )}
                <button style={dialogStyles.btnSecondary} onClick={removeKeepingFolder}>
                  {folderIsShared ? 'Remove agent (keep folder)' : 'Keep folder (agent becomes orphan)'}
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
  fieldLabel: {
    display: 'flex', flexDirection: 'column' as const, gap: 4,
    fontSize: 12, fontWeight: 500, color: 'var(--text-primary)',
    marginBottom: 12,
  },
  hint: { fontSize: 11, color: 'var(--text-muted)', fontWeight: 400 },
  conversationRow: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '8px 10px', background: 'var(--bg-surface)',
    border: '1px solid var(--border)', borderRadius: 4,
    marginBottom: 14,
  },
  conversationLabel: { fontSize: 12, color: 'var(--text-primary)' },
  btnSecondarySmall: {
    padding: '4px 10px', background: 'var(--bg-primary)', color: 'var(--text-primary)',
    border: '1px solid var(--border)', borderRadius: 4, fontSize: 11, cursor: 'pointer',
  },
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
