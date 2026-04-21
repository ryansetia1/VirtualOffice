import { useCallback, useState } from 'react';
import type { LayerType } from './useGrid';

export type ToolType = 'paint' | 'erase';
export type EditorMode = 'select' | 'draw' | 'place';
export type DrawSubTool = 'brush' | 'marquee';

export interface ToolState {
  mode: EditorMode;
  tool: ToolType;
  drawSubTool: DrawSubTool;
  activeLayer: LayerType;
  selectedAssetId: number | null;
  rotation: number;
  flipH: boolean;
  flipV: boolean;
}

export function useTool() {
  const [toolState, setToolState] = useState<ToolState>({
    // Start in 'select' so the user can't accidentally paint/erase/place
    // before they've chosen a tool.
    mode: 'select',
    tool: 'paint',
    drawSubTool: 'brush',
    activeLayer: 'object',
    selectedAssetId: null,
    rotation: 0,
    flipH: false,
    flipV: false,
  });

  const setMode = useCallback((mode: EditorMode) => {
    setToolState((prev) => ({ ...prev, mode }));
  }, []);

  const setDrawSubTool = useCallback((drawSubTool: DrawSubTool) => {
    setToolState((prev) => ({ ...prev, drawSubTool }));
  }, []);

  const setTool = useCallback((tool: ToolType) => {
    setToolState((prev) => ({ ...prev, tool }));
  }, []);

  const setActiveLayer = useCallback((layer: LayerType) => {
    setToolState((prev) => ({ ...prev, activeLayer: layer }));
  }, []);

  const selectAsset = useCallback((assetId: number | null) => {
    setToolState((prev) => ({
      ...prev,
      selectedAssetId: assetId,
      rotation: 0,
      flipH: false,
      flipV: false,
    }));
  }, []);

  const rotateAsset = useCallback(() => {
    setToolState((prev) => ({ ...prev, rotation: (prev.rotation + 90) % 360 }));
  }, []);

  const flipHAsset = useCallback(() => {
    setToolState((prev) => ({ ...prev, flipH: !prev.flipH }));
  }, []);

  const flipVAsset = useCallback(() => {
    setToolState((prev) => ({ ...prev, flipV: !prev.flipV }));
  }, []);

  const resetTransform = useCallback(() => {
    setToolState((prev) => ({ ...prev, rotation: 0, flipH: false, flipV: false }));
  }, []);

  return {
    toolState,
    setMode,
    setDrawSubTool,
    setTool,
    setActiveLayer,
    selectAsset,
    rotateAsset,
    flipHAsset,
    flipVAsset,
    resetTransform,
  };
}
