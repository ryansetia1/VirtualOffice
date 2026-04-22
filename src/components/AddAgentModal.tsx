import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CHAR_COUNT, CHAR_FRAME_W, CHAR_FRAME_H, FACING_ROW, getCachedCharacter, characterSpritePath } from '../utils/characterImageLoader';
import { isFolderNameValid, listAgentFolders, ensureAgentFolder } from '../utils/agentFolders';
import { isTauri } from '../utils/tauri';

export interface ExistingAgentSummary {
  nickname: string;
  folderName: string;
}

interface Props {
  onClose: () => void;
  onCreated: (input: {
    nickname: string;
    folderName: string;
    spriteId: number;
    startCommand?: string;
    continueCommand?: string;
    noConversationPattern?: string;
    busyPattern?: string;
    errorPattern?: string;
  }) => void;
  /** Folder name pre-fill when adopting an orphan. If set, folder input is disabled. */
  adoptFolder?: string | null;
  /** Sprite IDs already used (to gray out) - optional. */
  usedSpriteIds?: number[];
  /**
   * Existing agents. Used to detect when the user is about to share a folder
   * with another agent so we can surface an info message (not a hard error).
   */
  existingAgents?: ExistingAgentSummary[];
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

export default function AddAgentModal({ onClose, onCreated, adoptFolder, usedSpriteIds, existingAgents }: Props) {
  const [nickname, setNickname] = useState('');
  const [folderName, setFolderName] = useState(adoptFolder ?? '');
  const [spriteId, setSpriteId] = useState<number>(0);
  const [hoverSprite, setHoverSprite] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [existingFolders, setExistingFolders] = useState<string[]>([]);
  // Auto-run command config. Collapsible to keep the modal compact for users
  // who don't need it.
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [startCommand, setStartCommand] = useState('');
  const [continueCommand, setContinueCommand] = useState('');
  const [noConversationPattern, setNoConversationPattern] = useState('');
  const [busyPattern, setBusyPattern] = useState('');
  const [errorPattern, setErrorPattern] = useState('');

  useEffect(() => {
    if (!isTauri()) return;
    listAgentFolders().then(setExistingFolders).catch(() => setExistingFolders([]));
  }, []);

  const usedSet = useMemo(() => new Set(usedSpriteIds ?? []), [usedSpriteIds]);
  const agentFolderMap = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const a of existingAgents ?? []) {
      const k = a.folderName.toLowerCase();
      const arr = m.get(k) ?? [];
      arr.push(a.nickname);
      m.set(k, arr);
    }
    return m;
  }, [existingAgents]);

  // Derived state for the folder-name field.
  //
  // We now distinguish four cases:
  //   - structural error  → hard block submit
  //   - fresh new folder  → ensureAgentFolder will create it
  //   - orphan on disk    → ensureAgentFolder is a no-op; first-owner semantics
  //   - shared with other agent(s) → allowed, surface sharing info to the user
  //
  // Only structural errors are fatal; duplicate-folder is now an informational
  // state, not a block, which enables "spawn N agents in the same directory".
  const folderStatus = useMemo(() => {
    if (adoptFolder) return { kind: 'adopt' as const };
    if (!folderName) return { kind: 'empty' as const };
    const structural = isFolderNameValid(folderName);
    if (structural) return { kind: 'error' as const, message: structural };
    const lower = folderName.toLowerCase();
    const sharingWith = agentFolderMap.get(lower);
    if (sharingWith && sharingWith.length > 0) {
      return { kind: 'sharing' as const, nicknames: sharingWith };
    }
    if (existingFolders.some((f) => f.toLowerCase() === lower)) {
      return { kind: 'orphan' as const };
    }
    return { kind: 'new' as const };
  }, [folderName, existingFolders, agentFolderMap, adoptFolder]);

  const folderNameError = folderStatus.kind === 'error' ? folderStatus.message : null;

  // Combined list of folders the user might want to reuse: everything on disk
  // plus any agent folder (covers cases where agents exist in storage but the
  // disk listing hasn't resolved yet, e.g. browser build). Each entry carries
  // metadata so the picker can show "used by X, Y" or "empty folder".
  const folderOptions = useMemo(() => {
    const names = new Set<string>();
    for (const f of existingFolders) names.add(f);
    for (const a of existingAgents ?? []) names.add(a.folderName);
    return Array.from(names)
      .sort((a, b) => a.localeCompare(b))
      .map((name) => {
        const nicknames = agentFolderMap.get(name.toLowerCase()) ?? [];
        return { name, nicknames };
      });
  }, [existingFolders, existingAgents, agentFolderMap]);

  const canSubmit =
    nickname.trim().length > 0 &&
    nickname.trim().length <= 20 &&
    (adoptFolder ? true : (folderName.length > 0 && folderStatus.kind !== 'error')) &&
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
        // Idempotent: creates the folder on first agent, reuses it thereafter.
        await ensureAgentFolder(folderName);
      }
      onCreated({
        nickname: nickname.trim(),
        folderName: adoptFolder ?? folderName,
        spriteId,
        startCommand: startCommand.trim() || undefined,
        continueCommand: continueCommand.trim() || undefined,
        noConversationPattern: noConversationPattern.trim() || undefined,
        busyPattern: busyPattern.trim() || undefined,
        errorPattern: errorPattern.trim() || undefined,
      });
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }, [canSubmit, adoptFolder, folderName, nickname, spriteId, startCommand, continueCommand, noConversationPattern, busyPattern, errorPattern, onCreated]);

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
              style={{
                ...styles.input,
                ...(folderNameError ? styles.inputError : {}),
                ...(folderStatus.kind === 'sharing' ? styles.inputInfo : {}),
              }}
              placeholder="e.g. my-agent"
              value={folderName}
              disabled={!!adoptFolder}
              onChange={(e) => setFolderName(e.target.value.toLowerCase())}
            />
            <span style={{
              ...styles.hint,
              ...(folderStatus.kind === 'sharing' ? styles.hintInfo : {}),
            }}>
              {adoptFolder
                ? 'Adopting an orphaned folder - cannot change.'
                : folderStatus.kind === 'error'
                ? folderStatus.message
                : folderStatus.kind === 'sharing'
                ? `Shared with: ${folderStatus.nicknames.join(', ')}. Both agents will run in the same directory.`
                : folderStatus.kind === 'orphan'
                ? 'Folder already exists on disk — this agent will adopt it.'
                : 'a-z, 0-9, "-", "_". Created once, cannot be renamed later.'}
            </span>
            {/* Existing-folder picker: lets the user spawn the new agent into
                a folder that's already in use (shared) or sitting on disk as
                an orphan, without having to retype the name. */}
            {!adoptFolder && folderOptions.length > 0 && (
              <div style={styles.folderPicker}>
                <span style={styles.folderPickerLabel}>Or reuse an existing folder:</span>
                <div style={styles.folderChipRow}>
                  {folderOptions.map((opt) => {
                    const isSelected = folderName.toLowerCase() === opt.name.toLowerCase();
                    const isShared = opt.nicknames.length > 0;
                    return (
                      <button
                        key={opt.name}
                        type="button"
                        style={{
                          ...styles.folderChip,
                          ...(isShared ? styles.folderChipShared : styles.folderChipOrphan),
                          ...(isSelected ? styles.folderChipSelected : {}),
                        }}
                        title={
                          isShared
                            ? `Used by: ${opt.nicknames.join(', ')}`
                            : 'Empty folder on disk — will be adopted.'
                        }
                        onClick={() => setFolderName(opt.name.toLowerCase())}
                      >
                        <span style={styles.folderChipName}>{opt.name}</span>
                        <span style={styles.folderChipMeta}>
                          {isShared ? `${opt.nicknames.length} agent${opt.nicknames.length === 1 ? '' : 's'}` : 'orphan'}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
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

          {/* Advanced: auto-run commands. Collapsed by default so the modal
              stays simple for users who don't need it. */}
          <div style={styles.advancedSection}>
            <button
              type="button"
              style={styles.advancedToggle}
              onClick={() => setAdvancedOpen((v) => !v)}
            >
              <span>{advancedOpen ? '▾' : '▸'} Auto-run commands (optional)</span>
            </button>
            {advancedOpen && (
              <div style={styles.advancedBody}>
                <label style={styles.fieldLabel}>
                  Start command
                  <input
                    style={styles.input}
                    placeholder='e.g. claude'
                    value={startCommand}
                    onChange={(e) => setStartCommand(e.target.value)}
                  />
                  <span style={styles.hint}>
                    Runs automatically in the terminal on first open.
                  </span>
                </label>
                <label style={styles.fieldLabel}>
                  Continue command
                  <input
                    style={styles.input}
                    placeholder='e.g. --continue'
                    value={continueCommand}
                    onChange={(e) => setContinueCommand(e.target.value)}
                  />
                  <span style={styles.hint}>
                    Appended to the start command when a previous conversation exists.
                  </span>
                </label>
                <label style={styles.fieldLabel}>
                  No-conversation pattern (regex)
                  <input
                    style={styles.input}
                    placeholder='leave blank to use the default'
                    value={noConversationPattern}
                    onChange={(e) => setNoConversationPattern(e.target.value)}
                  />
                  <span style={styles.hint}>
                    If this pattern appears in the terminal after the continue command,
                    the agent falls back to the plain start command.
                  </span>
                </label>
                <label style={styles.fieldLabel}>
                  Busy pattern (regex)
                  <input
                    style={styles.input}
                    placeholder='leave blank to use the default'
                    value={busyPattern}
                    onChange={(e) => setBusyPattern(e.target.value)}
                  />
                  <span style={styles.hint}>
                    When this pattern appears in the terminal, a thinking bubble
                    is shown over the agent sprite. Default matches spinners and
                    common "Thinking…" lines.
                  </span>
                </label>
                <label style={styles.fieldLabel}>
                  Error pattern (regex)
                  <input
                    style={styles.input}
                    placeholder='leave blank to use the default'
                    value={errorPattern}
                    onChange={(e) => setErrorPattern(e.target.value)}
                  />
                  <span style={styles.hint}>
                    When this pattern matches a terminal line, a red "!" badge
                    appears on the sprite. Hover the agent to see the matched line.
                  </span>
                </label>
              </div>
            )}
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
  inputInfo: { borderColor: '#4fc3f7' },
  hint: { fontSize: 11, color: 'var(--text-muted)', fontWeight: 400 },
  hintInfo: { color: '#4fc3f7' },
  folderPicker: {
    marginTop: 6,
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  folderPickerLabel: {
    fontSize: 11,
    color: 'var(--text-muted)',
    fontWeight: 400,
  },
  folderChipRow: {
    display: 'flex',
    flexWrap: 'wrap' as const,
    gap: 4,
    maxHeight: 96,
    overflowY: 'auto' as const,
    padding: 2,
  },
  folderChip: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '4px 8px',
    background: 'var(--bg-surface)',
    border: '1px solid var(--border)',
    borderRadius: 999,
    fontSize: 11,
    color: 'var(--text-primary)',
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  folderChipShared: {},
  folderChipOrphan: { opacity: 0.75 },
  folderChipSelected: {
    borderColor: '#4fc3f7',
    background: 'rgba(79, 195, 247, 0.12)',
    color: '#4fc3f7',
  },
  folderChipName: { fontFamily: 'Menlo, Monaco, monospace' },
  folderChipMeta: {
    fontSize: 10,
    color: 'var(--text-muted)',
    padding: '1px 6px',
    background: 'var(--bg-primary)',
    borderRadius: 999,
  },
  advancedSection: {
    border: '1px solid var(--border)',
    borderRadius: 4,
    background: 'var(--bg-surface)',
  },
  advancedToggle: {
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '8px 10px',
    background: 'transparent',
    border: 'none',
    color: 'var(--text-primary)',
    fontSize: 12,
    fontWeight: 500,
    cursor: 'pointer',
    textAlign: 'left' as const,
  },
  advancedBody: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 10,
    padding: '4px 10px 10px 10px',
    borderTop: '1px solid var(--border)',
  },
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
