export const CHAR_COUNT = 40;
export const CHAR_SHEET_W = 64;
export const CHAR_SHEET_H = 128;
// The sheet canvas is 64×128 but each character frame is only 20×32.
// The final 4px column on the right is padding and must not be sampled,
// otherwise frame 2 (srcX = 2 * 64/3 ≈ 42.67) slides into that empty strip
// and the sprite appears mis-cropped / shifted.
export const CHAR_FRAME_W = 20;
export const CHAR_FRAME_H = 32;

export type Facing = 'down' | 'left' | 'right' | 'up';

export const FACING_ROW: Record<Facing, number> = {
  down: 0,
  left: 1,
  right: 2,
  up: 3,
};

const _w = window as unknown as {
  __characterImageCache?: Map<number, HTMLImageElement>;
  __characterImagesLoaded?: boolean;
};
if (!_w.__characterImageCache) _w.__characterImageCache = new Map();
if (!_w.__characterImagesLoaded) _w.__characterImagesLoaded = false;

const cache = _w.__characterImageCache;
const getLoaded = () => _w.__characterImagesLoaded!;
const setLoaded = (v: boolean) => { _w.__characterImagesLoaded = v; };

function characterPath(spriteId: number): string {
  return `/characters/${String(spriteId).padStart(3, '0')}.png`;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load: ${src}`));
    img.src = src;
  });
}

export async function preloadAllCharacters(
  onProgress?: (loaded: number, total: number) => void
): Promise<void> {
  if (getLoaded()) return;

  const total = CHAR_COUNT;
  let completed = 0;

  const BATCH_SIZE = 20;
  for (let i = 0; i < CHAR_COUNT; i += BATCH_SIZE) {
    const batch: number[] = [];
    for (let j = i; j < Math.min(i + BATCH_SIZE, CHAR_COUNT); j++) batch.push(j);
    const results = await Promise.allSettled(
      batch.map(async (spriteId) => {
        const img = await loadImage(characterPath(spriteId));
        cache.set(spriteId, img);
      })
    );
    completed += results.length;
    onProgress?.(completed, total);
  }

  setLoaded(true);
}

export function getCachedCharacter(spriteId: number): HTMLImageElement | undefined {
  const img = cache.get(spriteId);
  if (img) return img;
  // Fallback to sprite 0 if requested sprite is missing.
  return cache.get(0);
}

export function characterSpritePath(spriteId: number): string {
  return characterPath(spriteId);
}
