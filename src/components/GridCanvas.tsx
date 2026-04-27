import {
  useRef,
  useEffect,
  useCallback,
  useState,
  useMemo,
  type DragEvent,
  type PointerEvent,
} from 'react';
import type { RoomState, LayerType, Placement } from '../hooks/useGrid';
import type { ToolState } from '../hooks/useTool';
import type { CustomAssetData } from '../hooks/useCustomAssets';
import type { Agent } from '../hooks/useAgents';
import { getCachedImage } from '../utils/imageLoader';
import {
  getCachedCharacter,
  CHAR_FRAME_W,
  CHAR_FRAME_H,
  FACING_ROW,
} from '../utils/characterImageLoader';
import { getAssetTileInfo, type AssetTileInfo } from '../data/assetManifest';
import type { PixelMask } from '../utils/pixelMasks';
import ZoomNavigator from './ZoomNavigator';

interface Props {
  room: RoomState;
  version: number;
  toolState: ToolState;
  zoom: number;
  tileOverrides?: Record<number, [number, number][]>;
  customAssets?: CustomAssetData[];
  selectedPlacementIds?: Set<string>;
  hoveredPlacementIds?: Set<string>;
  readOnly?: boolean;
  onAddPlacement?: (assetId: number, row: number, col: number, layer: LayerType, rotation?: number, flipH?: boolean, flipV?: boolean, replace?: boolean) => void;
  onRemovePlacementAt?: (row: number, col: number, layer?: LayerType) => void;
  onRemovePlacementById?: (id: string) => void;
  getPlacementAt?: (row: number, col: number, layer?: LayerType) => Placement | null;
  onBeginUndoBatch?: () => void;
  onEndUndoBatch?: () => void;
  onSetSelectedIds?: (ids: Set<string>) => void;
  onDeletePlacements?: (ids: Set<string>) => void;
  onBulkMovePlacements?: (moves: { id: string; newRow: number; newCol: number }[]) => void;
  onBulkDuplicatePlacements?: (sources: { assetId: number; row: number; col: number; layer: LayerType; spanW: number; spanH: number; rotation: number; flipH: boolean; flipV: boolean; groupId?: string; zIndex?: number }[]) => void;
  onDuplicateGroup?: (groupId: string, offsetRow?: number, offsetCol?: number) => string[];
  onModeChange?: (mode: 'select' | 'draw' | 'place') => void;
  onZoomChange: (zoom: number) => void;
  onRotate?: () => void;
  onFlipH?: () => void;
  onFlipV?: () => void;
  agents?: Agent[];
  activeAgentId?: string | null;
  /** Agent currently under the cursor (in live/read-only mode). When set,
   *  that agent gets a warm glow ring under its feet to signal
   *  "click to take over / double-click to open terminal". */
  hoveredAgentId?: string | null;
  /** Agents whose terminal currently reports a "busy" signal (thinking,
   *  editing, running, etc.). Used to paint an animated thinking bubble
   *  above each sprite. Lookup-only; the component never mutates. */
  busyAgentIds?: Record<string, true>;
  /** Agents that have a pending error/warning from their terminal.
   *  Renders a red "!" badge at the top-right of the sprite; the message
   *  surfaces as a tooltip when that agent is hovered. */
  errorAgents?: Record<string, { message: string; at: number }>;
  /** Agents that just finished a piece of work while the user wasn't
   *  watching. Renders a green "✓" badge at the top-left of the sprite
   *  with a pop-in animation so it's impossible to miss on return. Cleared
   *  once the user opens that agent's terminal (acknowledgement) or a new
   *  busy window begins. */
  doneAgents?: Record<string, { at: number }>;
  onActivateAgent?: (id: string) => void;
  /** Fires when the user clicks empty space (or re-clicks the active agent)
   *  in live/read-only mode. Parent typically responds by clearing the
   *  active agent so the camera unlocks and WASD stops driving someone. */
  onDeactivateAgent?: () => void;
  onOpenAgentTerminal?: (id: string) => void;
  onAgentContextMenu?: (id: string, clientX: number, clientY: number) => void;
  /** Fires whenever the agent under the cursor changes (null when the
   *  pointer leaves the canvas or moves off every sprite). Only emitted
   *  in read-only (live) mode. */
  onAgentHover?: (id: string | null) => void;
  onPlacementContextMenu?: (placement: Placement, clientX: number, clientY: number) => void;
  /** Returns the effective render-order override for a placement:
   *    - `'auto'`  — follow normal y-sort (default).
   *    - `'above'` — force-render after any agent.
   *    - `'below'` — force-render before any agent.
   *  When omitted, every placement is treated as `'auto'`. */
  getRenderOrder?: (placement: Placement) => 'auto' | 'above' | 'below';
  showNameplates?: boolean;
  /** When true (and `readOnly`), overlays a red tint on every pixel that
   *  currently blocks agent movement. Useful to diagnose "invisible walls"
   *  caused by faint shadow pixels in an asset. */
  collisionDebug?: boolean;
  /** Supplies the effective collision mask for a placement. Only consulted
   *  when `collisionDebug` is on. */
  getPlacementCollisionMask?: (p: Placement) => PixelMask | null;
}

const GRID_LINE_COLOR = 'rgba(255, 255, 255, 0.06)';
const HOVER_COLOR = 'rgba(79, 195, 247, 0.15)';
const ERASE_COLOR = 'rgba(239, 83, 80, 0.25)';
const GHOST_ALPHA = 0.5;
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 4;
const LAYER_ORDER: LayerType[] = ['floor', 'wall', 'object'];
const TILE_PX = 48;

interface MovingPlacement {
  placement: Placement;
  offsetRow: number;
  offsetCol: number;
}

export default function GridCanvas({
  room,
  version,
  toolState,
  zoom,
  tileOverrides,
  customAssets,
  selectedPlacementIds,
  hoveredPlacementIds,
  readOnly,
  onAddPlacement,
  onRemovePlacementById,
  getPlacementAt,
  onBeginUndoBatch,
  onEndUndoBatch,
  onSetSelectedIds,
  onDeletePlacements,
  onBulkMovePlacements,
  onBulkDuplicatePlacements,
  onDuplicateGroup,
  onModeChange,
  onZoomChange,
  onRotate,
  onFlipH,
  onFlipV,
  agents,
  activeAgentId,
  hoveredAgentId,
  busyAgentIds,
  errorAgents,
  doneAgents,
  onActivateAgent,
  onDeactivateAgent,
  onOpenAgentTerminal,
  onAgentContextMenu,
  onAgentHover,
  onPlacementContextMenu,
  getRenderOrder,
  showNameplates = true,
  collisionDebug = false,
  getPlacementCollisionMask,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [hoverCell, setHoverCell] = useState<{ row: number; col: number } | null>(null);
  const [isPanning, setIsPanning] = useState(false);
  const [isPainting, setIsPainting] = useState(false);
  const [dragAssetId, setDragAssetId] = useState<number | null>(null);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [movingPlacement, setMovingPlacement] = useState<MovingPlacement | null>(null);
  const [containerSize, setContainerSize] = useState({ w: 0, h: 0 });
  const [marqueeStart, setMarqueeStart] = useState<{ row: number; col: number } | null>(null);
  const [cursorPos, setCursorPos] = useState<{ x: number; y: number } | null>(null);
  // Monotonic tick bumped at ~30fps while any agent is busy. Feeds the
  // render effect as a dep so the thinking-bubble dots stay animated even
  // when nothing else on screen is changing (idle sprites, static camera).
  const [busyTick, setBusyTick] = useState(0);
  const hasBusy = !!(busyAgentIds && Object.keys(busyAgentIds).length > 0);
  const hasError = !!(errorAgents && Object.keys(errorAgents).length > 0);
  const hasDone = !!(doneAgents && Object.keys(doneAgents).length > 0);
  // RAF loop is shared between the thinking-bubble dots, the error-badge
  // pulse, and the done-badge pop-in. Runs as long as any overlay still
  // needs animating so we don't double-register. Once all done badges have
  // finished their pop-in window the shared `busyTick` simply stops
  // updating — the final frame is already painted and stays put until the
  // parent clears `doneAgents`.
  const needsAnim = hasBusy || hasError || hasDone;
  useEffect(() => {
    if (!needsAnim) return;
    let raf = 0;
    let last = 0;
    const tick = (ts: number) => {
      // ~30fps cadence is plenty for 3-dot animation and halves the CPU
      // cost vs. redrawing on every vsync.
      if (ts - last >= 33) {
        last = ts;
        setBusyTick((v) => (v + 1) & 0x3fffffff);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [needsAnim]);

  // Select mode state -- use refs for drag to avoid stale closure issues
  const [selectMarquee, setSelectMarquee] = useState<{ startRow: number; startCol: number; endRow: number; endCol: number } | null>(null);
  const selectDraggingRef = useRef<{ startRow: number; startCol: number } | null>(null);
  const selectDragOffsetRef = useRef<{ dRow: number; dCol: number }>({ dRow: 0, dCol: 0 });
  const selectDragIdsRef = useRef<Set<string>>(new Set());
  const [selectDragRenderKey, setSelectDragRenderKey] = useState(0);

  const panStart = useRef({ x: 0, y: 0, ox: 0, oy: 0 });

  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const offsetRef = useRef(offset);
  offsetRef.current = offset;
  const onZoomChangeRef = useRef(onZoomChange);
  onZoomChangeRef.current = onZoomChange;

  const cellPx = room.cellSize * zoom;

  const agentsRef = useRef(agents);
  agentsRef.current = agents;
  const activeAgentIdRef = useRef(activeAgentId ?? null);
  activeAgentIdRef.current = activeAgentId ?? null;
  // Track the last-emitted hover id ourselves rather than reading it from the
  // prop so we don't fire duplicate callbacks if the parent intentionally
  // stays on the same hovered agent across prop updates.
  const lastHoveredAgentRef = useRef<string | null>(null);

  // Cache of red-tinted offscreen canvases keyed by `PixelMask` reference.
  // Masks are immutable once decoded, so identity is a safe cache key. Cleared
  // only on unmount; memory usage is proportional to distinct mask images in
  // use, which is bounded by (asset count + edited placements).
  const maskOverlayCacheRef = useRef<WeakMap<PixelMask, HTMLCanvasElement>>(new WeakMap());

  // ── Effective camera offset ────────────────────────────────────────────────
  // When in live/read-only mode with an active agent and a room that is larger
  // than the viewport, derive the camera offset directly from the agent's
  // position. Deriving (instead of running a separate rAF that calls setOffset)
  // keeps the agent's world-position and the camera offset inside the *same*
  // React render. That eliminates the 1-frame drift that was causing the
  // jagged "camera chasing the agent" effect.
  const effectiveOffset = useMemo(() => {
    if (!readOnly) return offset;
    if (!activeAgentId || !agents) return offset;
    const w = containerSize.w;
    const h = containerSize.h;
    if (w <= 0 || h <= 0) return offset;
    const a = agents.find((ag) => ag.id === activeAgentId);
    if (!a) return offset;
    const cp = room.cellSize * zoom;
    const gridW = room.width * cp;
    const gridH = room.height * cp;
    // Only follow on axes where the room is actually larger than the viewport
    // (with a small margin so we don't chase pixels when the room "barely" fits).
    const MARGIN = 24;
    const fitsX = gridW + MARGIN * 2 <= w;
    const fitsY = gridH + MARGIN * 2 <= h;
    if (fitsX && fitsY) return offset;
    const agentCx = (a.col + 0.5) * cp;
    const agentCy = (a.row + 0.5) * cp;
    let x = fitsX ? offset.x : w / 2 - agentCx;
    let y = fitsY ? offset.y : h / 2 - agentCy;
    // Clamp so the room doesn't ever scroll fully off-screen on the followed
    // axes. This also naturally freezes the camera at the edges of the room
    // rather than the agent drifting off-center once near a wall.
    if (!fitsX) {
      const minX = w - gridW;
      const maxX = 0;
      if (x < minX) x = minX;
      if (x > maxX) x = maxX;
    }
    if (!fitsY) {
      const minY = h - gridH;
      const maxY = 0;
      if (y < minY) y = minY;
      if (y > maxY) y = maxY;
    }
    return { x, y };
  }, [
    readOnly,
    activeAgentId,
    agents,
    offset,
    containerSize.w,
    containerSize.h,
    room.cellSize,
    room.width,
    room.height,
    zoom,
  ]);

  const hitTestAgent = useCallback(
    (clientX: number, clientY: number): string | null => {
      const list = agentsRef.current;
      if (!list || list.length === 0) return null;
      const canvas = canvasRef.current;
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      const x = clientX - rect.left - effectiveOffset.x;
      const y = clientY - rect.top - effectiveOffset.y;
      const spriteH = cellPx * 2.025;
      const spriteW = spriteH * (CHAR_FRAME_W / CHAR_FRAME_H);
      // Iterate last (top) to first so front-most wins
      for (let i = list.length - 1; i >= 0; i--) {
        const a = list[i];
        const centerX = (a.col + 0.5) * cellPx;
        const footY = (a.row + 1) * cellPx;
        const destX = centerX - spriteW / 2;
        const destY = footY - spriteH;
        if (x >= destX && x <= destX + spriteW && y >= destY && y <= destY + spriteH) {
          return a.id;
        }
      }
      return null;
    },
    [effectiveOffset.x, effectiveOffset.y, cellPx]
  );

  const toGrid = useCallback(
    (clientX: number, clientY: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      const x = clientX - rect.left - effectiveOffset.x;
      const y = clientY - rect.top - effectiveOffset.y;
      const col = Math.floor(x / cellPx);
      const row = Math.floor(y / cellPx);
      if (row < 0 || row >= room.height || col < 0 || col >= room.width) return null;
      return { row, col };
    },
    [effectiveOffset, cellPx, room.width, room.height]
  );

  const customAssetMap = useMemo(() => {
    const m = new Map<number, CustomAssetData>();
    if (customAssets) for (const a of customAssets) m.set(a.id, a);
    return m;
  }, [customAssets]);

  const resolveTileInfo = useCallback((assetId: number): AssetTileInfo => {
    const ca = customAssetMap.get(assetId);
    if (ca) {
      return { tiles: ca.tiles, srcCol: 0, srcRow: 0, spanW: ca.spanW, spanH: ca.spanH };
    }
    const overrideTiles = tileOverrides?.[assetId];
    if (overrideTiles && overrideTiles.length > 0) {
      const minC = Math.min(...overrideTiles.map((t) => t[0]));
      const minR = Math.min(...overrideTiles.map((t) => t[1]));
      const maxC = Math.max(...overrideTiles.map((t) => t[0]));
      const maxR = Math.max(...overrideTiles.map((t) => t[1]));
      return {
        tiles: overrideTiles,
        srcCol: minC,
        srcRow: minR,
        spanW: maxC - minC + 1,
        spanH: maxR - minR + 1,
      };
    }
    return getAssetTileInfo(assetId);
  }, [tileOverrides, customAssetMap]);

  const resolveSize = useCallback((assetId: number, rotation = 0): [number, number] => {
    const info = resolveTileInfo(assetId);
    const isRotated = rotation === 90 || rotation === 270;
    return isRotated ? [info.spanH, info.spanW] : [info.spanW, info.spanH];
  }, [resolveTileInfo]);

  // ── Draw an asset with rotation/flip transforms ──────────────────────────
  const drawAsset = useCallback(
    (ctx: CanvasRenderingContext2D, assetId: number, anchorCol: number, anchorRow: number, alpha = 1, rotation = 0, flipH = false, flipV = false) => {
      const img = getCachedImage(assetId);
      if (!img) return;
      const info = resolveTileInfo(assetId);
      const [sw, sh] = resolveSize(assetId, rotation);
      const hasTransform = rotation !== 0 || flipH || flipV;

      if (alpha < 1) ctx.globalAlpha = alpha;

      if (hasTransform) {
        ctx.save();
        const cx = (anchorCol + sw / 2) * cellPx;
        const cy = (anchorRow + sh / 2) * cellPx;
        ctx.translate(cx, cy);
        ctx.rotate((rotation * Math.PI) / 180);
        if (flipH) ctx.scale(-1, 1);
        if (flipV) ctx.scale(1, -1);
        ctx.translate(-cx, -cy);

        const drawCol = rotation === 90 || rotation === 270
          ? anchorCol + (sw - info.spanW) / 2
          : anchorCol;
        const drawRow = rotation === 90 || rotation === 270
          ? anchorRow + (sh - info.spanH) / 2
          : anchorRow;

        for (const [imgCol, imgRow] of info.tiles) {
          const relCol = imgCol - info.srcCol;
          const relRow = imgRow - info.srcRow;
          const srcX = imgCol * TILE_PX;
          const srcY = imgRow * TILE_PX;
          const col = drawCol + relCol;
          const row = drawRow + relRow;
          const dstX = Math.round(col * cellPx);
          const dstY = Math.round(row * cellPx);
          const dstW = Math.round((col + 1) * cellPx) - dstX;
          const dstH = Math.round((row + 1) * cellPx) - dstY;
          ctx.drawImage(img, srcX, srcY, TILE_PX, TILE_PX, dstX, dstY, dstW, dstH);
        }
        ctx.restore();
      } else {
        for (const [imgCol, imgRow] of info.tiles) {
          const relCol = imgCol - info.srcCol;
          const relRow = imgRow - info.srcRow;
          const srcX = imgCol * TILE_PX;
          const srcY = imgRow * TILE_PX;
          const col = anchorCol + relCol;
          const row = anchorRow + relRow;
          const dstX = Math.round(col * cellPx);
          const dstY = Math.round(row * cellPx);
          const dstW = Math.round((col + 1) * cellPx) - dstX;
          const dstH = Math.round((row + 1) * cellPx) - dstY;
          ctx.drawImage(img, srcX, srcY, TILE_PX, TILE_PX, dstX, dstY, dstW, dstH);
        }
      }

      if (alpha < 1) ctx.globalAlpha = 1;
    },
    [cellPx, resolveTileInfo, resolveSize]
  );

  // ── Canvas rendering ──────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const container = containerRef.current;
    if (!container) return;

    const dpr = window.devicePixelRatio || 1;
    const w = container.clientWidth;
    const h = container.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.clearRect(0, 0, w, h);
    ctx.save();
    // Keep sub-pixel translation in read-only mode for smooth camera follow;
    // in build mode, round so grid lines stay crisp.
    const tx = readOnly ? effectiveOffset.x : Math.round(effectiveOffset.x);
    const ty = readOnly ? effectiveOffset.y : Math.round(effectiveOffset.y);
    ctx.translate(tx, ty);

    ctx.fillStyle = '#0d1117';
    ctx.fillRect(0, 0, Math.round(room.width * cellPx), Math.round(room.height * cellPx));

    // Build group map for visibility checks
    const groupMap = new Map((room.groups ?? []).map((g) => [g.id, g]));

    // Draw placements: filter hidden layers/groups, sort by layer order then hybrid z-index
    const sorted = [...room.placements]
      .filter((p) => {
        if ((room.layerVisibility ?? {})[p.layer] === false) return false;
        if (p.groupId) {
          const g = groupMap.get(p.groupId);
          if (g && !g.visible) return false;
        }
        return true;
      })
      .sort((a, b) => {
        const la = LAYER_ORDER.indexOf(a.layer);
        const lb = LAYER_ORDER.indexOf(b.layer);
        if (la !== lb) return la - lb;
        const za = a.zIndex ?? (a.row + a.spanH) * 1000;
        const zb = b.zIndex ?? (b.row + b.spanH) * 1000;
        return za - zb;
      });

    // ── Unified y-sorted stream for walls + objects + agents ─────────────
    //
    // Floor is drawn first as a pure painter's-algorithm pass (it's always
    // the bottom). Everything else — walls, objects, agents — goes through
    // a single y-sorted stream so things Just Work the way Godot's YSort /
    // Unity 2D / Stardew Valley handle depth: whoever's foot is lower on
    // screen renders last (= visually in front).
    //
    // Putting walls in the same stream solves the "plant behind a half-
    // height wall" problem: a plant whose pot sits at the top row of a wall
    // naturally sorts *before* the wall (smaller `row + spanH`), so the
    // wall draws on top and occludes the pot.
    //
    // The `getRenderOrder` hook is the escape hatch for cases where
    // position-based sorting gets it wrong (tall back walls, floor art on
    // the object layer, decorative hanging signs). It pins a specific
    // placement (or every placement of an asset) to always draw in front of
    // or behind everything else in the stream, regardless of y-position.
    const floorLayer: Placement[] = [];
    const sortedStreamPlacements: Placement[] = [];
    for (const p of sorted) {
      if (movingPlacement && p.id === movingPlacement.placement.id) continue;
      if (p.layer === 'floor') floorLayer.push(p);
      else sortedStreamPlacements.push(p);
    }

    // Floor, painter's-algorithm style (already sorted by z-index above).
    for (const p of floorLayer) {
      drawAsset(ctx, p.assetId, p.col, p.row, 1, p.rotation, p.flipH, p.flipV);
    }

    type StreamItem =
      | { kind: 'placement'; bucket: 0 | 1 | 2; sortY: number; stableIdx: number; data: Placement }
      | { kind: 'agent'; bucket: 0 | 1 | 2; sortY: number; stableIdx: number; data: Agent };

    const stream: StreamItem[] = [];
    // Placements (walls + objects): bucket 0 = 'always behind', 1 = 'auto',
    // 2 = 'always in front'. Within a bucket we y-sort by natural bottom
    // edge so two items keep their normal relative depth.
    //
    // Note: we deliberately ignore `zIndex` as a sort key in the stream.
    // `reorderPlacementsBulk` / `bringToFront` / `sendToBack` write `zIndex`
    // values in small ranges (10, 20, 30, …) — when we previously used
    // `p.zIndex ?? (row+spanH)*1000` those small integers dominated the
    // sort key and dragged placements across y-depth, which broke the
    // "tall back wall covers the desks in front of it" invariant. The
    // initial `sorted` array that feeds `sortedStreamPlacements` is still
    // zIndex-aware, so zIndex continues to act as a *tiebreaker* for items
    // at identical y (via `stableIdx`). Users who want to pin a placement
    // outside its natural depth should use the `RenderOrder` override
    // (`Always in front` / `Always behind`) instead.
    for (let i = 0; i < sortedStreamPlacements.length; i++) {
      const p = sortedStreamPlacements[i];
      const order = getRenderOrder?.(p) ?? 'auto';
      const bucket: 0 | 1 | 2 = order === 'below' ? 0 : order === 'above' ? 2 : 1;
      const natural = (p.row + p.spanH) * 1000;
      stream.push({ kind: 'placement', bucket, sortY: natural, stableIdx: i, data: p });
    }
    // Agents live in the auto bucket — their sort key is the foot row so
    // they y-sort against object/wall placements naturally (`row + 1 ==
    // spanH` for a 1-cell footprint, matching the placement convention).
    if (readOnly && agents && agents.length > 0) {
      for (let i = 0; i < agents.length; i++) {
        const a = agents[i];
        stream.push({
          kind: 'agent',
          bucket: 1,
          sortY: (a.row + 1) * 1000,
          // Offset stableIdx so agents don't collide with placement indices
          // at identical sortY — purely a deterministic tiebreak.
          stableIdx: 1_000_000 + i,
          data: a,
        });
      }
    }
    stream.sort((x, y) => {
      if (x.bucket !== y.bucket) return x.bucket - y.bucket;
      if (x.sortY !== y.sortY) return x.sortY - y.sortY;
      return x.stableIdx - y.stableIdx;
    });

    // Agent sprite dimensions (same for every agent — sprite is ~2× cell
    // height so characters read as person-sized).
    const spriteH = cellPx * 2.025;
    const spriteW = spriteH * (CHAR_FRAME_W / CHAR_FRAME_H);

    for (const item of stream) {
      if (item.kind === 'placement') {
        const p = item.data;
        drawAsset(ctx, p.assetId, p.col, p.row, 1, p.rotation, p.flipH, p.flipV);
        continue;
      }

      const agent = item.data;
      const img = getCachedCharacter(agent.spriteId);
      const centerX = (agent.col + 0.5) * cellPx;
      const footY = (agent.row + 1) * cellPx;
      const destX = centerX - spriteW / 2;
      // Feet sit exactly on the bottom edge of the agent's cell so they never
      // visually poke into the neighboring cell (which could be a wall).
      const destY = footY - spriteH;
      const srcY = FACING_ROW[agent.facing] * CHAR_FRAME_H;
      const srcX = agent.animFrame * CHAR_FRAME_W;

      // Hover glow ring — signals "click to take over, double-click to open
      // terminal". Drawn underneath the active ring so both can co-exist on
      // the currently-active-and-hovered agent (warm glow beneath a crisper
      // blue selection ring on top).
      if (agent.id === hoveredAgentId) {
        const hoverRx = spriteW * 0.48;
        const hoverRy = spriteW * 0.2;
        const hoverCy = footY - hoverRy * 0.85;
        ctx.save();
        // Additive-ish layered ellipses simulate a soft bloom without
        // requiring per-pixel compositing that would break with imageSmoothing
        // disabled. Three passes, decreasing radius and increasing opacity.
        ctx.fillStyle = 'rgba(255, 214, 128, 0.18)';
        ctx.beginPath();
        ctx.ellipse(centerX, hoverCy, hoverRx * 1.15, hoverRy * 1.15, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = 'rgba(255, 214, 128, 0.28)';
        ctx.beginPath();
        ctx.ellipse(centerX, hoverCy, hoverRx, hoverRy, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(255, 214, 128, 0.85)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.restore();
      }

      // Active ring under feet.
      //   The ring must sit *within* the agent's cell — otherwise it visibly
      //   bleeds onto whatever is in the cell below (walls, floor tile, etc.)
      //   We anchor the bottom of the ellipse flush with `footY` so the whole
      //   ring is contained in the agent's cell.
      if (agent.id === activeAgentId) {
        const ringRx = spriteW * 0.4;
        const ringRy = spriteW * 0.16;
        const ringCy = footY - ringRy;
        ctx.save();
        ctx.fillStyle = 'rgba(79, 195, 247, 0.35)';
        ctx.beginPath();
        ctx.ellipse(centerX, ringCy, ringRx, ringRy, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(79, 195, 247, 0.8)';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.restore();
      }

      if (img) {
        const prevSmoothing = ctx.imageSmoothingEnabled;
        ctx.imageSmoothingEnabled = false;
        // Sub-pixel destination so the sprite slides smoothly with the camera.
        ctx.drawImage(
          img,
          srcX,
          srcY,
          CHAR_FRAME_W,
          CHAR_FRAME_H,
          destX,
          destY,
          spriteW,
          spriteH
        );
        ctx.imageSmoothingEnabled = prevSmoothing;
      }

      // Nameplate
      if (showNameplates && cellPx >= 24) {
        const label = agent.nickname || '(agent)';
        ctx.save();
        ctx.font = `${Math.max(10, Math.round(cellPx * 0.24))}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const metrics = ctx.measureText(label);
        const padX = 6, padY = 3;
        const tw = metrics.width + padX * 2;
        const th = Math.max(14, Math.round(cellPx * 0.32));
        const tx = centerX;
        const ty = destY - th / 2 - 2;
        ctx.fillStyle = agent.id === activeAgentId ? 'rgba(79, 195, 247, 0.95)' : 'rgba(20, 24, 34, 0.85)';
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
        ctx.lineWidth = 1;
        const rectX = tx - tw / 2;
        const rectY = ty - th / 2;
        ctx.beginPath();
        if (typeof ctx.roundRect === 'function') {
          ctx.roundRect(rectX, rectY, tw, th, 4);
        } else {
          ctx.rect(rectX, rectY, tw, th);
        }
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = agent.id === activeAgentId ? '#0d1117' : '#e8eef7';
        ctx.fillText(label, tx, ty + padY * 0.2);
        ctx.restore();
      }

      // Thinking bubble — a small speech bubble floating above the sprite
      // with 3 dots that breathe out of phase. Drawn last so it sits on top
      // of nameplates and any overlapping object sprites from the y-sort.
      if (busyAgentIds && busyAgentIds[agent.id]) {
        // Sprite-local scale so the bubble shrinks with zoom rather than
        // floating detached. Clamped to a minimum so it stays legible at
        // far zoom-outs but never explodes past the sprite at close range.
        const bubbleScale = Math.max(0.7, Math.min(1.4, cellPx / TILE_PX));
        const bubbleW = 34 * bubbleScale;
        const bubbleH = 18 * bubbleScale;
        // Place the bubble above whatever's already above the sprite
        // (nameplate or the sprite's own top edge), with a small gap.
        const nameplateH = showNameplates && cellPx >= 24 ? Math.max(14, Math.round(cellPx * 0.32)) + 4 : 0;
        const bubbleCy = destY - nameplateH - bubbleH / 2 - 4 * bubbleScale;
        const bubbleCx = centerX + spriteW * 0.18; // offset slightly right so tail points at the sprite's head
        const bubbleX = bubbleCx - bubbleW / 2;
        const bubbleY = bubbleCy - bubbleH / 2;
        const radius = Math.min(bubbleH / 2, 8 * bubbleScale);

        ctx.save();
        // Bubble shadow — subtle drop shadow for lift, cheap because it's
        // just a single offset ellipse rather than canvas shadowBlur.
        ctx.fillStyle = 'rgba(0, 0, 0, 0.25)';
        ctx.beginPath();
        if (typeof ctx.roundRect === 'function') {
          ctx.roundRect(bubbleX + 1, bubbleY + 2, bubbleW, bubbleH, radius);
        } else {
          ctx.rect(bubbleX + 1, bubbleY + 2, bubbleW, bubbleH);
        }
        ctx.fill();

        // Bubble body
        ctx.fillStyle = 'rgba(245, 247, 252, 0.98)';
        ctx.strokeStyle = 'rgba(20, 24, 34, 0.7)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        if (typeof ctx.roundRect === 'function') {
          ctx.roundRect(bubbleX, bubbleY, bubbleW, bubbleH, radius);
        } else {
          ctx.rect(bubbleX, bubbleY, bubbleW, bubbleH);
        }
        ctx.fill();
        ctx.stroke();

        // Tail — a small triangle pointing down-left toward the sprite's
        // head. Two triangles actually: fill (white) and stroke that
        // joins the bubble outline so the outline doesn't cross the tail.
        const tailBaseY = bubbleY + bubbleH - 0.5;
        const tailTipX = bubbleCx - bubbleW * 0.28;
        const tailTipY = tailBaseY + 6 * bubbleScale;
        const tailBaseLeft = tailTipX + 2 * bubbleScale;
        const tailBaseRight = tailTipX + 8 * bubbleScale;
        ctx.beginPath();
        ctx.moveTo(tailBaseLeft, tailBaseY);
        ctx.lineTo(tailTipX, tailTipY);
        ctx.lineTo(tailBaseRight, tailBaseY);
        ctx.closePath();
        ctx.fillStyle = 'rgba(245, 247, 252, 0.98)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(20, 24, 34, 0.7)';
        ctx.beginPath();
        ctx.moveTo(tailBaseLeft, tailBaseY);
        ctx.lineTo(tailTipX, tailTipY);
        ctx.lineTo(tailBaseRight, tailBaseY);
        ctx.stroke();

        // 3 animated dots — each dot's alpha + vertical offset is phased
        // by 1/3 of the cycle so they bounce in sequence (left-to-right).
        // Cycle is ~900ms which reads as "thinking" without being frantic.
        const now = performance.now();
        const cycle = 900;
        const dotR = 2.1 * bubbleScale;
        const dotSpacing = 7 * bubbleScale;
        const dotsCenterX = bubbleCx;
        const dotsBaseY = bubbleCy;
        for (let i = 0; i < 3; i++) {
          // Phase of this dot in [0, 1). Normalised so dot 0 starts at 0.
          const phase = ((now / cycle) - i / 3) % 1;
          const p = phase < 0 ? phase + 1 : phase;
          // Sine-based bounce: 0 → up → 0 over the first half, idle rest.
          const bounce = p < 0.5 ? Math.sin(p * Math.PI * 2) : 0;
          const dotY = dotsBaseY - bounce * 2.5 * bubbleScale;
          const dotX = dotsCenterX + (i - 1) * dotSpacing;
          const alpha = 0.35 + (p < 0.5 ? Math.sin(p * Math.PI) * 0.6 : 0);
          ctx.fillStyle = `rgba(20, 24, 34, ${alpha.toFixed(3)})`;
          ctx.beginPath();
          ctx.arc(dotX, dotY, dotR, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }

      // Error badge — red circle with white "!" pinned to the sprite's
      // top-right corner. Co-exists with the thinking bubble (they occupy
      // different positions) so a sprite can simultaneously signal
      // "I'm working" + "heads up, something errored earlier".
      if (errorAgents && errorAgents[agent.id]) {
        const badgeScale = Math.max(0.7, Math.min(1.3, cellPx / TILE_PX));
        const badgeR = 8 * badgeScale;
        // Anchor to the upper-right of the sprite's visible rect, nudged
        // slightly inward so it doesn't clip on very cramped zoom levels.
        const badgeCx = destX + spriteW - badgeR * 0.6;
        const badgeCy = destY + badgeR * 0.8;
        // Pulse: 1.0 → 1.12 → 1.0 over 1400ms. Sine-based so it breathes
        // rather than snaps. Amplitude is deliberately small — the color
        // is already loud, so we don't need the geometry to shout too.
        const pulsePhase = (performance.now() % 1400) / 1400;
        const pulse = 1 + Math.sin(pulsePhase * Math.PI * 2) * 0.06 + 0.06;
        const r = badgeR * pulse;

        ctx.save();
        // Outer soft glow. Radial gradient would be costlier and not
        // meaningfully prettier at this size, so we fake it with two
        // concentric translucent disks.
        ctx.fillStyle = 'rgba(239, 83, 80, 0.22)';
        ctx.beginPath();
        ctx.arc(badgeCx, badgeCy, r * 1.8, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = 'rgba(239, 83, 80, 0.35)';
        ctx.beginPath();
        ctx.arc(badgeCx, badgeCy, r * 1.4, 0, Math.PI * 2);
        ctx.fill();

        // Badge body
        ctx.fillStyle = '#ef5350';
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(badgeCx, badgeCy, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        // "!" glyph — drawn as a vertical bar + a dot rather than using
        // a text glyph, so we don't depend on a bold font being present
        // and rendering is pixel-stable across zoom levels.
        ctx.fillStyle = '#ffffff';
        const barW = Math.max(1.5, r * 0.26);
        const barH = r * 0.9;
        const barX = badgeCx - barW / 2;
        const barTop = badgeCy - barH * 0.55;
        // Shaft
        ctx.beginPath();
        if (typeof ctx.roundRect === 'function') {
          ctx.roundRect(barX, barTop, barW, barH * 0.7, barW * 0.4);
        } else {
          ctx.rect(barX, barTop, barW, barH * 0.7);
        }
        ctx.fill();
        // Dot
        ctx.beginPath();
        ctx.arc(badgeCx, badgeCy + barH * 0.35, barW * 0.6, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      // Done badge — green disk with a white checkmark pinned to the
      // sprite's upper-LEFT corner so it can coexist with the error badge
      // (upper-right) and the thinking bubble (above). Pops in over
      // ~400ms using an ease-out-back curve (scale 0 → 1.15 → 1.0) so it
      // nudges the eye without being distracting. After the pop-in
      // window it stays stable until the parent clears `doneAgents`.
      if (doneAgents && doneAgents[agent.id]) {
        const POP_IN_MS = 400;
        const entry = doneAgents[agent.id];
        // `at` was recorded via Date.now() in App.tsx; keep this loop on
        // the same clock so elapsed time is comparable regardless of
        // render-time jitter.
        const elapsed = Math.max(0, Date.now() - entry.at);
        const t = Math.min(1, elapsed / POP_IN_MS);
        // Scale curve: ease-out-back. Peaks at ~1.15 around t=0.6, then
        // settles to 1.0. Mirrors typical iOS/material "pop" feel.
        const scaleBump = (() => {
          if (t >= 1) return 1;
          const k = 1.70158;
          const f = t - 1;
          return 1 + (k + 1) * f * f * f + k * f * f; // easeOutBack
        })();
        const badgeScale = Math.max(0.7, Math.min(1.3, cellPx / TILE_PX));
        const baseR = 8 * badgeScale;
        const badgeCx = destX + baseR * 0.6;
        const badgeCy = destY + baseR * 0.8;
        const r = baseR * scaleBump;

        ctx.save();
        // Soft glow, same trick as the error badge — two translucent
        // disks stacked so we avoid a per-frame radial gradient.
        ctx.fillStyle = 'rgba(76, 175, 80, 0.22)';
        ctx.beginPath();
        ctx.arc(badgeCx, badgeCy, r * 1.8, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = 'rgba(76, 175, 80, 0.35)';
        ctx.beginPath();
        ctx.arc(badgeCx, badgeCy, r * 1.4, 0, Math.PI * 2);
        ctx.fill();

        // Badge body
        ctx.fillStyle = '#4caf50';
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(badgeCx, badgeCy, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        // White checkmark glyph — drawn as two line segments meeting at
        // a lower-left pivot. Sized so it stays legible across zoom
        // levels.
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = Math.max(1.5, r * 0.26);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        const checkReach = r * 0.6;
        // Pivot slightly below-center for an asymmetric check shape.
        const pivotX = badgeCx - r * 0.1;
        const pivotY = badgeCy + r * 0.22;
        ctx.beginPath();
        ctx.moveTo(pivotX - checkReach * 0.75, pivotY - checkReach * 0.1);
        ctx.lineTo(pivotX, pivotY);
        ctx.lineTo(pivotX + checkReach * 0.95, pivotY - checkReach * 0.85);
        ctx.stroke();
        ctx.restore();
      }
    }

    // Error tooltip — renders the stored error message above the hovered
    // agent's sprite (if that agent currently has an error). Drawn after
    // the y-sorted stream so it sits on top of every sprite. Word-wrap
    // is naive (greedy) but enough for a single ~120-char message split
    // across at most 3 lines.
    if (hoveredAgentId && errorAgents && errorAgents[hoveredAgentId] && agents) {
      const hovered = agents.find((a) => a.id === hoveredAgentId);
      const err = errorAgents[hoveredAgentId];
      if (hovered && err) {
        const centerX = (hovered.col + 0.5) * cellPx;
        const footY = (hovered.row + 1) * cellPx;
        const destY = footY - spriteH;
        const fontSize = Math.max(11, Math.round(cellPx * 0.22));
        ctx.save();
        ctx.font = `500 ${fontSize}px system-ui, sans-serif`;
        ctx.textBaseline = 'top';
        // Greedy word-wrap to keep the tooltip narrow enough to be
        // readable without running off-screen on small rooms.
        const maxLineW = Math.min(320, Math.max(140, cellPx * 5));
        const words = err.message.split(/\s+/);
        const lines: string[] = [];
        let current = '';
        for (const w of words) {
          const candidate = current ? `${current} ${w}` : w;
          if (ctx.measureText(candidate).width <= maxLineW) {
            current = candidate;
          } else {
            if (current) lines.push(current);
            current = w;
          }
          // Cap at 3 lines — if the remaining words still don't fit,
          // truncate with an ellipsis rather than growing forever.
          if (lines.length >= 3) break;
        }
        if (current && lines.length < 3) lines.push(current);
        if (lines.length === 3 && current !== lines[2]) {
          lines[2] = lines[2].replace(/.{0,3}$/, '…');
        }

        const padX = 8, padY = 6, lineGap = 3;
        let widest = 0;
        for (const l of lines) widest = Math.max(widest, ctx.measureText(l).width);
        const boxW = widest + padX * 2;
        const boxH = lines.length * fontSize + (lines.length - 1) * lineGap + padY * 2;
        // Position above the sprite, clamped so the box never leaves the
        // visible grid bounds. A small 6px gap above the sprite keeps
        // it visually attached without overlapping the nameplate.
        const nameplateH = showNameplates && cellPx >= 24 ? Math.max(14, Math.round(cellPx * 0.32)) + 4 : 0;
        let boxX = centerX - boxW / 2;
        let boxY = destY - nameplateH - boxH - 6;
        const gridW = room.width * cellPx;
        if (boxX < 4) boxX = 4;
        if (boxX + boxW > gridW - 4) boxX = gridW - 4 - boxW;
        if (boxY < 4) boxY = destY + spriteH + 6; // flip below sprite if no room above

        // Shadow
        ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
        ctx.beginPath();
        if (typeof ctx.roundRect === 'function') {
          ctx.roundRect(boxX + 1, boxY + 2, boxW, boxH, 6);
        } else {
          ctx.rect(boxX + 1, boxY + 2, boxW, boxH);
        }
        ctx.fill();

        // Box
        ctx.fillStyle = 'rgba(28, 18, 20, 0.96)';
        ctx.strokeStyle = 'rgba(239, 83, 80, 0.85)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        if (typeof ctx.roundRect === 'function') {
          ctx.roundRect(boxX, boxY, boxW, boxH, 6);
        } else {
          ctx.rect(boxX, boxY, boxW, boxH);
        }
        ctx.fill();
        ctx.stroke();

        // Text
        ctx.fillStyle = '#ffd2d0';
        let ty = boxY + padY;
        for (const line of lines) {
          ctx.fillText(line, boxX + padX, ty);
          ty += fontSize + lineGap;
        }
        ctx.restore();
      }
    }

    // ── Collision-debug overlay ────────────────────────────────────────────
    // Toggled by the 'C' key in live mode. Renders a red tint on every pixel
    // that blocks agent movement so the user can see *exactly* what's
    // stopping them (typically faint shadow pixels under an asset). We draw
    // this after the y-sorted stream so the tint sits on top of objects and
    // agents alike.
    if (readOnly && collisionDebug && getPlacementCollisionMask) {
      const cache = maskOverlayCacheRef.current;
      for (const p of room.placements) {
        if (p.layer !== 'object') continue;
        if ((room.layerVisibility ?? {}).object === false) continue;
        const mask = getPlacementCollisionMask(p);
        if (!mask) continue;

        let overlay = cache.get(mask);
        if (!overlay) {
          overlay = document.createElement('canvas');
          overlay.width = mask.w;
          overlay.height = mask.h;
          const octx = overlay.getContext('2d');
          if (octx) {
            const imgData = octx.createImageData(mask.w, mask.h);
            const data = imgData.data;
            const { bits, w, h } = mask;
            for (let y = 0; y < h; y++) {
              for (let x = 0; x < w; x++) {
                const idx = y * w + x;
                const bit = (bits[idx >> 3] >> (idx & 7)) & 1;
                if (bit) {
                  const i = idx * 4;
                  data[i] = 239;     // R
                  data[i + 1] = 83;  // G
                  data[i + 2] = 80;  // B
                  data[i + 3] = 160; // A
                }
              }
            }
            octx.putImageData(imgData, 0, 0);
          }
          cache.set(mask, overlay);
        }

        const info = resolveTileInfo(p.assetId);
        const [sw, sh] = resolveSize(p.assetId, p.rotation);
        const hasTransform = p.rotation !== 0 || p.flipH || p.flipV;
        // Disable smoothing so the tint keeps crisp pixel edges.
        const prevSmoothing = ctx.imageSmoothingEnabled;
        ctx.imageSmoothingEnabled = false;

        if (hasTransform) {
          ctx.save();
          const cx = (p.col + sw / 2) * cellPx;
          const cy = (p.row + sh / 2) * cellPx;
          ctx.translate(cx, cy);
          ctx.rotate((p.rotation * Math.PI) / 180);
          if (p.flipH) ctx.scale(-1, 1);
          if (p.flipV) ctx.scale(1, -1);
          ctx.translate(-cx, -cy);
          // Mirror drawAsset: when rotated 90/270, the mask (pre-rotation
          // bounds) is centered within the rendered box so after the
          // rotation it covers the rendered footprint exactly.
          const drawCol = p.rotation === 90 || p.rotation === 270
            ? p.col + (sw - info.spanW) / 2
            : p.col;
          const drawRow = p.rotation === 90 || p.rotation === 270
            ? p.row + (sh - info.spanH) / 2
            : p.row;
          ctx.drawImage(
            overlay,
            drawCol * cellPx,
            drawRow * cellPx,
            info.spanW * cellPx,
            info.spanH * cellPx,
          );
          ctx.restore();
        } else {
          ctx.drawImage(
            overlay,
            p.col * cellPx,
            p.row * cellPx,
            info.spanW * cellPx,
            info.spanH * cellPx,
          );
        }
        ctx.imageSmoothingEnabled = prevSmoothing;
      }
    }

    if (!readOnly) {
      // Grid lines
      ctx.strokeStyle = GRID_LINE_COLOR;
      ctx.lineWidth = 1;
      for (let r = 0; r <= room.height; r++) {
        ctx.beginPath();
        ctx.moveTo(0, r * cellPx);
        ctx.lineTo(room.width * cellPx, r * cellPx);
        ctx.stroke();
      }
      for (let c = 0; c <= room.width; c++) {
        ctx.beginPath();
        ctx.moveTo(c * cellPx, 0);
        ctx.lineTo(c * cellPx, room.height * cellPx);
        ctx.stroke();
      }

      // Hovered placement highlight (from Layers panel hover)
      if (hoveredPlacementIds && hoveredPlacementIds.size > 0) {
        ctx.save();
        for (const p of room.placements) {
          if (!hoveredPlacementIds.has(p.id)) continue;
          if ((room.layerVisibility ?? {})[p.layer] === false) continue;
          const [sw, sh] = resolveSize(p.assetId, p.rotation);
          const x = p.col * cellPx;
          const y = p.row * cellPx;
          const w = sw * cellPx;
          const h = sh * cellPx;
          ctx.fillStyle = 'rgba(0, 200, 255, 0.25)';
          ctx.fillRect(x, y, w, h);
          ctx.strokeStyle = '#00e5ff';
          ctx.lineWidth = 3;
          ctx.strokeRect(x + 1.5, y + 1.5, w - 3, h - 3);
        }
        ctx.restore();
      }

      // Selected placement highlight (from Layers panel)
      if (selectedPlacementIds && selectedPlacementIds.size > 0) {
        ctx.save();
        ctx.strokeStyle = '#4fc3f7';
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 3]);
        for (const p of room.placements) {
          if (!selectedPlacementIds.has(p.id)) continue;
          if ((room.layerVisibility ?? {})[p.layer] === false) continue;
          const [sw, sh] = resolveSize(p.assetId, p.rotation);
          ctx.strokeRect(
            p.col * cellPx + 1, p.row * cellPx + 1,
            sw * cellPx - 2, sh * cellPx - 2
          );
        }
        ctx.setLineDash([]);
        ctx.restore();
      }
    }

    // Place mode outlines
    if (!readOnly && toolState.mode === 'place') {
      ctx.strokeStyle = 'rgba(79, 195, 247, 0.25)';
      ctx.lineWidth = 1;
      for (const p of room.placements) {
        if (movingPlacement && p.id === movingPlacement.placement.id) continue;
        ctx.strokeRect(
          p.col * cellPx + 0.5,
          p.row * cellPx + 0.5,
          p.spanW * cellPx - 1,
          p.spanH * cellPx - 1
        );
      }
    }

    // Select mode: draw drag preview and marquee
    if (!readOnly && toolState.mode === 'select') {
      // Draw ghost of dragged placements at offset position
      const dragIds = selectDragIdsRef.current;
      const sDragging = selectDraggingRef.current;
      const sOffset = selectDragOffsetRef.current;
      if (sDragging && (sOffset.dRow !== 0 || sOffset.dCol !== 0) && dragIds.size > 0) {
        ctx.save();
        ctx.globalAlpha = 0.5;
        for (const p of room.placements) {
          if (!dragIds.has(p.id)) continue;
          const nr = p.row + sOffset.dRow;
          const nc = p.col + sOffset.dCol;
          drawAsset(ctx, p.assetId, nc, nr, 0.5, p.rotation, p.flipH, p.flipV);
        }
        ctx.globalAlpha = 1;
        ctx.restore();
      }
      // Draw selection marquee rectangle
      if (selectMarquee) {
        const r1 = Math.min(selectMarquee.startRow, selectMarquee.endRow);
        const c1 = Math.min(selectMarquee.startCol, selectMarquee.endCol);
        const r2 = Math.max(selectMarquee.startRow, selectMarquee.endRow);
        const c2 = Math.max(selectMarquee.startCol, selectMarquee.endCol);
        ctx.save();
        ctx.fillStyle = 'rgba(79, 195, 247, 0.1)';
        ctx.fillRect(c1 * cellPx, r1 * cellPx, (c2 - c1 + 1) * cellPx, (r2 - r1 + 1) * cellPx);
        ctx.strokeStyle = '#00e5ff';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 4]);
        ctx.strokeRect(c1 * cellPx, r1 * cellPx, (c2 - c1 + 1) * cellPx, (r2 - r1 + 1) * cellPx);
        ctx.setLineDash([]);
        ctx.restore();
      }
    }

    // Hover highlight + ghost preview (skip in select mode)
    if (!readOnly && hoverCell && !isPanning && toolState.mode !== 'select') {
      const { row, col } = hoverCell;

      if (toolState.tool === 'erase') {
        const target = getPlacementAt?.(row, col) ?? null;
        if (target) {
          ctx.fillStyle = ERASE_COLOR;
          ctx.fillRect(target.col * cellPx, target.row * cellPx, target.spanW * cellPx, target.spanH * cellPx);
        } else {
          ctx.fillStyle = ERASE_COLOR;
          ctx.fillRect(col * cellPx, row * cellPx, cellPx, cellPx);
        }
      } else if (marqueeStart && toolState.mode === 'draw' && toolState.drawSubTool === 'marquee' && toolState.selectedAssetId !== null) {
        // Marquee preview: show the fill rectangle and tiled asset preview
        const r1 = Math.min(marqueeStart.row, row);
        const c1 = Math.min(marqueeStart.col, col);
        const r2 = Math.max(marqueeStart.row, row);
        const c2 = Math.max(marqueeStart.col, col);

        ctx.fillStyle = HOVER_COLOR;
        ctx.fillRect(c1 * cellPx, r1 * cellPx, (c2 - c1 + 1) * cellPx, (r2 - r1 + 1) * cellPx);

        // Show ghost of tiled assets
        const previewId = toolState.selectedAssetId;
        const [sw, sh] = resolveSize(previewId, toolState.rotation);
        for (let mr = r1; mr <= r2; mr += sh) {
          for (let mc = c1; mc <= c2; mc += sw) {
            if (mr + sh <= r2 + 1 && mc + sw <= c2 + 1) {
              drawAsset(ctx, previewId, mc, mr, GHOST_ALPHA, toolState.rotation, toolState.flipH, toolState.flipV);
            }
          }
        }

        // Dashed border
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = 'var(--accent)';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(c1 * cellPx, r1 * cellPx, (c2 - c1 + 1) * cellPx, (r2 - r1 + 1) * cellPx);
        ctx.setLineDash([]);
      } else {
        const previewId = movingPlacement?.placement.assetId ?? dragAssetId ?? toolState.selectedAssetId;
        const previewRot = movingPlacement?.placement.rotation ?? toolState.rotation;
        const previewFlipH = movingPlacement?.placement.flipH ?? toolState.flipH;
        const previewFlipV = movingPlacement?.placement.flipV ?? toolState.flipV;
        if (previewId !== null) {
          const [sw, sh] = resolveSize(previewId, previewRot);
          let anchorRow = row;
          let anchorCol = col;
          if (movingPlacement) {
            anchorRow = row - movingPlacement.offsetRow;
            anchorCol = col - movingPlacement.offsetCol;
          }
          anchorRow = Math.max(0, Math.min(room.height - sh, anchorRow));
          anchorCol = Math.max(0, Math.min(room.width - sw, anchorCol));

          ctx.fillStyle = HOVER_COLOR;
          ctx.fillRect(anchorCol * cellPx, anchorRow * cellPx, sw * cellPx, sh * cellPx);
          drawAsset(ctx, previewId, anchorCol, anchorRow, GHOST_ALPHA, previewRot, previewFlipH, previewFlipV);
        } else {
          ctx.fillStyle = HOVER_COLOR;
          ctx.fillRect(col * cellPx, row * cellPx, cellPx, cellPx);
        }
      }
    }

    ctx.restore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room, version, effectiveOffset, zoom, hoverCell, toolState, dragAssetId, cellPx, movingPlacement, marqueeStart, isPanning, drawAsset, getPlacementAt, tileOverrides, resolveSize, resolveTileInfo, customAssets, selectedPlacementIds, hoveredPlacementIds, readOnly, selectMarquee, selectDragRenderKey, agents, activeAgentId, hoveredAgentId, busyAgentIds, errorAgents, doneAgents, busyTick, showNameplates, getRenderOrder, collisionDebug, getPlacementCollisionMask]);

  // ── Camera follow active agent (read-only mode only) ─────────────────────
  // The camera target is *derived* from agent position (see `effectiveOffset`
  // above), so there is no separate animation loop here. Keeping the camera
  // offset inside the same render as the agent's position guarantees they
  // never drift out of sync for a single frame, which was the root cause of
  // the jagged camera-follow motion.

  // ── Resize observer + center grid on first mount ───────────────────────────
  const hasCentered = useRef(false);
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const obs = new ResizeObserver(() => {
      const cw = container.clientWidth;
      const ch = container.clientHeight;
      setContainerSize({ w: cw, h: ch });
      if (!hasCentered.current) {
        hasCentered.current = true;
        const gridW = room.width * room.cellSize * zoomRef.current;
        const gridH = room.height * room.cellSize * zoomRef.current;
        setOffset({ x: (cw - gridW) / 2, y: (ch - gridH) / 2 });
      }
    });
    obs.observe(container);
    return () => obs.disconnect();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Keyboard: Space (pan), R (rotate), F (flip) ───────────────────────────
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      if (e.code === 'Space' && !e.repeat) {
        e.preventDefault();
        setSpaceHeld(true);
        return;
      }

      if (readOnly || e.repeat) return;

      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedPlacementIds && selectedPlacementIds.size > 0 && onDeletePlacements) {
        e.preventDefault();
        onDeletePlacements(selectedPlacementIds);
        return;
      }

      if ((e.key === 'r' || e.key === 'R') && onRotate) {
        e.preventDefault();
        onRotate();
      }
      if ((e.key === 'f' || e.key === 'F') && onFlipH) {
        e.preventDefault();
        onFlipH();
      }
      if ((e.key === 'v' || e.key === 'V') && onFlipV) {
        e.preventDefault();
        onFlipV();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') setSpaceHeld(false);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [onRotate, onFlipH, onFlipV, readOnly, selectedPlacementIds, onDeletePlacements]);

  // ── Native wheel — Figma-style trackpad ────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();

      if (e.ctrlKey || e.metaKey) {
        const rawDelta = e.deltaY;
        const zoomDelta = -rawDelta * 0.005;
        const currentZoom = zoomRef.current;
        const currentOffset = offsetRef.current;
        const newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, currentZoom + zoomDelta));

        if (Math.abs(newZoom - currentZoom) > 0.0001) {
          const rect = canvas.getBoundingClientRect();
          const mx = e.clientX - rect.left;
          const my = e.clientY - rect.top;
          const scale = newZoom / currentZoom;
          setOffset({
            x: mx - (mx - currentOffset.x) * scale,
            y: my - (my - currentOffset.y) * scale,
          });
          onZoomChangeRef.current(newZoom);
        }
      } else {
        setOffset((prev) => ({
          x: prev.x - e.deltaX,
          y: prev.y - e.deltaY,
        }));
      }
    };

    canvas.addEventListener('wheel', handleWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', handleWheel);
  }, []);

  // ── Pointer events ─────────────────────────────────────────────────────────
  const agentClickTimerRef = useRef<number | null>(null);
  const agentClickIdRef = useRef<string | null>(null);

  const handlePointerDown = useCallback(
    (e: PointerEvent<HTMLCanvasElement>) => {
      if (e.button === 1 || (e.button === 0 && spaceHeld)) {
        setIsPanning(true);
        panStart.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        return;
      }

      // Agent interaction in live (readOnly) mode
      if (readOnly && e.button === 0) {
        const hitId = hitTestAgent(e.clientX, e.clientY);
        if (hitId) {
          e.preventDefault();
          if (agentClickTimerRef.current !== null && agentClickIdRef.current === hitId) {
            // Double-click → open terminal
            window.clearTimeout(agentClickTimerRef.current);
            agentClickTimerRef.current = null;
            agentClickIdRef.current = null;
            onOpenAgentTerminal?.(hitId);
          } else {
            // Schedule single-click activation
            if (agentClickTimerRef.current !== null) window.clearTimeout(agentClickTimerRef.current);
            agentClickIdRef.current = hitId;
            agentClickTimerRef.current = window.setTimeout(() => {
              agentClickTimerRef.current = null;
              agentClickIdRef.current = null;
              // Toggle-off if the clicked agent is already active, so a
              // single-click on the active agent frees the camera. Matches
              // the intuition "click empty = deselect, click me again = also
              // deselect".
              if (activeAgentIdRef.current === hitId) {
                onDeactivateAgent?.();
              } else {
                onActivateAgent?.(hitId);
              }
            }, 250);
          }
          return;
        }
        // Empty-space click in live mode = deselect. Users were previously
        // stuck with the camera locked to whatever agent they first clicked;
        // this restores free-roam behavior without needing a dedicated button.
        if (activeAgentIdRef.current !== null) {
          e.preventDefault();
          onDeactivateAgent?.();
          return;
        }
      }

      if (e.button !== 0 || readOnly) return;
      const cell = toGrid(e.clientX, e.clientY);
      if (!cell) return;

      // Select mode (works across all visible/unlocked layers)
      if (toolState.mode === 'select') {
        const hit = getPlacementAt?.(cell.row, cell.col) ?? null;
        const isToggleKey = e.shiftKey || e.ctrlKey || e.metaKey;
        if (hit && isToggleKey) {
          const next = new Set(selectedPlacementIds ?? []);
          if (next.has(hit.id)) {
            next.delete(hit.id);
          } else {
            next.add(hit.id);
          }
          onSetSelectedIds?.(next);
          return;
        } else if (hit && selectedPlacementIds?.has(hit.id)) {
          selectDragIdsRef.current = new Set(selectedPlacementIds);
          selectDraggingRef.current = { startRow: cell.row, startCol: cell.col };
          selectDragOffsetRef.current = { dRow: 0, dCol: 0 };
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
        } else if (hit) {
          const nextIds = new Set([hit.id]);
          onSetSelectedIds?.(nextIds);
          selectDragIdsRef.current = nextIds;
          selectDraggingRef.current = { startRow: cell.row, startCol: cell.col };
          selectDragOffsetRef.current = { dRow: 0, dCol: 0 };
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
        } else {
          if (!isToggleKey) onSetSelectedIds?.(new Set());
          setSelectMarquee({ startRow: cell.row, startCol: cell.col, endRow: cell.row, endCol: cell.col });
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
        }
        return;
      }

      // Prevent interaction with locked or hidden layers for draw/place modes
      if ((room.layerLocked ?? {})[toolState.activeLayer] || (room.layerVisibility ?? {})[toolState.activeLayer] === false) return;

      if (toolState.tool === 'erase') {
        onBeginUndoBatch?.();
        const target = getPlacementAt?.(cell.row, cell.col) ?? null;
        if (target) onRemovePlacementById?.(target.id);
        setIsPainting(true);
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        return;
      }

      if (toolState.mode === 'place') {
        const existing = getPlacementAt?.(cell.row, cell.col) ?? null;
        if (existing) {
          setMovingPlacement({
            placement: existing,
            offsetRow: cell.row - existing.row,
            offsetCol: cell.col - existing.col,
          });
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
        } else if (toolState.selectedAssetId !== null) {
          const [sw, sh] = resolveSize(toolState.selectedAssetId, toolState.rotation);
          const anchorRow = Math.max(0, Math.min(room.height - sh, cell.row));
          const anchorCol = Math.max(0, Math.min(room.width - sw, cell.col));
          onAddPlacement?.(toolState.selectedAssetId, anchorRow, anchorCol, toolState.activeLayer, toolState.rotation, toolState.flipH, toolState.flipV, false);
        }
      } else if (toolState.mode === 'draw' && toolState.drawSubTool === 'marquee') {
        // Start marquee selection
        setMarqueeStart(cell);
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
      } else {
        // Brush mode
        onBeginUndoBatch?.();
        if (toolState.selectedAssetId !== null) {
          const [sw, sh] = resolveSize(toolState.selectedAssetId, toolState.rotation);
          const anchorRow = Math.max(0, Math.min(room.height - sh, cell.row));
          const anchorCol = Math.max(0, Math.min(room.width - sw, cell.col));
          onAddPlacement?.(toolState.selectedAssetId, anchorRow, anchorCol, toolState.activeLayer, toolState.rotation, toolState.flipH, toolState.flipV);
        }
        setIsPainting(true);
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
      }
    },
    [spaceHeld, offset, toGrid, toolState, onAddPlacement, onRemovePlacementById, getPlacementAt, room, resolveSize, selectedPlacementIds, onSetSelectedIds, onBeginUndoBatch]
  );

  const lastPaintCell = useRef<string | null>(null);

  const handlePointerMove = useCallback(
    (e: PointerEvent<HTMLCanvasElement>) => {
      if (isPanning) {
        const dx = e.clientX - panStart.current.x;
        const dy = e.clientY - panStart.current.y;
        setOffset({ x: panStart.current.ox + dx, y: panStart.current.oy + dy });
        return;
      }

      const cell = toGrid(e.clientX, e.clientY);
      setHoverCell(cell);

      const rect = containerRef.current?.getBoundingClientRect();
      if (rect) setCursorPos({ x: e.clientX - rect.left, y: e.clientY - rect.top });

      // Agent hover tracking. The sprite extends vertically beyond the
      // agent's cell, so we can't piggy-back on `cell` — it's null whenever
      // the cursor is near the top of a sprite that overhangs the grid edge.
      // `hitTestAgent` is explicitly pixel-accurate and cheap (O(n) with a
      // handful of agents) so we call it on every pointer-move in readOnly.
      if (readOnly && onAgentHover) {
        const hitId = hitTestAgent(e.clientX, e.clientY);
        if (hitId !== lastHoveredAgentRef.current) {
          lastHoveredAgentRef.current = hitId;
          onAgentHover(hitId);
        }
      }

      // Select mode: marquee or drag
      if (cell && toolState.mode === 'select') {
        if (selectMarquee) {
          setSelectMarquee((prev) => prev ? { ...prev, endRow: cell.row, endCol: cell.col } : null);
          return;
        }
        if (selectDraggingRef.current) {
          selectDragOffsetRef.current = {
            dRow: cell.row - selectDraggingRef.current.startRow,
            dCol: cell.col - selectDraggingRef.current.startCol,
          };
          setSelectDragRenderKey((k) => k + 1);
          return;
        }
      }

      if (isPainting && cell && toolState.mode === 'draw') {
        if (toolState.tool === 'erase') {
          const target = getPlacementAt?.(cell.row, cell.col) ?? null;
          if (target) onRemovePlacementById?.(target.id);
        } else if (toolState.selectedAssetId !== null) {
          const [sw, sh] = resolveSize(toolState.selectedAssetId, toolState.rotation);
          const anchorRow = Math.max(0, Math.min(room.height - sh, cell.row));
          const anchorCol = Math.max(0, Math.min(room.width - sw, cell.col));
          const key = `${anchorRow},${anchorCol}`;
          if (key !== lastPaintCell.current) {
            lastPaintCell.current = key;
            onAddPlacement?.(toolState.selectedAssetId, anchorRow, anchorCol, toolState.activeLayer, toolState.rotation, toolState.flipH, toolState.flipV);
          }
        }
      }
    },
    [isPanning, isPainting, toGrid, toolState, onAddPlacement, onRemovePlacementById, getPlacementAt, room.height, room.width, resolveSize, selectMarquee, readOnly, onAgentHover, hitTestAgent]
  );

  const handlePointerUp = useCallback(
    (e: PointerEvent<HTMLCanvasElement>) => {
      setIsPanning(false);
      const wasPainting = isPainting;
      setIsPainting(false);
      lastPaintCell.current = null;

      // Select mode: finish marquee or drag
      if (toolState.mode === 'select') {
        if (selectMarquee) {
          const r1 = Math.min(selectMarquee.startRow, selectMarquee.endRow);
          const c1 = Math.min(selectMarquee.startCol, selectMarquee.endCol);
          const r2 = Math.max(selectMarquee.startRow, selectMarquee.endRow);
          const c2 = Math.max(selectMarquee.startCol, selectMarquee.endCol);
          const marqueeHits = new Set<string>();
          for (const p of room.placements) {
            if ((room.layerVisibility ?? {})[p.layer] === false) continue;
            const [sw, sh] = resolveSize(p.assetId, p.rotation);
            const pr2 = p.row + sh - 1;
            const pc2 = p.col + sw - 1;
            if (p.row <= r2 && pr2 >= r1 && p.col <= c2 && pc2 >= c1) {
              marqueeHits.add(p.id);
            }
          }
          let result: Set<string>;
          if (e.shiftKey && selectedPlacementIds) {
            result = new Set(selectedPlacementIds);
            for (const id of marqueeHits) {
              if (result.has(id)) result.delete(id);
              else result.add(id);
            }
          } else {
            result = marqueeHits;
          }
          onSetSelectedIds?.(result);
          setSelectMarquee(null);
        }

        // Read from refs for up-to-date values
        const sDragging = selectDraggingRef.current;
        const sOffset = selectDragOffsetRef.current;
        const dragIds = selectDragIdsRef.current;

        if (sDragging && (sOffset.dRow !== 0 || sOffset.dCol !== 0) && dragIds.size > 0) {
          let dRow = sOffset.dRow;
          let dCol = sOffset.dCol;
          const isDuplicate = e.altKey;
          const selected = room.placements.filter((p) => dragIds.has(p.id));

          // Clamp offset based on group bounding box so all tiles move uniformly
          let minR = Infinity, minC = Infinity, maxR = -Infinity, maxC = -Infinity;
          for (const p of selected) {
            const [sw, sh] = resolveSize(p.assetId, p.rotation);
            if (p.row < minR) minR = p.row;
            if (p.col < minC) minC = p.col;
            if (p.row + sh > maxR) maxR = p.row + sh;
            if (p.col + sw > maxC) maxC = p.col + sw;
          }
          if (minR + dRow < 0) dRow = -minR;
          if (minC + dCol < 0) dCol = -minC;
          if (maxR + dRow > room.height) dRow = room.height - maxR;
          if (maxC + dCol > room.width) dCol = room.width - maxC;

          if (isDuplicate) {
            // Check if all selected tiles belong to the same group
            const groupIds = new Set(selected.map((p) => p.groupId).filter(Boolean));
            if (groupIds.size === 1 && onDuplicateGroup) {
              const gid = [...groupIds][0]!;
              const groupMembers = room.placements.filter((p) => p.groupId === gid);
              if (groupMembers.length === selected.length) {
                const newIds = onDuplicateGroup(gid, dRow, dCol);
                if (newIds.length > 0) onSetSelectedIds?.(new Set(newIds));
              } else {
                const sources = selected.map((p) => ({
                  assetId: p.assetId,
                  row: p.row + dRow, col: p.col + dCol,
                  layer: p.layer, spanW: p.spanW, spanH: p.spanH,
                  rotation: p.rotation, flipH: p.flipH, flipV: p.flipV,
                  groupId: p.groupId, zIndex: p.zIndex,
                }));
                onBulkDuplicatePlacements?.(sources);
              }
            } else {
              const sources = selected.map((p) => ({
                assetId: p.assetId,
                row: p.row + dRow, col: p.col + dCol,
                layer: p.layer, spanW: p.spanW, spanH: p.spanH,
                rotation: p.rotation, flipH: p.flipH, flipV: p.flipV,
                groupId: undefined, zIndex: p.zIndex,
              }));
              onBulkDuplicatePlacements?.(sources);
            }
          } else {
            const moves = selected.map((p) => ({
              id: p.id,
              newRow: p.row + dRow,
              newCol: p.col + dCol,
            }));
            onBulkMovePlacements?.(moves);
          }
        }

        selectDraggingRef.current = null;
        selectDragOffsetRef.current = { dRow: 0, dCol: 0 };
        setSelectDragRenderKey((k) => k + 1);
        return;
      }

      // End undo batch for brush paint/erase strokes
      if (wasPainting) onEndUndoBatch?.();

      if (movingPlacement) {
        const cell = toGrid(e.clientX, e.clientY);
        if (cell) {
          const p = movingPlacement.placement;
          let newRow = cell.row - movingPlacement.offsetRow;
          let newCol = cell.col - movingPlacement.offsetCol;
          newRow = Math.max(0, Math.min(room.height - p.spanH, newRow));
          newCol = Math.max(0, Math.min(room.width - p.spanW, newCol));

          if (newRow !== p.row || newCol !== p.col) {
            onBeginUndoBatch?.();
            onRemovePlacementById?.(p.id);
            onAddPlacement?.(p.assetId, newRow, newCol, p.layer, p.rotation, p.flipH, p.flipV, false);
            onEndUndoBatch?.();
          }
        }
        setMovingPlacement(null);
      }

      // Marquee fill
      if (marqueeStart && toolState.selectedAssetId !== null && toolState.drawSubTool === 'marquee') {
        const cell = toGrid(e.clientX, e.clientY);
        if (cell) {
          const r1 = Math.min(marqueeStart.row, cell.row);
          const c1 = Math.min(marqueeStart.col, cell.col);
          const r2 = Math.max(marqueeStart.row, cell.row);
          const c2 = Math.max(marqueeStart.col, cell.col);

          const assetId = toolState.selectedAssetId;
          const [sw, sh] = resolveSize(assetId, toolState.rotation);

          onBeginUndoBatch?.();
          for (let mr = r1; mr + sh <= r2 + 1; mr += sh) {
            for (let mc = c1; mc + sw <= c2 + 1; mc += sw) {
              onAddPlacement?.(assetId, mr, mc, toolState.activeLayer, toolState.rotation, toolState.flipH, toolState.flipV);
            }
          }
          onEndUndoBatch?.();
        }
        setMarqueeStart(null);
      }
    },
    [isPainting, movingPlacement, marqueeStart, toGrid, toolState, onRemovePlacementById, onAddPlacement, room, resolveSize, selectMarquee, selectedPlacementIds, onSetSelectedIds, onBulkMovePlacements, onBulkDuplicatePlacements, onDuplicateGroup, onBeginUndoBatch, onEndUndoBatch]
  );

  const handlePointerLeave = useCallback(() => {
    if (!isPanning && !isPainting && !movingPlacement && !marqueeStart) {
      setHoverCell(null);
      setCursorPos(null);
    }
    // Always clear the hovered agent when the pointer leaves the canvas —
    // the agent should resume wandering even if we're mid-drag elsewhere.
    if (lastHoveredAgentRef.current !== null) {
      lastHoveredAgentRef.current = null;
      onAgentHover?.(null);
    }
  }, [isPanning, isPainting, movingPlacement, marqueeStart, onAgentHover]);

  // ── HTML Drag & Drop (from asset palette) ──────────────────────────────────
  const handleDragEnter = useCallback((e: DragEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    for (const t of e.dataTransfer.types) {
      if (t.startsWith('asset-id/')) {
        const id = parseInt(t.replace('asset-id/', ''), 10);
        if (!isNaN(id)) {
          setDragAssetId(id);
          onModeChange?.('place');
        }
        break;
      }
    }
  }, [onModeChange]);

  const handleDragOver = useCallback(
    (e: DragEvent<HTMLCanvasElement>) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      const cell = toGrid(e.clientX, e.clientY);
      setHoverCell(cell);
    },
    [toGrid]
  );

  const handleDrop = useCallback(
    (e: DragEvent<HTMLCanvasElement>) => {
      e.preventDefault();
      const assetId = parseInt(e.dataTransfer.getData('text/asset-id'), 10);
      if (!isNaN(assetId)) {
        const cell = toGrid(e.clientX, e.clientY);
        if (cell) {
          const [sw, sh] = resolveSize(assetId, toolState.rotation);
          const anchorRow = Math.max(0, Math.min(room.height - sh, cell.row));
          const anchorCol = Math.max(0, Math.min(room.width - sw, cell.col));
          onAddPlacement?.(assetId, anchorRow, anchorCol, toolState.activeLayer, toolState.rotation, toolState.flipH, toolState.flipV, false);
        }
      }
      setDragAssetId(null);
    },
    [toGrid, toolState, onAddPlacement, room.height, room.width, resolveSize]
  );

  const handleDragLeave = useCallback(() => {
    setHoverCell(null);
    setDragAssetId(null);
  }, []);

  // ── Cursor style ───────────────────────────────────────────────────────────
  const getCursor = () => {
    if (isPanning || spaceHeld) return 'grab';
    if (toolState.mode === 'select') {
      if (selectDraggingRef.current) return 'grabbing';
      if (hoverCell && getPlacementAt?.(hoverCell.row, hoverCell.col)) return 'grab';
      return 'crosshair';
    }
    if (toolState.tool === 'erase') return 'crosshair';
    if (toolState.mode === 'place') {
      if (movingPlacement) return 'grabbing';
      if (hoverCell && getPlacementAt?.(hoverCell.row, hoverCell.col)) return 'grab';
    }
    return 'default';
  };

  return (
    <div
      ref={containerRef}
      style={{ flex: 1, overflow: 'hidden', cursor: getCursor(), position: 'relative' }}
    >
      <canvas
        ref={canvasRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerLeave}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        onDragLeave={handleDragLeave}
        onContextMenu={(e) => {
          if (readOnly && onAgentContextMenu) {
            const hitId = hitTestAgent(e.clientX, e.clientY);
            if (hitId) {
              e.preventDefault();
              onAgentContextMenu(hitId, e.clientX, e.clientY);
            }
            return;
          }
          if (!readOnly && onPlacementContextMenu) {
            const cell = toGrid(e.clientX, e.clientY);
            if (!cell) return;
            const hit = getPlacementAt?.(cell.row, cell.col) ?? null;
            if (hit) {
              e.preventDefault();
              onPlacementContextMenu(hit, e.clientX, e.clientY);
            }
          }
        }}
        style={{ display: 'block' }}
      />
      {!readOnly && toolState.mode === 'place' && toolState.selectedAssetId === null && cursorPos && !movingPlacement && (
        <div style={{
          position: 'absolute',
          left: cursorPos.x + 16,
          top: cursorPos.y + 16,
          background: 'rgba(0,0,0,0.75)',
          color: '#fff',
          padding: '4px 10px',
          borderRadius: 4,
          fontSize: 11,
          fontWeight: 500,
          pointerEvents: 'none',
          whiteSpace: 'nowrap',
          zIndex: 100,
        }}>
          Drag from Assets
        </div>
      )}
      {readOnly && collisionDebug && (
        <div style={{
          position: 'absolute',
          top: 12,
          left: 12,
          background: 'rgba(239, 83, 80, 0.92)',
          color: '#fff',
          padding: '6px 12px',
          borderRadius: 6,
          fontSize: 12,
          fontWeight: 600,
          pointerEvents: 'none',
          zIndex: 50,
          boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
          letterSpacing: 0.2,
        }}>
          COLLISION DEBUG &nbsp;·&nbsp; press C to hide
        </div>
      )}
      <ZoomNavigator
        room={room}
        zoom={zoom}
        offset={effectiveOffset}
        containerWidth={containerSize.w}
        containerHeight={containerSize.h}
        onZoomChange={onZoomChange}
        onOffsetChange={setOffset}
      />
    </div>
  );
}
