import { getAllAssets, getAssetTileInfo } from '../data/assetManifest';
import {
  buildMaskFromImage,
  deleteAutoMask,
  setAutoMask,
  getAutoMask,
} from './pixelMasks';
import type { PixelMask } from './pixelMasks';

// Persist on window to survive HMR
const _w = window as unknown as { __assetImageCache?: Map<number, HTMLImageElement>; __assetImagesLoaded?: boolean };
if (!_w.__assetImageCache) _w.__assetImageCache = new Map();
if (!_w.__assetImagesLoaded) _w.__assetImagesLoaded = false;

const imageCache = _w.__assetImageCache;
const getLoaded = () => _w.__assetImagesLoaded!;
const setLoaded = (v: boolean) => { _w.__assetImagesLoaded = v; };

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load: ${src}`));
    img.src = src;
  });
}

// Build the auto collision mask for a built-in asset from its loaded image.
function generateBuiltinMask(assetId: number, img: HTMLImageElement): PixelMask {
  const info = getAssetTileInfo(assetId);
  const mask = buildMaskFromImage(img, info.tiles, info.srcCol, info.srcRow, info.spanW, info.spanH);
  setAutoMask(assetId, mask);
  return mask;
}

export async function preloadAllAssets(
  onProgress?: (loaded: number, total: number) => void,
  urlResolver?: (id: number) => string
): Promise<void> {
  if (getLoaded()) return;

  const assets = getAllAssets();
  const total = assets.length;
  let completed = 0;

  const BATCH_SIZE = 30;
  for (let i = 0; i < assets.length; i += BATCH_SIZE) {
    const batch = assets.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map(async (asset) => {
        // Prefer the caller-provided URL so the preloader respects the user's
        // current category assignments (files may physically live in subfolders).
        const resolvedUrl = urlResolver?.(asset.id);
        const url = resolvedUrl && resolvedUrl.length > 0 ? resolvedUrl : asset.path;
        try {
          const img = await loadImage(url);
          imageCache.set(asset.id, img);
          generateBuiltinMask(asset.id, img);
        } catch {
          // Fallback: if the category-aware URL failed (file missing), try the
          // canonical root URL so at least the built-in default still loads.
          if (url !== asset.path) {
            try {
              const img = await loadImage(asset.path);
              imageCache.set(asset.id, img);
              generateBuiltinMask(asset.id, img);
            } catch { /* ignore */ }
          }
        }
      })
    );
    completed += results.length;
    onProgress?.(completed, total);
  }

  setLoaded(true);
}

/**
 * Re-fetch a single asset's image (used after the underlying file has been
 * moved to a new category folder). Safe to ignore errors — rendering will
 * continue to use the previously cached bitmap.
 */
export async function refreshAssetImage(assetId: number, url: string): Promise<void> {
  if (!url) return;
  try {
    const img = await loadImage(url);
    imageCache.set(assetId, img);
    // Regenerate the auto mask from the new pixels.
    generateBuiltinMask(assetId, img);
  } catch {
    // leave old cache in place
  }
}

export function getCachedImage(assetId: number): HTMLImageElement | undefined {
  return imageCache.get(assetId);
}

export function cacheImage(assetId: number, img: HTMLImageElement): void {
  imageCache.set(assetId, img);
}

/**
 * Build or replace the auto collision mask for a custom (user-imported)
 * asset. Custom assets have `srcCol=0, srcRow=0` and tiles relative to a
 * pre-cropped data-URL image, so we use their metadata verbatim.
 */
export function setCustomAssetMask(
  assetId: number,
  img: HTMLImageElement,
  tiles: [number, number][],
  spanW: number,
  spanH: number,
): void {
  const mask = buildMaskFromImage(img, tiles, 0, 0, spanW, spanH);
  setAutoMask(assetId, mask);
}

/** Drop the auto mask for an asset (used when a custom asset is removed). */
export function clearAssetMask(assetId: number): void {
  deleteAutoMask(assetId);
}

/** Ensure an auto mask exists for a built-in asset that may not have been
 * preloaded (e.g. off-project custom asset id). Returns the mask if one is
 * available. */
export function ensureAutoMask(assetId: number): PixelMask | undefined {
  const existing = getAutoMask(assetId);
  if (existing) return existing;
  const img = imageCache.get(assetId);
  if (!img) return undefined;
  return generateBuiltinMask(assetId, img);
}

export function isLoaded(): boolean {
  return getLoaded();
}

// 1x1 transparent image used to suppress the browser's default drag ghost
let _emptyDragImg: HTMLImageElement | null = null;
export function getEmptyDragImage(): HTMLImageElement {
  if (!_emptyDragImg) {
    _emptyDragImg = new Image(1, 1);
    _emptyDragImg.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  }
  return _emptyDragImg;
}
