# CLAUDE.md

Guidance for AI coding assistants (Claude, Cursor, etc.) working in this repo. Read this before making non-trivial changes.

## Project at a Glance

- **Name**: Virtual Office
- **Kind**: Browser-only, client-side React SPA. No backend, no database, no tests yet.
- **Stack**: React 19 + TypeScript 6 + Vite 8. Styling is a mix of inline `style` objects and a global `index.css` with CSS variables (`--bg-primary`, `--accent`, etc.).
- **Entry points**: `index.html` → `src/main.tsx` → `src/App.tsx`.
- **Runtime scripts**: `npm run dev`, `npm run build` (tsc + vite), `npm run lint`, `npm run preview`.

## High-Level Architecture

The app is a three-tab editor (`live` | `build` | `assets`) composed in `src/App.tsx`. Domain logic lives in **hooks**; UI lives in **components**; persistence/helpers in **utils**; the static tile catalog in **data**.

### State ownership
All source-of-truth state is produced in hooks and plumbed down as props. There is **no context, no Redux, no Zustand** — just hook composition in `App.tsx`.

| Hook | Owns |
| --- | --- |
| `useGrid(initialRoom)` | The full `RoomState` (grid size, placements, groups, per-layer visibility/lock/names), plus an **undo/redo history (max 100 steps)** and every mutation API (add/remove/move/duplicate/resize/reorder/group/bulk ops). |
| `useTool()` | Editor `ToolState`: `mode` (`select` / `draw` / `place`), `tool` (`paint` / `erase`), `drawSubTool` (`brush` / `marquee`), `activeLayer`, `selectedAssetId`, and transforms (`rotation`, `flipH`, `flipV`). |
| `useAssetCategories(customAssetIds)` | Asset library tree: `rootLabel`, hierarchical categories, uncategorized IDs, per-asset display names, and per-tile overrides. |
| `useCustomAssets()` | User-uploaded tilesheets & their cropped sub-assets. IDs start at 1000 to avoid collision with the 1–340 built-in range. |

### Data types worth memorizing

Defined in `src/hooks/useGrid.ts`:

```ts
type LayerType = 'floor' | 'wall' | 'object';

interface Placement {
  id: string;                  // 'p<n>' generated sequentially
  assetId: number;             // 1..340 built-in, 1000+ custom
  row: number; col: number;    // top-left grid cell
  spanW: number; spanH: number;// in cells
  layer: LayerType;
  rotation: number;            // 0 | 90 | 180 | 270
  flipH: boolean; flipV: boolean;
  zIndex?: number;             // within the same layer
  groupId?: string;            // optional group association
}

interface PlacementGroup { id: string; name: string; layer: LayerType; visible: boolean; locked: boolean; collapsed: boolean; }

interface RoomState {
  width: number; height: number; cellSize: number; // cellSize is always 48
  placements: Placement[]; groups: PlacementGroup[];
  layerVisibility: Record<LayerType, boolean>;
  layerLocked: Record<LayerType, boolean>;
  layerNames: Record<LayerType, string>;
}
```

### Component map (`src/components/`)

- `GridCanvas.tsx` — the central canvas, used in both `build` (interactive) and `live` (`readOnly`) modes. Handles placement hit-testing, drag/drop, marquee, bulk move/duplicate, rotate/flip, zoom.
- `Toolbar.tsx` — top bar in build mode: tool/mode/layer switches, transforms, undo/redo, export/import/clear, grid resize.
- `LayersPanel.tsx` — left panel: layer management + per-layer placement/group tree (resizable).
- `AssetPalette.tsx` — right panel in build mode: categorized asset picker + active transform preview.
- `AssetManager.tsx` — full-page manager on the `assets` tab: categories, renames, custom-tilesheet import, per-tile overrides.
- `AssetThumbnail.tsx` — shared thumbnail renderer (canvas-based, checkerboard background).
- `TileEditor.tsx` — edit per-tile occupancy for a specific asset.
- `ImportDialog.tsx` — custom tilesheet cropper flow.
- `ContextMenu.tsx`, `DragOverlay.tsx`, `ZoomNavigator.tsx` — smaller utility UI.

### Utilities (`src/utils/`)

- `imageLoader.ts` — preloads all 340 tiles on app start, caches `HTMLImageElement`s on `window.__assetImageCache` to survive HMR. Use `getCachedImage(assetId)` for sync access during canvas render.
- `roomStorage.ts` — `saveRoom` / `loadRoom` / `clearSavedRoom`, backed by the `virtualOffice_room` key. Includes a migration guard: if legacy `cells` format is detected, it returns `null` so the app starts from a default room.
- `projectFile.ts` — `exportProject()` / `importProject(File)`. Bundles four `localStorage` keys into a single JSON file with `_header: 'virtualOffice_project'` and `_version: 1`. Import replaces local state and the app does `window.location.reload()` afterwards.

### Asset catalog (`src/data/assetManifest.ts`)

- 340 built-in tiles, each `96x144` (2×3 cells of 48×48).
- `PATTERNS` maps a letter (A–J) to a list of occupied `[col, row]` cells within that 2×3 frame.
- `TILE_PATTERN` maps each asset ID to its pattern letter.
- `getAllAssets()` and `ASSET_COUNT` are the canonical accessors.

## Persistence (localStorage keys)

| Key | Owner | Content |
| --- | --- | --- |
| `virtualOffice_room` | `roomStorage.ts` | Current `RoomState` (auto-saved on every change). |
| `virtualOffice_library` | `useAssetCategories` | Category tree + display-name overrides. |
| `virtualOffice_tileOverrides` | `useAssetCategories` | Per-asset/per-tile occupancy overrides. |
| `virtualOffice_customAssets` | `useCustomAssets` | User-imported tilesheets and crop definitions. |

These four keys are also the exact payload of `exportProject` / `importProject`. **If you add another persisted key, you must add it to `KEYS` in `src/utils/projectFile.ts`** or export/import will silently drop it.

There is also a set of legacy keys (`virtualOffice_assetOverrides`, `virtualOffice_customCategories`, `virtualOffice_categoryLabels`, `virtualOffice_initialized`) that `useAssetCategories` migrates away from on first load.

## Conventions & Gotchas

### Do
- **Use existing hook APIs** to mutate state. `useGrid` exposes batched undo/redo via `beginUndoBatch` / `endUndoBatch`; wrap multi-step mutations (drag-move, bulk duplicate, etc.) in a batch.
- **Prefer `EMPTY_SET` / stable references** for `Set`/`Map` props to avoid useless re-renders in large canvas components. See `const EMPTY_SET = new Set<string>()` in `App.tsx`.
- **Cell size is always 48.** Hardcoded in many places; changing it requires auditing the canvas renderer, asset thumbnails, and custom-asset cropping.
- **Asset IDs**: `1..ASSET_COUNT` (currently 340) for built-ins, `1000+` for custom. Don't reuse.
- **Use `var(--...)` CSS variables** from `index.css` for colors so dark/light tweaks stay consistent.
- **Run `npm run build`** to type-check; there are no unit tests to run.

### Don't
- Don't add runtime dependencies unless truly needed — this project ships zero beyond `react`/`react-dom`.
- Don't introduce a global state library (Context/Redux/Zustand) without a concrete reason; hook composition is working well.
- Don't call `saveRoom` directly from components — the `useEffect` in `App.tsx` already persists on every `room` change.
- Don't mutate `RoomState`, `Placement`, or `PlacementGroup` in place. `useGrid`'s reducers expect new references to push onto the undo history.
- Don't bypass `preloadAllAssets` for render-time image access; rely on `getCachedImage` so the canvas stays synchronous.

### Undo/Redo model
`useGrid` keeps `past[]` / `future[]` arrays of `RoomState` snapshots (cap: 100). Every mutation pushes the previous state onto `past` and clears `future`. For compound interactions, wrap calls with `beginUndoBatch()` / `endUndoBatch()` so the whole sequence collapses to a single undo step.

### Keyboard shortcuts
Implemented in `App.tsx`:
- `Cmd/Ctrl+Z` → undo
- `Cmd/Ctrl+Shift+Z` / `Cmd/Ctrl+Y` → redo

Inputs/textareas are skipped via the `tag === 'INPUT' || tag === 'TEXTAREA'` guard. Add new shortcuts there and respect the same guard.

## Adding Things — Quick Recipes

### Add a new built-in asset
1. Drop the PNG into `public/tiles/` (and `assets/modern_office/` if you want it tracked alongside the source set).
2. Bump `ASSET_COUNT` in `src/data/assetManifest.ts` if you're extending the range, or update the generator if you change the pattern.
3. Add its ID to `TILE_PATTERN` with the right letter.
4. No component changes needed — the asset palette and preloader pick it up automatically.

### Add a new persisted setting
1. Add a key like `virtualOffice_mySetting`.
2. Wrap the load/save in a hook (see `useCustomAssets` for a minimal template).
3. Add the key to `KEYS` in `src/utils/projectFile.ts` so it round-trips through export/import.

### Add a new layer type
Not recommended; `LayerType` is a union used across dozens of files and default records (`layerVisibility`, `layerLocked`, `layerNames`). If you must, grep `'floor'` / `'wall'` / `'object'` and update every `Record<LayerType, ...>` initializer.

## Files You'll Touch Most Often

- `src/App.tsx` — wire-up & props plumbing
- `src/hooks/useGrid.ts` — anything placement/group/layer related
- `src/components/GridCanvas.tsx` — rendering & pointer interactions
- `src/components/LayersPanel.tsx` — layer/group UI
- `src/components/AssetPalette.tsx` / `AssetManager.tsx` — library UI
- `src/data/assetManifest.ts` — the static asset catalog

## Known Gaps / Watch-outs

- **No tests.** Any non-trivial change should at minimum be exercised manually in `npm run dev` across all three tabs, plus an export → reload → import round-trip.
- **localStorage quota.** Custom assets store data URLs; uploading many large tilesheets can blow the ~5 MB quota. `saveData` swallows the error silently — keep an eye on it.
- **HMR & image cache.** `imageLoader.ts` intentionally stashes the cache on `window` to survive HMR. Don't "clean this up" without a replacement.
- **Migration guard in `roomStorage.loadRoom`.** Only the current placement-based schema is loaded; the old `cells` schema triggers a fresh default. If you change `RoomState` shape, add another migration branch here.
- **No license file.** Tile artwork is third-party; don't assume redistribution rights.
