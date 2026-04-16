import { useMemo } from 'react';
import { getAssetTileInfo } from '../data/assetManifest';
import { getCachedImage } from '../utils/imageLoader';

const IMG_COLS = 2;
const IMG_ROWS = 3;

const CHECKER_BG: React.CSSProperties = {
  backgroundImage:
    'linear-gradient(45deg, #2a2a2a 25%, transparent 25%), ' +
    'linear-gradient(-45deg, #2a2a2a 25%, transparent 25%), ' +
    'linear-gradient(45deg, transparent 75%, #2a2a2a 75%), ' +
    'linear-gradient(-45deg, transparent 75%, #2a2a2a 75%)',
  backgroundSize: '8px 8px',
  backgroundPosition: '0 0, 0 4px, 4px -4px, -4px 0',
  backgroundColor: '#3a3a3a',
  borderRadius: 3,
};

interface Props {
  assetId: number;
  path: string;
  tileOverrides?: Record<number, [number, number][]>;
  size?: number;
}

export default function AssetThumbnail({ assetId, path, tileOverrides, size }: Props) {
  const info = useMemo(() => {
    const overrideTiles = tileOverrides?.[assetId];
    if (overrideTiles && overrideTiles.length > 0) {
      const minC = Math.min(...overrideTiles.map((t) => t[0]));
      const minR = Math.min(...overrideTiles.map((t) => t[1]));
      const maxC = Math.max(...overrideTiles.map((t) => t[0]));
      const maxR = Math.max(...overrideTiles.map((t) => t[1]));
      return { srcCol: minC, srcRow: minR, spanW: maxC - minC + 1, spanH: maxR - minR + 1 };
    }
    const ti = getAssetTileInfo(assetId);
    return { srcCol: ti.srcCol, srcRow: ti.srcRow, spanW: ti.spanW, spanH: ti.spanH };
  }, [assetId, tileOverrides]);

  // For custom assets (no path), use the cached pre-cropped image directly
  if (!path) {
    const cachedImg = getCachedImage(assetId);
    if (!cachedImg) {
      return (
        <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '9px', color: 'var(--text-muted)' }}>
          {info.spanW}×{info.spanH}
        </div>
      );
    }
    return (
      <div style={{ width: '100%', height: '100%', ...CHECKER_BG, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <img
          src={cachedImg.src}
          alt={`#${assetId}`}
          draggable={false}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'contain',
            imageRendering: 'pixelated',
          }}
        />
      </div>
    );
  }

  // Outer container fills the entire cell with checkerboard background.
  // Inner crop div maintains asset aspect ratio and is centered.
  const isTall = info.spanH > info.spanW;

  const cropStyle: React.CSSProperties = {
    position: 'relative',
    overflow: 'hidden',
    aspectRatio: `${info.spanW} / ${info.spanH}`,
    width: isTall ? 'auto' : '100%',
    height: isTall ? '100%' : 'auto',
    maxWidth: '100%',
    maxHeight: '100%',
  };

  const imgStyle: React.CSSProperties = {
    position: 'absolute',
    width: `${(IMG_COLS / info.spanW) * 100}%`,
    height: `${(IMG_ROWS / info.spanH) * 100}%`,
    left: `${-(info.srcCol / info.spanW) * 100}%`,
    top: `${-(info.srcRow / info.spanH) * 100}%`,
    imageRendering: 'pixelated',
  };

  return (
    <div style={{ width: '100%', height: '100%', ...CHECKER_BG, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={cropStyle}>
        <img src={path} alt={`#${assetId}`} draggable={false} style={imgStyle} />
      </div>
    </div>
  );
}
