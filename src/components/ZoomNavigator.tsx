import { useRef, useEffect, useCallback, useState } from 'react';
import type { RoomState } from '../hooks/useGrid';

const LAYER_COLORS: Record<string, string> = {
  floor: '#5c4a3a',
  wall: '#6b5b73',
  object: '#4a7a6b',
};

const MAP_MAX_W = 160;
const MAP_MAX_H = 120;
// Show area beyond workspace - 2x the workspace size in each direction
const MAP_PADDING_FACTOR = 1.5;
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 4;

interface Props {
  room: RoomState;
  zoom: number;
  offset: { x: number; y: number };
  containerWidth: number;
  containerHeight: number;
  onZoomChange: (zoom: number) => void;
  onOffsetChange: (offset: { x: number; y: number }) => void;
}

function blurTarget(e: React.MouseEvent) {
  (e.currentTarget as HTMLElement).blur();
}

export default function ZoomNavigator({
  room,
  zoom,
  offset,
  containerWidth,
  containerHeight,
  onZoomChange,
  onOffsetChange,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  // Calculate expanded area - show area beyond workspace
  const expandedW = room.width * MAP_PADDING_FACTOR;
  const expandedH = room.height * MAP_PADDING_FACTOR;
  
  // Calculate minimap size based on expanded area
  const expandedAspect = expandedW / expandedH;
  const mapW = expandedAspect >= MAP_MAX_W / MAP_MAX_H
    ? MAP_MAX_W
    : Math.round(MAP_MAX_H * expandedAspect);
  const mapH = expandedAspect >= MAP_MAX_W / MAP_MAX_H
    ? Math.round(MAP_MAX_W / expandedAspect)
    : MAP_MAX_H;

  // Scale converts from expanded area tiles to minimap pixels
  const tileToMapScale = mapW / expandedW;
  
  // Workspace position in expanded area (centered)
  const workspaceOffsetTiles = {
    x: (expandedW - room.width) / 2,
    y: (expandedH - room.height) / 2,
  };
  
  // Current zoom affects how much of the workspace is visible
  const cellPx = room.cellSize * zoom;

  const navigateTo = useCallback(
    (clientX: number, clientY: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      
      // Convert click position from minimap pixels to expanded area tiles
      const mapX = clientX - rect.left;
      const mapY = clientY - rect.top;
      const expandedTileX = mapX / tileToMapScale;
      const expandedTileY = mapY / tileToMapScale;
      
      // Convert to workspace coordinates (tiles relative to workspace origin)
      const workspaceTileX = expandedTileX - workspaceOffsetTiles.x;
      const workspaceTileY = expandedTileY - workspaceOffsetTiles.y;
      
      // Convert to pixel coordinates
      const workspacePixelX = workspaceTileX * room.cellSize * zoom;
      const workspacePixelY = workspaceTileY * room.cellSize * zoom;
      
      onOffsetChange({
        x: -(workspacePixelX - containerWidth / 2),
        y: -(workspacePixelY - containerHeight / 2),
      });
    },
    [tileToMapScale, workspaceOffsetTiles, room.cellSize, zoom, containerWidth, containerHeight, onOffsetChange]
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = mapW * dpr;
    canvas.height = mapH * dpr;
    canvas.style.width = `${mapW}px`;
    canvas.style.height = `${mapH}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Clear with lighter background (area outside workspace)
    ctx.fillStyle = '#1c2833';
    ctx.fillRect(0, 0, mapW, mapH);

    // Calculate workspace area position in minimap
    const workspaceMapX = workspaceOffsetTiles.x * tileToMapScale;
    const workspaceMapY = workspaceOffsetTiles.y * tileToMapScale;
    const workspaceMapW = room.width * tileToMapScale;
    const workspaceMapH = room.height * tileToMapScale;

    // Draw workspace area background (darker)
    ctx.fillStyle = '#0d1117';
    ctx.fillRect(workspaceMapX, workspaceMapY, workspaceMapW, workspaceMapH);

    // Draw subtle grid lines only in workspace area
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.lineWidth = 0.5;
    
    // Vertical grid lines in workspace
    for (let col = 0; col <= room.width; col++) {
      const x = workspaceMapX + col * tileToMapScale;
      ctx.beginPath();
      ctx.moveTo(x, workspaceMapY);
      ctx.lineTo(x, workspaceMapY + workspaceMapH);
      ctx.stroke();
    }
    
    // Horizontal grid lines in workspace  
    for (let row = 0; row <= room.height; row++) {
      const y = workspaceMapY + row * tileToMapScale;
      ctx.beginPath();
      ctx.moveTo(workspaceMapX, y);
      ctx.lineTo(workspaceMapX + workspaceMapW, y);
      ctx.stroke();
    }

    // Draw placements (only in workspace area)
    for (const p of room.placements) {
      const color = LAYER_COLORS[p.layer] ?? '#4a7a6b';
      ctx.fillStyle = color;
      ctx.fillRect(
        workspaceMapX + p.col * tileToMapScale,
        workspaceMapY + p.row * tileToMapScale,
        p.spanW * tileToMapScale,
        p.spanH * tileToMapScale
      );
    }

    // Draw workspace boundary
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(workspaceMapX + 0.5, workspaceMapY + 0.5, workspaceMapW - 1, workspaceMapH - 1);

    // Draw viewport rectangle - shows what area is currently visible
    // Convert viewport position from workspace pixels to minimap coordinates
    const tileSize = room.cellSize * zoom;
    const vpTileX = -offset.x / tileSize;
    const vpTileY = -offset.y / tileSize;
    const vpTileW = containerWidth / tileSize;
    const vpTileH = containerHeight / tileSize;
    
    // Convert to minimap coordinates (relative to workspace)
    const vpMapX = workspaceMapX + vpTileX * tileToMapScale;
    const vpMapY = workspaceMapY + vpTileY * tileToMapScale;
    const vpMapW = vpTileW * tileToMapScale;
    const vpMapH = vpTileH * tileToMapScale;

    ctx.fillStyle = 'rgba(79, 195, 247, 0.12)';
    ctx.fillRect(vpMapX, vpMapY, vpMapW, vpMapH);
    ctx.strokeStyle = 'rgba(79, 195, 247, 0.8)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(vpMapX, vpMapY, vpMapW, vpMapH);
  }, [room, zoom, offset, containerWidth, containerHeight, cellPx, mapW, mapH, tileToMapScale, workspaceOffsetTiles]);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      e.stopPropagation();
      setIsDragging(true);
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      navigateTo(e.clientX, e.clientY);
    },
    [navigateTo]
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!isDragging) return;
      navigateTo(e.clientX, e.clientY);
    },
    [isDragging, navigateTo]
  );

  const handlePointerUp = useCallback(() => {
    setIsDragging(false);
  }, []);

  return (
    <div style={styles.container}>
      <div style={styles.mapWrap}>
        <canvas
          ref={canvasRef}
          style={styles.canvas}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
        />
      </div>
      <div style={styles.controls}>
        <button
          style={styles.btn}
          onClick={(e) => { onZoomChange(Math.max(MIN_ZOOM, +(zoom - 0.1).toFixed(2))); blurTarget(e); }}
        >
          −
        </button>
        <span style={styles.zoomValue}>{Math.round(zoom * 100)}%</span>
        <button
          style={styles.btn}
          onClick={(e) => { onZoomChange(Math.min(MAX_ZOOM, +(zoom + 0.1).toFixed(2))); blurTarget(e); }}
        >
          +
        </button>
        <button
          style={styles.btn}
          onClick={(e) => { onZoomChange(1); blurTarget(e); }}
          title="Reset zoom to 100%"
        >
          1:1
        </button>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    position: 'absolute',
    bottom: 12,
    right: 12,
    zIndex: 10,
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    pointerEvents: 'auto',
  },
  mapWrap: {
    borderRadius: 6,
    overflow: 'hidden',
    border: '1px solid var(--border)',
    background: 'var(--bg-secondary)',
    boxShadow: '0 2px 12px rgba(0,0,0,0.4)',
  },
  canvas: {
    display: 'block',
    cursor: 'crosshair',
  },
  controls: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    padding: '4px 6px',
    borderRadius: 6,
    background: 'var(--bg-secondary)',
    border: '1px solid var(--border)',
    boxShadow: '0 2px 12px rgba(0,0,0,0.4)',
  },
  btn: {
    padding: '2px 8px',
    borderRadius: 4,
    border: '1px solid transparent',
    background: 'var(--bg-surface)',
    fontSize: 12,
    cursor: 'pointer',
    color: 'var(--text-secondary)',
    lineHeight: '18px',
  },
  zoomValue: {
    fontSize: 11,
    color: 'var(--text-secondary)',
    minWidth: 36,
    textAlign: 'center',
    fontVariantNumeric: 'tabular-nums',
  },
};
