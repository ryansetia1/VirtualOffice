import { getCurrentWebview } from '@tauri-apps/api/webview';
import { isTauri } from './tauri';

/**
 * Routes native OS drag-and-drop events to DOM-level drop zones.
 *
 * Tauri 2 delivers `enter | over | drop | leave` events (with real filesystem
 * paths) via `getCurrentWebview().onDragDropEvent`. A single webview listener
 * is enough for the entire app — we hit-test the reported pointer against
 * every registered zone and dispatch to whichever one sits under the cursor.
 *
 * Positions arrive in physical pixels and are converted to CSS pixels before
 * `document.elementFromPoint` is consulted, so the hit test honors whatever
 * the browser actually lays out. Offscreen or hidden zones (e.g. parked
 * xterm hosts) are naturally ignored because elementFromPoint can't see
 * them — no manual "is this zone active?" bookkeeping required.
 *
 * In the non-Tauri browser build `registerDropZone` is a no-op.
 */

export interface DropZoneCallbacks {
  /** `true` while this zone is under the cursor during a drag, `false` otherwise. */
  onHoverChange: (inside: boolean) => void;
  /** Fired when files are released over this zone. `paths` are absolute filesystem paths. */
  onDrop: (paths: string[]) => void;
}

export interface DropZoneHandle {
  dispose: () => void;
}

interface Zone {
  element: HTMLElement;
  callbacks: DropZoneCallbacks;
}

const zones = new Map<string, Zone>();
let listenerInstalled = false;

/**
 * Register a DOM element as a drop target. Returns a handle whose `dispose()`
 * removes it from the router. The global webview listener is installed lazily
 * on first registration and kept alive for the lifetime of the app.
 */
export function registerDropZone(
  id: string,
  element: HTMLElement,
  callbacks: DropZoneCallbacks,
): DropZoneHandle {
  zones.set(id, { element, callbacks });
  void ensureListener();
  return {
    dispose() {
      zones.delete(id);
    },
  };
}

async function ensureListener(): Promise<void> {
  if (listenerInstalled || !isTauri()) return;
  listenerInstalled = true;
  try {
    await getCurrentWebview().onDragDropEvent(({ payload }) => {
      if (payload.type === 'leave') {
        clearHover();
        return;
      }
      if (
        payload.type !== 'enter' &&
        payload.type !== 'over' &&
        payload.type !== 'drop'
      ) {
        return;
      }

      const ratio = window.devicePixelRatio || 1;
      const target = document.elementFromPoint(
        payload.position.x / ratio,
        payload.position.y / ratio,
      );
      const matchedId = findZoneUnder(target);

      for (const [id, zone] of zones) {
        zone.callbacks.onHoverChange(id === matchedId);
      }

      if (payload.type === 'drop') {
        if (matchedId && payload.paths && payload.paths.length > 0) {
          zones.get(matchedId)!.callbacks.onDrop(payload.paths);
        }
        clearHover();
      }
    });
  } catch (err) {
    console.warn('[webviewDropRouter] listener install failed', err);
  }
}

function findZoneUnder(target: Element | null): string | null {
  if (!target) return null;
  for (const [id, zone] of zones) {
    if (target === zone.element || zone.element.contains(target)) return id;
  }
  return null;
}

function clearHover(): void {
  for (const zone of zones.values()) zone.callbacks.onHoverChange(false);
}
