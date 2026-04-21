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
- **Per-asset blocking override**: mark object-layer placements as walkable so agents can walk through them (chairs, rugs, etc.).

### Live mode — Agents

- **40 built-in character sprite sheets** (64×128 sheets, 20×32 frames, 4 directions × 3 animation columns).
- **Add an agent** with a nickname (editable), a fixed project folder name, a sprite, and a spawn cell.
- **WASD / arrow keys** to move the active agent a cell at a time, `E` to interact (reserved).
- **Collision** respects placed walls + blocking object tiles.
- **Damped follow-camera** that kicks in only when the room is larger than the viewport on a given axis — fully zoomed out, the camera stays still and the agent walks across the full view.
- **Nameplate** with active-agent ring for quick identification.

### Live mode — Embedded terminal (desktop only)

- **Double-click an agent** to open a terminal tab docked at the bottom of the window.
- Each agent has its own PTY session rooted at its project folder (`<projects-root>/<folderName>/`), running your login shell (`$SHELL -l -i`).
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
   - Add an agent from the side panel (nickname + project folder + sprite + spawn cell).
   - Click an agent to make it active; move with `WASD` / arrows.
   - **Double-click** an agent to open its terminal (desktop only).
   - Rename / swap sprite / remove agents from the side panel.
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
| `Double-click agent` | Open embedded terminal (desktop build) |

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
│   ├── hooks/                # useGrid, useTool, useAssetCategories, useCustomAssets, useAgents, useBlockingOverrides
│   ├── data/assetManifest.ts # Built-in asset catalog + tile-occupancy patterns
│   └── utils/                # imageLoader, characterImageLoader, agentCollision, agentFolders,
│                             # assetFiles, pty, tauri, roomStorage, projectFile
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
- **`Agent`** — `{ id, nickname, folderName, spriteId, row, col, facing, animFrame, createdAt }`. `folderName` is immutable after creation and maps to an on-disk project folder; `nickname` is free-form.

All project state lives in `localStorage`:

- `virtualOffice_room`
- `virtualOffice_library`
- `virtualOffice_tileOverrides`
- `virtualOffice_customAssets`
- `virtualOffice_agents`
- `virtualOffice_blockingOverrides`

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

## License

No license specified yet. Tile artwork under `public/tiles/` / `assets/modern_office/` and character sheets under `public/characters/` / `assets/characters/` belong to their original authors and are not redistributed under any specific license here — check the source before reusing commercially.

## Credits

- Built by [@ryansetia1](https://github.com/ryansetia1).
- Pixel-art tiles: **Modern Office** tileset (third-party, retained with original copyright).
- Character sprites: third-party pixel-art set (retained with original copyright).
