# CLAUDE.md

Guidance for AI coding assistants (Claude, Cursor, etc.) working in this repo. Read this before making non-trivial changes.

## Project at a Glance

- **Name**: Virtual Office
- **Kind**: Dual-target app.
  - **Browser SPA** (`npm run dev`) — the room/asset editor, pure client-side.
  - **Tauri desktop app** (`npm run tauri:dev` / `tauri:build`) — adds real filesystem, an interactive terminal, and "live walk-around" agents on top of the exact same React tree.
- **Stack**: React 19 + TypeScript 6 + Vite 8 on the frontend. Rust 1.77 + Tauri 2 on the desktop side. Terminal emulation via `@xterm/xterm` + `portable-pty`.
- **Entry points**: `index.html` → `src/main.tsx` → `src/App.tsx`. Desktop entry: `src-tauri/src/main.rs` → `src-tauri/src/lib.rs::run`.
- **Runtime scripts**: `npm run dev`, `npm run build` (tsc + vite), `npm run lint`, `npm run preview`, `npm run tauri:dev`, `npm run tauri:build`.

## High-Level Architecture

The app is a three-tab editor (`live` | `build` | `assets`) composed in `src/App.tsx`. Domain logic lives in **hooks**; UI lives in **components**; persistence/helpers/IPC wrappers in **utils**; the static tile catalog in **data**. When running inside Tauri, a small Rust backend exposes filesystem + PTY commands that `utils/tauri.ts` wraps behind an `isTauri()` check — in the browser the app degrades gracefully and those features simply disable themselves.

### State ownership

All source-of-truth state is produced in hooks and plumbed down as props. There is **no context, no Redux, no Zustand** — just hook composition in `App.tsx`.

| Hook | Owns |
| --- | --- |
| `useGrid(initialRoom)` | The full `RoomState` (grid size, placements, groups, per-layer visibility/lock/names), plus an **undo/redo history (max 100 steps)** and every mutation API (add/remove/move/duplicate/resize/reorder/group/bulk ops). |
| `useTool()` | Editor `ToolState`: `mode` (`select` / `draw` / `place`), `tool` (`paint` / `erase`), `drawSubTool` (`brush` / `marquee`), `activeLayer`, `selectedAssetId`, and transforms (`rotation`, `flipH`, `flipV`). |
| `useAssetCategories(customAssetIds)` | Asset library tree: `rootLabel`, hierarchical categories, uncategorized IDs, per-asset display names, per-tile overrides, **and** (in Tauri) mirroring of category moves/renames to the real asset directory on disk. |
| `useCustomAssets()` | User-uploaded tilesheets & their cropped sub-assets. IDs start at 1000 to avoid collision with the 1–340 built-in range. |
| `useAgents()` | The list of live-mode agents, their position/facing/`animFrame`, `activeAgentId`, and mutation APIs (`addAgent`, `renameAgent`, `setSpriteId`, `moveAgent`, `setFacing`, `removeAgent`). Persists to `virtualOffice_agents`. |
| `useBlockingOverrides()` | Per-asset walkable/blocking overrides used by agent collision. Defaults object-layer placements to `blocking`; only explicit `'walkable'` lets agents pass through. Persists to `virtualOffice_blockingOverrides`. |

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

Defined in `src/hooks/useAgents.ts`:

```ts
type Facing = 'down' | 'left' | 'right' | 'up';

interface Agent {
  id: string;                 // 'a<n>' generated sequentially
  nickname: string;           // mutable, displayed above sprite
  folderName: string;         // immutable, maps to an on-disk project folder
  spriteId: number;           // 0..CHAR_COUNT-1 → /characters/NNN.png
  row: number; col: number;   // grid cell the agent is standing on
  facing: Facing;
  animFrame: 0 | 1 | 2;       // column within sprite sheet; 1 = idle
  createdAt: number;
}
```

### Component map (`src/components/`)

- `GridCanvas.tsx` — the central canvas, used in both `build` (interactive) and `live` (`readOnly`) modes. Handles placement hit-testing, drag/drop, marquee, bulk move/duplicate, rotate/flip, zoom. In read-only mode it also renders agents (with nameplates + active-ring), does agent hit-testing, and drives the derived **follow-camera**.
- `Toolbar.tsx` — top bar in build mode: tool/mode/layer switches, transforms, undo/redo, export/import/clear, grid resize.
- `LayersPanel.tsx` — left panel: layer management + per-layer placement/group tree (resizable).
- `AssetPalette.tsx` — right panel in build mode: categorized asset picker + active transform preview. Uses `resolveAssetUrl` from `assetFiles.ts` so thumbnails reflect the current on-disk category.
- `AssetManager.tsx` — full-page manager on the `assets` tab: categories, renames, custom-tilesheet import, per-tile overrides.
- `AssetThumbnail.tsx` — shared thumbnail renderer (canvas-based, checkerboard background).
- `TileEditor.tsx` — edit per-tile occupancy for a specific asset.
- `ImportDialog.tsx` — custom tilesheet cropper flow.
- `AgentsPanel.tsx`, `AddAgentModal.tsx` — live-mode agent list, rename, sprite-swap, remove (+ optional folder-delete), "Add Agent" flow that picks a folder name / sprite / spawn cell.
- `TerminalPanel.tsx` — bottom dock of xterm.js terminals that opens when you double-click an agent in live mode. One tab per agent, each backed by its own PTY session.
- `ContextMenu.tsx`, `DragOverlay.tsx`, `ZoomNavigator.tsx` — smaller utility UI.

### Utilities (`src/utils/`)

- `imageLoader.ts` — preloads all 340 tiles on app start, caches `HTMLImageElement`s on `window.__assetImageCache` to survive HMR. `preloadAllAssets(urlResolver?)` accepts the dynamic URL resolver from `assetFiles.ts` so assets that have been moved into category subfolders still load. Use `getCachedImage(assetId)` for sync access during canvas render.
- `characterImageLoader.ts` — same pattern but for the 40 character sprite sheets under `public/characters/000.png..039.png`. Each sheet is **64×128**, laid out as 3 columns × 4 rows, but each frame is only **20×32** — the last 4 pixels on the right of every sheet are padding and **must not** be sampled. Exports `CHAR_FRAME_W=20`, `CHAR_FRAME_H=32`, `FACING_ROW`, `preloadAllCharacters`, `getCachedCharacter`.
- `agentCollision.ts` — maps placements to a walkability grid using `useBlockingOverrides`. Object-layer placements block by default; floor placements never block; walls always block.
- `agentFolders.ts` — thin wrapper around the Rust agent-folder commands (`create`, `delete`, `list`, `agentFolderPath`). `isFolderNameValid(name)` enforces the same `[a-z0-9_-]+, max 64 chars` rule used on the Rust side.
- `assetFiles.ts` — mirror of `useAssetCategories` mutations to the real asset directory when running in Tauri. Exposes `resolveAssetUrl(assetId)` so thumbnails and the canvas renderer pick up moved/renamed files without refreshing the page.
- `pty.ts` — PTY IPC wrapper. Uses a typed Tauri `Channel<PtyMsg>` to stream shell output back into the renderer (messages are `{kind:'ready'|'data'|'exit'}`; `data` carries a base64 payload that the client decodes to `Uint8Array`). Also exposes `ptyWriteString`, `ptyWriteBytes`, `ptyResize`, `ptyKill`.
- `tauri.ts` — `isTauri()` and `invokeSafe()` guards that make Tauri commands no-op gracefully when running in a plain browser.
- `roomStorage.ts` — `saveRoom` / `loadRoom` / `clearSavedRoom`, backed by the `virtualOffice_room` key. Includes a migration guard: if legacy `cells` format is detected, it returns `null` so the app starts from a default room.
- `projectFile.ts` — `exportProject()` / `importProject(File)`. Bundles all persisted `localStorage` keys into a single JSON file with `_header: 'virtualOffice_project'` and `_version: 1`. Import replaces local state and the app does `window.location.reload()` afterwards.

### Rust backend (`src-tauri/src/`)

- `main.rs` — just calls `app_lib::run()`.
- `lib.rs` — registers the plugins (tauri-plugin-log in debug), initializes both filesystem roots, and wires every `#[tauri::command]` into `invoke_handler!`.
- `agents.rs` — project-folder operations. Root resolution order:
  1. `VIRTUAL_OFFICE_PROJECTS_DIR` env var if set,
  2. In debug: `<repo>/projects/`,
  3. In release: `<app-data>/projects/`.
  Exposes `get_projects_root`, `create_agent_folder`, `delete_agent_folder`, `list_agent_folders`, `agent_folder_path`. Every path is validated + canonicalized against the root to prevent `..` escapes.
- `asset_library.rs` — the real-folder mirror of the asset-category tree. Root picks up `VIRTUAL_OFFICE_ASSET_DIR`, else `<repo>/assets/modern_office/` in debug, else `<app-data>/assets/modern_office/` in release. Exposes `asset_get_root`, `asset_create_category`, `asset_rename_category`, `asset_delete_category`, `asset_move_file`, `asset_list_files`. Deleting a category moves any loose files back to the root instead of dropping them.
- `terminal.rs` — PTY sessions keyed by `session_id` in a global `HashMap`. `pty_spawn(session_id, cwd, cols, rows, on_message: Channel<PtyMsg>)` opens a login+interactive shell (`$SHELL -l -i`, falling back to `zsh`/`bash`/`cmd.exe`), spawns a reader thread that streams stdout through the channel, and **replaces any existing session with the same ID** transparently. `pty_write`, `pty_resize`, `pty_kill` round out the API.

### Asset catalog (`src/data/assetManifest.ts`)

- 340 built-in tiles, each `96x144` (2×3 cells of 48×48).
- `PATTERNS` maps a letter (A–J) to a list of occupied `[col, row]` cells within that 2×3 frame.
- `TILE_PATTERN` maps each asset ID to its pattern letter.
- `getAllAssets()` and `ASSET_COUNT` are the canonical accessors.

## Live Mode (agents + terminal)

- Live mode is the `live` tab rendered with `GridCanvas` in `readOnly` mode. It layers agents on top of the placed room and adds keyboard interaction.
- **Input** (handled in `App.tsx`): WASD/arrow keys move the active agent one cell at a time, `E` is the "interact" key, and **double-click on an agent** opens its terminal tab (`TerminalPanel`).
- **Collision** comes from `agentCollision.ts`: agents can walk on empty cells + floor tiles + any object explicitly tagged walkable; walls and un-overridden objects block.
- **Sprites** are drawn at `spriteH = cellPx * 2.025` (1-cell footprint, but roughly 2× cell height so characters read as people-size instead of chibi). `spriteW` is derived from the 20×32 frame aspect ratio so no horizontal squish. Both render and hit-test use the same multiplier — if you change it, change both call sites in `GridCanvas.tsx`.
- **Camera follow** is computed in `GridCanvas.tsx` as a `useMemo` called `effectiveOffset`. It does **not** run in a `requestAnimationFrame` loop. Each render it re-derives the offset needed to center the active agent, but only if the room is larger than the viewport on that axis, and clamps to room edges. Because the derivation runs in the same commit as the agent position update, the two stay perfectly in sync (no jitter). Build mode keeps using the raw `offset` state.
- **Terminal** sessions are `sessionId = \`agent:\${agent.id}\``. `TerminalPanel.tsx` boots xterm.js, calls `ptySpawn` with a fresh `Channel`, and wires xterm `onData`/`onBinary` → `ptyWriteString`/`ptyWriteBytes`. Tabs are closable; killing the PTY fires an `exit` message that auto-closes the tab after ~600 ms.

## Persistence

### localStorage keys

| Key | Owner | Content |
| --- | --- | --- |
| `virtualOffice_room` | `roomStorage.ts` | Current `RoomState` (auto-saved on every change). |
| `virtualOffice_library` | `useAssetCategories` | Category tree + display-name overrides. |
| `virtualOffice_tileOverrides` | `useAssetCategories` | Per-asset/per-tile occupancy overrides. |
| `virtualOffice_customAssets` | `useCustomAssets` | User-imported tilesheets and crop definitions. |
| `virtualOffice_agents` | `useAgents` | Agents list + `activeAgentId`. |
| `virtualOffice_blockingOverrides` | `useBlockingOverrides` | Per-asset walkable/blocking flags. |

These six keys are the exact payload of `exportProject` / `importProject`. **If you add another persisted key, you must add it to `KEYS` in `src/utils/projectFile.ts`** or export/import will silently drop it.

Legacy keys (`virtualOffice_assetOverrides`, `virtualOffice_customCategories`, `virtualOffice_categoryLabels`, `virtualOffice_initialized`) are migrated away from on first load by `useAssetCategories`.

### Filesystem (Tauri only)

- **Agent folders**: `<projects-root>/<folderName>/` for each agent; created on add, optionally deleted on remove.
- **Asset categories**: category paths (e.g. `floor/wood`) become real nested directories under `<asset-root>/`. Renaming a category renames the folder; moving an asset `mv`s its PNG.

## Conventions & Gotchas

### Do

- **Use existing hook APIs** to mutate state. `useGrid` exposes batched undo/redo via `beginUndoBatch` / `endUndoBatch`; wrap multi-step mutations (drag-move, bulk duplicate, etc.) in a batch.
- **Prefer `EMPTY_SET` / stable references** for `Set`/`Map` props to avoid useless re-renders in large canvas components. See `const EMPTY_SET = new Set<string>()` in `App.tsx`.
- **Cell size is always 48.** Hardcoded in many places; changing it requires auditing the canvas renderer, asset thumbnails, and custom-asset cropping.
- **Asset IDs**: `1..ASSET_COUNT` (currently 340) for built-ins, `1000+` for custom. Don't reuse.
- **Character sprites** sample `CHAR_FRAME_W=20` / `CHAR_FRAME_H=32`, not `sheet/3` or `sheet/4` — sampling the full sheet math mis-aligns frame 2 onto padding.
- **Gate Tauri-only code** behind `isTauri()` so the browser build still runs.
- **Use `var(--...)` CSS variables** from `index.css` for colors so dark/light tweaks stay consistent.
- **Run `npm run build`** to type-check; there are no unit tests to run.

### Don't

- Don't add runtime dependencies unless truly needed — the browser app keeps this near zero; the desktop app only adds `@tauri-apps/api` + xterm.
- Don't introduce a global state library (Context/Redux/Zustand) without a concrete reason; hook composition is working well.
- Don't call `saveRoom` directly from components — the `useEffect` in `App.tsx` already persists on every `room` change.
- Don't mutate `RoomState`, `Placement`, or `PlacementGroup` in place. `useGrid`'s reducers expect new references to push onto the undo history.
- Don't bypass `preloadAllAssets` / `preloadAllCharacters` for render-time image access; rely on `getCachedImage` / `getCachedCharacter` so the canvas stays synchronous.
- Don't wire PTY output through `emit`/`listen`. Events with `:` in the name silently fail; we intentionally switched to a typed `Channel<PtyMsg>`. Keep it that way.

### Undo/Redo model

`useGrid` keeps `past[]` / `future[]` arrays of `RoomState` snapshots (cap: 100). Every mutation pushes the previous state onto `past` and clears `future`. For compound interactions, wrap calls with `beginUndoBatch()` / `endUndoBatch()` so the whole sequence collapses to a single undo step. Agent movement is **not** undo-tracked (it's a transient runtime state, not a document edit).

### Keyboard shortcuts

Implemented in `App.tsx`:

- `Cmd/Ctrl+Z` → undo
- `Cmd/Ctrl+Shift+Z` / `Cmd/Ctrl+Y` → redo
- Live tab only: `W/A/S/D` or arrow keys → move active agent; `E` → interact (reserved for future hooks).

Inputs/textareas are skipped via the `tag === 'INPUT' || tag === 'TEXTAREA'` guard. The agent-movement handler additionally skips when xterm has focus so typing in the terminal doesn't steer the sprite. Add new shortcuts there and respect the same guards.

### React StrictMode interaction

React 19 StrictMode runs effects twice in dev (mount → cleanup → mount). `TerminalPanel` is the only place this matters today: the PTY init is fully async, so we can't guard the effect with a "did we already run?" ref — the cleanup from run #1 would leave the second run stranded. The implemented pattern:

1. Don't guard the effect. Every invocation runs.
2. Collect `term`, `closeChannel`, `ro` on a shared `state` object so cleanup can dispose whatever has actually been created so far, even mid-init.
3. Make `pty_spawn` on the Rust side **replace** an existing session with the same ID instead of erroring, so the second invocation can reuse `sessionId = agent:<id>`.

If you add more Tauri-backed effects that allocate resources, follow the same shape.

## Adding Things — Quick Recipes

### Add a new built-in asset

1. Drop the PNG into `public/tiles/` (and `assets/modern_office/` if you want it tracked alongside the source set).
2. Bump `ASSET_COUNT` in `src/data/assetManifest.ts` if you're extending the range, or update the generator if you change the pattern.
3. Add its ID to `TILE_PATTERN` with the right letter.
4. No component changes needed — the asset palette and preloader pick it up automatically.

### Add a new character sprite

1. Drop a `064.png`-style sheet into `public/characters/`, 64×128, 3 columns × 4 rows, usable frame area 20×32 per cell, last 4px on the right left blank.
2. Bump `CHAR_COUNT` in `src/utils/characterImageLoader.ts`.
3. The Add-Agent modal and sprite-swap menu will list it automatically.

### Add a new persisted setting

1. Add a key like `virtualOffice_mySetting`.
2. Wrap the load/save in a hook (see `useBlockingOverrides` for a minimal template).
3. Add the key to `KEYS` in `src/utils/projectFile.ts` so it round-trips through export/import.

### Add a new Tauri command

1. Add a `#[tauri::command] pub fn …` in the relevant module under `src-tauri/src/`.
2. Register it in `tauri::generate_handler!` inside `lib.rs::run`.
3. Add a wrapper in `src/utils/` that uses `invokeSafe` (which no-ops in the browser).
4. Call the wrapper from a hook or component.

### Add a new layer type

Not recommended; `LayerType` is a union used across dozens of files and default records (`layerVisibility`, `layerLocked`, `layerNames`). If you must, grep `'floor'` / `'wall'` / `'object'` and update every `Record<LayerType, ...>` initializer.

## Files You'll Touch Most Often

- `src/App.tsx` — wire-up & props plumbing, keyboard handling, live-mode loop
- `src/hooks/useGrid.ts` — anything placement/group/layer related
- `src/hooks/useAgents.ts` — agent list / movement API
- `src/components/GridCanvas.tsx` — rendering & pointer interactions (build + live)
- `src/components/TerminalPanel.tsx` — terminal dock + xterm/PTY wiring
- `src/components/LayersPanel.tsx` — layer/group UI
- `src/components/AssetPalette.tsx` / `AssetManager.tsx` — library UI
- `src/data/assetManifest.ts` — the static asset catalog
- `src-tauri/src/agents.rs` / `asset_library.rs` / `terminal.rs` — Rust commands

## Known Gaps / Watch-outs

- **No tests.** Any non-trivial change should at minimum be exercised manually in `npm run dev` + `npm run tauri:dev` across all three tabs, plus an export → reload → import round-trip.
- **localStorage quota.** Custom assets store data URLs; uploading many large tilesheets can blow the ~5 MB quota. `saveData` swallows the error silently — keep an eye on it.
- **HMR & image cache.** `imageLoader.ts` and `characterImageLoader.ts` intentionally stash their caches on `window` to survive HMR. Don't "clean this up" without a replacement.
- **Migration guard in `roomStorage.loadRoom`.** Only the current placement-based schema is loaded; the old `cells` schema triggers a fresh default. If you change `RoomState` shape, add another migration branch here.
- **Root resolution in dev vs release.** Both `agents.rs` and `asset_library.rs` use `CARGO_MANIFEST_DIR` at compile time for debug builds and `app_data_dir()` only in release. If you move the crate or split workspaces, update those branches.
- **No license file.** Tile artwork and character sprites are third-party; don't assume redistribution rights.
