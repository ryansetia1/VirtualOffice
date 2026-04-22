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

// Default regex for detecting "no previous conversation" messages from common
// AI CLI tools (Claude Code, Ollama, etc.). Users can override via each agent's
// `noConversationPattern` field.
const DEFAULT_NO_CONVERSATION_PATTERN =
  'no (previous |saved |existing )?conversation|no session found|no previous session|unable to (find|locate|resume)|resume.{0,30}(failed|error)';

function compilePattern(custom: string | undefined): RegExp {
  const src = (custom && custom.trim()) || DEFAULT_NO_CONVERSATION_PATTERN;
  try {
    return new RegExp(src, 'i');
  } catch {
    return new RegExp(DEFAULT_NO_CONVERSATION_PATTERN, 'i');
  }
}

// Default "agent is busy" regex. Covers:
//   - Braille spinner frames used by most CLI progress indicators
//   - Claude Code's own bullets (✻ ✢ ⏺ ●) usually followed by a verb
//   - Bare verbs with ellipsis (Thinking…, Processing…, Editing…) in case
//     the spinner is stripped or ANSI-positioned out of our capture window
// Intentionally generous — false positives are low-cost (bubble briefly
// shows) while false negatives make the feature invisible.
const DEFAULT_BUSY_PATTERN =
  '[\\u2800-\\u28ff]|[✻✢⏺●◐◓◑◒◴◷◶◵]\\s|(Thinking|Processing|Editing|Updating|Analyzing|Running|Reading|Writing|Searching|Cogitating|Generating|Fetching|Planning)(…|\\.{2,})';

function compileBusyPattern(custom: string | undefined): RegExp {
  const src = (custom && custom.trim()) || DEFAULT_BUSY_PATTERN;
  try {
    return new RegExp(src);
  } catch {
    return new RegExp(DEFAULT_BUSY_PATTERN);
  }
}

// Default "agent emitted an error/warning" regex. Case-insensitive on
// purpose — CLIs are inconsistent about capitalization. Covers:
//   - Explicit keywords: Error, Failed, Exception, rejected, timeout
//   - Common rate-limit / auth / quota wording
//   - API Error pattern with HTTP status (e.g. "API Error: 429", "HTTP 503")
// Kept line-oriented in callers (we match against the stripped last line
// rather than a rolling buffer) so a spurious word in the middle of a
// prose answer doesn't fire the badge.
const DEFAULT_ERROR_PATTERN =
  '\\bAPI Error\\b|\\bHTTP\\s+[45]\\d\\d\\b|\\b[45]\\d\\d\\s*(?:error|rejected|forbidden)\\b|\\b(?:error|failed|exception|rejected|refused|denied|timeout|timed out)\\b|\\b(?:rate|usage|quota|session)\\s+(?:limit|exceeded)\\b|\\bupgrade (?:for|to) higher|\\btoo many requests\\b|\\bunauthorized\\b';

function compileErrorPattern(custom: string | undefined): RegExp {
  const src = (custom && custom.trim()) || DEFAULT_ERROR_PATTERN;
  try {
    return new RegExp(src, 'i');
  } catch {
    return new RegExp(DEFAULT_ERROR_PATTERN, 'i');
  }
}

// Lines shorter than this are ignored for error matching. Prompts, blank
// lines, and single-word status chatter shouldn't be able to fire the
// badge ("error" as a bare word on a tool name line etc.). 8 is enough
// to filter that out while keeping real error messages like "API Error"
// intact.
const ERROR_MIN_LINE_LEN = 8;
// Cooldown between consecutive error fires, so a tool that prints the
// same rate-limit message every second doesn't cause a flickering badge.
// The App-side also auto-expires stale errors separately; this is just
// to avoid churn on the callback.
const ERROR_FIRE_COOLDOWN_MS = 5_000;

// Rough ANSI-escape stripper. Targets CSI (`\x1b[…`) and OSC (`\x1b]…\x07`)
// sequences that dominate xterm output. Not a perfect parser — a malformed
// OSC could leak — but regex is bounded and idle output rarely contains
// those corner cases. Good enough for the busy-pattern matcher.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[=>]/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

// How long to wait after the last busy signal before declaring "idle".
// 1500ms tolerates the natural gap between spinner frames even on sluggish
// terminal streams without making the bubble linger after the tool prints
// its final result.
const BUSY_IDLE_TIMEOUT_MS = 1500;
// Minimum on-screen lifetime for the bubble. Prevents flicker when a tool
// finishes a tiny sub-step in <200ms and we'd otherwise blink the bubble on
// and off within a single render frame.
const BUSY_MIN_VISIBLE_MS = 500;

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
  /**
   * Called when the PTY exits for any reason not initiated by an explicit
   * user reset. The parent uses this to promote the agent's conversation
   * state to "has previous" so the next open uses the continue command.
   */
  onSessionEnded?: () => void;
  /**
   * Called when the pattern watcher sees the "no previous conversation"
   * signal after running the continue command. The parent uses this to
   * demote the agent back to "fresh" state so fallback sticks.
   */
  onPatternFallback?: () => void;
  /**
   * Called once the start command has been sent to the PTY. The parent
   * uses this to *optimistically* mark `hasPreviousConversation = true`
   * so that subsequent opens (including after an app crash or forced
   * quit that skipped `onSessionEnded`) try the continue command first.
   * False positives are harmless — the pattern-fallback flow will Ctrl+C
   * and restart clean if there's nothing to resume.
   */
  onSessionStarted?: () => void;
  /**
   * Fires whenever our busy-signal watcher flips state. `true` means the
   * underlying CLI is actively thinking/editing/running; `false` means it
   * has been quiet for at least BUSY_IDLE_TIMEOUT_MS (and the minimum-
   * visible window has elapsed). The parent uses this to paint a thinking
   * bubble over the agent sprite.
   */
  onBusyChange?: (busy: boolean) => void;
  /**
   * Fires when the error-pattern watcher matches a line of PTY output.
   * Payload is the trimmed matching line (truncated to a sane length for
   * tooltip display). The parent owns lifecycle of the error badge —
   * this callback only reports new matches, subject to a short cooldown
   * so the same line firing repeatedly doesn't spam the UI.
   */
  onErrorDetected?: (message: string) => void;
}

export function TerminalView({ agent, target, active, onAutoClose, onSessionEnded, onPatternFallback, onSessionStarted, onBusyChange, onErrorDetected }: TerminalViewProps) {
  const sessionId = `agent:${agent.id}`;

  // The div we imperatively append to the current chrome slot. State so the
  // portal for banners re-renders once it exists.
  const [hostDiv, setHostDiv] = useState<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string>('booting…');

  // ── Auto-run command state machine ────────────────────────────────────────
  //
  // Phases:
  //   'booting'          → PTY not ready yet; nothing sent
  //   'running-continue' → continue-command was sent; pattern watcher active
  //   'falling-back'     → pattern matched, sending Ctrl+C + start command
  //   'user-controlled'  → either (a) no auto-command, (b) start command sent,
  //                        or (c) user typed and cancelled the pattern watch
  //
  // We track phase via ref for synchronous access inside PTY handlers.
  const phaseRef = useRef<'booting' | 'running-continue' | 'falling-back' | 'user-controlled'>('booting');
  // Rolling buffer of recent PTY output as a decoded string, capped at 4 KB,
  // used only while phaseRef.current === 'running-continue'. Match scope is
  // kept small so an occasional match inside legitimate output much later
  // can't retroactively trigger a fallback.
  const bufferRef = useRef<string>('');
  const patternRef = useRef<RegExp | null>(null);
  // Latest command snapshot captured at mount so the fallback can replay the
  // start command without re-reading agent (which may change mid-session
  // after the user edits the commands dialog — intentionally not live).
  const startCmdRef = useRef<string | null>(null);
  const decoderRef = useRef<TextDecoder>(new TextDecoder('utf-8', { fatal: false }));

  // ── Busy-signal watcher ───────────────────────────────────────────────────
  //
  // We feed stripped PTY output through a regex and track:
  //   busyLastMatchAt: timestamp of the most recent busy-pattern match
  //   busyShownAt:     timestamp we most recently flipped to busy=true
  //   busy:            current reported state (mirrored to parent)
  // A short buffer is kept across chunks so patterns don't split across
  // PTY reads. Idle timeout is polled on a 250ms interval rather than a
  // setTimeout chain so we never dangle timers across chunks.
  const busyPatternRef = useRef<RegExp | null>(null);
  const busyTailRef = useRef<string>('');
  const busyLastMatchAtRef = useRef<number>(0);
  const busyShownAtRef = useRef<number>(0);
  const busyRef = useRef<boolean>(false);
  const onBusyChangeRef = useRef<typeof onBusyChange>(onBusyChange);
  useEffect(() => { onBusyChangeRef.current = onBusyChange; }, [onBusyChange]);

  // ── Error-signal watcher ──────────────────────────────────────────────────
  //
  // Runs line-oriented: we keep a small tail across chunks, split on
  // newlines, and test each *complete* line. The trailing partial line
  // is preserved for the next chunk. This avoids matching a phrase that
  // happens to straddle a chunk boundary twice.
  const errorPatternRef = useRef<RegExp | null>(null);
  const errorTailRef = useRef<string>('');
  const errorLastFiredAtRef = useRef<number>(0);
  const onErrorDetectedRef = useRef<typeof onErrorDetected>(onErrorDetected);
  useEffect(() => { onErrorDetectedRef.current = onErrorDetected; }, [onErrorDetected]);

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
      busyTimer: number | null;
    } = { disposed: false, term: null, closeChannel: null, ro: null, busyTimer: null };

    // Idle-check tick. Runs at 250ms regardless of PTY activity so we can
    // declare "idle" without needing another chunk to wake us up. Cheap —
    // a few comparisons and a single callback at most. Also honours the
    // minimum-visible window so a 50ms blip doesn't flicker the bubble.
    state.busyTimer = window.setInterval(() => {
      if (!busyRef.current) return;
      const now = performance.now();
      const sinceMatch = now - busyLastMatchAtRef.current;
      const sinceShown = now - busyShownAtRef.current;
      if (sinceMatch >= BUSY_IDLE_TIMEOUT_MS && sinceShown >= BUSY_MIN_VISIBLE_MS) {
        busyRef.current = false;
        onBusyChangeRef.current?.(false);
      }
    }, 250);

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
        // User interaction cancels any pending auto-fallback: from this point
        // on we treat the session as user-controlled, so a late "no conversation"
        // match in output can't yank the terminal out from under them.
        if (phaseRef.current === 'running-continue' && data.length > 0) {
          phaseRef.current = 'user-controlled';
          patternRef.current = null;
          bufferRef.current = '';
        }
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

        // Capture the command config at mount. We intentionally snapshot here
        // rather than reading `agent` live, because mid-session edits to the
        // commands dialog should only apply to the NEXT open.
        const startCmd = agent.startCommand?.trim() ?? '';
        const contCmd = agent.continueCommand?.trim() ?? '';
        const hasPrev = !!agent.hasPreviousConversation;
        startCmdRef.current = startCmd || null;

        // Fallback mechanics: user picked the "aggressive" option (Q3-a), so
        // on pattern match we send Ctrl+C, then the plain start command after
        // a short settle delay. Kept as a ref-bound closure so it can be
        // re-triggered once without creating stale captures.
        const triggerFallback = () => {
          if (state.disposed) return;
          if (phaseRef.current !== 'running-continue') return;
          phaseRef.current = 'falling-back';
          patternRef.current = null;
          bufferRef.current = '';
          // Mark the agent as "no previous conversation" so this session and
          // future opens both treat it as fresh, matching Q4-a.
          onPatternFallback?.();
          term.writeln('\r\n\x1b[90m[no previous conversation — restarting fresh]\x1b[0m');
          // Ctrl+C → brief wait → re-run plain start command.
          ptyWriteBytes(sessionId, new Uint8Array([0x03]))
            .catch(() => { /* ignore */ })
            .then(() => new Promise((r) => setTimeout(r, 200)))
            .then(() => {
              if (state.disposed || !startCmd) return;
              return ptyWriteString(sessionId, `${startCmd}\r`);
            })
            .then(() => {
              if (state.disposed) return;
              phaseRef.current = 'user-controlled';
            })
            .catch((e) => console.warn('[terminal] fallback failed', e));
        };

        // Compile the busy-signal regex once up-front. Separate from the
        // "no previous conversation" pattern because it runs for the full
        // lifetime of the session, not just during the continue phase.
        busyPatternRef.current = compileBusyPattern(agent.busyPattern);
        // Same story for the error watcher — one compile per session.
        errorPatternRef.current = compileErrorPattern(agent.errorPattern);

        const closeChannel = await ptySpawn(sessionId, cwd, safeCols, safeRows, {
          onReady: () => {
            if (state.disposed) return;
            setStatusMsg('');
            if (!startCmd) {
              phaseRef.current = 'user-controlled';
              return;
            }
            // Wait ~200ms so login shell rc files (.zshrc etc.) finish
            // printing banner/prompt before we inject our command.
            window.setTimeout(() => {
              if (state.disposed) return;
              if (hasPrev && contCmd) {
                phaseRef.current = 'running-continue';
                patternRef.current = compilePattern(agent.noConversationPattern);
                bufferRef.current = '';
                ptyWriteString(sessionId, `${startCmd} ${contCmd}\r`)
                  .catch((e) => console.warn('[terminal] start+continue send failed', e));
              } else {
                phaseRef.current = 'user-controlled';
                ptyWriteString(sessionId, `${startCmd}\r`)
                  .catch((e) => console.warn('[terminal] start send failed', e));
              }
              // Optimistically promote the conversation state so the *next*
              // open tries continue first — even if the app dies before
              // `onSessionEnded` ever fires. If there's nothing to continue,
              // the pattern watcher will fall back and demote this back to
              // false, so the flag self-corrects.
              onSessionStarted?.();
            }, 200);
          },
          onData: (bytes) => {
            if (state.disposed) return;
            term.write(bytes);
            // Decode once per chunk — shared by both the "no previous
            // conversation" watcher (phase-gated) and the busy-signal
            // watcher (always on). The TextDecoder is stateful when
            // `stream: true`; decoding twice would corrupt UTF-8 splits.
            const decoded = decoderRef.current.decode(bytes, { stream: true });
            if (!decoded) return;

            // "no previous conversation" watcher. 4 KB is plenty to catch
            // any reasonable error line; if a tool splits the phrase across
            // more than 4 KB of output we'd rather miss a fallback than
            // flip phases mid-conversation.
            if (phaseRef.current === 'running-continue' && patternRef.current) {
              bufferRef.current = (bufferRef.current + decoded).slice(-4096);
              if (patternRef.current.test(bufferRef.current)) {
                triggerFallback();
              }
            }

            // Busy-signal watcher. Strip ANSI *after* concatenating with
            // the tail so escape sequences split across chunks still get
            // stripped correctly. Keep tail small (1 KB): busy markers
            // arrive fast and don't span much text, and a larger tail
            // would keep stale spinner chars "alive" after the tool is
            // actually done.
            if (busyPatternRef.current) {
              const combined = busyTailRef.current + decoded;
              const stripped = stripAnsi(combined);
              if (busyPatternRef.current.test(stripped)) {
                const now = performance.now();
                busyLastMatchAtRef.current = now;
                if (!busyRef.current) {
                  busyRef.current = true;
                  busyShownAtRef.current = now;
                  onBusyChangeRef.current?.(true);
                }
              }
              // Keep only the tail of the *decoded* (not stripped) stream;
              // ANSI stripping is cheap and re-runs on every chunk.
              busyTailRef.current = combined.slice(-1024);
            }

            // Error-signal watcher. Line-oriented so we can ship the
            // matched line to the parent as a tooltip payload. We also
            // replace lone `\r` with `\n` before splitting because some
            // tools redraw progress lines with carriage returns only,
            // which would otherwise cause the error line to be stuck in
            // the tail indefinitely.
            if (errorPatternRef.current) {
              const combined = errorTailRef.current + decoded;
              const normalized = combined.replace(/\r(?!\n)/g, '\n');
              const lines = normalized.split('\n');
              // The last element is the in-progress line (no terminator
              // yet) — keep it as the new tail. Process everything before.
              errorTailRef.current = lines.pop() ?? '';
              // Cap the tail so an extremely long single line (no
              // terminator at all, e.g. a very long prompt) can't grow
              // unbounded. 4 KB is way past the length of any sane error.
              if (errorTailRef.current.length > 4096) {
                errorTailRef.current = errorTailRef.current.slice(-4096);
              }
              for (const rawLine of lines) {
                const line = stripAnsi(rawLine).trim();
                if (line.length < ERROR_MIN_LINE_LEN) continue;
                if (!errorPatternRef.current.test(line)) continue;
                const now = performance.now();
                if (now - errorLastFiredAtRef.current < ERROR_FIRE_COOLDOWN_MS) continue;
                errorLastFiredAtRef.current = now;
                // Cap length for tooltip display (~120 chars is plenty).
                const message = line.length > 120 ? line.slice(0, 117) + '…' : line;
                onErrorDetectedRef.current?.(message);
              }
            }
          },
          onExit: () => {
            if (state.disposed) return;
            // Session ended → no more output will arrive, so clear the
            // thinking bubble immediately regardless of the idle window.
            if (busyRef.current) {
              busyRef.current = false;
              onBusyChangeRef.current?.(false);
            }
            // Surface the exit to the parent so the conversation flag can be
            // promoted to "has previous". Parent suppresses this when the
            // exit was initiated by an explicit user-reset click.
            onSessionEnded?.();
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
      if (state.busyTimer != null) window.clearInterval(state.busyTimer);
      if (state.closeChannel) state.closeChannel();
      ptyKill(sessionId).catch(() => { /* ignore */ });
      if (state.term) state.term.dispose();
      termRef.current = null;
      fitRef.current = null;
      // Make sure the parent's bubble clears if the session is torn down
      // while still reporting busy (user closes terminal mid-think).
      if (busyRef.current) {
        busyRef.current = false;
        onBusyChangeRef.current?.(false);
      }
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
  onReset?: (id: string) => void;
  setSlotEl: (el: HTMLDivElement | null) => void;
}

export default function TerminalPanel({
  terminals, hiddenIds, activeId, onSetActive, onHide, onFloat, onReset, setSlotEl,
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
            {onReset && (t.agent.startCommand?.trim()) && (
              <button
                style={styles.iconBtn}
                title="Restart with fresh conversation"
                onClick={(e) => { e.stopPropagation(); onReset(t.id); }}
              >
                <ResetIcon />
              </button>
            )}
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
  onReset?: (id: string) => void;
  setSlotEl: (id: string, el: HTMLDivElement | null) => void;
}

export function FloatingTerminalWindow({
  terminal, hidden, zIndex, initialPos, onHide, onDock, onFocus, onReset, setSlotEl,
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
        {onReset && (terminal.agent.startCommand?.trim()) && (
          <button style={styles.titleBtn} title="Restart with fresh conversation" onClick={() => onReset(terminal.id)}>
            <ResetIcon />
          </button>
        )}
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

function ResetIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 14 14" fill="none" style={{ display: 'block' }}>
      <path
        d="M11.5 4.5a4.5 4.5 0 1 0 1 2.8"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        fill="none"
      />
      <path d="M12 2v3h-3" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
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
