import { useEffect, useState } from 'react';
import type { Agent } from '../hooks/useAgents';
import { isTauri } from '../utils/tauri';
import { listAgentFolders } from '../utils/agentFolders';

interface Props {
  agents: Agent[];
  activeAgentId: string | null;
  onAddAgent: () => void;
  onAdoptFolder: (folderName: string) => void;
  onActivate: (agentId: string) => void;
  /** Bump this counter to force refresh of orphan list */
  refreshKey?: number;
}

export default function LiveHeader({ agents, activeAgentId, onAddAgent, onAdoptFolder, onActivate, refreshKey }: Props) {
  const [orphans, setOrphans] = useState<string[]>([]);
  const [orphansOpen, setOrphansOpen] = useState(false);
  const [desktopAvailable, setDesktopAvailable] = useState(false);

  useEffect(() => {
    setDesktopAvailable(isTauri());
    if (!isTauri()) return;
    (async () => {
      try {
        const all = await listAgentFolders();
        const used = new Set(agents.map((a) => a.folderName.toLowerCase()));
        setOrphans(all.filter((f) => !used.has(f.toLowerCase())));
      } catch {
        setOrphans([]);
      }
    })();
  }, [agents, refreshKey]);

  return (
    <div style={styles.container}>
      <button style={styles.addBtn} onClick={onAddAgent}>+ Agent</button>

      <div style={styles.agentList}>
        {agents.length === 0 && (
          <span style={styles.empty}>
            {desktopAvailable
              ? 'No agents yet. Click "+ Agent" to create one.'
              : 'Open via "npm run tauri:dev" to create agents with real folders.'}
          </span>
        )}
        {agents.map((a) => (
          <button
            key={a.id}
            style={{ ...styles.agentChip, ...(a.id === activeAgentId ? styles.agentChipActive : {}) }}
            onClick={() => onActivate(a.id)}
            title={`${a.nickname} — projects/${a.folderName}`}
          >
            <span style={styles.chipDot} />
            <span>{a.nickname}</span>
          </button>
        ))}
      </div>

      {desktopAvailable && orphans.length > 0 && (
        <div style={styles.orphansWrap}>
          <button
            style={styles.orphansHeader}
            onClick={() => setOrphansOpen((v) => !v)}
          >
            {orphansOpen ? '▾' : '▸'} {orphans.length} orphan{orphans.length === 1 ? '' : 's'}
          </button>
          {orphansOpen && (
            <div style={styles.orphansList}>
              {orphans.map((f) => (
                <button
                  key={f}
                  style={styles.orphanItem}
                  onClick={() => onAdoptFolder(f)}
                  title={`projects/${f}`}
                >
                  <span style={styles.orphanName}>{f}</span>
                  <span style={styles.orphanAdopt}>Adopt</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <div style={styles.spacer} />
      <span style={styles.hint}>WASD to move · Click to activate · Double-click to open terminal</span>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex', alignItems: 'center', gap: 10,
    padding: '8px 12px', borderBottom: '1px solid var(--border)',
    background: 'var(--bg-secondary)', minHeight: 44,
    position: 'relative',
  },
  addBtn: {
    padding: '6px 12px', background: 'var(--accent)', color: '#0d1117',
    border: 'none', borderRadius: 4, fontSize: 13, fontWeight: 600, cursor: 'pointer',
  },
  agentList: {
    display: 'flex', alignItems: 'center', gap: 6, flex: 1, flexWrap: 'wrap' as const,
    minWidth: 0,
  },
  empty: { fontSize: 12, color: 'var(--text-muted)' },
  agentChip: {
    display: 'flex', alignItems: 'center', gap: 6,
    padding: '4px 10px', background: 'var(--bg-surface)',
    border: '1px solid var(--border)', borderRadius: 999, fontSize: 12,
    color: 'var(--text-primary)', cursor: 'pointer',
  },
  agentChipActive: { borderColor: 'var(--accent)', background: 'var(--accent-dim)' },
  chipDot: { width: 6, height: 6, borderRadius: '50%', background: 'var(--accent)' },
  orphansWrap: { position: 'relative' },
  orphansHeader: {
    padding: '4px 10px', background: 'var(--bg-surface)', border: '1px solid var(--border)',
    borderRadius: 4, fontSize: 11, color: 'var(--text-muted)', cursor: 'pointer',
  },
  orphansList: {
    position: 'absolute' as const, top: '100%', right: 0, marginTop: 4,
    minWidth: 200, maxHeight: 260, overflowY: 'auto' as const,
    background: 'var(--bg-primary)', border: '1px solid var(--border)',
    borderRadius: 4, padding: 4, zIndex: 20,
    boxShadow: '0 12px 24px rgba(0, 0, 0, 0.35)',
  },
  orphanItem: {
    width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '6px 10px', background: 'transparent', border: 'none',
    color: 'var(--text-primary)', fontSize: 12, cursor: 'pointer', borderRadius: 3,
  },
  orphanName: { fontFamily: 'monospace' },
  orphanAdopt: { color: 'var(--accent)', fontWeight: 600, fontSize: 11 },
  spacer: { flex: 1 },
  hint: { fontSize: 11, color: 'var(--text-muted)' },
};
