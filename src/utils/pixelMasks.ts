/**
 * Per-asset collision masks at true pixel resolution.
 *
 * A {@link PixelMask} is a bit-packed alpha mask sized `(spanW * 48) × (spanH * 48)`
 * in the asset's NATIVE orientation (before rotation/flip). Bit = 1 means the
 * pixel is opaque and should block agents; bit = 0 means transparent / walkable.
 *
 * Auto masks are derived from each asset's PNG alpha at load time and cached
 * on `window.__assetMaskCache` so HMR doesn't force a rebuild. Override masks
 * (painted by the user in the Collision Editor) live in localStorage and win
 * over the auto mask for that asset.
 */

const TILE = 48;
const ALPHA_THRESHOLD = 16;

export interface PixelMask {
  /** Width in pixels (native orientation). */
  w: number;
  /** Height in pixels (native orientation). */
  h: number;
  /** Bit-packed, row-major. Bit index `y*w + x`, LSB-first within each byte. */
  bits: Uint8Array;
}

// ── HMR-stable cache ─────────────────────────────────────────────────────
const _w = window as unknown as { __assetMaskCache?: Map<number, PixelMask> };
if (!_w.__assetMaskCache) _w.__assetMaskCache = new Map();
const maskCache = _w.__assetMaskCache;

// ── Bit helpers ──────────────────────────────────────────────────────────
export function createEmptyMask(w: number, h: number): PixelMask {
  const total = w * h;
  const bytes = Math.ceil(total / 8);
  return { w, h, bits: new Uint8Array(bytes) };
}

export function createFullMask(w: number, h: number): PixelMask {
  const mask = createEmptyMask(w, h);
  mask.bits.fill(0xff);
  // Clear any spillover bits past `w*h` in the last byte to keep things tidy.
  const total = w * h;
  const extra = total & 7;
  if (extra !== 0) {
    const lastIdx = mask.bits.length - 1;
    mask.bits[lastIdx] &= (1 << extra) - 1;
  }
  return mask;
}

export function getBit(mask: PixelMask, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= mask.w || y >= mask.h) return false;
  const idx = y * mask.w + x;
  return (mask.bits[idx >> 3] & (1 << (idx & 7))) !== 0;
}

export function setBit(mask: PixelMask, x: number, y: number, value: boolean): void {
  if (x < 0 || y < 0 || x >= mask.w || y >= mask.h) return;
  const idx = y * mask.w + x;
  const byteIdx = idx >> 3;
  const bit = 1 << (idx & 7);
  if (value) mask.bits[byteIdx] |= bit;
  else mask.bits[byteIdx] &= ~bit;
}

export function cloneMask(mask: PixelMask): PixelMask {
  return { w: mask.w, h: mask.h, bits: new Uint8Array(mask.bits) };
}

export function masksEqual(a: PixelMask, b: PixelMask): boolean {
  if (a.w !== b.w || a.h !== b.h) return false;
  if (a.bits.length !== b.bits.length) return false;
  for (let i = 0; i < a.bits.length; i++) if (a.bits[i] !== b.bits[i]) return false;
  return true;
}

// ── Scratch canvas used for alpha sampling ───────────────────────────────
let scratchCanvas: HTMLCanvasElement | null = null;
let scratchCtx: CanvasRenderingContext2D | null = null;
function getScratchCtx(w: number, h: number): CanvasRenderingContext2D {
  if (!scratchCanvas) {
    scratchCanvas = document.createElement('canvas');
    scratchCtx = scratchCanvas.getContext('2d', { willReadFrequently: true });
  }
  if (scratchCanvas.width !== w) scratchCanvas.width = w;
  if (scratchCanvas.height !== h) scratchCanvas.height = h;
  scratchCtx!.clearRect(0, 0, w, h);
  scratchCtx!.imageSmoothingEnabled = false;
  return scratchCtx!;
}

// ── Build a mask from a loaded image ─────────────────────────────────────
/**
 * Builds a {@link PixelMask} by drawing only the asset's occupied tiles into
 * an offscreen canvas and thresholding the alpha channel.
 *
 * `tiles` are (imgCol, imgRow) cells within the source PNG that belong to the
 * asset; `srcCol`/`srcRow` are the top-left of the bounding box of those
 * tiles (so the result is compacted to `spanW × spanH` cells with no
 * negative offsets).
 */
export function buildMaskFromImage(
  img: HTMLImageElement,
  tiles: Array<[number, number]>,
  srcCol: number,
  srcRow: number,
  spanW: number,
  spanH: number,
  threshold = ALPHA_THRESHOLD,
): PixelMask {
  const W = spanW * TILE;
  const H = spanH * TILE;
  const mask = createEmptyMask(W, H);
  if (!img || img.naturalWidth === 0 || img.naturalHeight === 0) return mask;
  if (W === 0 || H === 0) return mask;

  const ctx = getScratchCtx(W, H);
  for (const [imgCol, imgRow] of tiles) {
    const dstX = (imgCol - srcCol) * TILE;
    const dstY = (imgRow - srcRow) * TILE;
    try {
      ctx.drawImage(img, imgCol * TILE, imgRow * TILE, TILE, TILE, dstX, dstY, TILE, TILE);
    } catch {
      // ignore; mask stays zero for that tile
    }
  }

  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(0, 0, W, H).data;
  } catch {
    // Tainted canvas (cross-origin image without CORS). Return empty mask.
    return mask;
  }

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const a = data[(y * W + x) * 4 + 3];
      if (a >= threshold) {
        const idx = y * W + x;
        mask.bits[idx >> 3] |= 1 << (idx & 7);
      }
    }
  }
  return mask;
}

// ── Encode / decode for localStorage ─────────────────────────────────────
export function encodeMask(mask: PixelMask): string {
  let binary = '';
  const bytes = mask.bits;
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  const b64 = btoa(binary);
  return `${mask.w}x${mask.h}:${b64}`;
}

export function decodeMask(s: string): PixelMask | null {
  const colon = s.indexOf(':');
  if (colon < 0) return null;
  const header = s.slice(0, colon);
  const body = s.slice(colon + 1);
  const sep = header.indexOf('x');
  if (sep < 0) return null;
  const w = Number(header.slice(0, sep));
  const h = Number(header.slice(sep + 1));
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  try {
    const binary = atob(body);
    const bits = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bits[i] = binary.charCodeAt(i);
    const expectedBytes = Math.ceil((w * h) / 8);
    if (bits.length !== expectedBytes) return null;
    return { w, h, bits };
  } catch {
    return null;
  }
}

// ── Auto-mask cache ──────────────────────────────────────────────────────
export function setAutoMask(assetId: number, mask: PixelMask): void {
  maskCache.set(assetId, mask);
}

export function getAutoMask(assetId: number): PixelMask | undefined {
  return maskCache.get(assetId);
}

export function hasAutoMask(assetId: number): boolean {
  return maskCache.has(assetId);
}

export function deleteAutoMask(assetId: number): void {
  maskCache.delete(assetId);
}

// ── World-pixel sampling against a placed asset ──────────────────────────
export interface PlacementShape {
  /** Grid row of top-left cell. */
  row: number;
  /** Grid column of top-left cell. */
  col: number;
  /** Rendered width in cells (post-rotation). */
  spanW: number;
  /** Rendered height in cells (post-rotation). */
  spanH: number;
  /** 0 | 90 | 180 | 270. */
  rotation: number;
  flipH: boolean;
  flipV: boolean;
}

/**
 * Given a world pixel `(wxPx, wyPx)` in grid-pixel coordinates (i.e.
 * `cell * 48`), return `true` if that pixel is on an opaque part of the
 * placement as drawn (accounting for rotation + flip).
 */
export function samplePlacementPixel(
  p: PlacementShape,
  wxPx: number,
  wyPx: number,
  mask: PixelMask,
): boolean {
  const isRot = p.rotation === 90 || p.rotation === 270;
  // Rendered box (post-rotation) in pixels, always matches spanW/spanH * TILE.
  const PW = p.spanW * TILE;
  const PH = p.spanH * TILE;
  const ax = p.col * TILE;
  const ay = p.row * TILE;
  const rx = wxPx - ax;
  const ry = wyPx - ay;
  if (rx < 0 || ry < 0 || rx >= PW || ry >= PH) return false;

  // Native mask dimensions (pre-rotation). If rotated 90/270 the native w/h
  // are the rendered h/w swapped; either way we just read them from the mask.
  const W = mask.w;
  const H = mask.h;
  if (isRot) {
    // Sanity: rendered box should be H × W when rotated. If the mask does not
    // match, bail out (treat as walkable) rather than index out of range.
    if (PW !== H || PH !== W) return false;
  } else {
    if (PW !== W || PH !== H) return false;
  }

  // Rendered-local, center-relative.
  const rcx = rx - PW / 2;
  const rcy = ry - PH / 2;

  // Inverse rotate (rendered → native, center-relative).
  // Forward canvas transform is: native → subtract center → flip → rotate → add center.
  // So inverse is: rendered → subtract center → inverse-rotate → inverse-flip → add native center.
  let ncx: number;
  let ncy: number;
  switch (p.rotation) {
    case 0:
      ncx = rcx; ncy = rcy; break;
    case 90:
      ncx = rcy; ncy = -rcx; break;
    case 180:
      ncx = -rcx; ncy = -rcy; break;
    case 270:
      ncx = -rcy; ncy = rcx; break;
    default:
      ncx = rcx; ncy = rcy; break;
  }

  if (p.flipH) ncx = -ncx;
  if (p.flipV) ncy = -ncy;

  const mx = Math.floor(ncx + W / 2);
  const my = Math.floor(ncy + H / 2);
  return getBit(mask, mx, my);
}
