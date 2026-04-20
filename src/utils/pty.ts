import { Channel, invoke } from '@tauri-apps/api/core';
import { invokeSafe } from './tauri';

// Tagged union matching Rust PtyMsg.
export type PtyMessage =
  | { kind: 'ready' }
  | { kind: 'data'; data_b64: string }
  | { kind: 'exit' };

export interface PtyHandlers {
  onReady?: () => void;
  onData: (bytes: Uint8Array) => void;
  onExit: () => void;
}

/**
 * Spawn a PTY and stream its output back through a typed Tauri Channel.
 * Returns a disposer that closes the channel (the PTY itself must be killed
 * via `ptyKill`).
 */
export async function ptySpawn(
  sessionId: string,
  cwd: string,
  cols: number,
  rows: number,
  handlers: PtyHandlers
): Promise<() => void> {
  const channel = new Channel<PtyMessage>();
  let closed = false;
  channel.onmessage = (msg) => {
    if (closed) return;
    switch (msg.kind) {
      case 'ready':
        handlers.onReady?.();
        break;
      case 'data':
        handlers.onData(base64ToUint8(msg.data_b64));
        break;
      case 'exit':
        handlers.onExit();
        break;
    }
  };

  await invoke<void>('pty_spawn', {
    sessionId,
    cwd,
    cols,
    rows,
    onMessage: channel,
  });

  return () => {
    closed = true;
  };
}

export async function ptyWriteBytes(sessionId: string, bytes: Uint8Array): Promise<void> {
  const b64 = uint8ToBase64(bytes);
  return invokeSafe<void>('pty_write', { sessionId, dataB64: b64 });
}

export async function ptyWriteString(sessionId: string, data: string): Promise<void> {
  const encoded = new TextEncoder().encode(data);
  return ptyWriteBytes(sessionId, encoded);
}

export async function ptyResize(sessionId: string, cols: number, rows: number): Promise<void> {
  return invokeSafe<void>('pty_resize', { sessionId, cols, rows });
}

export async function ptyKill(sessionId: string): Promise<void> {
  return invokeSafe<void>('pty_kill', { sessionId });
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    const slice = bytes.subarray(i, i + chunk);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

function base64ToUint8(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
