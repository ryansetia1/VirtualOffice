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

## Plan B — Per-asset sort anchor (implemented 2026-04-27)

> **Status:** shipped. See [../../src/hooks/useSortAnchorOverrides.ts](../../src/hooks/useSortAnchorOverrides.ts)
> and the `getSortAnchor` prop on `GridCanvas`. UI lives in the placement
> right-click menus (both the canvas and the Layers panel) under
> "Sort anchor: this object…" / "Sort anchor: all of this type…", which
> opens [../../src/components/SortAnchorDialog.tsx](../../src/components/SortAnchorDialog.tsx).

**Original trigger:** users want finer control than three buckets but not
the full pixel-priority machinery (plan D). Especially relevant for tall
assets (lamps, pillars, mannequins, chairs with tall backrests) where the
asset's visual "foot" is not at the bottom of its bounding box.

**Shipped behaviour:** a numeric `sortAnchor`, resolved per-placement →
per-asset → fallback `spanH`. Stored in `localStorage` under
`virtualOffice_assetSortAnchor` and `virtualOffice_placementSortAnchor`,
and round-tripped through project export/import. Fractional values (e.g.
`0.5`) are accepted.

Sort key in the unified stream becomes:

```ts
const anchor = getSortAnchor?.(p) ?? p.spanH;
const natural = (p.row + anchor) * 1000;
```

Anchor semantics (relative to the bbox bottom = `spanH`):
- `anchor === spanH`  — default, no change.
- `anchor > spanH`    — asset sorts deeper (draws later, occludes more).
- `anchor < spanH`    — asset sorts shallower (draws earlier, gets
                        occluded more readily).

### When to reach for it

- A chair / desk combo keeps covering the agent one row south of the
  seat — or *doesn't* cover the agent when sitting. Anchor lets you fix
  both without changing the bbox.
- Tall back wall whose pixels extend below its bbox.
- Floor art parked on the object layer → anchor to `1` (top row) so it
  behaves like a floor decal.

### Picking a value (tribal knowledge)

The "right" anchor depends on where the asset's visual foot sits
*inside* its bbox — which we can't infer automatically, hence the
manual editor. For any asset where an agent can occupy a row inside
the bbox (chair seat, vehicle entry, etc.), the rule of thumb:

```
anchor > (seatRowOffset + 1)   → asset covers agent on the seat row
anchor < (agentFootRowOffset + 1) → agent covers asset when past the foot
```

Where the offsets are measured from the bbox top (`row` field in a
placement). At equal sortY the tiebreak favours the agent, so
`anchor === seatRowOffset + 1` is **not enough** — aim just above.

**Seamless transitions.** Naively picking a half-step (`seat + 1.5`)
works, but the layer flip when the agent walks off the seat is
abrupt. Picking a *tiny* delta above the threshold makes the flip
feel smooth because the chair's sort line almost coincides with the
seat row — the agent pops in front the instant its foot crosses the
next row, with no noticeable travel.

Concrete example (chair, `spanH = 3`, seat at bbox row 1):
- `2.0` → agent wins on seat row (chair doesn't cover). ✗
- `2.1` → chair wins on seat row by a hair; agent wins immediately on
  next row south. Feels seamless during walk-off. ✓ (user-validated)
- `2.5` → works identically on integer rows; transition is slightly
  more abrupt during sub-row animation.
- `3.0` → default (`= spanH`). Ties with a sitting agent, agent wins.
  Same as the bug this feature is meant to fix.

So the practical recipe for chair-style assets:
`anchor = seatRowOffsetFromBboxTop + 1 + 0.1`.

### Relationship to the 3-bucket render-order override

Use the render-order override (`Always behind` / `Always in front`) when
you want to **ignore** y-sort entirely for this item — e.g. an overhead
sign that must always cover everything, or a rug that must always sit
beneath everything. Use the sort anchor when you still want y-sort to
win in the normal case, but the bbox's bottom edge isn't the right
geometry to sort against.

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
