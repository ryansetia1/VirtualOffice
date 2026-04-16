import { useEffect, useState, useRef } from 'react';
import { getCachedImage } from '../utils/imageLoader';
import { getAssetTileInfo } from '../data/assetManifest';

const PREVIEW_SIZE = 64;

export default function DragOverlay({
  tileOverrides,
}: {
  tileOverrides?: Record<number, [number, number][]>;
}) {
  const [dragging, setDragging] = useState(false);
  const [assetId, setAssetId] = useState<number | null>(null);
  const [count, setCount] = useState(1);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const thumbRef = useRef<string | null>(null);

  useEffect(() => {
    const onDragStart = (e: DragEvent) => {
      if (!e.dataTransfer) return;

      let firstId: number | null = null;
      let assetCount = 1;

      for (const t of e.dataTransfer.types) {
        if (t === 'text/asset-count') {
          assetCount = parseInt(e.dataTransfer.getData('text/asset-count'), 10) || 1;
        }
        if (firstId === null && t.startsWith('asset-id/')) {
          firstId = parseInt(t.replace('asset-id/', ''), 10);
        }
      }

      if (firstId !== null && !isNaN(firstId)) {
        setAssetId(firstId);
        setCount(assetCount);
        setDragging(true);
        setPos({ x: e.clientX, y: e.clientY });
        thumbRef.current = buildThumb(firstId, tileOverrides);
      }
    };

    const onDragOver = (e: DragEvent) => {
      setPos({ x: e.clientX, y: e.clientY });
    };

    const onDragEnd = () => {
      setDragging(false);
      setAssetId(null);
      setCount(1);
      thumbRef.current = null;
    };

    window.addEventListener('dragstart', onDragStart);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragend', onDragEnd);
    window.addEventListener('drop', onDragEnd);

    return () => {
      window.removeEventListener('dragstart', onDragStart);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragend', onDragEnd);
      window.removeEventListener('drop', onDragEnd);
    };
  }, [tileOverrides]);

  if (!dragging || assetId === null) return null;

  const src = thumbRef.current;

  return (
    <div
      style={{
        position: 'fixed',
        left: pos.x,
        top: pos.y,
        transform: 'translate(-50%, -50%)',
        width: PREVIEW_SIZE,
        height: PREVIEW_SIZE,
        pointerEvents: 'none',
        zIndex: 99999,
        filter: 'drop-shadow(0 2px 8px rgba(0,0,0,0.5))',
        opacity: 0.9,
      }}
    >
      {src ? (
        <img
          src={src}
          alt=""
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'contain',
            imageRendering: 'pixelated',
          }}
        />
      ) : (
        <div
          style={{
            width: '100%',
            height: '100%',
            background: 'var(--accent-dim)',
            border: '2px solid var(--accent)',
            borderRadius: 4,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 10,
            color: 'var(--text-muted)',
          }}
        >
          #{assetId}
        </div>
      )}
      {count > 1 && (
        <div
          style={{
            position: 'absolute',
            top: -6,
            right: -6,
            minWidth: 20,
            height: 20,
            borderRadius: 10,
            background: 'var(--accent)',
            color: '#fff',
            fontSize: 11,
            fontWeight: 700,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '0 5px',
            boxShadow: '0 1px 4px rgba(0,0,0,0.4)',
          }}
        >
          {count}
        </div>
      )}
    </div>
  );
}

const TILE = 48;

function buildThumb(
  assetId: number,
  tileOverrides?: Record<number, [number, number][]>,
): string | null {
  const img = getCachedImage(assetId);
  if (!img) return null;

  if (!img.src.includes('Modern_Office')) {
    return img.src;
  }

  const overrideTiles = tileOverrides?.[assetId];
  let srcCol: number, srcRow: number, spanW: number, spanH: number;
  let tiles: [number, number][];

  if (overrideTiles && overrideTiles.length > 0) {
    const minC = Math.min(...overrideTiles.map((t) => t[0]));
    const minR = Math.min(...overrideTiles.map((t) => t[1]));
    const maxC = Math.max(...overrideTiles.map((t) => t[0]));
    const maxR = Math.max(...overrideTiles.map((t) => t[1]));
    srcCol = minC;
    srcRow = minR;
    spanW = maxC - minC + 1;
    spanH = maxR - minR + 1;
    tiles = overrideTiles;
  } else {
    const info = getAssetTileInfo(assetId);
    srcCol = info.srcCol;
    srcRow = info.srcRow;
    spanW = info.spanW;
    spanH = info.spanH;
    tiles = info.tiles;
  }

  const canvas = document.createElement('canvas');
  canvas.width = spanW * TILE;
  canvas.height = spanH * TILE;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;

  const tileSet = new Set(tiles.map(([c, r]) => `${c},${r}`));
  for (let r = srcRow; r < srcRow + spanH; r++) {
    for (let c = srcCol; c < srcCol + spanW; c++) {
      if (!tileSet.has(`${c},${r}`)) continue;
      ctx.drawImage(
        img,
        c * TILE, r * TILE, TILE, TILE,
        (c - srcCol) * TILE, (r - srcRow) * TILE, TILE, TILE,
      );
    }
  }

  return canvas.toDataURL();
}
