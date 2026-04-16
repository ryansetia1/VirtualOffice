import { useState, useCallback, useRef } from 'react';
import type { LayerType } from '../hooks/useGrid';
import type { ToolType, EditorMode, DrawSubTool } from '../hooks/useTool';

function blurTarget(e: React.MouseEvent) {
  (e.currentTarget as HTMLElement).blur();
}

interface Props {
  gridWidth: number;
  gridHeight: number;
  activeLayer: LayerType;
  activeTool: ToolType;
  activeMode: EditorMode;
  activeDrawSubTool: DrawSubTool;
  rotation: number;
  flipH: boolean;
  flipV: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onResize: (w: number, h: number) => void;
  onToolChange: (tool: ToolType) => void;
  onModeChange: (mode: EditorMode) => void;
  onDrawSubToolChange: (sub: DrawSubTool) => void;
  onRotate: () => void;
  onFlipH: () => void;
  onFlipV: () => void;
  onResetTransform: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onExport: () => void;
  onImport: () => void;
  onClear: () => void;
}

const DRAW_SUBS: { key: DrawSubTool; label: string; desc: string }[] = [
  { key: 'brush', label: 'Brush', desc: 'Click/drag to paint tiles one by one' },
  { key: 'marquee', label: 'Marquee', desc: 'Drag a rectangle to fill area with selected asset' },
];

export default function Toolbar({
  gridWidth,
  gridHeight,
  activeLayer,
  activeTool,
  activeMode,
  activeDrawSubTool,
  rotation,
  flipH,
  flipV,
  canUndo,
  canRedo,
  onResize,
  onToolChange,
  onModeChange,
  onDrawSubToolChange,
  onRotate,
  onFlipH,
  onFlipV,
  onResetTransform,
  onUndo,
  onRedo,
  onExport,
  onImport,
  onClear,
}: Props) {
  const [editW, setEditW] = useState(String(gridWidth));
  const [editH, setEditH] = useState(String(gridHeight));

  const [paintDropdown, setPaintDropdown] = useState(false);
  const [dropdownPos, setDropdownPos] = useState({ left: 0, top: 0 });
  const paintBtnRef = useRef<HTMLDivElement>(null);
  const paintDropdownTimer = useRef<ReturnType<typeof setTimeout>>();

  const openPaintDropdown = () => {
    clearTimeout(paintDropdownTimer.current);
    if (paintBtnRef.current) {
      const rect = paintBtnRef.current.getBoundingClientRect();
      setDropdownPos({ left: rect.left, top: rect.bottom + 2 });
    }
    setPaintDropdown(true);
  };
  const closePaintDropdown = () => {
    paintDropdownTimer.current = setTimeout(() => setPaintDropdown(false), 150);
  };

  const toolsDisabled = activeMode === 'select' || activeMode === 'place';

  const handleResize = useCallback(() => {
    const w = Math.max(5, Math.min(100, parseInt(editW) || 20));
    const h = Math.max(5, Math.min(100, parseInt(editH) || 15));
    setEditW(String(w));
    setEditH(String(h));
    onResize(w, h);
  }, [editW, editH, onResize]);

  return (
    <div style={styles.bar}>
      <div style={styles.group}>
        <span style={styles.label}>Grid</span>
        <input
          type="number"
          min={5}
          max={100}
          value={editW}
          onChange={(e) => setEditW(e.target.value)}
          onBlur={handleResize}
          onKeyDown={(e) => e.key === 'Enter' && handleResize()}
          style={styles.numberInput}
        />
        <span style={styles.sep}>×</span>
        <input
          type="number"
          min={5}
          max={100}
          value={editH}
          onChange={(e) => setEditH(e.target.value)}
          onBlur={handleResize}
          onKeyDown={(e) => e.key === 'Enter' && handleResize()}
          style={styles.numberInput}
        />
      </div>

      <div style={styles.divider} />

      <div style={styles.group}>
        <span style={styles.label}>Layer</span>
        <span style={styles.layerIndicator}>{activeLayer.charAt(0).toUpperCase() + activeLayer.slice(1)}</span>
      </div>

      <div style={styles.divider} />

      <div style={styles.group}>
        <span style={styles.label}>Mode</span>
        {(['select', 'draw', 'place'] as EditorMode[]).map((m) => (
          <button
            key={m}
            onClick={(e) => { onModeChange(m); blurTarget(e); }}
            style={{ ...styles.btn, ...(activeMode === m ? styles.btnActive : styles.btnInactive) }}
            title={m === 'select' ? 'Select & move placements' : m === 'draw' ? 'Draw tiles on the grid' : 'Click to pick up & reposition placed tiles'}
          >
            {m.charAt(0).toUpperCase() + m.slice(1)}
          </button>
        ))}
      </div>

      <div style={styles.divider} />

      <div style={styles.group}>
        <span style={styles.label}>Tool</span>
        {/* Paint button with hover dropdown for Brush/Marquee */}
        <div
          ref={paintBtnRef}
          style={styles.dropdownWrap}
          onMouseEnter={toolsDisabled ? undefined : openPaintDropdown}
          onMouseLeave={toolsDisabled ? undefined : closePaintDropdown}
        >
          <button
            onClick={(e) => { if (!toolsDisabled) onToolChange('paint'); blurTarget(e); }}
            disabled={toolsDisabled}
            style={{ ...styles.btn, ...(toolsDisabled ? styles.btnDisabled : activeTool === 'paint' ? styles.btnActive : styles.btnInactive), ...styles.dropdownBtn }}
            title={toolsDisabled ? `Tools disabled in ${activeMode} mode` : `Paint: ${activeDrawSubTool}`}
          >
            Paint
            <span style={styles.dropdownArrow}>▾</span>
          </button>
          {paintDropdown && !toolsDisabled && (
            <div
              style={{ ...styles.dropdown, left: dropdownPos.left, top: dropdownPos.top }}
              onMouseEnter={openPaintDropdown}
              onMouseLeave={closePaintDropdown}
            >
              {DRAW_SUBS.map((s) => (
                <button
                  key={s.key}
                  style={{
                    ...styles.dropdownItem,
                    ...(activeDrawSubTool === s.key ? styles.dropdownItemActive : {}),
                  }}
                  onClick={(e) => {
                    onDrawSubToolChange(s.key);
                    setPaintDropdown(false);
                    blurTarget(e);
                  }}
                  title={s.desc}
                >
                  <span style={styles.dropdownCheck}>{activeDrawSubTool === s.key ? '✓' : ''}</span>
                  {s.label}
                </button>
              ))}
            </div>
          )}
        </div>
        <button
          onClick={(e) => { if (!toolsDisabled) onToolChange('erase'); blurTarget(e); }}
          disabled={toolsDisabled}
          style={{ ...styles.btn, ...(toolsDisabled ? styles.btnDisabled : activeTool === 'erase' ? styles.btnActive : styles.btnInactive) }}
          title={toolsDisabled ? `Tools disabled in ${activeMode} mode` : 'Erase'}
        >
          Erase
        </button>
      </div>

      <div style={styles.divider} />

      <div style={styles.group}>
        <span style={styles.label}>Transform</span>
        <button
          style={{ ...styles.btn, ...(rotation !== 0 ? styles.btnActive : styles.btnInactive) }}
          onClick={(e) => { onRotate(); blurTarget(e); }}
          title="Rotate 90° (R)"
        >
          ↻ {rotation > 0 ? `${rotation}°` : ''}
        </button>
        <button
          style={{ ...styles.btn, ...(flipH ? styles.btnActive : styles.btnInactive) }}
          onClick={(e) => { onFlipH(); blurTarget(e); }}
          title="Flip horizontal (F)"
        >
          ⇔
        </button>
        <button
          style={{ ...styles.btn, ...(flipV ? styles.btnActive : styles.btnInactive) }}
          onClick={(e) => { onFlipV(); blurTarget(e); }}
          title="Flip vertical (V)"
        >
          ⇕
        </button>
        {(rotation !== 0 || flipH || flipV) && (
          <button
            style={{ ...styles.btn, ...styles.btnInactive }}
            onClick={(e) => { onResetTransform(); blurTarget(e); }}
            title="Reset transform"
          >
            ✕
          </button>
        )}
      </div>

      <div style={styles.divider} />

      <div style={styles.group}>
        <button
          style={{ ...styles.btn, ...(canUndo ? styles.btnInactive : styles.btnDisabled) }}
          onClick={(e) => { onUndo(); blurTarget(e); }}
          disabled={!canUndo}
          title="Undo (Ctrl+Z)"
        >
          ↩
        </button>
        <button
          style={{ ...styles.btn, ...(canRedo ? styles.btnInactive : styles.btnDisabled) }}
          onClick={(e) => { onRedo(); blurTarget(e); }}
          disabled={!canRedo}
          title="Redo (Ctrl+Shift+Z)"
        >
          ↪
        </button>
      </div>

      <div style={{ flex: 1 }} />

      <div style={styles.group}>
        <button style={styles.actionBtn} onClick={(e) => { onExport(); blurTarget(e); }} title="Export project to JSON file">
          Export
        </button>
        <button style={styles.actionBtn} onClick={(e) => { onImport(); blurTarget(e); }} title="Import project from JSON file">
          Import
        </button>
        <button style={{ ...styles.actionBtn, ...styles.dangerBtn }} onClick={(e) => { onClear(); blurTarget(e); }}>
          Clear
        </button>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  bar: {
    height: 'var(--toolbar-height)',
    minHeight: 'var(--toolbar-height)',
    background: 'var(--bg-secondary)',
    borderBottom: '1px solid var(--border)',
    display: 'flex',
    alignItems: 'center',
    padding: '0 12px',
    gap: '4px',
    userSelect: 'none',
    overflow: 'hidden',
  },
  group: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    flexShrink: 0,
  },
  label: {
    fontSize: '10px',
    color: 'var(--text-muted)',
    fontWeight: 600,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.5px',
    marginRight: '2px',
  },
  layerIndicator: {
    fontSize: 12,
    fontWeight: 600,
    color: 'var(--accent)',
    background: 'var(--accent-dim)',
    padding: '2px 8px',
    borderRadius: 4,
  },
  numberInput: {
    width: '44px',
    padding: '3px 5px',
    border: '1px solid var(--border)',
    borderRadius: '4px',
    background: 'var(--bg-primary)',
    textAlign: 'center' as const,
    fontSize: '12px',
  },
  sep: {
    color: 'var(--text-muted)',
    fontSize: '12px',
  },
  btn: {
    padding: '3px 9px',
    borderRadius: '4px',
    fontSize: '12px',
    whiteSpace: 'nowrap' as const,
    cursor: 'pointer',
  },
  btnActive: {
    background: 'var(--accent-dim)',
    border: '1px solid var(--accent)',
    color: 'var(--accent)',
  },
  btnInactive: {
    background: 'var(--bg-surface)',
    border: '1px solid transparent',
    color: 'inherit',
  },
  btnDisabled: {
    background: 'var(--bg-surface)',
    border: '1px solid transparent',
    color: 'var(--text-muted)',
    opacity: 0.4,
    cursor: 'default',
  },
  divider: {
    width: '1px',
    height: '20px',
    background: 'var(--border)',
    margin: '0 6px',
    flexShrink: 0,
  },
  actionBtn: {
    padding: '3px 10px',
    borderRadius: '4px',
    border: '1px solid var(--border)',
    background: 'var(--bg-surface)',
    fontSize: '12px',
    fontWeight: 500,
    cursor: 'pointer',
    whiteSpace: 'nowrap' as const,
  },
  dangerBtn: {
    borderColor: 'rgba(239, 83, 80, 0.3)',
    color: 'var(--danger)',
  },
  dropdownWrap: {
    position: 'relative' as const,
  },
  dropdownBtn: {
    display: 'flex',
    alignItems: 'center',
    gap: 3,
  },
  dropdownArrow: {
    fontSize: 8,
    opacity: 0.6,
  },
  dropdown: {
    position: 'fixed' as const,
    background: 'var(--bg-surface)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    padding: '4px 0',
    minWidth: 120,
    boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
    zIndex: 9999,
  },
  dropdownItem: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    width: '100%',
    padding: '6px 12px',
    background: 'transparent',
    border: 'none',
    fontSize: 12,
    color: 'var(--text-primary)',
    cursor: 'pointer',
    textAlign: 'left' as const,
    whiteSpace: 'nowrap' as const,
  },
  dropdownItemActive: {
    color: 'var(--accent)',
    background: 'var(--accent-dim)',
  },
  dropdownCheck: {
    width: 14,
    fontSize: 10,
    flexShrink: 0,
  },
};
