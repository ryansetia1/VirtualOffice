import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification';
import type { Agent } from '../hooks/useAgents';
import { isTauri } from './tauri';

/**
 * Fire a macOS (or platform-native) "agent finished" notification.
 *
 * We defer the permission prompt until the first time a notification is
 * actually needed so users aren't pestered on app launch. The prompt
 * itself is a one-shot per-install — after the user answers, subsequent
 * calls short-circuit via `isPermissionGranted`.
 *
 * Silently no-ops when:
 *   - the app is running in a browser build (no Tauri runtime)
 *   - the user has denied the permission request
 *   - the underlying plugin call throws (permission revoked mid-session,
 *     OS-level Do-Not-Disturb that rejects the payload, etc.)
 *
 * Notification click-to-focus is handled automatically by macOS: clicking
 * the banner raises our app window. Per-notification action routing
 * (jump to a specific agent's terminal) is a v2 feature we skip for the
 * MVP — the user still sees the sprite's green check badge to tell them
 * which agent is done.
 */
export async function notifyAgentDone(agent: Agent): Promise<void> {
  if (!isTauri()) return;
  try {
    let granted = await isPermissionGranted();
    if (!granted) {
      const response = await requestPermission();
      granted = response === 'granted';
    }
    if (!granted) return;
    await sendNotification({
      title: `${agent.nickname} finished`,
      body: 'Click the app icon to open their terminal.',
    });
  } catch {
    // Non-fatal. The in-app badge is still visible; we just can't get a
    // system-level banner this time.
  }
}

/**
 * Fire a macOS (or platform-native) "agent error" notification.
 *
 * Shares the same permission-grant dance as `notifyAgentDone`. The first
 * line of the matched error is surfaced in the body so the user can
 * triage without opening the terminal (e.g. "rate limit" vs. "auth
 * expired"). Message is truncated to ~140 chars; longer payloads show an
 * ellipsis.
 *
 * Silently no-ops in browser builds or when permission is denied — the
 * red "!" badge on the sprite is still visible, so the user still has an
 * in-app cue regardless of whether the OS banner fires.
 */
export async function notifyAgentError(agent: Agent, message: string): Promise<void> {
  if (!isTauri()) return;
  try {
    let granted = await isPermissionGranted();
    if (!granted) {
      const response = await requestPermission();
      granted = response === 'granted';
    }
    if (!granted) return;
    const body = message.length > 140 ? message.slice(0, 137) + '…' : message;
    await sendNotification({
      title: `${agent.nickname} hit an error`,
      body: body || 'Check the terminal for details.',
    });
  } catch {
    // Non-fatal, see notifyAgentDone.
  }
}
