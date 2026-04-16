import { useState, useMemo, useCallback, type DragEvent } from 'react';
import { getAllAssets, type AssetInfo } from '../data/assetManifest';
import { getEmptyDragImage } from '../utils/imageLoader';
import type { CustomAssetData } from '../hooks/useCustomAssets';
import type { TreeNode } from '../hooks/useAssetCategories';
import ContextMenu, { type MenuItem } from './ContextMenu';
import TileEditor from './TileEditor';
import ImportDialog from './ImportDialog';
import AssetThumbnail from './AssetThumbnail';

interface Props {
  library: { rootLabel: string; filePattern: string; totalAssets: number };
  categoryTree: TreeNode[];
  uncategorizedIds: number[];
  tileOverrides: Record<number, [number, number][]>;
  customAssets: CustomAssetData[];
  customAssetInfos: AssetInfo[];
  onSetRootLabel: (label: string) => void;
  onCreateCategory: (path: string) => void;
  onRenameCategory: (path: string, newName: string) => void;
  onDeleteCategory: (path: string) => void;
  onMoveAssets: (ids: number[], targetPath: string) => void;
  onUncategorizeAssets: (ids: number[]) => void;
  getAssetDisplayName: (id: number) => string;
  onRenameAsset: (id: number, name: string) => void;
  onClearAssetName: (id: number) => void;
  onBatchRename: (find: string, replace: string) => number;
  onSetTileOverride: (id: number, tiles: [number, number][]) => void;
  onClearTileOverride: (id: number) => void;
  onAddCustomAssets: (assets: Omit<CustomAssetData, 'id'>[]) => Promise<CustomAssetData[]>;
  onRemoveCustomAsset: (id: number) => void;
}

const UNCATEGORIZED = '__uncategorized__';
const ALL_VIEW = '__all__';

export default function AssetManager({
  library,
  categoryTree,
  uncategorizedIds,
  tileOverrides,
  customAssets,
  customAssetInfos,
  onSetRootLabel,
  onCreateCategory,
  onRenameCategory,
  onDeleteCategory,
  onMoveAssets,
  onUncategorizeAssets,
  getAssetDisplayName,
  onRenameAsset,
  onClearAssetName,
  onBatchRename,
  onSetTileOverride,
  onClearTileOverride,
  onAddCustomAssets,
  onRemoveCustomAsset,
}: Props) {
  const [selectedView, setSelectedView] = useState<string>(ALL_VIEW);
  const [search, setSearch] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [newCatName, setNewCatName] = useState('');
  const [dragOverPath, setDragOverPath] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; path: string } | null>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [editingRootLabel, setEditingRootLabel] = useState(false);
  const [rootLabelValue, setRootLabelValue] = useState(library.rootLabel);

  const [tileEditorAsset, setTileEditorAsset] = useState<number | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importTargetCat, setImportTargetCat] = useState<string>('');

  const [assetCtxMenu, setAssetCtxMenu] = useState<{ x: number; y: number; targetIds: number[] } | null>(null);
  const [renamingAssetId, setRenamingAssetId] = useState<number | null>(null);
  const [assetRenameValue, setAssetRenameValue] = useState('');

  const [movePickerOpen, setMovePickerOpen] = useState(false);
  const [movePickerIds, setMovePickerIds] = useState<number[]>([]);
  const [movePickerSearch, setMovePickerSearch] = useState('');

  const [confirmDialog, setConfirmDialog] = useState<{ message: string; detail?: string; onConfirm: () => void } | null>(null);

  const [findReplaceOpen, setFindReplaceOpen] = useState(false);
  const [findValue, setFindValue] = useState('');
  const [replaceValue, setReplaceValue] = useState('');

  const allAssets = useMemo(() => [...getAllAssets(), ...customAssetInfos], [customAssetInfos]);
  const allAssetMap = useMemo(() => {
    const m = new Map<number, AssetInfo>();
    for (const a of allAssets) m.set(a.id, a);
    return m;
  }, [allAssets]);
  const customAssetMap = useMemo(() => {
    const m = new Map<number, CustomAssetData>();
    for (const a of customAssets) m.set(a.id, a);
    return m;
  }, [customAssets]);

  const uncatSet = useMemo(() => new Set(uncategorizedIds), [uncategorizedIds]);

  // Build a flat lookup: assetId -> categoryPath
  const assetCategoryMap = useMemo(() => {
    const m = new Map<number, string>();
    const walk = (nodes: TreeNode[]) => {
      for (const node of nodes) {
        for (const id of node.directAssetIds) m.set(id, node.path);
        walk(node.children);
      }
    };
    walk(categoryTree);
    return m;
  }, [categoryTree]);

  // Collect all category paths for "Move to" submenu
  const allCategoryPaths = useMemo(() => {
    const paths: string[] = [];
    const walk = (nodes: TreeNode[]) => {
      for (const n of nodes) {
        paths.push(n.path);
        walk(n.children);
      }
    };
    walk(categoryTree);
    return paths.sort();
  }, [categoryTree]);

  const totalUncategorized = uncategorizedIds.length;

  // ── Filtered assets ────────────────────────────────────────────────────────

  const viewAssetIds = useMemo(() => {
    if (selectedView === ALL_VIEW) return allAssets.map((a) => a.id);
    if (selectedView === UNCATEGORIZED) return uncategorizedIds;
    // Find node by path and show direct assets
    const findNode = (nodes: TreeNode[], path: string): TreeNode | null => {
      for (const n of nodes) {
        if (n.path === path) return n;
        const found = findNode(n.children, path);
        if (found) return found;
      }
      return null;
    };
    const node = findNode(categoryTree, selectedView);
    return node ? node.directAssetIds : [];
  }, [selectedView, allAssets, uncategorizedIds, categoryTree]);

  const filtered = useMemo(() => {
    const ids = new Set(viewAssetIds);
    return allAssets.filter((a) => {
      if (!ids.has(a.id)) return false;
      if (search) {
        const q = search.toLowerCase();
        const name = getAssetDisplayName(a.id).toLowerCase();
        if (!String(a.id).includes(q) && !name.includes(q)) return false;
      }
      return true;
    });
  }, [allAssets, viewAssetIds, search, getAssetDisplayName]);

  // ── Selection ──────────────────────────────────────────────────────────────

  const toggleSelect = useCallback((id: number, e: React.MouseEvent) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (e.shiftKey || e.metaKey || e.ctrlKey) {
        if (next.has(id)) next.delete(id); else next.add(id);
      } else {
        if (next.size === 1 && next.has(id)) next.clear();
        else { next.clear(); next.add(id); }
      }
      return next;
    });
  }, []);

  const selectAll = useCallback(() => setSelectedIds(new Set(filtered.map((a) => a.id))), [filtered]);
  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

  // ── Drag & drop ────────────────────────────────────────────────────────────

  const handleDragStartFromGrid = useCallback((e: DragEvent<HTMLDivElement>) => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    e.dataTransfer.setData('text/asset-ids', JSON.stringify(ids));
    e.dataTransfer.setData('text/asset-count', String(ids.length));
    for (const id of ids) {
      e.dataTransfer.setData(`asset-id/${id}`, '');
    }
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setDragImage(getEmptyDragImage(), 0, 0);
  }, [selectedIds]);

  const handleDropOnNode = useCallback((path: string, e: DragEvent<HTMLElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOverPath(null);
    const data = e.dataTransfer.getData('text/asset-ids');
    if (!data) return;
    try {
      const ids = JSON.parse(data) as number[];
      if (path === UNCATEGORIZED) onUncategorizeAssets(ids);
      else onMoveAssets(ids, path);
      setSelectedIds(new Set());
    } catch { /* ignore */ }
  }, [onMoveAssets, onUncategorizeAssets]);

  // ── Tree expand/collapse ───────────────────────────────────────────────────

  const toggleExpand = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  }, []);

  // ── Category context menu ──────────────────────────────────────────────────

  const handleNodeContextMenu = useCallback((e: React.MouseEvent, path: string) => {
    e.preventDefault();
    setCtxMenu({ x: e.clientX, y: e.clientY, path });
  }, []);

  const getCatContextItems = useCallback((path: string): MenuItem[] => {
    return [
      {
        label: 'New Subcategory',
        onClick: () => {
          const name = window.prompt('Subcategory name:');
          if (name?.trim()) onCreateCategory(path + '/' + name.trim().replace(/\//g, ''));
        },
      },
      {
        label: 'Rename',
        onClick: () => {
          const parts = path.split('/');
          setRenamingPath(path);
          setRenameValue(parts[parts.length - 1]);
        },
      },
      {
        label: 'Delete',
        danger: true,
        onClick: () => {
          setConfirmDialog({
            message: `Delete this category?`,
            detail: 'Assets inside will be moved to Uncategorized.',
            onConfirm: () => {
              onDeleteCategory(path);
              if (selectedView === path || selectedView.startsWith(path + '/')) setSelectedView(ALL_VIEW);
              setConfirmDialog(null);
            },
          });
        },
      },
    ];
  }, [onCreateCategory, onDeleteCategory, selectedView]);

  const handleRenameSubmit = useCallback(() => {
    if (!renamingPath || !renameValue.trim()) return;
    onRenameCategory(renamingPath, renameValue.trim());
    setRenamingPath(null);
    setRenameValue('');
  }, [renamingPath, renameValue, onRenameCategory]);

  // ── Add category ───────────────────────────────────────────────────────────

  const handleAddCategory = useCallback(() => {
    const name = newCatName.trim();
    if (!name) return;
    onCreateCategory(name);
    setNewCatName('');
    // Auto-expand parent paths
    const parts = name.split('/');
    if (parts.length > 1) {
      setExpanded((prev) => {
        const next = new Set(prev);
        for (let i = 1; i < parts.length; i++) next.add(parts.slice(0, i).join('/'));
        return next;
      });
    }
  }, [newCatName, onCreateCategory]);

  // ── Root label editing ─────────────────────────────────────────────────────

  const submitRootLabel = useCallback(() => {
    if (rootLabelValue.trim()) onSetRootLabel(rootLabelValue.trim());
    setEditingRootLabel(false);
  }, [rootLabelValue, onSetRootLabel]);

  // ── Asset context menu ─────────────────────────────────────────────────────

  const handleAssetContextMenu = useCallback((e: React.MouseEvent, assetId: number) => {
    e.preventDefault();
    // If right-clicked asset is in selection, operate on all selected; otherwise just this one
    const targetIds = selectedIds.has(assetId) && selectedIds.size > 1
      ? Array.from(selectedIds)
      : [assetId];
    setAssetCtxMenu({ x: e.clientX, y: e.clientY, targetIds });
  }, [selectedIds]);

  const getAssetContextItems = useCallback((targetIds: number[]): MenuItem[] => {
    const isBulk = targetIds.length > 1;
    const label = isBulk ? `${targetIds.length} assets` : `#${targetIds[0]}`;
    const singleId = isBulk ? null : targetIds[0];
    const hasCustom = targetIds.some((id) => customAssetMap.has(id));
    const hasCategorized = targetIds.some((id) => assetCategoryMap.has(id));

    const items: MenuItem[] = [];

    if (singleId !== null) {
      items.push({
        label: 'Rename',
        onClick: () => {
          setRenamingAssetId(singleId);
          setAssetRenameValue(getAssetDisplayName(singleId));
        },
      });
      if (!customAssetMap.has(singleId)) {
        items.push({
          label: 'Edit Tiles',
          onClick: () => setTileEditorAsset(singleId),
        });
      }
    }

    if (allCategoryPaths.length > 0) {
      items.push({
        label: isBulk ? `Move ${label}...` : 'Move to...',
        onClick: () => {
          setMovePickerIds(targetIds);
          setMovePickerSearch('');
          setMovePickerOpen(true);
        },
      });
    }

    if (hasCategorized) {
      items.push({
        label: isBulk ? `Uncategorize ${label}` : 'Uncategorize',
        onClick: () => {
          onUncategorizeAssets(targetIds);
          if (isBulk) setSelectedIds(new Set());
        },
      });
    }

    if (hasCustom) {
      const customIds = targetIds.filter((id) => customAssetMap.has(id));
      const deleteLabel = customIds.length > 1
        ? `Delete ${customIds.length} imported assets`
        : 'Delete Asset';
      items.push({
        label: deleteLabel,
        danger: true,
        onClick: () => {
          const msg = customIds.length > 1
            ? `Delete ${customIds.length} imported assets?`
            : `Delete imported asset #${customIds[0]}?`;
          setConfirmDialog({
            message: msg,
            detail: 'This action cannot be undone.',
            onConfirm: () => {
              onUncategorizeAssets(customIds);
              for (const id of customIds) onRemoveCustomAsset(id);
              setSelectedIds((prev) => {
                const next = new Set(prev);
                for (const id of customIds) next.delete(id);
                return next;
              });
              setConfirmDialog(null);
            },
          });
        },
      });
    }

    return items;
  }, [customAssetMap, getAssetDisplayName, allCategoryPaths, assetCategoryMap, onUncategorizeAssets, onRemoveCustomAsset]);

  const handleAssetRenameSubmit = useCallback(() => {
    if (renamingAssetId === null) return;
    if (assetRenameValue.trim()) onRenameAsset(renamingAssetId, assetRenameValue.trim());
    setRenamingAssetId(null);
    setAssetRenameValue('');
  }, [renamingAssetId, assetRenameValue, onRenameAsset]);

  // ── Find & Replace preview ─────────────────────────────────────────────────

  const findReplacePreview = useMemo(() => {
    if (!findValue || !findReplaceOpen) return [];
    const results: { id: number; before: string; after: string }[] = [];
    for (const a of allAssets) {
      const name = getAssetDisplayName(a.id);
      if (name.includes(findValue)) {
        results.push({ id: a.id, before: name, after: name.replaceAll(findValue, replaceValue) });
      }
    }
    return results;
  }, [findValue, replaceValue, findReplaceOpen, allAssets, getAssetDisplayName]);

  // ── Tree rendering ─────────────────────────────────────────────────────────

  const renderTreeNode = (node: TreeNode, depth: number): React.ReactNode => {
    const isExpanded = expanded.has(node.path);
    const hasChildren = node.children.length > 0;
    const isActive = selectedView === node.path;
    const isDragOver = dragOverPath === node.path;

    if (renamingPath === node.path) {
      return (
        <div key={node.path} style={{ paddingLeft: 8 + depth * 16 }}>
          <div style={styles.renameRow}>
            <input
              autoFocus
              style={styles.renameInput}
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleRenameSubmit();
                if (e.key === 'Escape') { setRenamingPath(null); setRenameValue(''); }
              }}
              onBlur={handleRenameSubmit}
            />
          </div>
        </div>
      );
    }

    return (
      <div key={node.path}>
        <button
          style={{
            ...styles.treeItem,
            paddingLeft: 8 + depth * 16,
            ...(isActive ? styles.treeItemActive : {}),
            ...(isDragOver ? styles.treeItemDragOver : {}),
          }}
          onClick={() => setSelectedView(node.path)}
          onContextMenu={(e) => handleNodeContextMenu(e, node.path)}
          onDragOver={(e) => { e.preventDefault(); setDragOverPath(node.path); }}
          onDragLeave={() => setDragOverPath(null)}
          onDrop={(e) => handleDropOnNode(node.path, e)}
        >
          {hasChildren ? (
            <span
              style={styles.chevron}
              onClick={(e) => { e.stopPropagation(); toggleExpand(node.path); }}
            >
              {isExpanded ? '▾' : '▸'}
            </span>
          ) : (
            <span style={styles.chevronSpacer} />
          )}
          <span style={styles.treeName}>{node.name}</span>
          <span style={styles.treeCount}>{node.totalAssetCount}</span>
        </button>
        {isExpanded && hasChildren && node.children.map((c) => renderTreeNode(c, depth + 1))}
      </div>
    );
  };

  return (
    <div style={styles.container}>
      {/* Sidebar: tree */}
      <div style={styles.sidebar}>
        <div style={styles.sidebarHeader}>
          {editingRootLabel ? (
            <input
              autoFocus
              style={styles.renameInput}
              value={rootLabelValue}
              onChange={(e) => setRootLabelValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitRootLabel();
                if (e.key === 'Escape') setEditingRootLabel(false);
              }}
              onBlur={submitRootLabel}
            />
          ) : (
            <span
              style={styles.sidebarTitle}
              onDoubleClick={() => { setRootLabelValue(library.rootLabel); setEditingRootLabel(true); }}
              title="Double-click to edit"
            >
              {library.rootLabel}
            </span>
          )}
        </div>

        <div style={styles.catList}>
          <button
            style={{ ...styles.treeItem, ...(selectedView === ALL_VIEW ? styles.treeItemActive : {}) }}
            onClick={() => setSelectedView(ALL_VIEW)}
          >
            <span style={styles.chevronSpacer} />
            <span style={styles.treeName}>All Assets</span>
            <span style={styles.treeCount}>{allAssets.length}</span>
          </button>

          {categoryTree.map((node) => renderTreeNode(node, 0))}

          <button
            style={{
              ...styles.treeItem,
              ...(selectedView === UNCATEGORIZED ? styles.treeItemActive : {}),
              ...(dragOverPath === UNCATEGORIZED ? styles.treeItemDragOver : {}),
              marginTop: 4,
              borderTop: '1px solid var(--border)',
            }}
            onClick={() => setSelectedView(UNCATEGORIZED)}
            onDragOver={(e) => { e.preventDefault(); setDragOverPath(UNCATEGORIZED); }}
            onDragLeave={() => setDragOverPath(null)}
            onDrop={(e) => handleDropOnNode(UNCATEGORIZED, e)}
          >
            <span style={styles.chevronSpacer} />
            <span style={{ ...styles.treeName, color: 'var(--text-muted)' }}>Uncategorized</span>
            <span style={styles.treeCount}>{totalUncategorized}</span>
          </button>
        </div>

        <div style={styles.newCatSection}>
          <input
            type="text"
            placeholder="New category (use / for nesting)"
            value={newCatName}
            onChange={(e) => setNewCatName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleAddCategory()}
            style={styles.newCatInput}
          />
          <button style={styles.newCatBtn} onClick={handleAddCategory} disabled={!newCatName.trim()}>+</button>
        </div>
      </div>

      {/* Main area */}
      <div style={styles.main}>
        <div style={styles.topBar}>
          <input
            type="text"
            placeholder="Search by ID or name..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={styles.searchInput}
          />
          <span style={styles.resultCount}>{filtered.length} assets</span>
          <div style={{ flex: 1 }} />
          {selectedIds.size > 0 && (
            <span style={styles.selectionInfo}>
              {selectedIds.size} selected
              <button style={styles.clearSelBtn} onClick={clearSelection}>Clear</button>
            </span>
          )}
          <button style={styles.toolBtn} onClick={selectAll}>Select All</button>
          <button style={styles.toolBtn} onClick={() => setFindReplaceOpen(true)}>Find & Replace</button>
          <button
            style={styles.importBtn}
            onClick={() => {
              setImportTargetCat(selectedView === ALL_VIEW || selectedView === UNCATEGORIZED ? '' : selectedView);
              setImportOpen(true);
            }}
          >
            Import
          </button>
        </div>

        <div style={styles.hint}>
          Shift/Cmd+click to multi-select, then drag onto a category. Right-click asset for options.
        </div>

        <div style={styles.gridArea}>
          {filtered.length === 0 ? (
            <div style={styles.empty}>No assets found</div>
          ) : (
            <div style={styles.grid}>
              {filtered.map((asset) => {
                const isSelected = selectedIds.has(asset.id);
                const hasTileOverride = tileOverrides[asset.id] !== undefined;
                const isCustom = customAssetMap.has(asset.id);
                const displayName = getAssetDisplayName(asset.id);
                return (
                  <div
                    key={asset.id}
                    draggable={isSelected}
                    onDragStart={isSelected ? handleDragStartFromGrid : undefined}
                    onClick={(e) => toggleSelect(asset.id, e)}
                    onContextMenu={(e) => handleAssetContextMenu(e, asset.id)}
                    style={{
                      ...styles.card,
                      ...(isSelected ? styles.cardSelected : {}),
                    }}
                    title={`#${asset.id} — ${displayName} (${asset.spanW}×${asset.spanH})${hasTileOverride ? ' [custom tiles]' : ''}${isCustom ? ' [imported]' : ''}`}
                  >
                    <div style={{
                      ...styles.cardImg,
                      aspectRatio: asset.spanW >= asset.spanH ? '1' : `${asset.spanW}/${asset.spanH}`,
                    }}>
                      <AssetThumbnail
                        assetId={asset.id}
                        path={asset.path}
                        tileOverrides={tileOverrides}
                      />
                      {hasTileOverride && <div style={styles.tileDot} />}
                      {isCustom && <div style={styles.customDot} />}
                    </div>
                    {isSelected && <div style={styles.selectionOverlay} />}
                    <div style={styles.cardInfo}>
                      {renamingAssetId === asset.id ? (
                        <input
                          autoFocus
                          style={styles.assetRenameInput}
                          value={assetRenameValue}
                          onChange={(e) => setAssetRenameValue(e.target.value)}
                          onClick={(e) => e.stopPropagation()}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleAssetRenameSubmit();
                            if (e.key === 'Escape') { setRenamingAssetId(null); setAssetRenameValue(''); }
                          }}
                          onBlur={handleAssetRenameSubmit}
                        />
                      ) : (
                        <span
                          style={styles.cardName}
                          onDoubleClick={(e) => {
                            e.stopPropagation();
                            setRenamingAssetId(asset.id);
                            setAssetRenameValue(displayName);
                          }}
                        >
                          #{asset.id}
                        </span>
                      )}
                      <span style={styles.cardSize}>{asset.spanW}×{asset.spanH}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Category context menu */}
      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={getCatContextItems(ctxMenu.path)}
          onClose={() => setCtxMenu(null)}
        />
      )}

      {/* Asset context menu */}
      {assetCtxMenu && (
        <ContextMenu
          x={assetCtxMenu.x}
          y={assetCtxMenu.y}
          items={getAssetContextItems(assetCtxMenu.targetIds)}
          onClose={() => setAssetCtxMenu(null)}
        />
      )}

      {/* Confirmation dialog */}
      {confirmDialog && (
        <div style={styles.overlay} onClick={() => setConfirmDialog(null)}>
          <div style={styles.confirmDialog} onClick={(e) => e.stopPropagation()}>
            <div style={styles.confirmIcon}>⚠️</div>
            <div style={styles.confirmMsg}>{confirmDialog.message}</div>
            {confirmDialog.detail && (
              <div style={styles.confirmDetail}>{confirmDialog.detail}</div>
            )}
            <div style={styles.confirmActions}>
              <button style={styles.confirmCancelBtn} onClick={() => setConfirmDialog(null)}>
                Cancel
              </button>
              <button style={styles.confirmDeleteBtn} onClick={confirmDialog.onConfirm}>
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Tile editor modal */}
      {tileEditorAsset !== null && (
        <TileEditor
          assetId={tileEditorAsset}
          tileOverrides={tileOverrides}
          onSave={(tiles) => onSetTileOverride(tileEditorAsset, tiles)}
          onReset={() => onClearTileOverride(tileEditorAsset)}
          onClose={() => setTileEditorAsset(null)}
        />
      )}

      {/* Import dialog */}
      {importOpen && (
        <ImportDialog
          targetCategory={importTargetCat}
          onImport={async (assets) => {
            const created = await onAddCustomAssets(assets);
            const cat = assets[0]?.category;
            if (cat) onMoveAssets(created.map((a) => a.id), cat);
          }}
          onClose={() => setImportOpen(false)}
        />
      )}

      {/* Move to category picker */}
      {movePickerOpen && (
        <div style={styles.overlay} onClick={() => setMovePickerOpen(false)}>
          <div style={styles.moveDialog} onClick={(e) => e.stopPropagation()}>
            <div style={styles.frHeader}>
              <span style={styles.frTitle}>
                Move {movePickerIds.length > 1 ? `${movePickerIds.length} assets` : `#${movePickerIds[0]}`} to...
              </span>
              <button style={styles.frCloseBtn} onClick={() => setMovePickerOpen(false)}>✕</button>
            </div>
            <div style={styles.moveSearch}>
              <input
                autoFocus
                type="text"
                placeholder="Search categories..."
                value={movePickerSearch}
                onChange={(e) => setMovePickerSearch(e.target.value)}
                style={styles.frInput}
              />
            </div>
            <div style={styles.moveList}>
              {allCategoryPaths
                .filter((p) => !movePickerSearch || p.toLowerCase().includes(movePickerSearch.toLowerCase()))
                .map((p) => (
                  <button
                    key={p}
                    style={styles.moveItem}
                    onClick={() => {
                      onMoveAssets(movePickerIds, p);
                      setMovePickerOpen(false);
                      setSelectedIds(new Set());
                    }}
                  >
                    <span style={styles.moveFolderIcon}>📁</span>
                    <span style={styles.movePath}>{p}</span>
                  </button>
                ))}
              {allCategoryPaths.filter((p) => !movePickerSearch || p.toLowerCase().includes(movePickerSearch.toLowerCase())).length === 0 && (
                <div style={styles.empty}>No matching categories</div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Find & Replace dialog */}
      {findReplaceOpen && (
        <div style={styles.overlay} onClick={() => setFindReplaceOpen(false)}>
          <div style={styles.frDialog} onClick={(e) => e.stopPropagation()}>
            <div style={styles.frHeader}>
              <span style={styles.frTitle}>Find & Replace Asset Names</span>
              <button style={styles.frCloseBtn} onClick={() => setFindReplaceOpen(false)}>✕</button>
            </div>
            <div style={styles.frBody}>
              <div style={styles.frRow}>
                <label style={styles.frLabel}>Find</label>
                <input
                  autoFocus
                  style={styles.frInput}
                  value={findValue}
                  onChange={(e) => setFindValue(e.target.value)}
                  placeholder="Text to find..."
                />
              </div>
              <div style={styles.frRow}>
                <label style={styles.frLabel}>Replace</label>
                <input
                  style={styles.frInput}
                  value={replaceValue}
                  onChange={(e) => setReplaceValue(e.target.value)}
                  placeholder="Replace with..."
                />
              </div>
              {findValue && (
                <div style={styles.frPreview}>
                  <div style={styles.frPreviewHeader}>
                    {findReplacePreview.length} match{findReplacePreview.length !== 1 ? 'es' : ''}
                  </div>
                  <div style={styles.frPreviewList}>
                    {findReplacePreview.slice(0, 50).map((r) => (
                      <div key={r.id} style={styles.frPreviewRow}>
                        <span style={styles.frPreviewId}>#{r.id}</span>
                        <span style={styles.frPreviewBefore}>{r.before}</span>
                        <span style={styles.frPreviewArrow}>→</span>
                        <span style={styles.frPreviewAfter}>{r.after}</span>
                      </div>
                    ))}
                    {findReplacePreview.length > 50 && (
                      <div style={styles.frPreviewRow}>
                        <span style={styles.frPreviewId}>...</span>
                        <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>
                          and {findReplacePreview.length - 50} more
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
            <div style={styles.frFooter}>
              <button style={styles.frCancelBtn} onClick={() => setFindReplaceOpen(false)}>Cancel</button>
              <button
                style={styles.frApplyBtn}
                disabled={!findValue || findReplacePreview.length === 0}
                onClick={() => {
                  const count = onBatchRename(findValue, replaceValue);
                  if (count > 0) {
                    setFindValue('');
                    setReplaceValue('');
                    setFindReplaceOpen(false);
                  }
                }}
              >
                Apply All ({findReplacePreview.length})
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: { display: 'flex', height: '100%', width: '100%', overflow: 'hidden' },
  sidebar: {
    width: 240, minWidth: 240, background: 'var(--bg-secondary)', borderRight: '1px solid var(--border)',
    display: 'flex', flexDirection: 'column', overflow: 'hidden',
  },
  sidebarHeader: {
    padding: '10px 14px', borderBottom: '1px solid var(--border)', display: 'flex',
    alignItems: 'center', justifyContent: 'space-between', flexShrink: 0,
  },
  sidebarTitle: { fontWeight: 600, fontSize: 13, color: 'var(--text-primary)', cursor: 'default' },
  catList: { flex: 1, overflowY: 'auto', padding: '4px 0' },
  treeItem: {
    width: '100%', padding: '6px 10px', display: 'flex', alignItems: 'center', gap: 4,
    background: 'transparent', fontSize: 12, cursor: 'pointer', color: 'var(--text-secondary)',
    borderLeft: '3px solid transparent', textAlign: 'left' as const,
  },
  treeItemActive: { background: 'var(--accent-dim)', color: 'var(--accent)', borderLeftColor: 'var(--accent)' },
  treeItemDragOver: { background: 'rgba(79, 195, 247, 0.25)', borderLeftColor: 'var(--accent)' },
  chevron: { fontSize: 10, color: 'var(--text-muted)', width: 12, flexShrink: 0, cursor: 'pointer', textAlign: 'center' as const },
  chevronSpacer: { width: 12, flexShrink: 0 },
  treeName: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const },
  treeCount: { fontSize: 10, color: 'var(--text-muted)', fontFamily: 'monospace', flexShrink: 0 },
  renameRow: { padding: '2px 0' },
  renameInput: {
    width: '100%', padding: '4px 8px', border: '1px solid var(--accent)', borderRadius: 3,
    background: 'var(--bg-primary)', fontSize: 12, color: 'var(--text-primary)', outline: 'none',
  },
  newCatSection: {
    padding: '8px 10px', borderTop: '1px solid var(--border)', display: 'flex', gap: 4, flexShrink: 0,
  },
  newCatInput: {
    flex: 1, padding: '4px 8px', border: '1px solid var(--border)', borderRadius: 3,
    background: 'var(--bg-primary)', fontSize: 11,
  },
  newCatBtn: {
    width: 28, border: '1px solid var(--border)', borderRadius: 3, background: 'var(--bg-surface)',
    fontSize: 14, cursor: 'pointer', color: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  main: { flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' },
  topBar: {
    padding: '10px 16px', borderBottom: '1px solid var(--border)', display: 'flex',
    alignItems: 'center', gap: 10, flexShrink: 0, background: 'var(--bg-secondary)',
  },
  searchInput: {
    padding: '6px 10px', border: '1px solid var(--border)', borderRadius: 4,
    background: 'var(--bg-primary)', fontSize: 12, width: 220,
  },
  resultCount: { fontSize: 11, color: 'var(--text-muted)' },
  selectionInfo: { fontSize: 11, color: 'var(--accent)', display: 'flex', alignItems: 'center', gap: 6 },
  clearSelBtn: {
    padding: '1px 6px', border: '1px solid var(--border)', borderRadius: 3,
    background: 'var(--bg-surface)', fontSize: 10, cursor: 'pointer', color: 'var(--text-secondary)',
  },
  toolBtn: {
    padding: '4px 10px', border: '1px solid var(--border)', borderRadius: 4,
    background: 'var(--bg-surface)', fontSize: 11, cursor: 'pointer', color: 'var(--text-secondary)', flexShrink: 0,
  },
  importBtn: {
    padding: '4px 10px', border: '1px solid var(--accent)', borderRadius: 4,
    background: 'var(--accent-dim)', fontSize: 11, cursor: 'pointer', color: 'var(--accent)', fontWeight: 500, flexShrink: 0,
  },
  hint: {
    padding: '6px 16px', fontSize: 11, color: 'var(--text-muted)',
    borderBottom: '1px solid var(--border)', background: 'var(--bg-primary)', flexShrink: 0,
  },
  gridArea: { flex: 1, overflowY: 'auto', padding: '12px 16px', background: 'var(--bg-primary)' },
  empty: { color: 'var(--text-muted)', textAlign: 'center' as const, marginTop: 60, fontSize: 14 },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(100px, 1fr))', gap: 6 },
  card: { position: 'relative' as const, borderRadius: 6, background: 'var(--bg-surface)', overflow: 'hidden', cursor: 'pointer' },
  cardSelected: { background: 'var(--accent-dim)' },
  selectionOverlay: {
    position: 'absolute' as const, inset: 0, borderRadius: 6, border: '2px solid var(--accent)',
    pointerEvents: 'none' as const, zIndex: 2,
  },
  cardImg: {
    position: 'relative' as const, background: 'var(--bg-primary)', display: 'flex',
    alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
  },
  tileDot: {
    position: 'absolute' as const, top: 4, right: 4, width: 6, height: 6, borderRadius: '50%', background: 'var(--accent)',
  },
  customDot: {
    position: 'absolute' as const, bottom: 4, right: 4, width: 6, height: 6, borderRadius: '50%', background: '#81c784',
  },
  cardInfo: { padding: '4px 6px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  cardName: {
    fontSize: 10, color: 'var(--text-muted)', fontFamily: 'monospace', cursor: 'text',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const, flex: 1,
  },
  cardSize: {
    fontSize: 9, color: 'var(--text-muted)', fontFamily: 'monospace',
    background: 'var(--bg-primary)', padding: '1px 4px', borderRadius: 2, flexShrink: 0,
  },
  assetRenameInput: {
    flex: 1, padding: '2px 4px', border: '1px solid var(--accent)', borderRadius: 2,
    background: 'var(--bg-primary)', fontSize: 10, color: 'var(--text-primary)', outline: 'none',
  },

  // Confirmation dialog
  confirmDialog: {
    width: 360, background: 'var(--bg-secondary)', borderRadius: 10,
    border: '1px solid var(--border)', padding: '28px 24px 20px',
    boxShadow: '0 12px 40px rgba(0,0,0,0.5)', textAlign: 'center' as const,
  },
  confirmIcon: { fontSize: 32, marginBottom: 12 },
  confirmMsg: { fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 6 },
  confirmDetail: { fontSize: 12, color: 'var(--text-muted)', marginBottom: 20 },
  confirmActions: { display: 'flex', gap: 10, justifyContent: 'center' },
  confirmCancelBtn: {
    padding: '8px 20px', border: '1px solid var(--border)', borderRadius: 6,
    background: 'var(--bg-surface)', fontSize: 12, cursor: 'pointer', color: 'var(--text-secondary)',
    fontWeight: 500,
  },
  confirmDeleteBtn: {
    padding: '8px 20px', border: '1px solid var(--danger)', borderRadius: 6,
    background: 'var(--danger)', fontSize: 12, cursor: 'pointer', color: '#fff',
    fontWeight: 600,
  },

  // Move picker dialog
  moveDialog: {
    width: 380, maxHeight: '70vh', background: 'var(--bg-secondary)', borderRadius: 8,
    border: '1px solid var(--border)', overflow: 'hidden', display: 'flex', flexDirection: 'column',
    boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
  },
  moveSearch: { padding: '8px 12px', borderBottom: '1px solid var(--border)' },
  moveList: { flex: 1, overflowY: 'auto', padding: '4px 0' },
  moveItem: {
    width: '100%', padding: '8px 14px', background: 'transparent', border: 'none', display: 'flex',
    alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-primary)', cursor: 'pointer',
    textAlign: 'left' as const,
  },
  moveFolderIcon: { fontSize: 14, flexShrink: 0 },
  movePath: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const },

  // Find & Replace dialog
  overlay: {
    position: 'fixed' as const, inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex',
    alignItems: 'center', justifyContent: 'center', zIndex: 1000,
  },
  frDialog: {
    width: 520, background: 'var(--bg-secondary)', borderRadius: 8,
    border: '1px solid var(--border)', overflow: 'hidden',
    boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
  },
  frHeader: {
    padding: '12px 16px', borderBottom: '1px solid var(--border)', display: 'flex',
    alignItems: 'center', justifyContent: 'space-between',
  },
  frTitle: { fontWeight: 600, fontSize: 13, color: 'var(--text-primary)' },
  frCloseBtn: {
    background: 'transparent', border: 'none', color: 'var(--text-muted)', fontSize: 14, cursor: 'pointer',
  },
  frBody: { padding: 16, display: 'flex', flexDirection: 'column', gap: 12 },
  frRow: { display: 'flex', alignItems: 'center', gap: 10 },
  frLabel: { width: 60, fontSize: 12, color: 'var(--text-secondary)', flexShrink: 0 },
  frInput: {
    flex: 1, padding: '6px 10px', border: '1px solid var(--border)', borderRadius: 4,
    background: 'var(--bg-primary)', fontSize: 12,
  },
  frPreview: { borderTop: '1px solid var(--border)', paddingTop: 12 },
  frPreviewHeader: { fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 },
  frPreviewList: { maxHeight: 200, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 },
  frPreviewRow: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, padding: '2px 4px', borderRadius: 3, background: 'var(--bg-primary)' },
  frPreviewId: { color: 'var(--text-muted)', fontFamily: 'monospace', width: 40, flexShrink: 0 },
  frPreviewBefore: { color: 'var(--danger)', textDecoration: 'line-through', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const },
  frPreviewArrow: { color: 'var(--text-muted)', flexShrink: 0 },
  frPreviewAfter: { color: '#81c784', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const },
  frFooter: {
    padding: '12px 16px', borderTop: '1px solid var(--border)', display: 'flex',
    justifyContent: 'flex-end', gap: 8,
  },
  frCancelBtn: {
    padding: '6px 14px', border: '1px solid var(--border)', borderRadius: 4,
    background: 'var(--bg-surface)', fontSize: 12, cursor: 'pointer', color: 'var(--text-secondary)',
  },
  frApplyBtn: {
    padding: '6px 14px', border: '1px solid var(--accent)', borderRadius: 4,
    background: 'var(--accent-dim)', fontSize: 12, cursor: 'pointer', color: 'var(--accent)', fontWeight: 500,
  },
};
