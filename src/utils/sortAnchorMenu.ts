import type { SortAnchorApi } from '../hooks/useSortAnchorOverrides';

/** Minimal fields we need off a placement to build the menu. Declared as
 *  a generic constraint so callers can pass either the full `Placement`
 *  from `useGrid` or a structural subset (e.g. from the Layers panel,
 *  which only holds a lookup stub). The exact type flows through to
 *  `openDialog`, keeping callers type-safe. */
interface PlacementLike {
  id: string;
  assetId: number;
  spanH: number;
}

interface MenuItem {
  label: string;
  onClick: () => void;
}

/**
 * Builds the three sort-anchor menu entries shared between the workspace
 * right-click menu (`App.tsx`) and the Layers panel context menu
 * (`LayersPanel.tsx`). Keeping the labels + handler composition in one
 * place stops the two menus from drifting out of sync.
 *
 * Entries:
 *   1. "Sort anchor: this object… (current X · unset?)" — opens the
 *      placement-scope dialog. The "unset" suffix makes it obvious when
 *      the displayed value is the inherited asset / spanH fallback
 *      rather than an explicit override on the placement.
 *   2. "Sort anchor: all of this type… (default Y · unset, = spanH?)"
 *      — opens the asset-scope dialog. Annotated similarly.
 *   3. "Reset sort anchor to type default" — only shown when the
 *      placement has an explicit override.
 */
export function buildSortAnchorMenuItems<P extends PlacementLike>(
  placement: P,
  api: Pick<SortAnchorApi,
    | 'getAnchor'
    | 'getAssetAnchor'
    | 'hasPlacementOverride'
    | 'clearPlacementOverride'
  >,
  openDialog: (p: P, scope: 'placement' | 'asset') => void,
): MenuItem[] {
  const effAnchor = api.getAnchor(placement, placement.spanH);
  const assetAnchor = api.getAssetAnchor(placement.assetId);
  const hasOverride = api.hasPlacementOverride(placement.id);

  const placementLabel = hasOverride ? `${effAnchor}` : `${effAnchor} · unset`;
  const assetLabel = assetAnchor === null
    ? `${placement.spanH} · unset, = spanH`
    : `${assetAnchor}`;

  const items: MenuItem[] = [
    {
      label: `Sort anchor: this object… (current ${placementLabel})`,
      onClick: () => openDialog(placement, 'placement'),
    },
    {
      label: `Sort anchor: all of this type… (default ${assetLabel})`,
      onClick: () => openDialog(placement, 'asset'),
    },
  ];
  if (hasOverride) {
    items.push({
      label: 'Reset sort anchor to type default',
      onClick: () => api.clearPlacementOverride(placement.id),
    });
  }
  return items;
}
