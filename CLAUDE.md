---
description: 
alwaysApply: true
---

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
| `useAgents()` | The list of live-mode agents, their position/facing/`animFrame`, `activeAgentId`, and mutation APIs (`addAgent`, `renameAgent`, `setSpriteId`, `moveAgent`, `setFacing`, `removeAgent`, `setAgentAutonomous`, `setHasPreviousConversation`, `setAgentCommands`). Persists to `virtualOffice_agents`. On load, `activeAgentId` is always forced to `null` so every launch starts with wandering agents and a free camera. |
| `useWanderLoop({ agents, room, agentsApi, collisionApi })` | Autonomous RAF-driven random walk for every agent with `autonomous === true`. Per-agent state machine (`walking` / `idle`) with momentum-biased direction changes, collision-aware moves via `agentCollision.ts`, and imperative `pauseAgent(id)` / `resumeAgent(id, graceMs?)` / `kickTakeoverTimer(id)` exports. Pauses on tab hide, on hover, on terminal open, and for 5s after any WASD input (then auto-resumes). Doesn't touch `activeAgentId`. |
| `useCollisionMasks()` | Per-asset pixel collision masks used by agent collision. Auto masks are derived from each asset's alpha channel at load (on `window.__assetMaskCache`); user paints in the Collision Editor persist to `virtualOffice_collisionMasks` and win over the auto mask. Migrates the legacy `virtualOffice_blockingOverrides` walkable flags into empty masks on first load. |

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
  id: string;                        // 'a<n>' generated sequentially
  nickname: string;                  // mutable, displayed above sprite
  folderName: string;                // NOT unique — multiple agents can share one folder
  spriteId: number;                  // 0..CHAR_COUNT-1 → /characters/NNN.png
  row: number; col: number;          // grid cell the agent is standing on
  facing: Facing;
  animFrame: 0 | 1 | 2;              // column within sprite sheet; 1 = idle
  createdAt: number;
  autonomous?: boolean;              // default true for new agents; enables wander loop
  // Auto-run commands (see "Terminal auto-run" below for the full state machine)
  startCommand?: string;             // e.g. "claude"
  continueCommand?: string;          // e.g. "--continue"
  noConversationPattern?: string;    // override default fallback regex
  busyPattern?: string;              // override default thinking-bubble regex
  errorPattern?: string;             // override default error-badge regex
  hasPreviousConversation?: boolean; // flipped by session lifecycle; drives continue vs fresh
}
```

`folderName` used to be unique per-agent but is intentionally **not** unique anymore — two agents can share one folder so you can e.g. run `claude` + a cron-style checker against the same repo. `ensure_agent_folder` is idempotent; `remove_agent` only deletes the folder on disk when no other agent references it.

### Component map (`src/components/`)

- `GridCanvas.tsx` — the central canvas, used in both `build` (interactive) and `live` (`readOnly`) modes. Handles placement hit-testing, drag/drop, marquee, bulk move/duplicate, rotate/flip, zoom. In read-only mode it also renders agents (with nameplates + active-ring + hover warm-glow), does agent hit-testing, emits `onAgentHover` so the wander loop can pause, draws the **thinking-bubble** overlay for any agent in `busyAgentIds`, draws a red **"!" error badge** for any agent in `errorAgents` plus a hover tooltip with the captured error line, and drives the derived **follow-camera**. A shared 30fps RAF ticks only while either overlay set is non-empty — zero cost when idle.
- `Toolbar.tsx` — top bar in build mode: tool/mode/layer switches, transforms, undo/redo, export/import/clear, grid resize.
- `LayersPanel.tsx` — left panel: layer management + per-layer placement/group tree (resizable).
- `AssetPalette.tsx` — right panel in build mode: categorized asset picker + active transform preview. Uses `resolveAssetUrl` from `assetFiles.ts` so thumbnails reflect the current on-disk category.
- `AssetManager.tsx` — full-page manager on the `assets` tab: categories, renames, custom-tilesheet import, per-tile overrides.
- `AssetThumbnail.tsx` — shared thumbnail renderer (canvas-based, checkerboard background).
- `TileEditor.tsx` — edit per-tile occupancy for a specific asset.
- `ImportDialog.tsx` — custom tilesheet cropper flow.
- `AgentsPanel.tsx`, `AddAgentModal.tsx` — live-mode agent list, rename, sprite-swap, remove (+ conditional folder-delete when no other agent shares the folder), "Add Agent" flow that picks a folder (**new or existing** — existing folders from the projects root are surfaced as an autocomplete) / sprite / spawn cell / optional `startCommand` / `continueCommand` / `noConversationPattern` / `busyPattern` / `errorPattern`.
- `LiveHeader.tsx` — chip strip listing agents in live mode; clicking a chip toggles activation (re-click the active agent to deselect), double-click opens its terminal.
- `TerminalPanel.tsx` — bottom dock of xterm.js terminals that opens when you double-click an agent in live mode. One tab per agent, each backed by its own PTY session. Implements the **auto-run command state machine**, **busy-signal watcher**, and **error-signal watcher** (see "Terminal auto-run" below).
- `ContextMenu.tsx`, `DragOverlay.tsx`, `ZoomNavigator.tsx` — smaller utility UI.

### Utilities (`src/utils/`)

- `imageLoader.ts` — preloads all 340 tiles on app start, caches `HTMLImageElement`s on `window.__assetImageCache` to survive HMR. `preloadAllAssets(urlResolver?)` accepts the dynamic URL resolver from `assetFiles.ts` so assets that have been moved into category subfolders still load. Use `getCachedImage(assetId)` for sync access during canvas render.
- `characterImageLoader.ts` — same pattern but for the 40 character sprite sheets under `public/characters/000.png..039.png`. Each sheet is **64×128**, laid out as 3 columns × 4 rows, but each frame is only **20×32** — the last 4 pixels on the right of every sheet are padding and **must not** be sampled. Exports `CHAR_FRAME_W=20`, `CHAR_FRAME_H=32`, `FACING_ROW`, `preloadAllCharacters`, `getCachedCharacter`.
- `agentCollision.ts` — pixel-accurate collision. Samples each agent footprint point against the effective pixel mask (override ∪ auto) for every object placement whose AABB covers that cell, honoring the placement's rotation + flip. Walls still block at cell granularity; floor never blocks.
- `pixelMasks.ts` — mask types, alpha-threshold mask generation, bit-level get/set, base64 encode/decode for localStorage, and `samplePlacementPixel()` with the rotation/flip inverse math.
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
  Exposes `get_projects_root`, `create_agent_folder`, `ensure_agent_folder` (idempotent — no-op if the folder already exists, used when spawning a second agent into the same folder), `delete_agent_folder`, `list_agent_folders`, `agent_folder_path`. Every path is validated + canonicalized against the root to prevent `..` escapes.
- `asset_library.rs` — the real-folder mirror of the asset-category tree. Root picks up `VIRTUAL_OFFICE_ASSET_DIR`, else `<repo>/assets/modern_office/` in debug, else `<app-data>/assets/modern_office/` in release. Exposes `asset_get_root`, `asset_create_category`, `asset_rename_category`, `asset_delete_category`, `asset_move_file`, `asset_list_files`. Deleting a category moves any loose files back to the root instead of dropping them.
- `terminal.rs` — PTY sessions keyed by `session_id` in a global `HashMap`. `pty_spawn(session_id, cwd, cols, rows, on_message: Channel<PtyMsg>)` opens a login+interactive shell (`$SHELL -l -i`, falling back to `zsh`/`bash`/`cmd.exe`), spawns a reader thread that streams stdout through the channel, and **replaces any existing session with the same ID** transparently. `pty_write`, `pty_resize`, `pty_kill` round out the API.

### Asset catalog (`src/data/assetManifest.ts`)

- 340 built-in tiles, each `96x144` (2×3 cells of 48×48).
- `PATTERNS` maps a letter (A–J) to a list of occupied `[col, row]` cells within that 2×3 frame.
- `TILE_PATTERN` maps each asset ID to its pattern letter.
- `getAllAssets()` and `ASSET_COUNT` are the canonical accessors.

## Live Mode (agents + terminal)

Live mode is the `live` tab rendered with `GridCanvas` in `readOnly` mode. It's also the **default tab** on app start (was `build` previously).

### Input & selection (`App.tsx`)

- **WASD / arrow keys** move the active agent one cell at a time. `E` is the "interact" key (reserved).
- **Single-click on an agent** makes it active (camera follows, WASD steers it). Clicking the same agent again, clicking empty space, pressing `Escape`, or clicking the active chip in `LiveHeader` **deselects** — no agent is active, camera unlocks, wandering resumes.
- **Double-click on an agent** opens its terminal tab (`TerminalPanel`).
- **Hover on an agent** pauses its wander loop and paints a warm glow ring under its feet; moving the cursor off resumes wandering after a short grace (~400 ms) so a pixel-imperfect boundary doesn't twitch the sprite away.
- WASD input `kickTakeoverTimer`s the hovered/active agent: the wander loop stays paused for 5 s after each keystroke, then auto-resumes if the user has gone idle.

### Autonomous wandering (`useWanderLoop`)

- Every agent with `autonomous === true` (default for new agents) walks on its own. Per-agent state machine alternates between `walking` (1–3 s) and `idle` (0.5–2 s). When a walk starts, direction is 70% "continue previous" and 30% "turn", producing readable, non-spammy paths rather than drunken jitter.
- Move attempts go through `resolveAgentMove` / `canAgentStandAt` (`agentCollision.ts`) so wanderers respect the same pixel masks as WASD-driven agents. A failed move short-circuits the walk phase into idle.
- Pause / resume is imperative (`wanderApiRef.current`). External pausers: hover, terminal-open, WASD takeover timer, tab visibility `hidden`. Toggle per-agent via the context-menu "Wander otomatis" checkbox, which calls `agentsApi.setAgentAutonomous(id, bool)`.

### Collision & rendering

- **Collision** comes from `agentCollision.ts`: agents walk on empty cells + floor tiles + transparent pixels of any object (per the asset's auto or user-painted mask). Walls always block at cell granularity; un-derived objects (image still loading) fall back to whole-cell blocking.
- **Sprites** are drawn at `spriteH = cellPx * 2.025` (1-cell footprint, but roughly 2× cell height so characters read as people-size instead of chibi). `spriteW` is derived from the 20×32 frame aspect ratio so no horizontal squish. Both render and hit-test use the same multiplier — if you change it, change both call sites in `GridCanvas.tsx`.
- **Camera follow** is computed in `GridCanvas.tsx` as a `useMemo` called `effectiveOffset`. It does **not** run in a `requestAnimationFrame` loop. Each render it re-derives the offset needed to center the active agent, but only if the room is larger than the viewport on that axis, and clamps to room edges. Because the derivation runs in the same commit as the agent position update, the two stay perfectly in sync (no jitter). When no agent is active the camera is frozen at the current offset — the user can pan/zoom freely. Build mode keeps using the raw `offset` state.

### Terminal auto-run (`TerminalPanel.tsx`)

Terminal sessions are `sessionId = \`agent:\${agent.id}\``. `TerminalPanel.tsx` boots xterm.js, calls `ptySpawn` with a fresh `Channel`, and wires xterm `onData`/`onBinary` → `ptyWriteString`/`ptyWriteBytes`. Tabs are closable; killing the PTY fires an `exit` message that auto-closes the tab after ~600 ms.

Layered on top of the raw PTY is a **three-watcher pipeline** that runs for the life of the session. All three share a single `TextDecoder` pass on each chunk (stateful `stream: true` — decoding twice would corrupt UTF-8 splits across chunks).

**1. Auto-run state machine** — sends `startCommand` / `continueCommand` once the PTY is ready.

  Phases: `booting` → `running-continue` → `falling-back` → `user-controlled`. Any keystroke during `running-continue` cancels the watcher (user took over). Kept in `phaseRef` for synchronous access from PTY handlers.

  - No `startCommand` → `user-controlled` immediately.
  - Has `startCommand`, no `continueCommand` or `hasPreviousConversation === false` → send `startCommand\r`, `user-controlled`.
  - Has both and `hasPreviousConversation === true` → send `\`${startCommand} ${continueCommand}\r\``, switch to `running-continue`, arm the no-conversation watcher (rolling 4 KB buffer tested against `compilePattern(noConversationPattern)` default regex: `'no (previous |…)conversation|no session found|…|resume.{0,30}(failed|error)'`).
  - Watcher match → `falling-back`: send Ctrl+C (byte `0x03`), wait 200 ms, re-send plain `startCommand\r`, demote to `hasPreviousConversation = false` via `onPatternFallback`.

  Optimistic promotion: 200 ms after the start command is sent, `onSessionStarted` flips `hasPreviousConversation = true`. This way a force-quit or crash between "session started" and "session ended" still leaves the agent resume-able on next launch; the watcher demotes it back if there's nothing to continue.

**2. Busy-signal watcher** — detects "tool is thinking/editing/running".

  Default regex matches Braille spinners (`[⠀-⣿]`), claude-code bullets (`✻ ✢ ⏺ ●`), and verb+ellipsis lines (`Thinking…`, `Processing…`, etc.). Stripping is done with a cheap ANSI regex (`\x1b[…` + OSC) over the combined tail (~1 KB) so escape sequences split across chunks don't leak matches.

  State: instant flip to `busy = true` on first match; stays `true` for at least `BUSY_MIN_VISIBLE_MS` (500 ms, prevents flicker on sub-step completions) and then until `BUSY_IDLE_TIMEOUT_MS` (1500 ms) elapses without a new match. Polled by a 250 ms interval (not a chained setTimeout) so we never dangle timers across chunks. Also cleared on PTY `exit` and component unmount. Emits `onBusyChange(busy)` → `App.tsx` updates `busyAgentIds: Record<string, true>` → `GridCanvas` renders the thinking bubble.

**3. Error-signal watcher** — detects API errors, rate limits, exceptions.

  Line-oriented: decoded chunks are concatenated with a tail, `\r` (not followed by `\n`) is normalized to `\n` (progress-bar redraws don't stall the tail), split on newlines, and each **complete** line is ANSI-stripped, trimmed, tested only if ≥ 8 chars. Default regex (case-insensitive): `\bAPI Error\b | \bHTTP [45]\d\d\b | [45]\d\d (error|rejected|forbidden) | error|failed|exception|rejected|refused|denied|timeout | rate|usage|quota|session limit | too many requests | unauthorized`.

  `ERROR_FIRE_COOLDOWN_MS = 5_000` throttles the callback so a tool spamming the same line doesn't churn the UI. The matched line (truncated to 120 chars) is passed to `onErrorDetected(message)` → `App.tsx` stores it in `errorAgents: Record<string, { message, at }>`. Cleared when: the user opens that agent's terminal (ack), the agent becomes busy again (tool recovered), or the stale sweeper (30 s interval, 10 min expiry) times it out.

All three watchers are per-agent configurable via the "Edit auto-run commands…" context-menu dialog and the Add-Agent modal. Leaving a pattern blank falls back to the built-in default.

## Persistence

### localStorage keys

| Key | Owner | Content |
| --- | --- | --- |
| `virtualOffice_room` | `roomStorage.ts` | Current `RoomState` (auto-saved on every change). |
| `virtualOffice_library` | `useAssetCategories` | Category tree + display-name overrides. |
| `virtualOffice_tileOverrides` | `useAssetCategories` | Per-asset/per-tile occupancy overrides. |
| `virtualOffice_customAssets` | `useCustomAssets` | User-imported tilesheets and crop definitions. |
| `virtualOffice_agents` | `useAgents` | Agents list + auto-run commands + pattern overrides + `hasPreviousConversation`. `activeAgentId` is persisted but always reset to `null` on load so every launch boots into free-camera + wandering mode. |
| `virtualOffice_collisionMasks` | `useCollisionMasks` | Per-asset pixel-mask overrides painted in the Collision Editor. |

These six keys are the exact payload of `exportProject` / `importProject`. **If you add another persisted key, you must add it to `KEYS` in `src/utils/projectFile.ts`** or export/import will silently drop it.

Legacy keys (`virtualOffice_assetOverrides`, `virtualOffice_customCategories`, `virtualOffice_categoryLabels`, `virtualOffice_initialized`) are migrated away from on first load by `useAssetCategories`. `virtualOffice_blockingOverrides` is the legacy walkable/blocking flag store; `useCollisionMasks` migrates any `walkable` entries into empty pixel masks and deletes the key on first load. The key is still listed in `projectFile.ts` so old project files import cleanly.

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
- Live tab only: `W/A/S/D` or arrow keys → move active agent (also kicks the 5s takeover timer); `E` → interact (reserved); `Escape` → deselect active agent (unlocks camera, resumes wandering).

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
2. Wrap the load/save in a hook (see `useCollisionMasks` for a template that also handles a one-shot migration).
3. Add the key to `KEYS` in `src/utils/projectFile.ts` so it round-trips through export/import.

### Add another per-agent regex pattern (busy / error / …)

1. Extend the `Agent` interface in `src/hooks/useAgents.ts` with a `foo?: string` field; add it to `normalizeAgent`, `AddAgentInput`, `AgentCommandsInput`, the `addAgent` body, and `setAgentCommands`.
2. In `src/components/TerminalPanel.tsx`:
   - Add a `DEFAULT_FOO_PATTERN` constant and a `compileFooPattern()` helper (match the pattern used by `compileBusyPattern` / `compileErrorPattern`).
   - Add refs (`fooPatternRef`, any state) next to the busy/error refs.
   - Compile the regex at `onReady` (right next to `busyPatternRef.current = …`).
   - Plug the match logic into the already-decoded chunk in `onData` (don't double-decode — reuse `decoded`).
   - Add an `onFooDetected` / `onFooChange` prop and ref-mirror it so callbacks aren't stale across renders.
3. In `src/App.tsx`: add a state bucket (e.g. `fooAgents`), wire the callback to set it, clear it wherever "acknowledge" logically happens, and pass it to `GridCanvas`.
4. In `src/components/GridCanvas.tsx`: add the prop, extend `needsAnim` / the RAF gate if the overlay animates, draw the overlay inside the per-agent loop (after the nameplate + before collision-debug overlay), and add the prop to the render effect's dep array.
5. Add input fields to `AddAgentModal.tsx` and the "Edit auto-run commands…" dialog in `App.tsx` so the user can override the default.

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
