import { useState, useEffect, useRef, useCallback } from 'react';
import { getAssetTileInfo, getAssetPath } from '../data/assetManifest';

const TILE = 48;
const COLS = 2;
const ROWS = 3;
const SCALE = 3;
const CELL = TILE * SCALE;

interface Props {
  assetId: number;
  tileOverrides: Record<number, [number, number][]>;
  onSave: (tiles: [number, number][]) => void;
  onReset: () => void;
  onClose: () => void;
}

export default function TileEditor({ assetId, tileOverrides, onSave, onReset, onClose }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);

  const autoTiles = getAssetTileInfo(assetId).tiles;
  const existingOverride = tileOverrides[assetId];

  const [activeTiles, setActiveTiles] = useState<Set<string>>(() => {
    const source = existingOverride ?? autoTiles;
    return new Set(source.map(([c, r]) => `${c},${r}`));
  });

  // Load image
  useEffect(() => {
    const img = new Image();
    img.src = getAssetPath(assetId);
    img.onload = () => {
      imgRef.current = img;
      draw();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assetId]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = false;

    // Draw checkerboard pattern behind the image (Photoshop-style transparency)
    const checkerSize = 8;
    for (let y = 0; y < canvas.height; y += checkerSize) {
      for (let x = 0; x < canvas.width; x += checkerSize) {
        const isLight = ((x / checkerSize) + (y / checkerSize)) % 2 === 0;
        ctx.fillStyle = isLight ? '#3a3a3a' : '#2a2a2a';
        ctx.fillRect(x, y, checkerSize, checkerSize);
      }
    }

    // Draw scaled image on top of checkerboard
    ctx.drawImage(img, 0, 0, COLS * CELL, ROWS * CELL);

    // Overlay grid
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const key = `${c},${r}`;
        const isActive = activeTiles.has(key);
        const x = c * CELL;
        const y = r * CELL;

        if (!isActive) {
          ctx.fillStyle = 'rgba(0, 0, 0, 0.65)';
          ctx.fillRect(x, y, CELL, CELL);
        } else {
          ctx.strokeStyle = 'rgba(79, 195, 247, 0.6)';
          ctx.lineWidth = 2;
          ctx.strokeRect(x + 1, y + 1, CELL - 2, CELL - 2);
        }

        // Grid lines
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
        ctx.lineWidth = 1;
        ctx.strokeRect(x, y, CELL, CELL);
      }
    }
  }, [activeTiles, assetId]);

  useEffect(() => {
    draw();
  }, [draw]);

  const handleCanvasClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const x = (e.clientX - rect.left) * scaleX;
    const y = (e.clientY - rect.top) * scaleY;
    const col = Math.floor(x / CELL);
    const row = Math.floor(y / CELL);
    if (col < 0 || col >= COLS || row < 0 || row >= ROWS) return;

    const key = `${col},${row}`;
    setActiveTiles((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const handleSave = useCallback(() => {
    const tiles: [number, number][] = [];
    for (const key of activeTiles) {
      const [c, r] = key.split(',').map(Number);
      tiles.push([c, r]);
    }
    if (tiles.length === 0) return;
    tiles.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    onSave(tiles);
    onClose();
  }, [activeTiles, onSave, onClose]);

  const handleReset = useCallback(() => {
    onReset();
    const auto = new Set(autoTiles.map(([c, r]) => `${c},${r}`));
    setActiveTiles(auto);
  }, [autoTiles, onReset]);

  const hasChanges = (() => {
    const autoSet = new Set(autoTiles.map(([c, r]) => `${c},${r}`));
    if (activeTiles.size !== autoSet.size) return true;
    for (const k of activeTiles) if (!autoSet.has(k)) return true;
    return false;
  })();

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div style={styles.header}>
          <span style={styles.title}>Edit Tiles — Asset #{assetId}</span>
          <button style={styles.closeBtn} onClick={onClose}>×</button>
        </div>

        <div style={styles.body}>
          <p style={styles.desc}>
            Click tiles to toggle which 48×48 cells are occupied. Active tiles have a blue border;
            inactive tiles are dimmed.
          </p>

          <canvas
            ref={canvasRef}
            width={COLS * CELL}
            height={ROWS * CELL}
            style={styles.canvas}
            onClick={handleCanvasClick}
          />

          <div style={styles.info}>
            <span>{activeTiles.size} / {COLS * ROWS} tiles active</span>
            {existingOverride && <span style={styles.customBadge}>Custom override</span>}
          </div>
        </div>

        <div style={styles.footer}>
          <button style={styles.resetBtn} onClick={handleReset} disabled={!hasChanges && !existingOverride}>
            Reset to Auto
          </button>
          <div style={{ flex: 1 }} />
          <button style={styles.cancelBtn} onClick={onClose}>Cancel</button>
          <button style={styles.saveBtn} onClick={handleSave} disabled={activeTiles.size === 0}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0, 0, 0, 0.6)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 9000,
  },
  modal: {
    background: 'var(--bg-secondary)',
    border: '1px solid var(--border)',
    borderRadius: '8px',
    width: '380px',
    maxHeight: '90vh',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  header: {
    padding: '12px 16px',
    borderBottom: '1px solid var(--border)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: {
    fontSize: '13px',
    fontWeight: 600,
    color: 'var(--text-primary)',
  },
  closeBtn: {
    width: '24px',
    height: '24px',
    border: 'none',
    background: 'transparent',
    color: 'var(--text-muted)',
    fontSize: '16px',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: '4px',
  },
  body: {
    padding: '16px',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '12px',
  },
  desc: {
    fontSize: '11px',
    color: 'var(--text-muted)',
    margin: 0,
    lineHeight: 1.5,
    textAlign: 'center' as const,
  },
  canvas: {
    cursor: 'pointer',
    borderRadius: '4px',
    border: '1px solid var(--border)',
    width: `${COLS * CELL}px`,
    height: `${ROWS * CELL}px`,
    imageRendering: 'pixelated' as const,
  },
  info: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    fontSize: '11px',
    color: 'var(--text-muted)',
  },
  customBadge: {
    padding: '1px 6px',
    borderRadius: '3px',
    background: 'var(--accent-dim)',
    color: 'var(--accent)',
    fontSize: '10px',
  },
  footer: {
    padding: '10px 16px',
    borderTop: '1px solid var(--border)',
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  resetBtn: {
    padding: '5px 12px',
    border: '1px solid var(--border)',
    borderRadius: '4px',
    background: 'transparent',
    fontSize: '11px',
    cursor: 'pointer',
    color: 'var(--text-secondary)',
  },
  cancelBtn: {
    padding: '5px 12px',
    border: '1px solid var(--border)',
    borderRadius: '4px',
    background: 'transparent',
    fontSize: '11px',
    cursor: 'pointer',
    color: 'var(--text-secondary)',
  },
  saveBtn: {
    padding: '5px 16px',
    border: '1px solid var(--accent)',
    borderRadius: '4px',
    background: 'var(--accent)',
    fontSize: '11px',
    cursor: 'pointer',
    color: '#fff',
    fontWeight: 500,
  },
};
