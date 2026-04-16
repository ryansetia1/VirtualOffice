export interface AssetTileInfo {
  tiles: [number, number][];
  srcCol: number;
  srcRow: number;
  spanW: number;
  spanH: number;
}

export interface AssetInfo {
  id: number;
  path: string;
  spanW: number;
  spanH: number;
}

// ─── Tile occupancy data ──────────────────────────────────────────────────────
// All images are 96x144 = 2 cols × 3 rows of 48×48 tiles.
// Each tile position is [col, row] in that 2×3 frame (col: 0-1, row: 0-2).

type TileList = [number, number][];

const PATTERNS: Record<string, TileList> = {
  A: [[0, 2]],
  B: [[0, 1], [0, 2]],
  C: [[0, 1], [1, 1], [0, 2], [1, 2]],
  D: [[0, 0], [0, 1], [0, 2]],
  E: [[0, 2], [1, 2]],
  F: [[0, 0], [1, 0], [0, 1], [1, 1], [0, 2], [1, 2]],
  G: [[1, 0], [0, 1], [1, 1], [0, 2], [1, 2]],
  H: [[0, 1], [1, 1], [0, 2]],
  I: [[0, 1], [1, 1], [1, 2]],
  J: [[0, 0], [1, 0], [0, 1], [1, 1], [1, 2]],
};

const TILE_PATTERN: Record<number, string> = {
  96: 'B', 97: 'B', 99: 'B', 101: 'B', 102: 'B', 103: 'B', 104: 'B',
  105: 'B', 106: 'B', 107: 'B', 108: 'B', 109: 'B', 110: 'B', 111: 'B',
  112: 'B', 113: 'B', 114: 'B', 115: 'B', 117: 'B', 118: 'B', 122: 'B',
  123: 'B', 126: 'B', 127: 'B', 135: 'B', 136: 'B', 137: 'B', 138: 'B',
  139: 'B', 140: 'B', 141: 'B', 142: 'B', 143: 'B', 144: 'B', 145: 'B',
  146: 'B', 147: 'B', 148: 'B', 149: 'B', 150: 'B', 151: 'B', 152: 'B',
  155: 'B', 156: 'B', 163: 'B', 167: 'B', 168: 'B', 169: 'B', 179: 'B',
  180: 'B', 181: 'B', 182: 'B', 183: 'B', 184: 'B', 185: 'B', 186: 'B',
  187: 'B', 196: 'B', 197: 'B', 198: 'B', 199: 'B', 204: 'B', 206: 'B',
  210: 'B', 211: 'B', 212: 'B', 213: 'B', 214: 'B', 215: 'B', 216: 'B',
  217: 'B', 218: 'B', 219: 'B', 220: 'B', 221: 'B', 222: 'B', 223: 'B',
  224: 'B', 226: 'B', 228: 'B', 230: 'B', 232: 'B', 234: 'B', 236: 'B',
  270: 'B', 271: 'B', 273: 'B', 279: 'B', 280: 'B', 306: 'B', 307: 'B',
  308: 'B', 315: 'B', 316: 'B', 329: 'B', 330: 'B', 331: 'B', 332: 'B',
  333: 'B', 334: 'B', 335: 'B', 336: 'B', 337: 'B', 338: 'B',
  116: 'C', 164: 'C', 170: 'C', 171: 'C', 172: 'C', 174: 'C', 177: 'C',
  178: 'C', 194: 'C', 200: 'C', 205: 'C', 208: 'C', 225: 'C', 227: 'C',
  229: 'C', 231: 'C', 233: 'C', 235: 'C', 249: 'C', 254: 'C', 259: 'C',
  264: 'C', 269: 'C', 285: 'C', 290: 'C', 295: 'C', 300: 'C', 305: 'C',
  317: 'C', 318: 'C', 319: 'C', 339: 'C',
  98: 'D', 100: 'D', 173: 'D', 202: 'D', 207: 'D', 209: 'D', 275: 'D',
  276: 'D', 311: 'D', 312: 'D',
  165: 'E', 166: 'E', 188: 'E', 189: 'E', 190: 'E', 191: 'E', 192: 'E',
  193: 'E', 240: 'E',
  175: 'F', 176: 'F', 195: 'F', 203: 'F', 320: 'F', 321: 'F', 322: 'F',
  323: 'G', 324: 'G', 325: 'G', 326: 'G', 327: 'G', 328: 'G',
  248: 'H', 253: 'H', 258: 'H', 263: 'H', 268: 'H',
  284: 'I', 289: 'I', 294: 'I', 299: 'I', 304: 'I',
  201: 'J',
};

const tileInfoCache = new Map<number, AssetTileInfo>();

export function getAssetTileInfo(id: number): AssetTileInfo {
  const cached = tileInfoCache.get(id);
  if (cached) return cached;

  const patternCode = TILE_PATTERN[id] ?? 'A';
  const tiles = PATTERNS[patternCode];

  const minC = Math.min(...tiles.map((t) => t[0]));
  const minR = Math.min(...tiles.map((t) => t[1]));
  const maxC = Math.max(...tiles.map((t) => t[0]));
  const maxR = Math.max(...tiles.map((t) => t[1]));

  const info: AssetTileInfo = {
    tiles: tiles as [number, number][],
    srcCol: minC,
    srcRow: minR,
    spanW: maxC - minC + 1,
    spanH: maxR - minR + 1,
  };

  tileInfoCache.set(id, info);
  return info;
}

export function getAssetSize(id: number): [number, number] {
  const info = getAssetTileInfo(id);
  return [info.spanW, info.spanH];
}

function buildAssetPath(id: number): string {
  return `/tiles/Modern_Office_Singles_48x48_${id}.png`;
}

export const ASSET_COUNT = 339;

const allAssets: AssetInfo[] = [];
const assetById = new Map<number, AssetInfo>();

for (let id = 1; id <= ASSET_COUNT; id++) {
  const [spanW, spanH] = getAssetSize(id);
  const asset: AssetInfo = { id, path: buildAssetPath(id), spanW, spanH };
  allAssets.push(asset);
  assetById.set(id, asset);
}

export function getAllAssets(): AssetInfo[] {
  return allAssets;
}

export function getAssetById(id: number): AssetInfo | undefined {
  return assetById.get(id);
}

export function getAssetPath(id: number): string {
  return buildAssetPath(id);
}

export const TOTAL_ASSETS = ASSET_COUNT;
