import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { Agent } from '../hooks/useAgents';
import { agentFolderPath } from '../utils/agentFolders';
import {
  ptySpawn,
  ptyWriteString,
  ptyWriteBytes,
  ptyResize,
  ptyKill,
} from '../utils/pty';

interface OpenTerminal {
  id: string; // equals agent.id
  agent: Agent;
}

interface Props {
  terminals: OpenTerminal[];
  activeId: string | null;
  onSetActive: (id: string) => void;
  onClose: (id: string) => void;
}

export default function TerminalPanel({ terminals, activeId, onSetActive, onClose }: Props) {
  const [height, setHeight] = useState<number>(320);
  const resizingRef = useRef(false);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!resizingRef.current) return;
      const h = Math.max(160, Math.min(window.innerHeight - 120, window.innerHeight - e.clientY));
      setHeight(h);
    };
    const onUp = () => { resizingRef.current = false; document.body.style.userSelect = ''; };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  if (terminals.length === 0) return null;

  return (
    <div style={{ ...styles.container, height }}>
      <div
        style={styles.resizer}
        onMouseDown={() => { resizingRef.current = true; document.body.style.userSelect = 'none'; }}
      />
      <div style={styles.tabs}>
        {terminals.map((t) => (
          <div
            key={t.id}
            style={{ ...styles.tab, ...(t.id === activeId ? styles.tabActive : {}) }}
            onClick={() => onSetActive(t.id)}
          >
            <span style={styles.tabLabel}>{t.agent.nickname}</span>
            <button
              style={styles.tabCloseBtn}
              onClick={(e) => { e.stopPropagation(); onClose(t.id); }}
              title="Close terminal"
            >×</button>
          </div>
        ))}
      </div>
      <div style={styles.body}>
        {terminals.map((t) => (
          <TerminalView
            key={t.id}
            agent={t.agent}
            active={t.id === activeId}
            onAutoClose={() => onClose(t.id)}
          />
        ))}
      </div>
    </div>
  );
}

function TerminalView({ agent, active, onAutoClose }: { agent: Agent; active: boolean; onAutoClose: () => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sessionId = `agent:${agent.id}`;
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string>('booting…');

  const fit = useCallback(() => {
    const fitAddon = fitRef.current;
    const term = termRef.current;
    if (!fitAddon || !term) return;
    try {
      fitAddon.fit();
      ptyResize(sessionId, term.cols, term.rows).catch(() => { /* ignore */ });
    } catch {
      // element not ready
    }
  }, [sessionId]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    // `state` lives through the whole effect closure so the cleanup
    // function can dispose whatever was already created even if the
    // async init didn't finish yet (e.g. React StrictMode's mount →
    // cleanup → remount cycle in dev). The async block below writes
    // to state.term / state.closeChannel / state.ro as soon as each
    // resource exists, and cleanup reads from `state` — so nothing
    // leaks whether cleanup fires before, during, or after init.
    const state: {
      disposed: boolean;
      term: Terminal | null;
      closeChannel: (() => void) | null;
      ro: ResizeObserver | null;
    } = { disposed: false, term: null, closeChannel: null, ro: null };

    (async () => {
      let term: Terminal;
      try {
        term = new Terminal({
          fontSize: 13,
          fontFamily: 'Menlo, Monaco, "Courier New", monospace',
          theme: {
            background: '#0d1117',
            foreground: '#e8eef7',
            cursor: '#4fc3f7',
            selectionBackground: 'rgba(79, 195, 247, 0.35)',
          },
          cursorBlink: true,
          scrollback: 5000,
          convertEol: true,
        });
        const fitAddon = new FitAddon();
        term.loadAddon(fitAddon);
        term.open(el);

        state.term = term;
        termRef.current = term;
        fitRef.current = fitAddon;

        if (state.disposed) { term.dispose(); return; }

        try { fitAddon.fit(); } catch (e) { console.warn('[terminal] fit failed (non-fatal)', e); }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[terminal] xterm open failed:', err);
        setErrorMsg(`xterm failed to open: ${msg}`);
        return;
      }

      term.onData((data) => {
        if (state.disposed) return;
        ptyWriteString(sessionId, data).catch((e) => console.warn('[terminal] write failed', e));
      });
      term.onBinary((data) => {
        if (state.disposed) return;
        const bytes = new Uint8Array(data.length);
        for (let i = 0; i < data.length; i++) bytes[i] = data.charCodeAt(i) & 0xff;
        ptyWriteBytes(sessionId, bytes).catch((e) => console.warn('[terminal] write-bytes failed', e));
      });

      let cwd: string;
      try {
        setStatusMsg('resolving agent folder…');
        cwd = await agentFolderPath(agent.folderName);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[terminal] resolve cwd failed:', err);
        if (!state.disposed) {
          setErrorMsg(`cannot resolve agent folder: ${msg}`);
          term.writeln(`\r\n\x1b[31mcannot resolve agent folder: ${msg}\x1b[0m`);
        }
        return;
      }

      if (state.disposed) return;

      try {
        setStatusMsg('spawning shell…');
        const safeCols = term.cols && term.cols > 2 ? term.cols : 100;
        const safeRows = term.rows && term.rows > 2 ? term.rows : 30;
        term.write(`\x1b[90m[projects/${agent.folderName}]\x1b[0m\r\n`);
        const closeChannel = await ptySpawn(sessionId, cwd, safeCols, safeRows, {
          onReady: () => {
            if (state.disposed) return;
            setStatusMsg('');
          },
          onData: (bytes) => {
            if (state.disposed) return;
            term.write(bytes);
          },
          onExit: () => {
            if (state.disposed) return;
            term.writeln('\r\n\x1b[90m[session exited]\x1b[0m');
            window.setTimeout(() => onAutoClose(), 600);
          },
        });
        if (state.disposed) {
          closeChannel();
          ptyKill(sessionId).catch(() => { /* ignore */ });
          return;
        }
        state.closeChannel = closeChannel;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[terminal] spawn failed:', err);
        if (!state.disposed) {
          setErrorMsg(`spawn failed: ${msg}`);
          term.writeln(`\r\n\x1b[31mspawn failed: ${msg}\x1b[0m`);
        }
        return;
      }

      const ro = new ResizeObserver(() => fit());
      ro.observe(el);
      if (state.disposed) { ro.disconnect(); return; }
      state.ro = ro;
    })();

    return () => {
      state.disposed = true;
      if (state.ro) state.ro.disconnect();
      if (state.closeChannel) state.closeChannel();
      ptyKill(sessionId).catch(() => { /* ignore */ });
      if (state.term) state.term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (active) {
      fit();
      termRef.current?.focus();
    }
  }, [active, fit]);

  return (
    <div style={{ ...styles.termHost, display: active ? 'block' : 'none' }}>
      <div ref={containerRef} style={styles.termMount} />
      {statusMsg && !errorMsg && (
        <div style={styles.statusBanner}>{statusMsg}</div>
      )}
      {errorMsg && <div style={styles.errorBanner}>{errorMsg}</div>}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    position: 'fixed' as const, left: 0, right: 0, bottom: 0,
    background: '#0d1117', borderTop: '1px solid var(--border)',
    display: 'flex', flexDirection: 'column' as const,
    zIndex: 500, boxShadow: '0 -12px 32px rgba(0, 0, 0, 0.45)',
  },
  resizer: {
    position: 'absolute' as const, top: -3, left: 0, right: 0, height: 6,
    cursor: 'ns-resize', background: 'transparent', zIndex: 1,
  },
  tabs: {
    display: 'flex', alignItems: 'stretch', background: 'var(--bg-secondary)',
    borderBottom: '1px solid var(--border)', minHeight: 32, overflowX: 'auto' as const,
  },
  tab: {
    display: 'flex', alignItems: 'center', gap: 6,
    padding: '4px 10px 4px 12px', borderRight: '1px solid var(--border)',
    fontSize: 12, color: 'var(--text-muted)', cursor: 'pointer', userSelect: 'none' as const,
  },
  tabActive: { background: '#0d1117', color: 'var(--text-primary)' },
  tabLabel: { whiteSpace: 'nowrap' as const },
  tabCloseBtn: {
    background: 'transparent', border: 'none', color: 'inherit',
    fontSize: 16, lineHeight: 1, cursor: 'pointer', padding: '0 4px',
  },
  body: { flex: 1, position: 'relative' as const, overflow: 'hidden' },
  termHost: { position: 'absolute' as const, inset: 0 },
  termMount: { width: '100%', height: '100%', padding: 6, boxSizing: 'border-box' as const },
  statusBanner: {
    position: 'absolute' as const, left: 10, bottom: 10,
    padding: '4px 8px', background: 'rgba(100, 149, 237, 0.18)',
    border: '1px solid rgba(100, 149, 237, 0.4)', color: '#90caf9',
    borderRadius: 4, fontSize: 11, pointerEvents: 'none' as const,
  },
  errorBanner: {
    position: 'absolute' as const, left: 10, right: 10, top: 10,
    padding: '6px 10px', background: 'rgba(239, 83, 80, 0.2)',
    border: '1px solid rgba(239, 83, 80, 0.5)', color: '#ef5350',
    borderRadius: 4, fontSize: 12,
  },
};
