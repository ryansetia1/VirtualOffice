import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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

export interface OpenTerminal {
  id: string;
  agent: Agent;
}

// ──────────────────────────────────────────────────────────────────────────────
// Parking element
//
// xterm lives inside a div we create imperatively. When no chrome is showing
// the terminal (inactive docked tab, hidden window, etc.) we park that div in
// this offscreen element so xterm stays mounted in the DOM without being
// visible. The key property of `terminal-parking`: xterm's DOM is never
// destroyed, so React never remounts TerminalView, so the PTY is never
// restarted — docking ↔ floating is just an `appendChild` of our host div.
// ──────────────────────────────────────────────────────────────────────────────

function ensureParkingEl(): HTMLElement {
  let p = document.getElementById('terminal-parking');
  if (!p) {
    p = document.createElement('div');
    p.id = 'terminal-parking';
    p.style.position = 'fixed';
    p.style.left = '-99999px';
    p.style.top = '0';
    p.style.width = '800px';
    p.style.height = '400px';
    p.style.overflow = 'hidden';
    p.style.visibility = 'hidden';
    p.style.pointerEvents = 'none';
    document.body.appendChild(p);
  }
  return p;
}

// ──────────────────────────────────────────────────────────────────────────────
// TerminalView — stable, owns xterm + PTY, reparented via imperative DOM ops
// ──────────────────────────────────────────────────────────────────────────────

interface TerminalViewProps {
  agent: Agent;
  /** Current slot element to host the xterm DOM, or null to park offscreen. */
  target: HTMLElement | null;
  /** True when this terminal is the currently-visible one in its chrome. */
  active: boolean;
  onAutoClose: () => void;
}

export function TerminalView({ agent, target, active, onAutoClose }: TerminalViewProps) {
  const sessionId = `agent:${agent.id}`;

  // The div we imperatively append to the current chrome slot. State so the
  // portal for banners re-renders once it exists.
  const [hostDiv, setHostDiv] = useState<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string>('booting…');

  // ── One-time setup: create host div, open xterm, spawn PTY ──────────────────
  useEffect(() => {
    const div = document.createElement('div');
    div.style.width = '100%';
    div.style.height = '100%';
    div.style.padding = '6px';
    div.style.boxSizing = 'border-box';
    div.style.position = 'relative'; // for absolute-positioned banners
    ensureParkingEl().appendChild(div); // park before xterm sizes itself
    setHostDiv(div);

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
        term.open(div);

        state.term = term;
        termRef.current = term;
        fitRef.current = fitAddon;

        if (state.disposed) { term.dispose(); return; }

        try { fitAddon.fit(); } catch (e) { console.warn('[terminal] fit failed (non-fatal)', e); }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
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
        if (!state.disposed) {
          setErrorMsg(`spawn failed: ${msg}`);
          term.writeln(`\r\n\x1b[31mspawn failed: ${msg}\x1b[0m`);
        }
        return;
      }

      // Re-fit whenever the current chrome slot resizes.
      const ro = new ResizeObserver(() => {
        try { fitRef.current?.fit(); } catch { /* ignore */ }
        const t = termRef.current;
        if (t) ptyResize(sessionId, t.cols, t.rows).catch(() => { /* ignore */ });
      });
      ro.observe(div);
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
      div.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Reparent our host div whenever the target slot changes ─────────────────
  useEffect(() => {
    if (!hostDiv) return;
    const dest = target || ensureParkingEl();
    if (hostDiv.parentElement !== dest) {
      dest.appendChild(hostDiv);
      // After reparenting, fit to the new container size (next frame so the
      // new parent has its final layout dimensions).
      requestAnimationFrame(() => {
        try { fitRef.current?.fit(); } catch { /* ignore */ }
      });
    }
  }, [target, hostDiv]);

  // ── Focus when we become the visible terminal ──────────────────────────────
  useEffect(() => {
    if (!active) return;
    requestAnimationFrame(() => {
      try { fitRef.current?.fit(); } catch { /* ignore */ }
      termRef.current?.focus();
    });
  }, [active]);

  // Render banners inside the host div via portal. They inherit CSS visibility
  // from whatever parent the host div is currently attached to (chrome slot
  // or parking), so hiding the chrome hides the banners automatically.
  if (!hostDiv) return null;
  return createPortal(
    <>
      {statusMsg && !errorMsg && <div style={styles.statusBanner}>{statusMsg}</div>}
      {errorMsg && <div style={styles.errorBanner}>{errorMsg}</div>}
    </>,
    hostDiv
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// DockedPanel — tabbed panel at the bottom; renders a single slot element
// ──────────────────────────────────────────────────────────────────────────────

interface DockedPanelProps {
  terminals: OpenTerminal[];
  hiddenIds: Set<string>;
  activeId: string | null;
  onSetActive: (id: string) => void;
  onHide: (id: string) => void;
  onFloat: (id: string) => void;
  setSlotEl: (el: HTMLDivElement | null) => void;
}

export default function TerminalPanel({
  terminals, hiddenIds, activeId, onSetActive, onHide, onFloat, setSlotEl,
}: DockedPanelProps) {
  const [height, setHeight] = useState<number>(320);
  const resizingRef = useRef(false);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!resizingRef.current) return;
      setHeight(Math.max(160, Math.min(window.innerHeight - 120, window.innerHeight - e.clientY)));
    };
    const onUp = () => { resizingRef.current = false; document.body.style.userSelect = ''; };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, []);

  if (terminals.length === 0) return null;

  const visibleTerminals = terminals.filter((t) => !hiddenIds.has(t.id));
  const allHidden = visibleTerminals.length === 0;

  const activeTab = activeId && !hiddenIds.has(activeId) && terminals.some((t) => t.id === activeId)
    ? activeId
    : visibleTerminals.length > 0 ? visibleTerminals[visibleTerminals.length - 1].id : null;

  return (
    <div style={{
      ...styles.dockedContainer,
      height,
      // When every docked terminal is hidden, make the whole panel disappear
      // but keep it mounted so the (empty) slot stays registered. Children
      // don't explicitly override visibility, so inheritance does the work.
      visibility: allHidden ? 'hidden' : undefined,
      pointerEvents: allHidden ? 'none' : undefined,
    }}>
      <div
        style={styles.resizer}
        onMouseDown={() => { resizingRef.current = true; document.body.style.userSelect = 'none'; }}
      />
      <div style={styles.tabs}>
        {visibleTerminals.map((t) => (
          <div
            key={t.id}
            data-tab="true"
            style={{ ...styles.tab, ...(t.id === activeTab ? styles.tabActive : {}) }}
            onClick={() => onSetActive(t.id)}
          >
            <span style={styles.tabLabel}>{t.agent.nickname}</span>
            <button
              style={styles.iconBtn}
              title="Float window"
              onClick={(e) => { e.stopPropagation(); onFloat(t.id); }}
            >
              <FloatIcon />
            </button>
            <button
              style={{ ...styles.iconBtn, fontSize: 16 }}
              title="Hide (double-click agent to reopen)"
              onClick={(e) => { e.stopPropagation(); onHide(t.id); }}
            >×</button>
          </div>
        ))}
        <div style={{ flex: 1 }} />
      </div>
      {/* The single slot for whichever docked terminal is currently active. */}
      <div ref={setSlotEl} style={styles.body} />
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// FloatingTerminalWindow — one per floating terminal, provides its own slot
// ──────────────────────────────────────────────────────────────────────────────

const FLOAT_W = 720;
const FLOAT_H = 420;
const TITLE_H = 32;

interface FloatingWindowProps {
  terminal: OpenTerminal;
  hidden: boolean;
  zIndex: number;
  initialPos: { x: number; y: number };
  onHide: (id: string) => void;
  onDock: (id: string) => void;
  onFocus: (id: string) => void;
  setSlotEl: (id: string, el: HTMLDivElement | null) => void;
}

export function FloatingTerminalWindow({
  terminal, hidden, zIndex, initialPos, onHide, onDock, onFocus, setSlotEl,
}: FloatingWindowProps) {
  const [pos, setPos] = useState(initialPos);
  const [size, setSize] = useState({ w: FLOAT_W, h: FLOAT_H });
  const [shaded, setShaded] = useState(false);

  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);
  const resizeRef = useRef<{ sx: number; sy: number; ow: number; oh: number } | null>(null);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (dragRef.current) {
        setPos({
          x: Math.max(0, Math.min(window.innerWidth  - 120, dragRef.current.ox + e.clientX - dragRef.current.sx)),
          y: Math.max(0, Math.min(window.innerHeight -  40, dragRef.current.oy + e.clientY - dragRef.current.sy)),
        });
      }
      if (resizeRef.current) {
        setSize({
          w: Math.max(320, resizeRef.current.ow + e.clientX - resizeRef.current.sx),
          h: Math.max(200, resizeRef.current.oh + e.clientY - resizeRef.current.sy),
        });
      }
    };
    const onUp = () => {
      dragRef.current = null;
      resizeRef.current = null;
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, []);

  const slotSetter = useCallback(
    (el: HTMLDivElement | null) => setSlotEl(terminal.id, el),
    [setSlotEl, terminal.id]
  );

  return (
    <div
      style={{
        position: 'fixed',
        left: pos.x,
        top: pos.y,
        width: size.w,
        height: shaded ? TITLE_H : size.h,
        minWidth: 320,
        background: '#0d1117',
        border: '1px solid var(--border)',
        borderRadius: 8,
        display: 'flex',
        flexDirection: 'column',
        zIndex,
        boxShadow: '0 20px 60px rgba(0,0,0,0.7)',
        overflow: 'hidden',
        // Hidden windows stay mounted (we want to preserve position/size and
        // keep the slot registered). Children don't force visibility:visible,
        // so inheritance correctly hides everything inside.
        visibility: hidden ? 'hidden' : undefined,
        pointerEvents: hidden ? 'none' : undefined,
      }}
      onMouseDown={() => onFocus(terminal.id)}
    >
      <div
        style={styles.floatTitleBar}
        onMouseDown={(e) => {
          if ((e.target as HTMLElement).closest('button')) return;
          dragRef.current = { sx: e.clientX, sy: e.clientY, ox: pos.x, oy: pos.y };
          document.body.style.userSelect = 'none';
          document.body.style.cursor = 'move';
        }}
      >
        <span style={styles.floatTitle}>{terminal.agent.nickname}</span>
        <button style={styles.titleBtn} title="Dock to bottom" onClick={() => onDock(terminal.id)}>
          <DockIcon />
        </button>
        <button style={styles.titleBtn} title={shaded ? 'Restore' : 'Minimise'} onClick={() => setShaded((s) => !s)}>
          {shaded ? '▲' : '▼'}
        </button>
        <button
          style={{ ...styles.titleBtn, borderRight: 'none' }}
          title="Hide (double-click agent to reopen)"
          onClick={() => onHide(terminal.id)}
        >×</button>
      </div>

      {/* Slot for xterm. When shaded the flex body collapses to 0 height, so
          ResizeObserver inside TerminalView will refit on un-shade. */}
      <div ref={slotSetter} style={{ flex: 1, position: 'relative', overflow: 'hidden' }} />

      {!shaded && (
        <div
          style={styles.resizeGrip}
          onMouseDown={(e) => {
            resizeRef.current = { sx: e.clientX, sy: e.clientY, ow: size.w, oh: size.h };
            document.body.style.userSelect = 'none';
            document.body.style.cursor = 'nwse-resize';
            e.stopPropagation();
          }}
        />
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Icons
// ──────────────────────────────────────────────────────────────────────────────

function FloatIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 14 14" fill="none" style={{ display: 'block' }}>
      <rect x="1" y="4" width="8" height="9" rx="1" stroke="currentColor" strokeWidth="1.25" />
      <path d="M5 1h8v8" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M9 1l4 4" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
    </svg>
  );
}

function DockIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 14 14" fill="none" style={{ display: 'block' }}>
      <rect x="1" y="8" width="12" height="5" rx="1" stroke="currentColor" strokeWidth="1.25" />
      <path d="M7 1v6M4 4l3 3 3-3" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Styles
// ──────────────────────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  dockedContainer: {
    position: 'fixed', left: 0, right: 0, bottom: 0,
    background: '#0d1117', borderTop: '1px solid var(--border)',
    display: 'flex', flexDirection: 'column',
    zIndex: 500, boxShadow: '0 -12px 32px rgba(0,0,0,0.45)',
  },
  resizer: {
    position: 'absolute', top: -3, left: 0, right: 0, height: 6,
    cursor: 'ns-resize', background: 'transparent', zIndex: 1,
  },
  tabs: {
    display: 'flex', alignItems: 'stretch', background: 'var(--bg-secondary)',
    borderBottom: '1px solid var(--border)', minHeight: 32, overflowX: 'auto', flexShrink: 0,
  },
  tab: {
    display: 'flex', alignItems: 'center', gap: 4,
    padding: '4px 6px 4px 12px', borderRight: '1px solid var(--border)',
    fontSize: 12, color: 'var(--text-muted)', cursor: 'pointer', userSelect: 'none', flexShrink: 0,
  },
  tabActive: { background: '#0d1117', color: 'var(--text-primary)' },
  tabLabel: { whiteSpace: 'nowrap' },
  iconBtn: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'transparent', border: 'none', color: 'inherit',
    cursor: 'pointer', padding: '2px 4px', borderRadius: 3,
  },
  body: { flex: 1, position: 'relative', overflow: 'hidden' },
  floatTitleBar: {
    display: 'flex', alignItems: 'center',
    height: TITLE_H, flexShrink: 0,
    background: 'var(--bg-secondary)', borderBottom: '1px solid var(--border)',
    cursor: 'move', userSelect: 'none',
  },
  floatTitle: {
    flex: 1, padding: '0 12px',
    fontSize: 12, color: 'var(--text-primary)',
    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
  },
  titleBtn: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'transparent', border: 'none',
    borderLeft: '1px solid var(--border)',
    color: 'var(--text-muted)', cursor: 'pointer',
    width: 32, height: TITLE_H, flexShrink: 0, fontSize: 14,
  },
  resizeGrip: {
    position: 'absolute', bottom: 0, right: 0,
    width: 18, height: 18, cursor: 'nwse-resize', zIndex: 2,
    background: 'linear-gradient(135deg, transparent 50%, rgba(255,255,255,0.07) 50%)',
  },
  statusBanner: {
    position: 'absolute', left: 10, bottom: 10,
    padding: '4px 8px', background: 'rgba(100, 149, 237, 0.18)',
    border: '1px solid rgba(100, 149, 237, 0.4)', color: '#90caf9',
    borderRadius: 4, fontSize: 11, pointerEvents: 'none',
  },
  errorBanner: {
    position: 'absolute', left: 10, right: 10, top: 10,
    padding: '6px 10px', background: 'rgba(239, 83, 80, 0.2)',
    border: '1px solid rgba(239, 83, 80, 0.5)', color: '#ef5350',
    borderRadius: 4, fontSize: 12,
  },
};
