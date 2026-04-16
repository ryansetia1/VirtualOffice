import { getAllAssets } from '../data/assetManifest';

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

export async function preloadAllAssets(
  onProgress?: (loaded: number, total: number) => void
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
        const img = await loadImage(asset.path);
        imageCache.set(asset.id, img);
      })
    );
    completed += results.length;
    onProgress?.(completed, total);
  }

  setLoaded(true);
}

export function getCachedImage(assetId: number): HTMLImageElement | undefined {
  return imageCache.get(assetId);
}

export function cacheImage(assetId: number, img: HTMLImageElement): void {
  imageCache.set(assetId, img);
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
