import type { RoomState, LayerType } from '../hooks/useGrid';

export type BlockingMap = Record<number, 'walkable' | 'blocking'>;

const AGENT_FOOTPRINT = 0.7;

function placementCovers(
  p: { row: number; col: number; spanW: number; spanH: number },
  r: number,
  c: number
): boolean {
  return r >= p.row && r < p.row + p.spanH && c >= p.col && c < p.col + p.spanW;
}

function isLayerBlocking(
  room: RoomState,
  r: number,
  c: number,
  layer: LayerType,
  blocking: BlockingMap,
): boolean {
  if (r < 0 || c < 0 || r >= room.height || c >= room.width) return true;
  for (const p of room.placements) {
    if (p.layer !== layer) continue;
    if ((room.layerVisibility ?? {})[p.layer] === false) continue;
    if (!placementCovers(p, r, c)) continue;
    if (layer === 'wall') return true;
    if (layer === 'object') {
      // Default blocking unless explicit 'walkable'
      if (blocking[p.assetId] !== 'walkable') return true;
    }
  }
  return false;
}

function cellBlocked(
  room: RoomState,
  r: number,
  c: number,
  blocking: BlockingMap,
): boolean {
  if (isLayerBlocking(room, r, c, 'wall', blocking)) return true;
  if (isLayerBlocking(room, r, c, 'object', blocking)) return true;
  return false;
}

/**
 * Test whether an agent with 1-cell footprint (reduced to AGENT_FOOTPRINT)
 * can stand with top-left at (row, col).
 */
export function canAgentStandAt(
  row: number,
  col: number,
  room: RoomState,
  blocking: BlockingMap,
): boolean {
  if (row < 0 || col < 0) return false;
  if (row + 1 > room.height || col + 1 > room.width) return false;
  const inset = (1 - AGENT_FOOTPRINT) / 2;
  const corners: Array<[number, number]> = [
    [row + inset, col + inset],
    [row + inset, col + 1 - inset],
    [row + 1 - inset, col + inset],
    [row + 1 - inset, col + 1 - inset],
  ];
  for (const [cr, cc] of corners) {
    const ir = Math.floor(cr);
    const ic = Math.floor(cc);
    if (cellBlocked(room, ir, ic, blocking)) return false;
  }
  return true;
}

/**
 * Attempt a movement, trying axis-separated fallback so agents can slide
 * along walls.
 */
export function resolveAgentMove(
  fromRow: number,
  fromCol: number,
  dRow: number,
  dCol: number,
  room: RoomState,
  blocking: BlockingMap,
): { row: number; col: number } {
  let nRow = fromRow + dRow;
  let nCol = fromCol + dCol;
  if (canAgentStandAt(nRow, nCol, room, blocking)) {
    return { row: nRow, col: nCol };
  }
  // Try horizontal only
  if (dCol !== 0 && canAgentStandAt(fromRow, fromCol + dCol, room, blocking)) {
    return { row: fromRow, col: fromCol + dCol };
  }
  // Try vertical only
  if (dRow !== 0 && canAgentStandAt(fromRow + dRow, fromCol, room, blocking)) {
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
  blocking: BlockingMap,
  maxRadius = 20,
): { row: number; col: number } | null {
  if (canAgentStandAt(row, col, room, blocking)) return { row, col };
  for (let radius = 1; radius <= maxRadius; radius++) {
    for (let dr = -radius; dr <= radius; dr++) {
      for (let dc = -radius; dc <= radius; dc++) {
        if (Math.max(Math.abs(dr), Math.abs(dc)) !== radius) continue;
        const r = row + dr;
        const c = col + dc;
        if (canAgentStandAt(r, c, room, blocking)) return { row: r, col: c };
      }
    }
  }
  return null;
}
