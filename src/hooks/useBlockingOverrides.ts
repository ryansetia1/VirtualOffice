import { useCallback, useEffect, useRef, useState } from 'react';

export type Blocking = 'walkable' | 'blocking';
export type BlockingMap = Record<number, Blocking>;

const STORAGE_KEY = 'virtualOffice_blockingOverrides';

function load(): BlockingMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const result: BlockingMap = {};
    for (const [k, v] of Object.entries(parsed)) {
      const id = Number(k);
      if (!Number.isFinite(id)) continue;
      if (v === 'walkable' || v === 'blocking') result[id] = v;
    }
    return result;
  } catch {
    return {};
  }
}

function save(map: BlockingMap) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // ignore quota errors
  }
}

export interface UseBlockingOverridesApi {
  overrides: BlockingMap;
  /** Returns true if agents should be blocked by this asset on the object layer. */
  isBlocking: (assetId: number) => boolean;
  setBlocking: (assetId: number, value: Blocking) => void;
  clearBlocking: (assetId: number) => void;
}

export function useBlockingOverrides(): UseBlockingOverridesApi {
  const [overrides, setOverrides] = useState<BlockingMap>(load);
  const isFirst = useRef(true);
  useEffect(() => {
    if (isFirst.current) { isFirst.current = false; return; }
    save(overrides);
  }, [overrides]);

  const isBlocking = useCallback(
    (assetId: number): boolean => {
      const v = overrides[assetId];
      // Default: blocking for object layer; only explicit 'walkable' lets agents pass.
      return v !== 'walkable';
    },
    [overrides]
  );

  const setBlocking = useCallback((assetId: number, value: Blocking) => {
    setOverrides((prev) => ({ ...prev, [assetId]: value }));
  }, []);

  const clearBlocking = useCallback((assetId: number) => {
    setOverrides((prev) => {
      if (!(assetId in prev)) return prev;
      const next = { ...prev };
      delete next[assetId];
      return next;
    });
  }, []);

  return { overrides, isBlocking, setBlocking, clearBlocking };
}
