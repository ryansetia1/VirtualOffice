# Live Mode, Agents, and the Embedded Terminal

This document captures the design and hard-won lessons from the work that added:

1. Walk-around character **agents** to the Live tab.
2. A damped **follow-camera** that kicks in only when zoomed past the viewport.
3. A per-agent **embedded terminal** (xterm.js + Tauri PTY).
4. **Real filesystem** mirrors for both per-agent project folders and asset categories.

It complements `CLAUDE.md` with the *why* — the alternatives we tried, what broke, and what the invariants are today. If you're about to change any of these systems, read the relevant section first.

---

## 1. Agents

### Data model

```ts
interface Agent {
  id: string;            // 'a<n>'
  nickname: string;      // mutable, shown on nameplate
  folderName: string;    // immutable, maps 1:1 to <projects-root>/<folderName>/
  spriteId: number;      // 0..CHAR_COUNT-1
  row: number; col: number;
  facing: Facing;        // 'down'|'left'|'right'|'up'
  animFrame: 0 | 1 | 2;
  createdAt: number;
}
```

Stored in `localStorage` under `virtualOffice_agents`. Movement is **not** undo-tracked — it's runtime state, not a document edit.

### Sprites

Each character lives at `/characters/NNN.png`, a **64×128** sheet laid out 3 cols × 4 rows. Critically, **each frame is only 20×32** — the last 4 px on the right of every row is padding. If you sample the sheet as `sheet.width/3 × sheet.height/4` the pixels slide into that empty strip and frame 2 looks shifted. Use the exported `CHAR_FRAME_W = 20` and `CHAR_FRAME_H = 32` from `src/utils/characterImageLoader.ts` everywhere you draw a character.

In-world render size in `GridCanvas.tsx`:

```ts
const spriteH = cellPx * 2.025;
const spriteW = spriteH * (CHAR_FRAME_W / CHAR_FRAME_H);
```

We originally used `cellPx * 1.35` (chibi-sized) and bumped it 1.5× to `2.025` so characters read as person-sized against the tileset. The *same* multiplier has to be used for the hit-test in `hitTestAgent` or double-click becomes unpredictable.

### Collision

`src/utils/agentCollision.ts` builds a walkability grid from placements:

- **Floor layer**: never blocks.
- **Wall layer**: always blocks.
- **Object layer**: blocks **by default**; `useBlockingOverrides` lets a specific asset be tagged `'walkable'` (think: rugs, small carpets, chairs you want to pass through).

Per-asset overrides live in `virtualOffice_blockingOverrides`.

---

## 2. The follow-camera

### What we tried first

An animated camera in a `requestAnimationFrame` loop: target offset = `(w/2 − agent.x, h/2 − agent.y)`, actual offset eased toward it with `dt`-scaled exponential decay, plus a deadzone. The agent position updated in a different commit from the camera offset, so:

- Agent sprite jumped one cell instantly.
- Camera eased toward that new position over several frames.
- **Net effect: the agent visibly "slid" inside the viewport every move.**

Adding a tighter easing just made the slide shorter; it never went away because the two systems were not in the same commit.

### What we do now

`GridCanvas.tsx` keeps an `offset` state for build mode, but in `readOnly` mode it **derives** `effectiveOffset` via `useMemo`:

```ts
const effectiveOffset = useMemo(() => {
  if (!readOnly) return offset;
  if (!activeAgentId || !agents) return offset;

  const cp   = room.cellSize * zoom;
  const gridW = room.width  * cp;
  const gridH = room.height * cp;
  const fitsX = gridW + MARGIN*2 <= containerSize.w;
  const fitsY = gridH + MARGIN*2 <= containerSize.h;
  if (fitsX && fitsY) return offset;   // don't follow if zoomed out

  const a = agents.find(ag => ag.id === activeAgentId)!;
  let x = fitsX ? offset.x : containerSize.w/2 - (a.col + 0.5) * cp;
  let y = fitsY ? offset.y : containerSize.h/2 - (a.row + 0.5) * cp;
  // clamp so we never scroll past room edges
  …
  return { x, y };
}, [readOnly, activeAgentId, agents, offset, containerSize.w, containerSize.h,
    room.cellSize, room.width, room.height, zoom]);
```

Because the offset is derived during the same commit as the agent position update, they never desync. There is no `rAF` loop, no easing, and no jitter. Panning / zooming still work in build mode because `effectiveOffset === offset` there.

Hit-testing and `toGrid` both use `effectiveOffset` (not `offset`) so pointer math agrees with what's drawn.

Sub-pixel rendering is allowed in read-only mode: we do `ctx.translate(effectiveOffset.x, effectiveOffset.y)` raw (no `Math.round`) when `readOnly` is true, so sprite movement at fractional zooms looks smooth.

### Invariants

- **Camera only follows when the room doesn't fit the viewport** on that axis. Fully zoomed out → camera stays, agent walks across the visible room.
- Camera offset is clamped to room edges; there's no empty margin past the last cell.
- Any new render that depends on the offset (tooltips, marquee, drag previews) must use `effectiveOffset`, not `offset`, when `readOnly` is true.

---

## 3. The embedded terminal

### Shape

- One xterm.js instance per agent, rendered inside `TerminalPanel.tsx`.
- `sessionId = \`agent:\${agent.id}\`` identifies the PTY on the Rust side.
- PTY is spawned with the agent's project folder as `cwd`.
- Output streams back from Rust via a typed **Tauri `Channel<PtyMsg>`**.

### Message protocol

```rust
#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum PtyMsg {
    Ready,
    Data { data_b64: String },
    Exit,
}
```

- `ready` — PTY opened and reader thread is running.
- `data` — chunk of stdout, base64-encoded (so arbitrary bytes round-trip cleanly through JSON).
- `exit` — child process exited; frontend auto-closes the tab ~600 ms later.

JS side decodes base64 → `Uint8Array` and hands it directly to `term.write(bytes)`. The `onData` / `onBinary` hooks on xterm send keystrokes back via `pty_write` (which takes a base64 payload).

### Why not Tauri events

We started with `app.emit('pty:output:<id>', ...)` and `listen('pty:output:<id>', …)`. That worked for small payloads but:

1. Event names with `:` occasionally failed to bind on the JS side, and the silence was indistinguishable from "no output yet".
2. Delivery isn't backpressured — bursty `npm install` output can drop batches.
3. Cleanup is fiddly (unlisteners by session id, shared global bus).

Switching to `Channel<T>` gave us a typed, per-spawn stream with a clear onmessage/close lifecycle and no global registry.

### Why the PTY spawns a login + interactive shell

`terminal.rs::pick_shell()`:

```rust
(shell, vec!["-l".to_string(), "-i".to_string()])
```

Without `-l`, `.zprofile` / `.profile` don't run and `$PATH` is missing user tooling (`nvm`, `cargo`, `brew`, …). Without `-i`, no prompt is emitted and the shell looks frozen. Keep both flags.

On Windows we fall back to `cmd.exe` (no login/interactive flags).

### React StrictMode — the bug that ate an afternoon

React 19's StrictMode runs effects twice in dev (mount → cleanup → mount). The terminal init is fully async:

```tsx
useEffect(() => {
  (async () => {
    const term = new Terminal(...);
    // ...awaits...
    await ptySpawn(sessionId, ...);
  })();
  return () => { /* kill pty, dispose term */ };
}, []);
```

We initially guarded with `if (spawnedRef.current) return; spawnedRef.current = true;`. This exploded because:

1. Mount #1's effect kicks off, sets `spawnedRef.current = true`, starts awaiting.
2. StrictMode fires cleanup → we `ptyKill(sessionId)` (async, returns a Promise).
3. Mount #2's effect runs, sees `spawnedRef.current === true`, returns early. **No terminal.**
4. Mount #1's async finishes, sees `disposed === true`, returns early. **Also no terminal.**
5. Bonus race: if mount #2 *didn't* guard, its `ptySpawn` could hit the Rust side before mount #1's `ptyKill` drained, tripping an "already exists" error.

The fix has two parts:

- **Rust**: `pty_spawn` now *replaces* an existing session with the same id transparently (kill old, insert new). No more "already exists" error from the dev-mode race.
- **TS (`TerminalPanel.tsx`)**: no `spawnedRef` guard. Every effect invocation runs. Resources (`term`, `closeChannel`, `ro`) are stored on a shared `state` object as soon as they exist, and cleanup disposes whatever's there — so it's safe whether cleanup fires before, during, or after init.

If you add any other Tauri-backed effect that allocates a native resource, copy this shape.

### Status + error banners

`TerminalPanel` shows a small bottom-left banner with progress strings (`resolving agent folder…`, `spawning shell…`, then blank once ready) and a top-red banner for hard errors. During an earlier debugging pass we had 5 granular steps (`1/5 new Terminal()`, …) — once the race was fixed those weren't needed anymore and were collapsed, but the two banners are still useful for diagnosing folder-resolution or spawn failures.

---

## 4. Real filesystem mirrors

### Agent project folders (`src-tauri/src/agents.rs`)

- Root: `VIRTUAL_OFFICE_PROJECTS_DIR` env var → `<repo>/projects/` (debug) → `<app-data>/projects/` (release).
- `create_agent_folder(folder_name)` creates the folder; frontend calls it from "Add Agent".
- `delete_agent_folder(folder_name)` is opt-in from the Remove Agent UI.
- `list_agent_folders()` lets the Add-Agent modal warn about name collisions.
- `agent_folder_path(folder_name)` resolves the `cwd` for the terminal spawn.
- Every name passes `validate_folder_name` (same regex as the TS `isFolderNameValid`) and is canonicalized against the root so `..` can't escape.

Folder name rules: `^[a-z0-9_-]{1,64}$`, no `..`.

### Asset categories (`src-tauri/src/asset_library.rs`)

- Root: `VIRTUAL_OFFICE_ASSET_DIR` env var → `<repo>/assets/modern_office/` (debug) → `<app-data>/assets/modern_office/` (release).
- `asset_create_category(path)` / `asset_rename_category(from,to)` / `asset_delete_category(path)` manage nested category folders.
- `asset_move_file(asset_file, target_category)` does the actual `fs::rename` when the user drags an asset between categories in the Asset Manager.
- **Deleting a category does not drop its files** — it moves them back to the root first. Losing assets because someone accidentally removed a category would be devastating.
- `asset_list_files(path)` is used for reconciliation and to build the live URL resolver.

### Frontend side

`src/utils/assetFiles.ts` wraps all of the above and also exposes **`resolveAssetUrl(assetId)`** — a reactive URL resolver that reflects the current on-disk path of each built-in asset. `useAssetCategories` calls into `assetFiles` whenever a category is created/renamed/deleted or an asset is moved, *and* invalidates `resolveAssetUrl` so thumbnails + the canvas re-render with the new URL without reloading the page.

In browser-only mode (`isTauri() === false`) all of this becomes a no-op and categories live only in `localStorage` like before.

---

## 5. Change log for this session

- **Agents / live mode**
  - `useAgents` + `useBlockingOverrides` hooks.
  - `AgentsPanel`, `AddAgentModal` UI.
  - WASD / arrow movement + `E` reserved.
  - Sprite loader + 40 character sheets under `public/characters/`.
  - Fixed sprite crop from `sheet/3 × sheet/4` → `20 × 32` to match the real frame size.
  - Upscaled in-world sprite from `cellPx * 1.35` → `cellPx * 2.025` (×1.5).

- **Camera**
  - Replaced the rAF-based easing loop with a derived `effectiveOffset` (`useMemo`).
  - No follow when the room fits the viewport; clamped to edges when it doesn't.
  - Sub-pixel translation in read-only mode.

- **Terminal**
  - PTY output migrated from Tauri events to `Channel<PtyMsg>`.
  - `pty_spawn` now replaces sessions instead of erroring on duplicate id (fixes StrictMode race).
  - Removed the `spawnedRef` guard; resources collected on a shared `state` object so cleanup is safe at any init stage.
  - `xterm` + `@xterm/addon-fit` + base64 stdin/stdout.

- **Filesystem mirror**
  - `src-tauri/src/agents.rs` — per-agent project folders.
  - `src-tauri/src/asset_library.rs` — real nested category folders for the asset library.
  - `src/utils/assetFiles.ts` + `resolveAssetUrl` — dynamic asset URL resolution.
  - `useAssetCategories` refactored to mirror changes to disk when running in Tauri.

- **Persistence**
  - New `localStorage` keys: `virtualOffice_agents`, `virtualOffice_blockingOverrides`.
  - Both added to `KEYS` in `projectFile.ts` so export/import keeps round-tripping everything.

---

## 6. Gotchas to re-read before touching any of this

- **Don't sample character sheets with `sheet.w/3`.** It's 20×32 per frame, not `64/3 × 128/4`.
- **Don't change the `2.025` multiplier in just one place.** Render + hit-test both use it; they must stay identical.
- **Don't reintroduce an rAF camera loop.** The derived-offset approach is deliberate.
- **Don't go back to Tauri events for PTY output.** Channels are the stable surface.
- **Don't add a `spawnedRef` guard to `TerminalPanel`.** StrictMode will strand it.
- **Don't forget the new `localStorage` keys in `projectFile.ts::KEYS`.**
- **Don't delete category folders by `rm -rf` on the Rust side.** Move their contents back to the root first.
