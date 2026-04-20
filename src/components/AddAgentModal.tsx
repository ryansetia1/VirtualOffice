import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CHAR_COUNT, CHAR_FRAME_W, CHAR_FRAME_H, FACING_ROW, getCachedCharacter, characterSpritePath } from '../utils/characterImageLoader';
import { isFolderNameValid, listAgentFolders, createAgentFolder } from '../utils/agentFolders';
import { isTauri } from '../utils/tauri';

interface Props {
  onClose: () => void;
  onCreated: (input: { nickname: string; folderName: string; spriteId: number }) => void;
  /** Folder name pre-fill when adopting an orphan. If set, folder input is disabled. */
  adoptFolder?: string | null;
  /** Sprite IDs already used (to gray out) - optional. */
  usedSpriteIds?: number[];
  /** Existing agent folder names (from useAgents) to prevent duplicates. */
  existingFolderNames?: string[];
}

function SpriteThumb({ spriteId, isHover }: { spriteId: number; isHover: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [frame, setFrame] = useState<0 | 1 | 2>(1);

  useEffect(() => {
    if (!isHover) { setFrame(1); return; }
    const id = window.setInterval(() => {
      setFrame((f) => ((f === 0 ? 1 : f === 1 ? 2 : 1) as 0 | 1 | 2));
    }, 150);
    return () => window.clearInterval(id);
  }, [isHover]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = 48 * dpr;
    canvas.height = 64 * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, 48, 64);
    const img = getCachedCharacter(spriteId);
    if (img) {
      const srcX = frame * CHAR_FRAME_W;
      const srcY = FACING_ROW.down * CHAR_FRAME_H;
      ctx.drawImage(img, srcX, srcY, CHAR_FRAME_W, CHAR_FRAME_H, 4, 0, 40, 64);
    } else {
      const im = new Image();
      im.src = characterSpritePath(spriteId);
      im.onload = () => {
        ctx.drawImage(im, frame * CHAR_FRAME_W, FACING_ROW.down * CHAR_FRAME_H, CHAR_FRAME_W, CHAR_FRAME_H, 4, 0, 40, 64);
      };
    }
  }, [spriteId, frame]);

  return <canvas ref={canvasRef} style={{ width: 48, height: 64, imageRendering: 'pixelated' as const, display: 'block' }} />;
}

export default function AddAgentModal({ onClose, onCreated, adoptFolder, usedSpriteIds, existingFolderNames }: Props) {
  const [nickname, setNickname] = useState('');
  const [folderName, setFolderName] = useState(adoptFolder ?? '');
  const [spriteId, setSpriteId] = useState<number>(0);
  const [hoverSprite, setHoverSprite] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [existingFolders, setExistingFolders] = useState<string[]>([]);

  useEffect(() => {
    if (!isTauri()) return;
    listAgentFolders().then(setExistingFolders).catch(() => setExistingFolders([]));
  }, []);

  const usedSet = useMemo(() => new Set(usedSpriteIds ?? []), [usedSpriteIds]);
  const agentFolderSet = useMemo(
    () => new Set((existingFolderNames ?? []).map((f) => f.toLowerCase())),
    [existingFolderNames]
  );

  const folderNameError = useMemo(() => {
    if (adoptFolder) return null;
    if (!folderName) return null;
    const structural = isFolderNameValid(folderName);
    if (structural) return structural;
    const lower = folderName.toLowerCase();
    if (agentFolderSet.has(lower)) return 'An agent with this folder already exists.';
    if (existingFolders.some((f) => f.toLowerCase() === lower)) return 'Folder already exists on disk.';
    return null;
  }, [folderName, existingFolders, agentFolderSet, adoptFolder]);

  const canSubmit =
    nickname.trim().length > 0 &&
    nickname.trim().length <= 20 &&
    (adoptFolder ? true : (folderName.length > 0 && folderNameError === null)) &&
    !submitting;

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setErrorMsg(null);
    try {
      if (!adoptFolder) {
        if (!isTauri()) {
          setErrorMsg('Creating agent folders requires the desktop app (run via "npm run tauri:dev").');
          setSubmitting(false);
          return;
        }
        await createAgentFolder(folderName);
      }
      onCreated({
        nickname: nickname.trim(),
        folderName: adoptFolder ?? folderName,
        spriteId,
      });
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }, [canSubmit, adoptFolder, folderName, nickname, spriteId, onCreated]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div style={styles.backdrop} onClick={onClose}>
      <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div style={styles.header}>
          <h2 style={styles.title}>{adoptFolder ? `Adopt "${adoptFolder}"` : 'Add Agent'}</h2>
          <button style={styles.closeBtn} onClick={onClose}>×</button>
        </div>

        <div style={styles.body}>
          <label style={styles.fieldLabel}>
            Nickname
            <input
              autoFocus
              style={styles.input}
              placeholder="e.g. researcher"
              value={nickname}
              maxLength={20}
              onChange={(e) => setNickname(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canSubmit) handleSubmit();
              }}
            />
            <span style={styles.hint}>Max 20 characters. Editable later.</span>
          </label>

          <label style={styles.fieldLabel}>
            Folder name
            <input
              style={{ ...styles.input, ...(folderNameError ? styles.inputError : {}) }}
              placeholder="e.g. my-agent"
              value={folderName}
              disabled={!!adoptFolder}
              onChange={(e) => setFolderName(e.target.value.toLowerCase())}
            />
            <span style={styles.hint}>
              {adoptFolder
                ? 'Adopting an orphaned folder - cannot change.'
                : folderNameError
                ? folderNameError
                : 'a-z, 0-9, "-", "_". Created once, cannot be renamed later.'}
            </span>
          </label>

          <div style={styles.fieldLabel}>
            <span>Sprite</span>
            <div style={styles.spriteGrid}>
              {Array.from({ length: CHAR_COUNT }, (_, i) => i).map((id) => {
                const isSelected = spriteId === id;
                const isUsed = usedSet.has(id);
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setSpriteId(id)}
                    onMouseEnter={() => setHoverSprite(id)}
                    onMouseLeave={() => setHoverSprite((h) => (h === id ? null : h))}
                    style={{
                      ...styles.spriteTile,
                      ...(isSelected ? styles.spriteTileSelected : {}),
                      ...(isUsed && !isSelected ? styles.spriteTileUsed : {}),
                    }}
                    title={isUsed ? `Sprite ${id} (already used)` : `Sprite ${id}`}
                  >
                    <SpriteThumb spriteId={id} isHover={hoverSprite === id || isSelected} />
                  </button>
                );
              })}
            </div>
          </div>

          {errorMsg && <div style={styles.error}>{errorMsg}</div>}
        </div>

        <div style={styles.footer}>
          <button style={styles.cancelBtn} onClick={onClose}>Cancel</button>
          <button
            style={{ ...styles.submitBtn, ...(canSubmit ? {} : styles.submitBtnDisabled) }}
            disabled={!canSubmit}
            onClick={handleSubmit}
          >
            {submitting ? 'Creating…' : adoptFolder ? 'Adopt' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  backdrop: {
    position: 'fixed', inset: 0, background: 'rgba(0, 0, 0, 0.55)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
  },
  modal: {
    width: 520, maxHeight: '85vh', display: 'flex', flexDirection: 'column',
    background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: 8,
    boxShadow: '0 18px 48px rgba(0, 0, 0, 0.45)', overflow: 'hidden',
  },
  header: {
    padding: '12px 16px', borderBottom: '1px solid var(--border)',
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    background: 'var(--bg-secondary)',
  },
  title: { fontSize: 15, fontWeight: 600, margin: 0, color: 'var(--text-primary)' },
  closeBtn: {
    background: 'transparent', border: 'none', color: 'var(--text-muted)',
    fontSize: 22, lineHeight: 1, cursor: 'pointer', padding: 0, width: 28, height: 28,
  },
  body: { flex: 1, overflow: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 14 },
  fieldLabel: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, fontWeight: 500, color: 'var(--text-primary)' },
  input: {
    padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 4,
    background: 'var(--bg-surface)', color: 'var(--text-primary)', fontSize: 13,
  },
  inputError: { borderColor: '#ef5350' },
  hint: { fontSize: 11, color: 'var(--text-muted)', fontWeight: 400 },
  spriteGrid: {
    display: 'grid', gridTemplateColumns: 'repeat(8, 1fr)', gap: 4,
    padding: 8, background: 'var(--bg-surface)', borderRadius: 4,
    maxHeight: 280, overflowY: 'auto',
  },
  spriteTile: {
    aspectRatio: '3 / 4', padding: 4, display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'var(--bg-primary)', border: '1px solid transparent', borderRadius: 4, cursor: 'pointer',
  },
  spriteTileSelected: { borderColor: 'var(--accent)', background: 'var(--accent-dim)' },
  spriteTileUsed: { opacity: 0.35 },
  error: {
    padding: '8px 12px', background: 'rgba(239, 83, 80, 0.12)', border: '1px solid rgba(239, 83, 80, 0.4)',
    borderRadius: 4, color: '#ef5350', fontSize: 12,
  },
  footer: {
    padding: '10px 16px', borderTop: '1px solid var(--border)',
    display: 'flex', justifyContent: 'flex-end', gap: 8, background: 'var(--bg-secondary)',
  },
  cancelBtn: {
    padding: '6px 14px', background: 'var(--bg-surface)', color: 'var(--text-primary)',
    border: '1px solid var(--border)', borderRadius: 4, fontSize: 13, cursor: 'pointer',
  },
  submitBtn: {
    padding: '6px 14px', background: 'var(--accent)', color: '#0d1117',
    border: '1px solid var(--accent)', borderRadius: 4, fontSize: 13, fontWeight: 600, cursor: 'pointer',
  },
  submitBtnDisabled: { opacity: 0.5, cursor: 'not-allowed' },
};
