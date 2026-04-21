# Render-Order Backup Plans

> **Status:** not implemented. Park here until pain justifies the work.
>
> **Last updated:** 2026-04-21.
>
> **Scope:** alternatives to extend / replace the current y-sort + 3-bucket
> render-order system, recorded so we don't re-discover the trade-offs from
> scratch next time we hit a pain point.

---

## Current system (what we already have)

**Stream composition** — `src/components/GridCanvas.tsx`
1. Floor layer: pure painter's-algorithm pre-pass (always at the bottom).
2. Walls + objects + agents: single y-sorted stream.
   - Primary sort key: `(row + spanH) * 1000` (natural bottom edge).
   - `zIndex` is *not* used as a cross-y sort key — it only influences the
     initial iteration order that becomes `stableIdx`, which breaks ties for
     same-y items. Explicit stacking via `Bring to front` / `Send to back`
     therefore cannot drag a placement across rows.
3. Three buckets layered on top of the y-sort:
   - `0 = 'Always behind'` — drawn first.
   - `1 = 'Auto'` — the default y-sorted pool.
   - `2 = 'Always in front'` — drawn last.
   - Within each bucket, items still y-sort among themselves.

**Overrides** — `src/hooks/useRenderOrderOverrides.ts`
- Per-placement override wins over per-asset default wins over `'auto'`.
- Persisted to `localStorage` (`virtualOffice_assetRenderOrder`,
  `virtualOffice_placementRenderOrder`).
- Legacy boolean "aboveAgent" keys are migrated on first load.

**Escape hatch for the user:** right-click a placement → "Always behind" or
"Always in front" on either scope (this object / all of this type).

---

## Known limitations

### L1 — "Janky" sort-flip when an agent walks through a walkable object
When an agent has `collision = walkable` beneath a placement whose bounding
box spans multiple rows (e.g. a luggage `2×2`), the agent's y-sort flips
abruptly at the row boundary inside the placement's footprint. Screenshot
comparison: luggage covers the agent at row N, then the agent covers the
luggage at row N+1. Visually this reads as a "pop".

**Current workaround:** mark the asset (or the specific placement) as
`'Always behind'`. This removes the flip by pinning the asset to bucket 0.

### L2 — Chained manual overrides ("drag the back wall into bucket 0 too")
Because buckets are flat, once a decorative "walkable" asset is moved to
bucket 0, any wall that's visually behind that decoration also needs to be
moved to bucket 0 — otherwise the wall (still in bucket 1) will draw on top
of the decoration. The user has to remember to pair them up like a Photoshop
layer group.

### L3 — No per-pixel depth
Assets with mixed solid + walkable parts (tree trunk + leaves, pillar base
+ capital, countertop + legs, etc.) can't be handled purely by y-sort or
the 3-bucket system. The whole placement is one sort unit.

### L4 — `zIndex` no longer reorders across rows
Side-effect of the fix for the top-wall regression (2026-04-21). Layers
Panel drag-reorder and `bringToFront`/`sendToBack` only reshuffle same-row
items now. If a user relied on these to pin a wall in front of a desk in a
different row, they have to use the `RenderOrder` override instead.

---

## Backup plan A — Auto-derive `RenderOrder` from collision mask

**Trigger:** users complain that they have to manually mark every walkable
decoration as `'Always behind'`, or creators producing new walkable assets
forget to toggle it and end up with the L1 pop.

**Idea:** fall back to a collision-driven default before landing on `'auto'`:

```ts
effective order = placement override
              || asset override
              || auto-from-mask(assetId)
              || 'auto'
```

Where `auto-from-mask`:
- If opaque-pixel ratio of the effective mask < ~15% → `'below'`.
- Otherwise → `'auto'`.

**Where it lives**
- Add a `getOrderFromMask(assetId): RenderOrder | null` helper in
  `useCollisionMasks.ts` (it already has the decoded mask cache).
- Wire it as a fallback inside `useRenderOrderOverrides.getOrder(...)`.
- Cache the derived value per assetId so we don't re-scan every mask on
  every render.

**Pros**
- Zero-friction default for walkable decorations.
- Semantically clean: "walkable" and "behind the agent" are already tied
  in the user's mental model.
- User can still override per-asset / per-placement.

**Cons**
- Doesn't solve L2 automatically: a wall behind a walkable decoration still
  needs a manual bump to bucket 0, because walls have solid masks and the
  heuristic correctly leaves them in `auto`.
- Heuristic can misclassify hybrid assets (mostly-walkable tree with a
  solid trunk footprint might flip to `'below'` and then hide behind a
  floor rug). Mitigation: let the user override via the existing menu.

**Estimated effort:** small — ~20–40 lines, mostly in `useCollisionMasks.ts`
and `useRenderOrderOverrides.ts`.

---

## Backup plan B — Per-asset sort anchor

**Trigger:** users want finer control than three buckets but not the full
pixel-priority machinery (plan D). Especially relevant for tall assets
(lamps, pillars, mannequins) where the asset's visual "foot" is not at the
bottom of its bounding box.

**Idea:** add an optional `sortAnchor` to assets and/or placements.

```ts
// Offset from the top row of the placement's bbox, in cells.
// Default = spanH   (current behavior: foot at bbox bottom).
// spanH - 1 = bottom row anchor, 0 = top row anchor.
sortAnchor?: number;
```

Sort key becomes `(row + sortAnchor) * 1000` instead of
`(row + spanH) * 1000`.

**Pros**
- Covers the luggage case without any bucket override — anchor at the top
  of the bbox means any agent whose foot is at or below that row draws in
  front.
- Covers "tall back wall" cases too: shove the anchor up so the wall
  effectively sorts at its top row.
- Fractional anchors (e.g. `0.5`) are trivial and give sub-row control.

**Cons**
- More UI — a numeric field in the Collision Editor or Asset Manager.
- User has to understand what the anchor means.
- Doesn't handle hybrid per-pixel cases (L3).

**Where it lives**
- Data: add to `Placement` (`useGrid.ts`) and to a new per-asset map (
  parallel to `useRenderOrderOverrides`).
- Resolution helper next to `getRenderOrder`.
- UI surface: Collision Editor or a small panel in Asset Manager.

**Estimated effort:** medium — ~100–200 lines including UI.

---

## Backup plan C — Nested / layered buckets

**Trigger:** pain point L2 becomes the dominant complaint. Users want "a
back-world group that sorts behind a front-world group, and within each
group the normal y-sort still applies".

**Idea:** replace the flat 3-bucket system with an ordered list of
user-definable *depth groups*. Each placement is assigned to a group;
groups are ordered; within a group, y-sort applies.

Defaults:
- `depth-back` (back walls, floor-ish decor on object layer).
- `depth-main` (normal objects, walls, agents).
- `depth-front` (overhead signage, hanging lamps).

Users can add groups between those if they want finer layering.

**Pros**
- Scales past 3 levels cleanly (and the existing 3 are just the default
  configuration).
- L2 mostly dissolves because you only drag a whole group "behind"; the
  wall and luggage share a group and y-sort within it.

**Cons**
- New concept in the UI.
- Needs group-management UI (create / rename / reorder / delete).
- Most users will never need more than the 3 defaults, so the payoff is
  limited unless the codebase scales to many more decorative primitives.

**Estimated effort:** large — easily 300–500 lines including UI.

---

## Backup plan D — Per-pixel (per-tile) priority

**Trigger:** pain point L3 becomes dominant — users want a tree whose
leaves always render above agents but whose trunk y-sorts normally.

**Idea:** RPG Maker-style. Per tile within an asset's bounding box, mark
one of `'below'` / `'normal'` / `'above'`. At render time, split the
placement into passes:
- The `'below'` pass draws before the agent stream item.
- The `'normal'` pass y-sorts against agents as today.
- The `'above'` pass draws after the agent stream item.

**Pros**
- Fully resolves L3.
- Most faithful to how experienced 2D RPGs solve occlusion.

**Cons**
- Significant authoring cost: every asset's tiles need priority flags.
- Rendering needs to draw each placement in up to three passes, which
  complicates the y-sort stream (each placement contributes up to 3
  stream items, each tagged with a different sub-set of its tiles).
- Collision mask editor already exists per tile — pixel priority would
  likely live next to it, doubling the per-tile editing surface.

**Where it lives**
- New per-asset map keyed by `assetId` → `tilePriority[tileIdx]`.
- New field in `TileEditor.tsx` UI.
- `drawAsset` needs a variant that skips tiles not in the current pass,
  or a `drawAssetPartial(asset, tileFilter)`.

**Estimated effort:** very large — design + data + UI + renderer changes.
Don't attempt until L3 is unambiguously blocking multiple users.

---

## Decision triggers (when to revisit)

| Trigger                                                       | Plan to reach for |
|---------------------------------------------------------------|-------------------|
| Multiple users set "Always behind" on walkable decor          | A                 |
| Tall / oddly-anchored assets keep needing manual override     | B                 |
| Chained-bucket workflow (L2) becomes the dominant complaint   | C                 |
| Visible demand for per-tile priority (leaves + trunk, etc.)   | D                 |

Plans A and B compose: A can cover the common case automatically, B can
stay as a manual knob for the remaining oddities. Plans C and D each
subsume parts of A/B but come with much more weight.

---

## Related code

- `src/components/GridCanvas.tsx` — stream composition & sort.
- `src/hooks/useRenderOrderOverrides.ts` — bucket overrides + persistence.
- `src/hooks/useCollisionMasks.ts` — effective mask resolution (source of
  truth for plan A's heuristic).
- `src/utils/agentCollision.ts` — pixel collision tests (uses the same
  masks plan A would read).
- Context menus (labels: "Auto (depth-sorted)" / "Always in front" /
  "Always behind"):
  - `src/App.tsx` — workspace right-click menu.
  - `src/components/LayersPanel.tsx` — layers-panel right-click menu.
