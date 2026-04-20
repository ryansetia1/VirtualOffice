# Virtual Office

A browser-based, grid-first **room/level editor** for designing pixel-art office layouts. Build rooms with floor, wall, and object layers, organize your own tile library, and export/import the whole project as a single JSON file.

Built with **React 19 + TypeScript + Vite**. No backend required — everything runs client-side and persists to `localStorage`.

![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-6-3178C6?logo=typescript&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-8-646CFF?logo=vite&logoColor=white)

## Features

### Editor
- **Three-tab workspace**: `Live` (preview), `Build` (main editor), `Assets` (library manager).
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
- **Hierarchical categories** with create/rename/delete and batch asset moves.
- **Custom uploads**: import your own tilesheets and crop them into new assets.
- **Per-tile overrides**: mark which tile positions within a multi-tile asset are solid/walkable.
- **Asset renaming** (single and batch) with display-name overrides.

### Project Persistence
- **Auto-save** to `localStorage` on every change.
- **Export/Import** the entire project (room, library, overrides, custom assets) as a single `.json` file.
- **Clear room** confirmation to reset placements.

## Quick Start

### Prerequisites
- Node.js 20+ (or whatever your environment supports Vite 8 on)
- `npm` (ships with Node)

### Install & Run
```bash
git clone https://github.com/ryansetia1/VirtualOffice.git
cd VirtualOffice
npm install
npm run dev
```

Then open the URL printed by Vite (usually `http://localhost:5173`).

### Build for Production
```bash
npm run build    # type-check + bundle into dist/
npm run preview  # serve the built bundle locally
```

### Lint
```bash
npm run lint
```

## Usage

1. **Build tab** — select an asset from the right palette, pick a layer and tool in the toolbar, then click on the grid to place/erase.
2. **Layers panel (left)** — toggle layer visibility/lock, rename layers, reorder placements, and manage groups.
3. **Assets tab** — organize your asset library: create categories, rename assets, upload custom tilesheets, and define per-tile overrides.
4. **Live tab** — read-only preview of the current room with zoom/pan only.
5. **Export / Import** — use the toolbar buttons to save the entire project to a `.json` file or load one.

### Keyboard Shortcuts
| Shortcut | Action |
| --- | --- |
| `Cmd/Ctrl + Z` | Undo |
| `Cmd/Ctrl + Shift + Z` | Redo |
| `Cmd/Ctrl + Y` | Redo |

## Project Structure

```text
VirtualOffice/
├── assets/modern_office/     # Source tile PNGs (also copied to public/tiles/)
├── public/
│   ├── tiles/                # 340 built-in 48×48 tile PNGs served statically
│   ├── favicon.svg
│   └── icons.svg
├── src/
│   ├── App.tsx               # Top-level layout, tabs, state wiring
│   ├── main.tsx              # React entry point
│   ├── index.css             # Global theme + tab styles
│   ├── components/           # UI components (GridCanvas, Toolbar, LayersPanel, etc.)
│   ├── hooks/                # useGrid, useTool, useAssetCategories, useCustomAssets
│   ├── data/assetManifest.ts # Built-in asset catalog + tile-occupancy patterns
│   └── utils/                # imageLoader, roomStorage, projectFile (import/export)
├── package.json
├── vite.config.ts
└── tsconfig.json
```

## Data Model (at a glance)

- **`Placement`** — `{ id, assetId, row, col, layer, spanW, spanH, rotation, flipH, flipV, zIndex?, groupId? }`
- **`PlacementGroup`** — `{ id, name, layer, visible, locked, collapsed }`
- **`RoomState`** — grid `width`/`height`, `cellSize` (48), `placements[]`, `groups[]`, and per-layer `visibility` / `locked` / `names`.

All project state lives in `localStorage` under these keys:
- `virtualOffice_room`
- `virtualOffice_library`
- `virtualOffice_tileOverrides`
- `virtualOffice_customAssets`

These same keys are what `exportProject()` bundles into a single JSON file.

## Tech Stack

- **React 19** + **TypeScript 6**
- **Vite 8** for dev server & build
- **ESLint 9** (typescript-eslint + react-hooks)
- Zero runtime dependencies beyond `react` / `react-dom`

## Roadmap Ideas

- Multi-user collaboration (WebRTC or a lightweight backend)
- Export to sprite-sheet / PNG snapshot
- Walkable pathfinding using the per-tile overrides
- Avatar / NPC layer for a true "virtual office" walk-around experience

## License

No license specified yet. Tile art under `public/tiles/` and `assets/modern_office/` belongs to its original authors and is not redistributed under any specific license here — check the source before reusing commercially.

## Credits

- Built by [@ryansetia1](https://github.com/ryansetia1).
- Pixel-art tiles: **Modern Office** tileset (third-party, retained with original copyright).
