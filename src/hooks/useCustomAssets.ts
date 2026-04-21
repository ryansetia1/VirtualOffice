import { useCallback, useState, useEffect, useRef } from 'react';
import { cacheImage, getCachedImage, setCustomAssetMask, clearAssetMask } from '../utils/imageLoader';
import type { AssetInfo } from '../data/assetManifest';

const STORAGE_KEY = 'virtualOffice_customAssets';
const TILE = 48;

export interface CustomAssetData {
  id: number;
  sourceUrl: string;
  cropX: number;
  cropY: number;
  category: string;
  spanW: number;
  spanH: number;
  tiles: [number, number][];
  dataUrl?: string;
}

function loadData(): CustomAssetData[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as CustomAssetData[]) : [];
  } catch {
    return [];
  }
}

function saveData(data: CustomAssetData[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch { /* ignore */ }
}

function nextId(existing: CustomAssetData[]): number {
  if (existing.length === 0) return 1000;
  return Math.max(...existing.map((a) => a.id)) + 1;
}

async function loadSourceImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load: ${url}`));
    img.src = url;
  });
}

function cropTilesToDataUrl(
  source: HTMLImageElement,
  cropX: number,
  cropY: number,
  spanW: number,
  spanH: number,
  tiles: [number, number][]
): string {
  const canvas = document.createElement('canvas');
  canvas.width = spanW * TILE;
  canvas.height = spanH * TILE;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  const tileSet = new Set(tiles.map(([c, r]) => `${c},${r}`));
  for (let r = 0; r < spanH; r++) {
    for (let c = 0; c < spanW; c++) {
      if (!tileSet.has(`${c},${r}`)) continue;
      ctx.drawImage(source, cropX + c * TILE, cropY + r * TILE, TILE, TILE, c * TILE, r * TILE, TILE, TILE);
    }
  }
  return canvas.toDataURL();
}

function cacheFromDataUrl(
  id: number,
  dataUrl: string,
  tiles: [number, number][],
  spanW: number,
  spanH: number,
): Promise<void> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      cacheImage(id, img);
      setCustomAssetMask(id, img, tiles, spanW, spanH);
      resolve();
    };
    img.onerror = () => resolve();
    img.src = dataUrl;
  });
}

export function useCustomAssets() {
  const [assets, setAssets] = useState<CustomAssetData[]>(loadData);
  const loadedRef = useRef(false);

  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    const data = loadData();
    for (const a of data) {
      if (a.dataUrl && !getCachedImage(a.id)) {
        cacheFromDataUrl(a.id, a.dataUrl, a.tiles, a.spanW, a.spanH);
      }
    }
  }, []);

  const addCustomAssets = useCallback(async (newAssets: Omit<CustomAssetData, 'id'>[]): Promise<CustomAssetData[]> => {
    const existing = loadData();
    let id = nextId(existing);

    // Group by sourceUrl to avoid loading the same image multiple times
    const bySource = new Map<string, Omit<CustomAssetData, 'id'>[]>();
    for (const a of newAssets) {
      if (!bySource.has(a.sourceUrl)) bySource.set(a.sourceUrl, []);
      bySource.get(a.sourceUrl)!.push(a);
    }

    const withIds: CustomAssetData[] = [];

    for (const [url, items] of bySource) {
      let source: HTMLImageElement | null = null;
      try {
        source = await loadSourceImage(url);
      } catch { /* ignore */ }

      for (const a of items) {
        const asset: CustomAssetData = { ...a, id: id++ };
        if (source) {
          const dataUrl = cropTilesToDataUrl(source, a.cropX, a.cropY, a.spanW, a.spanH, a.tiles);
          asset.dataUrl = dataUrl;
          await cacheFromDataUrl(asset.id, dataUrl, a.tiles, a.spanW, a.spanH);
        }
        withIds.push(asset);
      }
    }

    const all = [...existing, ...withIds];
    saveData(all);
    setAssets(all);

    return withIds;
  }, []);

  const removeCustomAsset = useCallback((id: number) => {
    setAssets((prev) => {
      const next = prev.filter((a) => a.id !== id);
      saveData(next);
      return next;
    });
    clearAssetMask(id);
  }, []);

  const customAssetInfos: AssetInfo[] = assets.map((a) => ({
    id: a.id,
    path: '',
    spanW: a.spanW,
    spanH: a.spanH,
  }));

  return {
    customAssets: assets,
    customAssetInfos,
    addCustomAssets,
    removeCustomAsset,
  };
}
