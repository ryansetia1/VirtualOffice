import React, { useEffect, useRef, useState } from 'react';

export type DialogScope =
  | {
      kind: 'placement';
      placementId: string;
      assetId: number;
      assetName: string;
      /** bbox height in cells; also the default `anchor` value. */
      spanH: number;
      /** Resolved anchor at dialog-open time (placement → asset → spanH). */
      currentEffective: number;
      /** `true` when there's an explicit per-placement override. Drives the
       *  visibility of the "Reset to default" button. */
      hasOverride: boolean;
    }
  | {
      kind: 'asset';
      assetId: number;
      assetName: string;
      spanH: number;
      currentEffective: number;
      hasOverride: boolean;
    };

interface Props {
  scope: DialogScope;
  /**
   * Effective render-order bucket (`getOrder(placement)` for placement
   * scope, `getAssetOrder(assetId)` for asset scope). When it's anything
   * other than `'auto'`, forced render-order wins over y-sort — i.e. the
   * anchor has no visible effect. We surface that as a warning.
   */
  currentRenderOrder: 'auto' | 'above' | 'below';
  /** Clears whichever render-order scope is currently non-auto. See the
   *  caller in `App.tsx` for the exact scoping. */
  onClearRenderOrder: () => void;
  /** Commit a new anchor. `null` clears the override (placement → fall
   *  back to asset default; asset → fall back to `spanH`). */
  onSave: (anchor: number | null) => void;
  onCancel: () => void;
}

/**
 * Editor for the per-asset / per-placement y-sort anchor.
 *
 * The anchor shifts where the asset sits on the unified y-sort line:
 * `sortY = (row + anchor) * 1000`. See `useSortAnchorOverrides` for the
 * full semantics. Default (unset) is `spanH`, which sorts by the bbox's
 * bottom edge.
 *
 * The dialog intentionally does NOT ship preset buttons — the "right"
 * value depends on where the asset's visual foot lives *within* its
 * bbox, which we can't infer. We nudge users with the sentence in the
 * subtitle and let them iterate with a half-step spinner.
 */
export default function SortAnchorDialog({
  scope,
  currentRenderOrder,
  onClearRenderOrder,
  onSave,
  onCancel,
}: Props) {
  const [value, setValue] = useState<string>(() => fmt(scope.currentEffective));
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.select();
  }, []);

  const parsed = Number(value);
  const isValid = value.trim() !== '' && Number.isFinite(parsed);
  const submit = () => { if (isValid) onSave(parsed); };

  const title = scope.kind === 'placement'
    ? `Sort anchor — this object (${scope.assetName})`
    : `Sort anchor — all of ${scope.assetName}`;
  const defaultLabel = scope.kind === 'placement' ? 'asset default' : `spanH = ${scope.spanH}`;
  const hasConflict = currentRenderOrder !== 'auto';

  return (
    <div style={styles.backdrop} onClick={onCancel}>
      <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
        <h3 style={styles.title}>{title}</h3>
        <p style={styles.subtitle}>
          Shifts the asset's y-sort line. Raise the number to draw later
          (cover more); lower it to draw earlier (get covered more). Try
          half-steps like <code>spanH ± 0.5</code> first — the tiebreaker
          favours the agent at equal sortY, so half-steps are usually
          what tall assets like chairs need. Default is {defaultLabel}.
        </p>

        {hasConflict && (
          <div style={styles.warning}>
            <strong>Heads up:</strong> render order is set to{' '}
            <code>{currentRenderOrder === 'above' ? 'Always in front' : 'Always behind'}</code>.
            Forced render order always wins over y-sort, so the anchor
            has no effect until that's cleared.
            <div style={{ marginTop: 8 }}>
              <button style={styles.btnWarning} onClick={onClearRenderOrder}>
                Clear render order → Auto
              </button>
            </div>
          </div>
        )}

        <label style={styles.field}>
          Anchor (rows from bbox top)
          <input
            ref={inputRef}
            type="number"
            step={0.5}
            style={styles.input}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
              if (e.key === 'Escape') onCancel();
            }}
          />
          <span style={styles.hint}>{describeDelta(parsed, scope.spanH, isValid)}</span>
        </label>

        <div style={styles.meta}>
          <span><strong>spanH:</strong> {scope.spanH}</span>
          <span><strong>Current:</strong> {fmt(scope.currentEffective)}</span>
        </div>

        <div style={styles.actions}>
          {scope.hasOverride && (
            <button style={styles.btnSecondary} onClick={() => onSave(null)}>
              Reset to default
            </button>
          )}
          <div style={{ flex: 1 }} />
          <button style={styles.btnSecondary} onClick={onCancel}>Cancel</button>
          <button
            style={{ ...styles.btnPrimary, opacity: isValid ? 1 : 0.5, cursor: isValid ? 'pointer' : 'not-allowed' }}
            onClick={submit}
            disabled={!isValid}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

function fmt(n: number): string {
  return Number.isFinite(n) ? String(n) : '';
}

function describeDelta(parsed: number, spanH: number, isValid: boolean): string {
  if (!isValid) return 'Enter a finite number.';
  const delta = parsed - spanH;
  if (delta === 0) return 'Matches the bbox bottom — default behaviour.';
  const mag = Math.abs(delta).toFixed(2).replace(/\.?0+$/, '');
  return delta > 0
    ? `${mag} row${delta === 1 ? '' : 's'} deeper than spanH — draws later, occludes more.`
    : `${mag} row${delta === -1 ? '' : 's'} shallower than spanH — draws earlier, gets occluded more.`;
}

const styles: Record<string, React.CSSProperties> = {
  backdrop: {
    position: 'fixed', inset: 0, background: 'rgba(0, 0, 0, 0.55)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1100,
  },
  modal: {
    width: 440, background: 'var(--bg-primary)', border: '1px solid var(--border)',
    borderRadius: 8, padding: 16, boxShadow: '0 18px 48px rgba(0, 0, 0, 0.45)',
    maxHeight: '90vh', overflowY: 'auto',
  },
  title: { margin: '0 0 8px 0', fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' },
  subtitle: { margin: '0 0 14px 0', fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5 },
  warning: {
    padding: '10px 12px', marginBottom: 14,
    background: 'rgba(255, 167, 38, 0.12)',
    border: '1px solid rgba(255, 167, 38, 0.5)',
    borderRadius: 4,
    fontSize: 12, color: 'var(--text-primary)', lineHeight: 1.5,
  },
  field: {
    display: 'flex', flexDirection: 'column', gap: 4,
    fontSize: 12, fontWeight: 500, color: 'var(--text-primary)',
    marginBottom: 12,
  },
  input: {
    width: '100%', padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 4,
    background: 'var(--bg-surface)', color: 'var(--text-primary)', fontSize: 13,
    boxSizing: 'border-box',
  },
  hint: { fontSize: 11, color: 'var(--text-muted)', fontWeight: 400 },
  meta: {
    display: 'flex', gap: 16, fontSize: 11, color: 'var(--text-muted)',
    padding: '8px 10px', background: 'var(--bg-surface)',
    border: '1px solid var(--border)', borderRadius: 4,
    marginBottom: 14,
  },
  actions: { display: 'flex', gap: 8, alignItems: 'center' },
  btnSecondary: {
    padding: '6px 14px', background: 'var(--bg-surface)', color: 'var(--text-primary)',
    border: '1px solid var(--border)', borderRadius: 4, fontSize: 13, cursor: 'pointer',
  },
  btnPrimary: {
    padding: '6px 14px', background: 'var(--accent)', color: '#0d1117',
    border: '1px solid var(--accent)', borderRadius: 4, fontSize: 13, fontWeight: 600,
  },
  btnWarning: {
    padding: '5px 12px', background: 'rgba(255, 167, 38, 0.2)', color: 'var(--text-primary)',
    border: '1px solid rgba(255, 167, 38, 0.7)', borderRadius: 4, fontSize: 12,
    cursor: 'pointer', fontWeight: 500,
  },
};
