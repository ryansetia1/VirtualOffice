import { useState, useCallback, useMemo, type DragEvent } from 'react';
import { getAllAssets, type AssetInfo } from '../data/assetManifest';
import { getEmptyDragImage } from '../utils/imageLoader';
import type { LayerType } from '../hooks/useGrid';
import type { TreeNode } from '../hooks/useAssetCategories';
import AssetThumbnail from './AssetThumbnail';
import TileEditor from './TileEditor';

interface Props {
  selectedAssetId: number | null;
  categoryTree: TreeNode[];
  uncategorizedIds: number[];
  tileOverrides: Record<number, [number, number][]>;
  customAssetInfos: AssetInfo[];
  getAssetDisplayName: (id: number) => string;
  getCategoryForAsset: (id: number) => string | null;
  onSelectAsset: (assetId: number | null) => void;
  onAutoLayer?: (layer: LayerType) => void;
  onSetTileOverride: (id: number, tiles: [number, number][]) => void;
  onClearTileOverride: (id: number) => void;
}

interface FlatSection {
  path: string;
  label: string;
  depth: number;
  assetIds: number[];
}

const DEFAULT_COLS = 4;
const MIN_COLS = 2;
const MAX_COLS = 8;

function detectLayer(categoryPath: string | null): LayerType {
  if (!categoryPath) return 'object';
  const lower = categoryPath.toLowerCase();
  if (lower.includes('floor')) return 'floor';
  if (lower.includes('wall')) return 'wall';
  return 'object';
}

export default function AssetPalette({
  selectedAssetId,
  categoryTree,
  uncategorizedIds,
  tileOverrides,
  customAssetInfos,
  getAssetDisplayName,
  getCategoryForAsset,
  onSelectAsset,
  onAutoLayer,
  onSetTileOverride,
  onClearTileOverride,
}: Props) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [search, setSearch] = useState('');
  const [tileEditorAsset, setTileEditorAsset] = useState<number | null>(null);
  const [gridCols, setGridCols] = useState(DEFAULT_COLS);

  const allAssets = useMemo(() => [...getAllAssets(), ...customAssetInfos], [customAssetInfos]);
  const assetMap = useMemo(() => {
    const m = new Map<number, AssetInfo>();
    for (const a of allAssets) m.set(a.id, a);
    return m;
  }, [allAssets]);

  // Flatten tree into ordered sections for display
  const sections = useMemo(() => {
    const result: FlatSection[] = [];

    if (uncategorizedIds.length > 0) {
      result.push({ path: '__uncategorized__', label: 'Uncategorized', depth: 0, assetIds: uncategorizedIds });
    }

    const walk = (nodes: TreeNode[], depth: number) => {
      for (const node of nodes) {
        if (node.directAssetIds.length > 0 || node.children.length > 0) {
          result.push({
            path: node.path,
            label: node.name,
            depth,
            assetIds: node.directAssetIds,
          });
        }
        walk(node.children, depth + 1);
      }
    };
    walk(categoryTree, 0);
    return result;
  }, [categoryTree, uncategorizedIds]);

  const toggleCategory = useCallback((path: string) => {
    setCollapsed((prev) => ({ ...prev, [path]: !prev[path] }));
  }, []);

  const handleDragStart = useCallback((e: DragEvent<HTMLDivElement>, assetId: number) => {
    e.dataTransfer.setData('text/asset-id', String(assetId));
    e.dataTransfer.setData(`asset-id/${assetId}`, '');
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setDragImage(getEmptyDragImage(), 0, 0);
  }, []);

  const handleAssetContextMenu = useCallback((e: React.MouseEvent, assetId: number) => {
    e.preventDefault();
    setTileEditorAsset(assetId);
  }, []);

  const filteredSections = sections.filter((s) => {
    if (!search) return true;
    return s.label.toLowerCase().includes(search.toLowerCase());
  });

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <span style={styles.title}>Assets</span>
      </div>

      <div style={styles.searchWrap}>
        <input
          type="text"
          placeholder="Filter categories..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={styles.searchInput}
        />
      </div>

      <div style={styles.zoomRow}>
        <span style={styles.zoomLabel}>Size</span>
        <input
          type="range"
          min={MIN_COLS}
          max={MAX_COLS}
          step={1}
          value={MAX_COLS + MIN_COLS - gridCols}
          onChange={(e) => setGridCols(MAX_COLS + MIN_COLS - Number(e.target.value))}
          style={styles.zoomSlider}
        />
        {gridCols !== DEFAULT_COLS && (
          <button
            style={styles.zoomResetBtn}
            onClick={(e) => { setGridCols(DEFAULT_COLS); (e.currentTarget as HTMLElement).blur(); }}
          >
            Reset
          </button>
        )}
      </div>

      <div style={styles.scrollArea}>
        {filteredSections.map((section) => {
          const isCollapsed = collapsed[section.path] ?? false;
          const assets = section.assetIds
            .map((id) => assetMap.get(id))
            .filter((a): a is AssetInfo => a !== undefined);

          return (
            <div key={section.path} style={styles.categoryBlock}>
              <button
                style={{ ...styles.categoryHeader, paddingLeft: 12 + section.depth * 12 }}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => toggleCategory(section.path)}
              >
                <span style={styles.chevron}>{isCollapsed ? '▸' : '▾'}</span>
                <span>{section.label}</span>
                <span style={styles.count}>{assets.length}</span>
              </button>
              {!isCollapsed && assets.length > 0 && (
                <div style={{ ...styles.grid, gridTemplateColumns: `repeat(${gridCols}, 1fr)` }}>
                  {assets.map((asset) => {
                    const isSelected = selectedAssetId === asset.id;
                    return (
                      <div
                        key={asset.id}
                        draggable
                        onDragStart={(e) => handleDragStart(e, asset.id)}
                        onClick={() => {
                          const newId = isSelected ? null : asset.id;
                          onSelectAsset(newId);
                          if (newId !== null && onAutoLayer) {
                            const cat = getCategoryForAsset(newId);
                            onAutoLayer(detectLayer(cat));
                          }
                        }}
                        onContextMenu={asset.path ? (e) => handleAssetContextMenu(e, asset.id) : undefined}
                        style={{
                          ...styles.tile,
                          ...(isSelected ? styles.tileSelected : {}),
                        }}
                        title={`#${asset.id} — ${getAssetDisplayName(asset.id)} (${asset.spanW}×${asset.spanH})`}
                      >
                        <AssetThumbnail
                          assetId={asset.id}
                          path={asset.path}
                          tileOverrides={tileOverrides}
                        />
                        {isSelected && <div style={styles.selectionOverlay} />}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {tileEditorAsset !== null && (
        <TileEditor
          assetId={tileEditorAsset}
          tileOverrides={tileOverrides}
          onSave={(tiles) => onSetTileOverride(tileEditorAsset, tiles)}
          onReset={() => onClearTileOverride(tileEditorAsset)}
          onClose={() => setTileEditorAsset(null)}
        />
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    width: 'var(--palette-width)', minWidth: 'var(--palette-width)', background: 'var(--bg-secondary)',
    borderLeft: '1px solid var(--border)', display: 'flex', flexDirection: 'column', height: '100%', userSelect: 'none',
  },
  header: { padding: '10px 12px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8 },
  title: { fontWeight: 600, fontSize: 14, color: 'var(--text-primary)' },
  searchWrap: { padding: 8, borderBottom: '1px solid var(--border)' },
  searchInput: { width: '100%', padding: '6px 8px', border: '1px solid var(--border)', borderRadius: 4, background: 'var(--bg-primary)', fontSize: 12 },
  zoomRow: { padding: '6px 12px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 },
  zoomLabel: { fontSize: 10, color: 'var(--text-muted)', fontWeight: 500, flexShrink: 0 },
  zoomSlider: { flex: 1, height: 4, cursor: 'pointer', accentColor: 'var(--accent)' },
  zoomResetBtn: { padding: '1px 6px', border: '1px solid var(--border)', borderRadius: 3, background: 'var(--bg-surface)', fontSize: 9, cursor: 'pointer', color: 'var(--text-muted)', flexShrink: 0 },
  scrollArea: { flex: 1, overflowY: 'auto', overflowX: 'hidden' },
  categoryBlock: { borderBottom: '1px solid var(--border)' },
  categoryHeader: { width: '100%', padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 6, background: 'var(--bg-surface)', fontSize: 12, fontWeight: 500, textAlign: 'left' as const },
  chevron: { fontSize: 10, color: 'var(--text-muted)', width: 12 },
  count: { marginLeft: 'auto', fontSize: 11, color: 'var(--text-muted)' },
  grid: { display: 'grid', gap: 4, padding: 8, background: 'var(--bg-primary)' },
  tile: { 
    aspectRatio: '1',
    display: 'flex', 
    alignItems: 'center', 
    justifyContent: 'center', 
    borderRadius: 4, 
    cursor: 'grab', 
    background: 'transparent', 
    overflow: 'hidden',
    position: 'relative' as const,
  },
  tileSelected: { background: 'var(--accent-dim)' },
  selectionOverlay: { position: 'absolute' as const, inset: 0, borderRadius: 4, border: '2px solid var(--accent)', pointerEvents: 'none' as const, zIndex: 1 },
};
