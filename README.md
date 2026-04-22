# Virtual Office

A grid-first **pixel-art office builder** that also ships as a **desktop app with live, walk-around agents** and an **embedded terminal**. Design rooms across three layers (floor / wall / object), organize your own tile library, then jump into the Live tab, walk an avatar around the room you just built, and double-click it to drop into a real shell inside that agent's project folder.

Built with **React 19 + TypeScript + Vite** on the frontend and **Rust + Tauri 2** on the desktop side. The browser build is fully offline — the Tauri build adds native filesystem access, PTY-backed terminals, and per-agent project folders.

![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-6-3178C6?logo=typescript&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-8-646CFF?logo=vite&logoColor=white)
![Tauri](https://img.shields.io/badge/Tauri-2-FFC131?logo=tauri&logoColor=black)
![xterm.js](https://img.shields.io/badge/xterm.js-6-000000?logo=gnu-bash&logoColor=white)

## Features

### Editor (browser + desktop)

- **Three-tab workspace**: `Live` (walk-around preview), `Build` (main editor), `Assets` (library manager).
- **Grid canvas** with configurable room size and `48px` cell size.
- **Three layers**: `floor`, `wall`, `object` — each with independent visibility, lock, and rename support.
- **Modes**: `select`, `draw` (brush / marquee), and `place`.
- **Tools**: paint and erase.
- **Transforms**: rotate, flip horizontally, flip vertically, reset transform.
- **Z-order controls**: bring to front, send to back, manual reorder.
- **Groups**: create, duplicate, ungroup, rename, lock, hide, collapse, reorder across layers.
- **Bulk operations**: multi-select move and duplicate placements.
- **Undo/Redo** (up to 100 steps) with `Cmd/Ctrl+Z` and `Cmd/Ctrl+Shift+Z` / `Cmd/Ctrl+Y`.
- **Zoom navigator** with minimap.

### Asset Library

- **340 built-in tiles** from a Modern Office pixel-art set (48×48).
- **Hierarchical categories** with create / rename / delete and batch asset moves. Categories are **real filesystem folders** in the Tauri build — renaming a category renames the folder on disk, and moving an asset `mv`s the PNG.
- **Custom uploads**: import your own tilesheets and crop them into new assets.
- **Per-tile overrides**: mark which tile positions within a multi-tile asset are solid/walkable.
- **Asset renaming** (single and batch) with display-name overrides.
- **Per-asset pixel collision**: each asset's alpha channel is auto-converted into a collision mask at load, so agents already walk through any transparent part of a tile with no setup. Right-click an asset (or use the grid menu on the Assets tab) → **Edit Collision** to paint the mask yourself with a brush tool when you want to carve a gap through a desk, make a chair walkable, etc.

### Live mode — Agents

- **40 built-in character sprite sheets** (64×128 sheets, 20×32 frames, 4 directions × 3 animation columns).
- **Add an agent** with a nickname (editable), a project folder (**new or existing** — multiple agents can share one folder so you can run e.g. `claude` + a cron-style checker in the same repo), a sprite, and a spawn cell. Optional per-agent **auto-run commands** and regex overrides are set here too.
- **Autonomous wandering**: new agents walk around the room on their own by default — momentum-biased random walk with idle pauses, respecting the same pixel-accurate collision as WASD movement. Toggle per-agent via "Wander otomatis" in the context menu.
- **Hover-to-pause, click-to-take-over**: hover an agent to freeze its wander (warm glow ring under its feet signals "I'm waiting for you"); single-click to activate the follow-camera; WASD steers it; the wander loop auto-resumes ~5 s after your last keystroke if you go idle. Double-click opens the embedded terminal.
- **Deselection made easy**: click empty space, re-click the active agent, re-click its chip in the Live header, or press `Escape` — the camera unlocks and every agent goes back to wandering.
- **Pixel-accurate collision**: walls still block whole cells, but object-layer placements are tested against per-asset pixel masks, so agents can slip through any transparent gap — including user-painted holes — and rotations/flips carry the mask correctly.
- **Damped follow-camera** that kicks in only when the room is larger than the viewport on a given axis and only while an agent is active. Fully zoomed out (or with no active agent), the camera is free.
- **Nameplate** with active-agent ring for quick identification.

### Live mode — Embedded terminal (desktop only)

- **Double-click an agent** to open a terminal tab docked at the bottom of the window.
- Each agent has its own PTY session rooted at its project folder (`<projects-root>/<folderName>/`), running your login shell (`$SHELL -l -i`).
- **Auto-run commands** — per-agent `startCommand` (e.g. `claude`) fires when the session boots. If a previous conversation exists, `continueCommand` (e.g. `--continue`) is appended automatically. A regex watcher detects "no previous conversation" messages and falls back to a fresh `startCommand` via `Ctrl+C` so you never get stuck at a dead resume prompt. Optimistic state tracking survives app crashes.
- **Thinking bubble on the sprite** — an animated 3-dot speech bubble appears above the agent whenever its terminal is actively producing output (spinners, "Thinking…", progress lines). 500 ms minimum-visible + 1500 ms idle timeout tuned so it reads as "working" without flickering.
- **Error / warning badge** — a red pulsing `!` badge pins to the top-right of the sprite when the terminal emits API errors, rate limits, exceptions, etc. Hover the agent to see the actual error line as a tooltip. Cleared automatically when you open the terminal (acknowledge), the agent becomes busy again (recovered), or after 10 minutes stale.
- Output streams over a typed **Tauri `Channel`**, not brittle named events.
- Tabs can be resized, closed, and re-opened; the shell stays alive across resizes.

### Project Persistence

- **Auto-save** to `localStorage` on every change.
- **Export / Import** the entire project (room, library, overrides, custom assets, agents, blocking overrides) as a single `.json` file.
- **Per-agent project folders on disk** (desktop build) — creating an agent creates the folder; removing an agent optionally removes it too.
- **Clear room** confirmation to reset placements.

## Quick Start

### Prerequisites

- Node.js 20+ (for Vite 8)
- `npm` (ships with Node)
- For the desktop app: Rust 1.77+ and the platform prerequisites from [Tauri's setup guide](https://v2.tauri.app/start/prerequisites/).

### Install

```bash
git clone https://github.com/ryansetia1/VirtualOffice.git
cd VirtualOffice
npm install
```

### Run — browser only

```bash
npm run dev
```

Open the URL Vite prints (usually `http://localhost:5173`). The Live-mode terminal and on-disk folder features are stubbed out in this mode; everything else works.

### Run — desktop app (with agents + terminal + real filesystem)

```bash
npm run tauri:dev
```

This boots the Vite dev server and opens the native Tauri window. Double-click an agent in Live mode to get a real shell.

### Build for production

```bash
npm run build          # browser bundle → dist/
npm run tauri:build    # native installer/app bundle → src-tauri/target/release/bundle/
```

### Lint

```bash
npm run lint
```

## Usage

1. **Build tab** — select an asset from the right palette, pick a layer and tool in the toolbar, then click on the grid to place/erase.
2. **Layers panel (left)** — toggle layer visibility/lock, rename layers, reorder placements, and manage groups.
3. **Assets tab** — organize your asset library: create categories, rename assets, upload custom tilesheets, and define per-tile overrides.
4. **Live tab**
   - Add an agent from the side panel (nickname, **new or existing** project folder, sprite, spawn cell, optional auto-run commands & regex patterns).
   - Agents wander around on their own by default. **Hover** to pause one; **click** to activate the follow-camera; move with `WASD` / arrows; the wander loop auto-resumes a few seconds after you stop steering.
   - Press `Escape`, click empty space, or re-click the active agent / chip to **deselect** — the camera unlocks and everyone goes back to wandering.
   - **Double-click** an agent to open its terminal (desktop only). If a `startCommand` is configured, it runs automatically. A thinking bubble over the sprite means the tool is working; a red `!` badge means it hit an error — hover to see the message.
   - Rename / swap sprite / edit auto-run commands / toggle wandering / remove agents via right-click or the side panel.
5. **Export / Import** — use the toolbar buttons to save the entire project to a `.json` file or load one. Agents and blocking overrides are included.

### Keyboard Shortcuts

| Shortcut | Action |
| --- | --- |
| `Cmd/Ctrl + Z` | Undo |
| `Cmd/Ctrl + Shift + Z` | Redo |
| `Cmd/Ctrl + Y` | Redo |
| `W / A / S / D` | Move active agent (Live tab) |
| Arrow keys | Move active agent (Live tab) |
| `E` | Interact (Live tab, reserved) |
| `Escape` | Deselect active agent, unlock camera (Live tab) |
| `Double-click agent` | Open embedded terminal (desktop build) |
| Hover agent | Pause its wandering + show warm glow ring |

Shortcuts are suppressed when an input/textarea — or the embedded xterm — has focus.

## Project Structure

```text
VirtualOffice/
├── assets/
│   ├── modern_office/        # Source tile PNGs (also copied to public/tiles/)
│   └── characters/           # Character sprite sheets
├── public/
│   ├── tiles/                # 340 built-in 48×48 tile PNGs served statically
│   ├── characters/           # 40 character sheets (000.png..039.png, 64×128)
│   ├── favicon.svg
│   └── icons.svg
├── src/
│   ├── App.tsx               # Top-level layout, tabs, state wiring, agent keyboard loop
│   ├── main.tsx              # React entry point
│   ├── index.css             # Global theme + tab styles
│   ├── components/           # GridCanvas, Toolbar, LayersPanel, TerminalPanel, AgentsPanel, etc.
│   ├── hooks/                # useGrid, useTool, useAssetCategories, useCustomAssets, useAgents, useCollisionMasks, useWanderLoop
│   ├── data/assetManifest.ts # Built-in asset catalog + tile-occupancy patterns
│   └── utils/                # imageLoader, characterImageLoader, agentCollision, pixelMasks,
│                             # agentFolders, assetFiles, pty, tauri, roomStorage, projectFile
├── src-tauri/
│   ├── src/
│   │   ├── main.rs           # Binary entry point
│   │   ├── lib.rs            # Plugin registration + command registry
│   │   ├── agents.rs         # Per-agent project folder CRUD
│   │   ├── asset_library.rs  # Real-folder mirror of asset categories
│   │   └── terminal.rs       # PTY sessions streamed back via Channel<PtyMsg>
│   ├── Cargo.toml
│   └── tauri.conf.json
├── package.json
├── vite.config.ts
└── tsconfig.json
```

## Data Model (at a glance)

- **`Placement`** — `{ id, assetId, row, col, layer, spanW, spanH, rotation, flipH, flipV, zIndex?, groupId? }`
- **`PlacementGroup`** — `{ id, name, layer, visible, locked, collapsed }`
- **`RoomState`** — grid `width`/`height`, `cellSize` (48), `placements[]`, `groups[]`, and per-layer `visibility` / `locked` / `names`.
- **`Agent`** — `{ id, nickname, folderName, spriteId, row, col, facing, animFrame, createdAt, autonomous?, startCommand?, continueCommand?, noConversationPattern?, busyPattern?, errorPattern?, hasPreviousConversation? }`. `folderName` maps to an on-disk project folder and **can be shared** by multiple agents; `nickname` is free-form. The command/pattern fields power the auto-run flow, thinking bubble, and error badge in Live mode.

All project state lives in `localStorage`:

- `virtualOffice_room`
- `virtualOffice_library`
- `virtualOffice_tileOverrides`
- `virtualOffice_customAssets`
- `virtualOffice_agents`
- `virtualOffice_collisionMasks` (legacy `virtualOffice_blockingOverrides` is still bundled for migration and dropped on first load)

These same keys are what `exportProject()` bundles into a single JSON file.

## Tech Stack

- **React 19** + **TypeScript 6**
- **Vite 8** for dev server & build
- **Tauri 2** for the native desktop build (Rust 1.77+)
- **`portable-pty`** (Rust) + **`@xterm/xterm`** + **`@xterm/addon-fit`** for the embedded terminal
- **ESLint 9** (typescript-eslint + react-hooks)

## Environment overrides (desktop build)

- `VIRTUAL_OFFICE_PROJECTS_DIR` — override where per-agent project folders live. Defaults to `<repo>/projects/` in dev or `<app-data>/projects/` in release.
- `VIRTUAL_OFFICE_ASSET_DIR` — override the asset root. Defaults to `<repo>/assets/modern_office/` in dev or `<app-data>/assets/modern_office/` in release.

## Roadmap Ideas

- Multi-user collaboration (WebRTC or a lightweight backend)
- Export to sprite-sheet / PNG snapshot
- Agent-to-agent "conversations" hooked into the `E` interact key
- Configurable agent speed / diagonal movement / pathfinding
- Richer terminal tooling (search, split panes, copy-on-select toggle)
- Smarter wander goals (seek coffee machine, group around whiteboard, nap on couch)
- More sprite overlays (speech balloons on `stdout` prompts, progress-bar rings for long runs)

## License

No license specified yet. Tile artwork under `public/tiles/` / `assets/modern_office/` and character sheets under `public/characters/` / `assets/characters/` belong to their original authors and are not redistributed under any specific license here — check the source before reusing commercially.

## Credits

- Built by [@ryansetia1](https://github.com/ryansetia1).
- Pixel-art tiles: **Modern Office** tileset (third-party, retained with original copyright).
- Character sprites: third-party pixel-art set (retained with original copyright).
