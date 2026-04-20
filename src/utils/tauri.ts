import { invoke } from '@tauri-apps/api/core';

type TauriWindow = Window & { __TAURI_INTERNALS__?: unknown };

export function isTauri(): boolean {
  if (typeof window === 'undefined') return false;
  return '__TAURI_INTERNALS__' in (window as TauriWindow);
}

export async function invokeSafe<T>(
  cmd: string,
  args?: Record<string, unknown>
): Promise<T> {
  if (!isTauri()) {
    throw new Error(
      `"${cmd}" requires the Virtual Office desktop app. Launch with \`npm run tauri:dev\`.`
    );
  }
  return invoke<T>(cmd, args);
}
