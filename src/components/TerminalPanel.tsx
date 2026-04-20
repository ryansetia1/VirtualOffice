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
  const spawnedRef = useRef(false);
  const sessionId = `agent:${agent.id}`;
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

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
    if (!el || spawnedRef.current) return;
    spawnedRef.current = true;

    let disposed = false;
    let closeChannel: (() => void) | null = null;
    let ro: ResizeObserver | null = null;
    let term: Terminal | null = null;

    // Wait for the host element to have layout (width/height > 0) before
    // opening xterm & spawning the PTY. Without this, FitAddon can return
    // 0x0 dimensions and the shell never paints a prompt.
    const waitForLayout = () => new Promise<void>((resolve) => {
      const check = () => {
        if (disposed) return resolve();
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) return resolve();
        requestAnimationFrame(check);
      };
      check();
    });

    (async () => {
      try {
        await waitForLayout();
        if (disposed) return;

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
        termRef.current = term;
        fitRef.current = fitAddon;

        try { fitAddon.fit(); } catch { /* ignore */ }

        // Guard against degenerate sizes.
        const safeCols = term.cols && term.cols > 2 ? term.cols : 100;
        const safeRows = term.rows && term.rows > 2 ? term.rows : 30;

        term.onData((data) => {
          ptyWriteString(sessionId, data).catch(() => { /* ignore */ });
        });
        term.onBinary((data) => {
          const bytes = new Uint8Array(data.length);
          for (let i = 0; i < data.length; i++) bytes[i] = data.charCodeAt(i) & 0xff;
          ptyWriteBytes(sessionId, bytes).catch(() => { /* ignore */ });
        });

        // Spawn PTY with a streaming channel. Output arrives in `onData`;
        // `onReady` is emitted synchronously from the Rust side so we can
        // verify the IPC plumbing is healthy before the shell even starts.
        const greet = (text: string) => {
          if (!disposed && term) term.write(text);
        };
        greet('\x1b[90m[connecting…]\x1b[0m\r\n');

        const cwd = await agentFolderPath(agent.folderName);
        closeChannel = await ptySpawn(sessionId, cwd, safeCols, safeRows, {
          onReady: () => greet('\x1b[90m[pty ready]\x1b[0m\r\n'),
          onData: (bytes) => {
            if (disposed || !term) return;
            term.write(bytes);
          },
          onExit: () => {
            if (disposed || !term) return;
            term.writeln('\r\n\x1b[90m[session exited]\x1b[0m');
            window.setTimeout(() => onAutoClose(), 600);
          },
        });

        ro = new ResizeObserver(() => fit());
        ro.observe(el);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setErrorMsg(msg);
        if (term) term.writeln(`\r\n\x1b[31m${msg}\x1b[0m`);
      }
    })();

    return () => {
      disposed = true;
      if (ro) ro.disconnect();
      if (closeChannel) closeChannel();
      ptyKill(sessionId).catch(() => { /* ignore */ });
      if (term) term.dispose();
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
  errorBanner: {
    position: 'absolute' as const, left: 10, right: 10, top: 10,
    padding: '6px 10px', background: 'rgba(239, 83, 80, 0.2)',
    border: '1px solid rgba(239, 83, 80, 0.5)', color: '#ef5350',
    borderRadius: 4, fontSize: 12,
  },
};
