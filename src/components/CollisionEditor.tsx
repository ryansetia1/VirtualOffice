import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getCachedImage } from '../utils/imageLoader';
import {
  cloneMask,
  createEmptyMask,
  createFullMask,
  getAutoMask,
  getBit,
  setBit,
  masksEqual,
  type PixelMask,
} from '../utils/pixelMasks';

const TILE = 48;

interface Props {
  assetId: number;
  displayName?: string;
  /** Current effective mask (override if any, else auto). Used as starting point. */
  initialMask?: PixelMask;
  /** Auto mask for this asset — used for the "Reset to auto" button. */
  autoMask?: PixelMask;
  /** True if the user has a saved override for this asset. */
  hasOverride?: boolean;
  /** Source-PNG tiles that make up this asset (needed to composite preview). */
  tiles: [number, number][];
  /** Column offset of the asset's bounding box inside the source PNG. */
  srcCol: number;
  /** Row offset of the asset's bounding box inside the source PNG. */
  srcRow: number;
  onSave: (mask: PixelMask) => void;
  onReset: () => void;
  onClose: () => void;
}

type Tool = 'brush' | 'eraser';

const BRUSH_SIZES: Array<{ label: string; radius: number }> = [
  { label: '1 px', radius: 0 },
  { label: '3 px', radius: 1 },
  { label: '5 px', radius: 2 },
  { label: '9 px', radius: 4 },
];

export default function CollisionEditor({
  assetId,
  displayName,
  initialMask,
  autoMask,
  hasOverride,
  tiles,
  srcCol,
  srcRow,
  onSave,
  onReset,
  onClose,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [mask, setMask] = useState<PixelMask>(() => {
    if (initialMask) return cloneMask(initialMask);
    if (autoMask) return cloneMask(autoMask);
    return createEmptyMask(TILE * 2, TILE * 3);
  });
  const [tool, setTool] = useState<Tool>('brush');
  const [brushIdx, setBrushIdx] = useState(1);
  const brushRadius = BRUSH_SIZES[brushIdx].radius;
  const [showAuto, setShowAuto] = useState(true);
  const [painting, setPainting] = useState(false);

  // Fit the display canvas to the asset's aspect ratio while keeping a pixel
  // size that's comfortable to paint on.
  const scale = useMemo(() => {
    if (mask.w === 0 || mask.h === 0) return 4;
    // Target roughly 400 px on the longer side.
    const s = Math.max(2, Math.min(8, Math.floor(400 / Math.max(mask.w, mask.h))));
    return s;
  }, [mask.w, mask.h]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const W = mask.w * scale;
    const H = mask.h * scale;
    canvas.width = W;
    canvas.height = H;
    ctx.imageSmoothingEnabled = false;

    // Checkerboard background (Photoshop-style transparency).
    const check = 8;
    for (let y = 0; y < H; y += check) {
      for (let x = 0; x < W; x += check) {
        const isLight = ((x / check) + (y / check)) % 2 === 0;
        ctx.fillStyle = isLight ? '#3a3a3a' : '#2a2a2a';
        ctx.fillRect(x, y, check, check);
      }
    }

    // Underlay: composite the asset from its source PNG, tile-by-tile, the
    // same way the mask was built. This keeps the displayed art aligned
    // with the collision bits even for multi-cell bounding boxes that
    // occupy only a subset of the full 2×3 tile sheet.
    const img = getCachedImage(assetId);
    if (img) {
      ctx.globalAlpha = 0.9;
      for (const [imgCol, imgRow] of tiles) {
        const sx = imgCol * TILE;
        const sy = imgRow * TILE;
        const dx = (imgCol - srcCol) * TILE * scale;
        const dy = (imgRow - srcRow) * TILE * scale;
        try {
          ctx.drawImage(img, sx, sy, TILE, TILE, dx, dy, TILE * scale, TILE * scale);
        } catch { /* ignore */ }
      }
      ctx.globalAlpha = 1;
    }

    // Mask overlay: blocking = translucent red; walkable = dim veil so the
    // user can see what agents will pass through.
    for (let y = 0; y < mask.h; y++) {
      for (let x = 0; x < mask.w; x++) {
        const blocking = getBit(mask, x, y);
        if (blocking) {
          ctx.fillStyle = 'rgba(239, 83, 80, 0.55)';
          ctx.fillRect(x * scale, y * scale, scale, scale);
        } else {
          ctx.fillStyle = 'rgba(79, 195, 247, 0.08)';
          ctx.fillRect(x * scale, y * scale, scale, scale);
        }
      }
    }

    // Optional outline of the auto mask for reference while painting.
    if (showAuto && autoMask && (autoMask.w === mask.w && autoMask.h === mask.h)) {
      ctx.strokeStyle = 'rgba(100, 200, 255, 0.9)';
      ctx.lineWidth = 1;
      for (let y = 0; y < autoMask.h; y++) {
        for (let x = 0; x < autoMask.w; x++) {
          const here = getBit(autoMask, x, y);
          const right = x + 1 < autoMask.w ? getBit(autoMask, x + 1, y) : false;
          const below = y + 1 < autoMask.h ? getBit(autoMask, x, y + 1) : false;
          if (here !== right) {
            const xx = (x + 1) * scale;
            ctx.beginPath();
            ctx.moveTo(xx, y * scale);
            ctx.lineTo(xx, (y + 1) * scale);
            ctx.stroke();
          }
          if (here !== below) {
            const yy = (y + 1) * scale;
            ctx.beginPath();
            ctx.moveTo(x * scale, yy);
            ctx.lineTo((x + 1) * scale, yy);
            ctx.stroke();
          }
        }
      }
    }

    // Tile grid lines (48-px cells) for orientation.
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
    ctx.lineWidth = 1;
    for (let cx = 0; cx <= mask.w; cx += TILE) {
      ctx.beginPath();
      ctx.moveTo(cx * scale, 0);
      ctx.lineTo(cx * scale, H);
      ctx.stroke();
    }
    for (let cy = 0; cy <= mask.h; cy += TILE) {
      ctx.beginPath();
      ctx.moveTo(0, cy * scale);
      ctx.lineTo(W, cy * scale);
      ctx.stroke();
    }
  }, [assetId, autoMask, mask, scale, showAuto, tiles, srcCol, srcRow]);

  useEffect(() => { draw(); }, [draw]);

  const applyBrush = useCallback((px: number, py: number, value: boolean) => {
    setMask((prev) => {
      const next = cloneMask(prev);
      for (let dy = -brushRadius; dy <= brushRadius; dy++) {
        for (let dx = -brushRadius; dx <= brushRadius; dx++) {
          if (dx * dx + dy * dy > brushRadius * brushRadius + brushRadius) continue;
          setBit(next, px + dx, py + dy, value);
        }
      }
      return next;
    });
  }, [brushRadius]);

  const canvasToPixel = useCallback((clientX: number, clientY: number): { x: number; y: number } | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const cx = (clientX - rect.left) * scaleX;
    const cy = (clientY - rect.top) * scaleY;
    const x = Math.floor(cx / scale);
    const y = Math.floor(cy / scale);
    if (x < 0 || y < 0 || x >= mask.w || y >= mask.h) return null;
    return { x, y };
  }, [mask.w, mask.h, scale]);

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const p = canvasToPixel(e.clientX, e.clientY);
    if (!p) return;
    (e.currentTarget as HTMLCanvasElement).setPointerCapture(e.pointerId);
    setPainting(true);
    applyBrush(p.x, p.y, tool === 'brush');
  }, [applyBrush, canvasToPixel, tool]);

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!painting) return;
    const p = canvasToPixel(e.clientX, e.clientY);
    if (!p) return;
    applyBrush(p.x, p.y, tool === 'brush');
  }, [applyBrush, canvasToPixel, painting, tool]);

  const handlePointerUp = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    (e.currentTarget as HTMLCanvasElement).releasePointerCapture?.(e.pointerId);
    setPainting(false);
  }, []);

  const handleFill = useCallback(() => {
    setMask(() => createFullMask(mask.w, mask.h));
  }, [mask.w, mask.h]);

  const handleClear = useCallback(() => {
    setMask(() => createEmptyMask(mask.w, mask.h));
  }, [mask.w, mask.h]);

  const handleInvert = useCallback(() => {
    setMask((prev) => {
      const next = cloneMask(prev);
      for (let i = 0; i < next.bits.length; i++) next.bits[i] = ~next.bits[i] & 0xff;
      // Clear spillover past w*h.
      const total = next.w * next.h;
      const extra = total & 7;
      if (extra !== 0) next.bits[next.bits.length - 1] &= (1 << extra) - 1;
      return next;
    });
  }, []);

  const handleResetToAuto = useCallback(() => {
    if (!autoMask) return;
    setMask(cloneMask(autoMask));
  }, [autoMask]);

  const handleSave = useCallback(() => {
    // If the user's mask is identical to the auto mask, clear the override
    // instead of persisting a redundant copy.
    const auto = autoMask ?? getAutoMask(assetId);
    if (auto && masksEqual(auto, mask)) {
      onReset();
    } else {
      onSave(cloneMask(mask));
    }
    onClose();
  }, [assetId, autoMask, mask, onClose, onReset, onSave]);

  const coverage = useMemo(() => {
    let opaque = 0;
    for (let y = 0; y < mask.h; y++) {
      for (let x = 0; x < mask.w; x++) {
        if (getBit(mask, x, y)) opaque++;
      }
    }
    const total = mask.w * mask.h;
    return { opaque, total, pct: total === 0 ? 0 : Math.round((opaque / total) * 100) };
  }, [mask]);

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div style={styles.header}>
          <div>
            <div style={styles.title}>Collision — {displayName ?? `Asset #${assetId}`}</div>
            <div style={styles.subtitle}>
              Paint the pixels that block agents. Transparent areas let agents walk through.
            </div>
          </div>
          <button style={styles.closeBtn} onClick={onClose}>×</button>
        </div>

        <div style={styles.body}>
          <div style={styles.toolbar}>
            <div style={styles.toolGroup}>
              <button
                style={{ ...styles.toolBtn, ...(tool === 'brush' ? styles.toolBtnActive : {}) }}
                onClick={() => setTool('brush')}
              >
                Block
              </button>
              <button
                style={{ ...styles.toolBtn, ...(tool === 'eraser' ? styles.toolBtnActive : {}) }}
                onClick={() => setTool('eraser')}
              >
                Walkable
              </button>
            </div>
            <div style={styles.toolGroup}>
              <span style={styles.toolLabel}>Brush</span>
              {BRUSH_SIZES.map((b, i) => (
                <button
                  key={b.label}
                  style={{ ...styles.toolBtn, ...(brushIdx === i ? styles.toolBtnActive : {}) }}
                  onClick={() => setBrushIdx(i)}
                >
                  {b.label}
                </button>
              ))}
            </div>
            <div style={styles.toolGroup}>
              <label style={styles.checkboxLabel}>
                <input
                  type="checkbox"
                  checked={showAuto}
                  onChange={(e) => setShowAuto(e.target.checked)}
                />
                <span>Auto outline</span>
              </label>
            </div>
          </div>

          <div style={styles.canvasWrap}>
            <canvas
              ref={canvasRef}
              style={{
                ...styles.canvas,
                cursor: tool === 'brush' ? 'crosshair' : 'cell',
              }}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerUp}
            />
          </div>

          <div style={styles.info}>
            <span>{coverage.opaque} / {coverage.total} px blocking ({coverage.pct}%)</span>
            {hasOverride && <span style={styles.customBadge}>Custom</span>}
          </div>
        </div>

        <div style={styles.footer}>
          <button style={styles.secondaryBtn} onClick={handleClear}>All walkable</button>
          <button style={styles.secondaryBtn} onClick={handleFill}>All blocking</button>
          <button style={styles.secondaryBtn} onClick={handleInvert}>Invert</button>
          <button style={styles.secondaryBtn} onClick={handleResetToAuto} disabled={!autoMask}>
            Reset to auto
          </button>
          <div style={{ flex: 1 }} />
          <button style={styles.cancelBtn} onClick={onClose}>Cancel</button>
          <button style={styles.saveBtn} onClick={handleSave}>Save</button>
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed', inset: 0, background: 'rgba(0, 0, 0, 0.6)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9000,
  },
  modal: {
    background: 'var(--bg-secondary)', border: '1px solid var(--border)',
    borderRadius: 8, width: 'min(90vw, 640px)', maxHeight: '92vh',
    display: 'flex', flexDirection: 'column', overflow: 'hidden',
  },
  header: {
    padding: '12px 16px', borderBottom: '1px solid var(--border)',
    display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12,
  },
  title: { fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' },
  subtitle: { marginTop: 4, fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.4 },
  closeBtn: {
    width: 24, height: 24, border: 'none', background: 'transparent',
    color: 'var(--text-muted)', fontSize: 16, cursor: 'pointer', borderRadius: 4,
  },
  body: { padding: 16, display: 'flex', flexDirection: 'column', gap: 12, overflow: 'auto' },
  toolbar: {
    display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center',
    padding: '8px 10px', background: 'var(--bg-surface)', borderRadius: 6,
  },
  toolGroup: { display: 'flex', alignItems: 'center', gap: 6 },
  toolLabel: { fontSize: 10, color: 'var(--text-muted)', fontWeight: 600, letterSpacing: 0.4, textTransform: 'uppercase' },
  toolBtn: {
    padding: '4px 10px', background: 'var(--bg-primary)', color: 'var(--text-primary)',
    border: '1px solid var(--border)', borderRadius: 4, fontSize: 11, cursor: 'pointer',
  },
  toolBtnActive: {
    background: 'var(--accent)', color: '#0d1117', borderColor: 'var(--accent)', fontWeight: 600,
  },
  checkboxLabel: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-primary)' },
  canvasWrap: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: 12, background: 'var(--bg-primary)', borderRadius: 6,
  },
  canvas: {
    border: '1px solid var(--border)', borderRadius: 4, imageRendering: 'pixelated',
    maxWidth: '100%', touchAction: 'none',
  },
  info: {
    display: 'flex', alignItems: 'center', gap: 8,
    fontSize: 11, color: 'var(--text-muted)',
  },
  customBadge: {
    padding: '1px 6px', borderRadius: 3, background: 'var(--accent-dim)',
    color: 'var(--accent)', fontSize: 10,
  },
  footer: {
    padding: '10px 16px', borderTop: '1px solid var(--border)',
    display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
  },
  secondaryBtn: {
    padding: '5px 10px', background: 'transparent', color: 'var(--text-secondary)',
    border: '1px solid var(--border)', borderRadius: 4, fontSize: 11, cursor: 'pointer',
  },
  cancelBtn: {
    padding: '5px 12px', background: 'transparent', color: 'var(--text-secondary)',
    border: '1px solid var(--border)', borderRadius: 4, fontSize: 11, cursor: 'pointer',
  },
  saveBtn: {
    padding: '5px 16px', background: 'var(--accent)', color: '#0d1117',
    border: '1px solid var(--accent)', borderRadius: 4, fontSize: 11, fontWeight: 600, cursor: 'pointer',
  },
};
