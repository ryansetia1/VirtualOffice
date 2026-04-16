import { useState, useRef, useCallback, useEffect } from 'react';
import type { CustomAssetData } from '../hooks/useCustomAssets';

const TILE = 48;
type ImportMode = 'select' | 'draw';
type SelectTool = 'click' | 'marquee';
type DrawTool = 'marquee' | 'freeform';

interface Props {
  targetCategory: string;
  onImport: (assets: Omit<CustomAssetData, 'id'>[]) => void;
  onClose: () => void;
}

interface DrawnRegion {
  col: number;
  row: number;
  w: number;
  h: number;
}

export default function ImportDialog({ targetCategory, onImport, onClose }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [urlInput, setUrlInput] = useState('');
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cols, setCols] = useState(0);
  const [rows, setRows] = useState(0);
  const [category, setCategory] = useState(targetCategory);
  const [mode, setMode] = useState<ImportMode>('select');
  const [selectTool, setSelectTool] = useState<SelectTool>('click');
  const [drawTool, setDrawTool] = useState<DrawTool>('marquee');

  // Select mode state
  const [selectedTiles, setSelectedTiles] = useState<Set<string>>(new Set());
  const [selMarqueeStart, setSelMarqueeStart] = useState<{ col: number; row: number } | null>(null);
  const [selMarqueeCurrent, setSelMarqueeCurrent] = useState<{ col: number; row: number } | null>(null);
  const [selMarqueeDragging, setSelMarqueeDragging] = useState(false);

  // Draw mode — marquee state
  const [regions, setRegions] = useState<DrawnRegion[]>([]);
  const [drawing, setDrawing] = useState(false);
  const [drawStart, setDrawStart] = useState<{ col: number; row: number } | null>(null);
  const [drawCurrent, setDrawCurrent] = useState<{ col: number; row: number } | null>(null);

  // Draw mode — freeform state
  const [freeformTiles, setFreeformTiles] = useState<Set<string>>(new Set());
  const [freeformPainting, setFreeformPainting] = useState(false);
  const [freeformErasing, setFreeformErasing] = useState(false);

  const loadImage = useCallback((url: string) => {
    setError(null);
    setSelectedTiles(new Set());
    setRegions([]);
    setFreeformTiles(new Set());
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => {
      const c = Math.floor(image.width / TILE);
      const r = Math.floor(image.height / TILE);
      if (c === 0 || r === 0) {
        setError(`Image too small (${image.width}×${image.height}). Needs at least ${TILE}×${TILE}px.`);
        return;
      }
      setCols(c);
      setRows(r);
      setImg(image);
      setImageUrl(url);
    };
    image.onerror = () => setError('Failed to load image. Check the URL path.');
    image.src = url;
  }, []);

  const handleLoadUrl = useCallback(() => {
    const url = urlInput.trim();
    if (!url) return;
    loadImage(url);
  }, [urlInput, loadImage]);

  const handleFileUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    setUrlInput(file.name);
    loadImage(url);
  }, [loadImage]);

  // ── Canvas coordinate helpers ─────────────────────────────────────────────
  const getCanvasCell = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas || cols === 0 || rows === 0) return null;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const px = (e.clientX - rect.left) * scaleX;
    const py = (e.clientY - rect.top) * scaleY;
    const cellPx = canvas.width / cols;
    const col = Math.floor(px / cellPx);
    const row = Math.floor(py / cellPx);
    if (col < 0 || col >= cols || row < 0 || row >= rows) return null;
    return { col, row };
  }, [cols, rows]);

  const normalizeRect = (start: { col: number; row: number }, end: { col: number; row: number }) => {
    const c1 = Math.min(start.col, end.col);
    const r1 = Math.min(start.row, end.row);
    const c2 = Math.max(start.col, end.col);
    const r2 = Math.max(start.row, end.row);
    return { col: c1, row: r1, w: c2 - c1 + 1, h: r2 - r1 + 1 };
  };

  // ── Canvas events ──────────────────────────────────────────────────────────
  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const cell = getCanvasCell(e);
    if (!cell) return;

    if (mode === 'select') {
      if (selectTool === 'click') {
        const key = `${cell.col},${cell.row}`;
        setSelectedTiles((prev) => {
          const next = new Set(prev);
          if (next.has(key)) next.delete(key); else next.add(key);
          return next;
        });
      } else {
        // Marquee select: start drag
        setSelMarqueeDragging(true);
        setSelMarqueeStart(cell);
        setSelMarqueeCurrent(cell);
      }
    } else if (drawTool === 'marquee') {
      const hitIdx = regions.findIndex((r) =>
        cell.col >= r.col && cell.col < r.col + r.w &&
        cell.row >= r.row && cell.row < r.row + r.h
      );
      if (hitIdx >= 0 && !e.shiftKey) {
        setRegions((prev) => prev.filter((_, i) => i !== hitIdx));
        return;
      }
      setDrawing(true);
      setDrawStart(cell);
      setDrawCurrent(cell);
    } else {
      const key = `${cell.col},${cell.row}`;
      const isErasing = freeformTiles.has(key);
      setFreeformErasing(isErasing);
      setFreeformPainting(true);
      setFreeformTiles((prev) => {
        const next = new Set(prev);
        if (isErasing) next.delete(key); else next.add(key);
        return next;
      });
    }
  }, [mode, selectTool, drawTool, getCanvasCell, regions, freeformTiles]);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (mode === 'select' && selectTool === 'marquee' && selMarqueeDragging) {
      const cell = getCanvasCell(e);
      if (cell) setSelMarqueeCurrent(cell);
    } else if (mode === 'draw' && drawTool === 'marquee') {
      if (!drawing) return;
      const cell = getCanvasCell(e);
      if (cell) setDrawCurrent(cell);
    } else if (mode === 'draw' && drawTool === 'freeform') {
      if (!freeformPainting) return;
      const cell = getCanvasCell(e);
      if (!cell) return;
      const key = `${cell.col},${cell.row}`;
      setFreeformTiles((prev) => {
        const next = new Set(prev);
        if (freeformErasing) next.delete(key); else next.add(key);
        return next;
      });
    }
  }, [mode, selectTool, selMarqueeDragging, drawTool, drawing, freeformPainting, freeformErasing, getCanvasCell]);

  const handleMouseUp = useCallback(() => {
    // Select marquee: commit rectangle to individual tiles
    if (mode === 'select' && selectTool === 'marquee' && selMarqueeDragging && selMarqueeStart && selMarqueeCurrent) {
      setSelMarqueeDragging(false);
      const rect = normalizeRect(selMarqueeStart, selMarqueeCurrent);
      setSelectedTiles((prev) => {
        const next = new Set(prev);
        for (let r = rect.row; r < rect.row + rect.h; r++) {
          for (let c = rect.col; c < rect.col + rect.w; c++) {
            next.add(`${c},${r}`);
          }
        }
        return next;
      });
      setSelMarqueeStart(null);
      setSelMarqueeCurrent(null);
      return;
    }

    if (mode === 'draw' && drawTool === 'freeform') {
      setFreeformPainting(false);
      setFreeformErasing(false);
      return;
    }
    if (!drawing || !drawStart || !drawCurrent) return;
    setDrawing(false);
    const region = normalizeRect(drawStart, drawCurrent);
    setRegions((prev) => [...prev, region]);
    setDrawStart(null);
    setDrawCurrent(null);
  }, [mode, selectTool, selMarqueeDragging, selMarqueeStart, selMarqueeCurrent, drawTool, drawing, drawStart, drawCurrent]);

  const handleMouseLeave = useCallback(() => {
    if (selMarqueeDragging) handleMouseUp();
    if (drawing) handleMouseUp();
    if (freeformPainting) { setFreeformPainting(false); setFreeformErasing(false); }
  }, [selMarqueeDragging, drawing, freeformPainting, handleMouseUp]);

  // ── Canvas rendering ───────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !img || cols === 0 || rows === 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const scale = Math.min(1, 600 / (cols * TILE), 400 / (rows * TILE));
    const cellPx = TILE * scale;
    canvas.width = cols * cellPx;
    canvas.height = rows * cellPx;

    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, 0, 0, cols * TILE, rows * TILE, 0, 0, canvas.width, canvas.height);

    if (mode === 'select') {
      // Compute in-progress marquee tiles for preview
      const previewSet = new Set(selectedTiles);
      if (selMarqueeDragging && selMarqueeStart && selMarqueeCurrent) {
        const rect = normalizeRect(selMarqueeStart, selMarqueeCurrent);
        for (let r = rect.row; r < rect.row + rect.h; r++) {
          for (let c = rect.col; c < rect.col + rect.w; c++) {
            previewSet.add(`${c},${r}`);
          }
        }
      }

      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const x = c * cellPx;
          const y = r * cellPx;
          const key = `${c},${r}`;
          if (previewSet.has(key)) {
            ctx.strokeStyle = 'rgba(79, 195, 247, 0.9)';
            ctx.lineWidth = 2;
            ctx.strokeRect(x + 1, y + 1, cellPx - 2, cellPx - 2);
          } else {
            ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
            ctx.fillRect(x, y, cellPx, cellPx);
          }
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
          ctx.lineWidth = 0.5;
          ctx.strokeRect(x, y, cellPx, cellPx);
        }
      }

      // Draw marquee dashed outline
      if (selMarqueeDragging && selMarqueeStart && selMarqueeCurrent) {
        const rect = normalizeRect(selMarqueeStart, selMarqueeCurrent);
        ctx.strokeStyle = 'rgba(79, 195, 247, 0.8)';
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 4]);
        ctx.strokeRect(rect.col * cellPx + 1, rect.row * cellPx + 1, rect.w * cellPx - 2, rect.h * cellPx - 2);
        ctx.setLineDash([]);
      }
    } else if (drawTool === 'freeform') {
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const x = c * cellPx;
          const y = r * cellPx;
          const key = `${c},${r}`;
          if (freeformTiles.has(key)) {
            ctx.strokeStyle = 'rgba(129, 199, 132, 0.9)';
            ctx.lineWidth = 2;
            ctx.strokeRect(x + 1, y + 1, cellPx - 2, cellPx - 2);
          } else {
            ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
            ctx.fillRect(x, y, cellPx, cellPx);
          }
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
          ctx.lineWidth = 0.5;
          ctx.strokeRect(x, y, cellPx, cellPx);
        }
      }
    } else {
      ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
      ctx.lineWidth = 0.5;
      for (let r = 0; r <= rows; r++) {
        ctx.beginPath(); ctx.moveTo(0, r * cellPx); ctx.lineTo(cols * cellPx, r * cellPx); ctx.stroke();
      }
      for (let c = 0; c <= cols; c++) {
        ctx.beginPath(); ctx.moveTo(c * cellPx, 0); ctx.lineTo(c * cellPx, rows * cellPx); ctx.stroke();
      }

      const COLORS = ['rgba(79, 195, 247, 0.7)', 'rgba(129, 199, 132, 0.7)', 'rgba(255, 183, 77, 0.7)',
        'rgba(186, 104, 200, 0.7)', 'rgba(255, 138, 128, 0.7)', 'rgba(77, 208, 225, 0.7)'];

      for (let i = 0; i < regions.length; i++) {
        const r = regions[i];
        const rx = r.col * cellPx;
        const ry = r.row * cellPx;
        const rw = r.w * cellPx;
        const rh = r.h * cellPx;
        ctx.drawImage(img, r.col * TILE, r.row * TILE, r.w * TILE, r.h * TILE, rx, ry, rw, rh);
        const color = COLORS[i % COLORS.length];
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.strokeRect(rx + 1, ry + 1, rw - 2, rh - 2);
        ctx.fillStyle = color;
        ctx.font = `bold ${Math.max(10, cellPx * 0.3)}px monospace`;
        ctx.fillText(`${r.w}×${r.h}`, rx + 4, ry + cellPx * 0.4);
      }

      if (drawing && drawStart && drawCurrent) {
        const pr = normalizeRect(drawStart, drawCurrent);
        const rx = pr.col * cellPx;
        const ry = pr.row * cellPx;
        const rw = pr.w * cellPx;
        const rh = pr.h * cellPx;
        ctx.drawImage(img, pr.col * TILE, pr.row * TILE, pr.w * TILE, pr.h * TILE, rx, ry, rw, rh);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 4]);
        ctx.strokeRect(rx + 1, ry + 1, rw - 2, rh - 2);
        ctx.setLineDash([]);
      }
    }
  }, [img, cols, rows, mode, selectTool, drawTool, selectedTiles, selMarqueeDragging, selMarqueeStart, selMarqueeCurrent, freeformTiles, regions, drawing, drawStart, drawCurrent]);

  // ── Select helpers ─────────────────────────────────────────────────────────
  const selectAll = useCallback(() => {
    const all = new Set<string>();
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++)
        all.add(`${c},${r}`);
    setSelectedTiles(all);
  }, [cols, rows]);

  const clearAll = useCallback(() => {
    if (mode === 'select') setSelectedTiles(new Set());
    else if (drawTool === 'freeform') setFreeformTiles(new Set());
    else setRegions([]);
  }, [mode, drawTool]);

  // ── Import ─────────────────────────────────────────────────────────────────
  const itemCount = mode === 'select'
    ? selectedTiles.size
    : drawTool === 'freeform'
      ? freeformTiles.size
      : regions.length;

  const handleImport = useCallback(() => {
    if (!imageUrl || itemCount === 0) return;

    const assets: Omit<CustomAssetData, 'id'>[] = [];

    if (mode === 'select') {
      for (const key of selectedTiles) {
        const [c, r] = key.split(',').map(Number);
        assets.push({
          sourceUrl: imageUrl,
          cropX: c * TILE,
          cropY: r * TILE,
          category,
          spanW: 1,
          spanH: 1,
          tiles: [[0, 0]],
        });
      }
    } else if (drawTool === 'freeform') {
      const cells = Array.from(freeformTiles).map((key) => {
        const [c, r] = key.split(',').map(Number);
        return { col: c, row: r };
      });
      if (cells.length === 0) return;

      const minC = Math.min(...cells.map((c) => c.col));
      const minR = Math.min(...cells.map((c) => c.row));
      const maxC = Math.max(...cells.map((c) => c.col));
      const maxR = Math.max(...cells.map((c) => c.row));
      const spanW = maxC - minC + 1;
      const spanH = maxR - minR + 1;
      const tiles: [number, number][] = cells.map((c) => [c.col - minC, c.row - minR]);

      assets.push({
        sourceUrl: imageUrl,
        cropX: minC * TILE,
        cropY: minR * TILE,
        category,
        spanW,
        spanH,
        tiles,
      });
    } else {
      for (const region of regions) {
        const tiles: [number, number][] = [];
        for (let r = 0; r < region.h; r++)
          for (let c = 0; c < region.w; c++)
            tiles.push([c, r]);
        assets.push({
          sourceUrl: imageUrl,
          cropX: region.col * TILE,
          cropY: region.row * TILE,
          category,
          spanW: region.w,
          spanH: region.h,
          tiles,
        });
      }
    }

    onImport(assets);
    onClose();
  }, [imageUrl, itemCount, mode, drawTool, selectedTiles, freeformTiles, regions, category, onImport, onClose]);

  // ── Info / hint text ───────────────────────────────────────────────────────
  const infoLabel = mode === 'select'
    ? `${itemCount} tiles`
    : drawTool === 'freeform'
      ? `${itemCount} tiles (1 asset)`
      : `${itemCount} regions`;

  const hintText = mode === 'select'
    ? selectTool === 'click'
      ? 'Click tiles to select/deselect. Each selected tile becomes a 1×1 asset.'
      : 'Click and drag to select a rectangle of tiles. Each tile becomes a 1×1 asset. Shift+click a tile to deselect.'
    : drawTool === 'marquee'
      ? 'Click and drag to draw rectangular regions. Each region becomes one multi-tile asset. Click a region to remove it.'
      : 'Click/drag to paint tiles. All painted tiles become one custom-shaped asset. Click painted tiles to erase.';

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div style={styles.header}>
          <span style={styles.title}>Import Assets</span>
          <button style={styles.closeBtn} onClick={onClose}>×</button>
        </div>

        <div style={styles.body}>
          <div style={styles.urlRow}>
            <input
              type="text"
              placeholder="Paste image URL or path (e.g., /assets/spritesheet.png)"
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleLoadUrl()}
              style={styles.urlInput}
            />
            <button style={styles.loadBtn} onClick={handleLoadUrl}>Load</button>
            <label style={styles.fileLabel}>
              Browse
              <input type="file" accept="image/*" onChange={handleFileUpload} style={{ display: 'none' }} />
            </label>
          </div>

          <div style={styles.catRow}>
            <label style={styles.catLabel}>Category:</label>
            <input
              type="text"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              style={styles.catInput}
            />
          </div>

          {error && <div style={styles.error}>{error}</div>}

          {img && cols > 0 && (
            <>
              <div style={styles.modeRow}>
                <span style={styles.modeLabel}>Mode:</span>
                <button
                  style={{ ...styles.modeBtn, ...(mode === 'select' ? styles.modeBtnActive : {}) }}
                  onClick={() => setMode('select')}
                >
                  Select (1×1)
                </button>
                <button
                  style={{ ...styles.modeBtn, ...(mode === 'draw' ? styles.modeBtnActive : {}) }}
                  onClick={() => setMode('draw')}
                >
                  Draw (multi-tile)
                </button>
              </div>

              {mode === 'select' && (
                <div style={styles.subToolRow}>
                  <span style={styles.subToolLabel}>Tool:</span>
                  <button
                    style={{ ...styles.subToolBtn, ...(selectTool === 'click' ? styles.subToolBtnActiveBlue : {}) }}
                    onClick={() => setSelectTool('click')}
                  >
                    Click
                  </button>
                  <button
                    style={{ ...styles.subToolBtn, ...(selectTool === 'marquee' ? styles.subToolBtnActiveBlue : {}) }}
                    onClick={() => setSelectTool('marquee')}
                  >
                    Marquee
                  </button>
                </div>
              )}

              {mode === 'draw' && (
                <div style={styles.subToolRow}>
                  <span style={styles.subToolLabel}>Tool:</span>
                  <button
                    style={{ ...styles.subToolBtn, ...(drawTool === 'marquee' ? styles.subToolBtnActive : {}) }}
                    onClick={() => setDrawTool('marquee')}
                  >
                    Marquee
                  </button>
                  <button
                    style={{ ...styles.subToolBtn, ...(drawTool === 'freeform' ? styles.subToolBtnActive : {}) }}
                    onClick={() => setDrawTool('freeform')}
                  >
                    Freeform
                  </button>
                </div>
              )}

              <div style={styles.modeRow}>
                <span style={styles.infoText}>
                  {cols}×{rows} grid — {infoLabel}
                </span>
                <div style={{ flex: 1 }} />
                {mode === 'select' && <button style={styles.smallBtn} onClick={selectAll}>Select All</button>}
                <button style={styles.smallBtn} onClick={clearAll}>Clear</button>
              </div>

              <div style={styles.canvasWrap}>
                <canvas
                  ref={canvasRef}
                  style={styles.canvas}
                  onMouseDown={handleMouseDown}
                  onMouseMove={handleMouseMove}
                  onMouseUp={handleMouseUp}
                  onMouseLeave={handleMouseLeave}
                />
              </div>

              <p style={styles.hint}>{hintText}</p>
            </>
          )}
        </div>

        <div style={styles.footer}>
          <button style={styles.cancelBtn} onClick={onClose}>Cancel</button>
          <button
            style={styles.importBtn}
            onClick={handleImport}
            disabled={itemCount === 0}
          >
            Import {itemCount > 0 ? `(${itemCount})` : ''}
          </button>
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9000 },
  modal: { background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: '8px', width: '700px', maxHeight: '90vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' },
  header: { padding: '12px 16px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  title: { fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' },
  closeBtn: { width: '24px', height: '24px', border: 'none', background: 'transparent', color: 'var(--text-muted)', fontSize: '16px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '4px' },
  body: { padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px', overflowY: 'auto' },
  urlRow: { display: 'flex', gap: '6px' },
  urlInput: { flex: 1, padding: '6px 10px', border: '1px solid var(--border)', borderRadius: '4px', background: 'var(--bg-primary)', fontSize: '12px', color: 'var(--text-primary)' },
  loadBtn: { padding: '6px 14px', border: '1px solid var(--accent)', borderRadius: '4px', background: 'var(--accent-dim)', fontSize: '11px', cursor: 'pointer', color: 'var(--accent)', fontWeight: 500 },
  fileLabel: { padding: '6px 14px', border: '1px solid var(--border)', borderRadius: '4px', background: 'var(--bg-surface)', fontSize: '11px', cursor: 'pointer', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center' },
  catRow: { display: 'flex', alignItems: 'center', gap: '8px' },
  catLabel: { fontSize: '12px', color: 'var(--text-secondary)', flexShrink: 0 },
  catInput: { flex: 1, padding: '4px 8px', border: '1px solid var(--border)', borderRadius: '4px', background: 'var(--bg-primary)', fontSize: '12px', color: 'var(--text-primary)', maxWidth: '200px' },
  error: { padding: '8px 12px', borderRadius: '4px', background: 'rgba(239,83,80,0.15)', color: 'var(--danger)', fontSize: '12px' },
  modeRow: { display: 'flex', alignItems: 'center', gap: '6px' },
  modeLabel: { fontSize: '11px', color: 'var(--text-muted)', marginRight: '2px' },
  modeBtn: { padding: '3px 10px', border: '1px solid var(--border)', borderRadius: '4px', background: 'var(--bg-surface)', fontSize: '10px', cursor: 'pointer', color: 'var(--text-secondary)' },
  modeBtnActive: { borderColor: 'var(--accent)', background: 'var(--accent-dim)', color: 'var(--accent)' },
  subToolRow: { display: 'flex', alignItems: 'center', gap: '6px', paddingLeft: 4 },
  subToolLabel: { fontSize: '10px', color: 'var(--text-muted)', marginRight: '2px' },
  subToolBtn: { padding: '2px 8px', border: '1px solid var(--border)', borderRadius: '3px', background: 'var(--bg-primary)', fontSize: '10px', cursor: 'pointer', color: 'var(--text-muted)' },
  subToolBtnActive: { borderColor: 'rgba(129, 199, 132, 0.6)', background: 'rgba(129, 199, 132, 0.12)', color: '#81c784' },
  subToolBtnActiveBlue: { borderColor: 'rgba(79, 195, 247, 0.6)', background: 'rgba(79, 195, 247, 0.12)', color: 'var(--accent)' },
  infoText: { fontSize: '11px', color: 'var(--text-muted)' },
  smallBtn: { padding: '2px 8px', border: '1px solid var(--border)', borderRadius: '3px', background: 'var(--bg-surface)', fontSize: '10px', cursor: 'pointer', color: 'var(--text-secondary)' },
  canvasWrap: { display: 'flex', justifyContent: 'center', maxHeight: '420px', overflow: 'auto', border: '1px solid var(--border)', borderRadius: '4px', background: 'var(--bg-primary)' },
  canvas: { cursor: 'crosshair', imageRendering: 'pixelated' as const, maxWidth: '100%' },
  hint: { fontSize: '11px', color: 'var(--text-muted)', margin: 0, textAlign: 'center' as const },
  footer: { padding: '10px 16px', borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'flex-end', gap: '8px' },
  cancelBtn: { padding: '5px 12px', border: '1px solid var(--border)', borderRadius: '4px', background: 'transparent', fontSize: '11px', cursor: 'pointer', color: 'var(--text-secondary)' },
  importBtn: { padding: '5px 16px', border: '1px solid var(--accent)', borderRadius: '4px', background: 'var(--accent)', fontSize: '11px', cursor: 'pointer', color: '#fff', fontWeight: 500 },
};
