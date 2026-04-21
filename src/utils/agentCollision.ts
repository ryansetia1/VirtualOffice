import type { RoomState, Placement } from '../hooks/useGrid';
import { samplePlacementPixel, type PixelMask } from './pixelMasks';

/**
 * Pixel-accurate collision for the live-mode agent.
 *
 * Walls still block whole cells (a wall is a wall), but object-layer
 * placements are tested against the asset's alpha mask so agents can walk
 * through any fully-transparent part of the asset. The user can override the
 * auto-derived mask per asset in the Collision Editor.
 */

const TILE = 48;
/**
 * Fraction of a cell the agent's footprint covers. The 4 sample points sit on
 * the corners of this inset square so the agent can hug walls without
 * clipping into them.
 */
const AGENT_FOOTPRINT = 0.7;

export interface MasksApi {
  /** Returns the effective mask for a placement, honoring per-placement
   * overrides first, then per-asset overrides, then the auto mask. Returns
   * `null` if no mask is known yet (image still loading). */
  getEffectiveMaskFor(placement: { id: string; assetId: number }): PixelMask | null;
}

function placementCovers(
  p: { row: number; col: number; spanW: number; spanH: number },
  r: number,
  c: number,
): boolean {
  return r >= p.row && r < p.row + p.spanH && c >= p.col && c < p.col + p.spanW;
}

/**
 * Walls block whole cells. Any wall placement whose bounding box contains the
 * sample cell counts as blocking (unless the wall layer is hidden).
 */
function wallBlockedAtCell(room: RoomState, r: number, c: number): boolean {
  if ((room.layerVisibility ?? {}).wall === false) return false;
  for (const p of room.placements) {
    if (p.layer !== 'wall') continue;
    if (placementCovers(p, r, c)) return true;
  }
  return false;
}

/**
 * Object-layer test at world pixel coordinates (cell * TILE). Samples the
 * effective mask for every object placement whose bounding box contains the
 * pixel; any opaque bit = blocked.
 */
function objectBlockedAtPixel(
  room: RoomState,
  wxPx: number,
  wyPx: number,
  masks: MasksApi,
): boolean {
  if ((room.layerVisibility ?? {}).object === false) return false;
  const r = Math.floor(wyPx / TILE);
  const c = Math.floor(wxPx / TILE);
  for (const p of room.placements) {
    if (p.layer !== 'object') continue;
    if (!placementCovers(p, r, c)) continue;
    const mask = masks.getEffectiveMaskFor(p);
    if (!mask) {
      // Mask not yet known — be conservative and treat the covered cell as
      // blocking. This matches the legacy default where object placements
      // blocked unless explicitly walkable.
      return true;
    }
    if (samplePlacementPixel(p as Placement, wxPx, wyPx, mask)) return true;
  }
  return false;
}

/**
 * Test whether a single world pixel is blocked by any wall or object.
 */
export function pixelBlocked(
  wxPx: number,
  wyPx: number,
  room: RoomState,
  masks: MasksApi,
): boolean {
  const r = Math.floor(wyPx / TILE);
  const c = Math.floor(wxPx / TILE);
  if (r < 0 || c < 0 || r >= room.height || c >= room.width) return true;
  if (wallBlockedAtCell(room, r, c)) return true;
  if (objectBlockedAtPixel(room, wxPx, wyPx, masks)) return true;
  return false;
}

/**
 * Test whether an agent with 1-cell footprint (reduced to AGENT_FOOTPRINT)
 * can stand with top-left at (row, col). Samples 4 corners + the center of
 * the inset square at pixel resolution so agents can slip through narrow
 * transparent gaps.
 */
export function canAgentStandAt(
  row: number,
  col: number,
  room: RoomState,
  masks: MasksApi,
): boolean {
  if (row < 0 || col < 0) return false;
  if (row + 1 > room.height || col + 1 > room.width) return false;
  const inset = (1 - AGENT_FOOTPRINT) / 2;
  const left = (col + inset) * TILE;
  const right = (col + 1 - inset) * TILE - 1;
  const top = (row + inset) * TILE;
  const bottom = (row + 1 - inset) * TILE - 1;
  const cx = (col + 0.5) * TILE;
  const cy = (row + 0.5) * TILE;
  const samples: Array<[number, number]> = [
    [left, top],
    [right, top],
    [left, bottom],
    [right, bottom],
    [cx, cy],
  ];
  for (const [px, py] of samples) {
    if (pixelBlocked(px, py, room, masks)) return false;
  }
  return true;
}

/**
 * Attempt a movement, trying axis-separated fallback so agents can slide
 * along walls (and now slip through pixel gaps on one axis at a time).
 */
export function resolveAgentMove(
  fromRow: number,
  fromCol: number,
  dRow: number,
  dCol: number,
  room: RoomState,
  masks: MasksApi,
): { row: number; col: number } {
  const nRow = fromRow + dRow;
  const nCol = fromCol + dCol;
  if (canAgentStandAt(nRow, nCol, room, masks)) {
    return { row: nRow, col: nCol };
  }
  if (dCol !== 0 && canAgentStandAt(fromRow, fromCol + dCol, room, masks)) {
    return { row: fromRow, col: fromCol + dCol };
  }
  if (dRow !== 0 && canAgentStandAt(fromRow + dRow, fromCol, room, masks)) {
    return { row: fromRow + dRow, col: fromCol };
  }
  return { row: fromRow, col: fromCol };
}

/**
 * Find the nearest walkable top-left cell (1-footprint) to (row, col)
 * using a ring search. Returns null if none found within maxRadius.
 */
export function findNearestWalkable(
  row: number,
  col: number,
  room: RoomState,
  masks: MasksApi,
  maxRadius = 20,
): { row: number; col: number } | null {
  if (canAgentStandAt(row, col, room, masks)) return { row, col };
  for (let radius = 1; radius <= maxRadius; radius++) {
    for (let dr = -radius; dr <= radius; dr++) {
      for (let dc = -radius; dc <= radius; dc++) {
        if (Math.max(Math.abs(dr), Math.abs(dc)) !== radius) continue;
        const r = row + dr;
        const c = col + dc;
        if (canAgentStandAt(r, c, room, masks)) return { row: r, col: c };
      }
    }
  }
  return null;
}
