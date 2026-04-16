import { useState, useCallback, useEffect, useRef } from 'react';
import { useGrid, createDefaultRoom } from './hooks/useGrid';
import { useTool } from './hooks/useTool';
import { useAssetCategories } from './hooks/useAssetCategories';
import { useCustomAssets } from './hooks/useCustomAssets';
import { preloadAllAssets } from './utils/imageLoader';
import { saveRoom, loadRoom } from './utils/roomStorage';
import { exportProject, importProject } from './utils/projectFile';
import GridCanvas from './components/GridCanvas';
import AssetPalette from './components/AssetPalette';
import Toolbar from './components/Toolbar';
import AssetManager from './components/AssetManager';
import LayersPanel from './components/LayersPanel';
import DragOverlay from './components/DragOverlay';

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
  const { customAssets, customAssetInfos, addCustomAssets, removeCustomAsset } = useCustomAssets();
  const customAssetIds = customAssets.map((a) => a.id);
  const {
    library, categoryTree, uncategorizedIds, tileOverrides,
    setRootLabel,
    createCategory, renameCategory, deleteCategory, moveAssets, uncategorizeAssets,
    getAssetDisplayName, getCategoryForAsset, renameAsset, clearAssetName, batchRenameAssets,
    setTileOverride, clearTileOverride,
  } = useAssetCategories(customAssetIds);

  useEffect(() => {
    preloadAllAssets((loaded, total) => {
      setLoadProgress(Math.round((loaded / total) * 100));
    }).then(() => setLoading(false));
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
                style={{ ...styles.tab, ...(activeTab === tab ? styles.tabActive : {}) }}
                onClick={(e) => { setActiveTab(tab); (e.currentTarget as HTMLElement).blur(); }}
              >
                {tab.charAt(0).toUpperCase() + tab.slice(1)}
              </button>
            ))}
          </div>
        </div>
      </div>

      {activeTab === 'live' && (
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
          />
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
        />
      )}
      <DragOverlay tileOverrides={tileOverrides} />
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  app: { display: 'flex', flexDirection: 'column', height: '100%', width: '100%' },
  tabBar: {
    height: 40, minHeight: 40, background: 'var(--bg-secondary)', borderBottom: '1px solid var(--border)',
    display: 'flex', alignItems: 'center', padding: '0 16px', userSelect: 'none',
  },
  tabBarLeft: { display: 'flex', alignItems: 'center', gap: 16 },
  appTitle: { fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '-0.3px' },
  tabs: { display: 'flex', gap: 2 },
  tab: {
    padding: '6px 16px', borderRadius: '4px 4px 0 0', background: 'transparent', fontSize: 12,
    fontWeight: 500, cursor: 'pointer', color: 'var(--text-muted)',
    borderTop: 'none', borderLeft: 'none', borderRight: 'none',
    borderBottom: '2px solid transparent',
    outline: 'none',
    transition: 'color 0.15s, border-color 0.15s, background 0.15s',
  },
  tabActive: { color: 'var(--accent)', borderBottomColor: 'var(--accent)', background: 'var(--accent-dim)' },
  body: { flex: 1, display: 'flex', overflow: 'hidden' },
  loadingScreen: { height: '100%', width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-primary)' },
  loadingContent: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 },
  loadingTitle: { fontSize: 28, fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '-0.5px', margin: 0 },
  loadingSubtitle: { fontSize: 14, color: 'var(--text-muted)', margin: 0 },
  progressBarOuter: { width: 280, height: 6, borderRadius: 3, background: 'var(--bg-surface)', overflow: 'hidden' },
  progressBarInner: { height: '100%', background: 'var(--accent)', borderRadius: 3, transition: 'width 0.2s ease' },
  progressText: { fontSize: 12, color: 'var(--text-muted)' },
};
