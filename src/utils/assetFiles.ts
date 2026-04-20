import { isTauri, invokeSafe } from './tauri';

export interface AssetFileEntry {
  file_name: string;
  category_path: string | null;
}

/**
 * All mirror operations are best-effort:
 * - in the browser they simply no-op (so the web dev workflow still works)
 * - in Tauri they sync the on-disk category folders with the localStorage state.
 *
 * These operations are awaited so callers can surface errors, but the localStorage
 * side is already updated synchronously by `useAssetCategories`.
 */

export async function assetCreateCategory(path: string): Promise<void> {
  if (!isTauri()) return;
  try {
    await invokeSafe<void>('asset_create_category', { path });
  } catch (err) {
    // Surface but don't throw so localStorage state stays intact.
    console.warn('[asset_library] create failed:', err);
  }
}

export async function assetRenameCategory(oldPath: string, newPath: string): Promise<void> {
  if (!isTauri()) return;
  try {
    await invokeSafe<void>('asset_rename_category', { oldPath, newPath });
  } catch (err) {
    console.warn('[asset_library] rename failed:', err);
  }
}

export async function assetDeleteCategory(path: string): Promise<void> {
  if (!isTauri()) return;
  try {
    await invokeSafe<void>('asset_delete_category', { path });
  } catch (err) {
    console.warn('[asset_library] delete failed:', err);
  }
}

export async function assetMoveFile(fileName: string, targetPath: string | null): Promise<void> {
  if (!isTauri()) return;
  try {
    await invokeSafe<void>('asset_move_file', { fileName, targetPath });
  } catch (err) {
    console.warn('[asset_library] move failed:', err);
  }
}

export async function assetListFiles(): Promise<AssetFileEntry[]> {
  if (!isTauri()) return [];
  try {
    return await invokeSafe<AssetFileEntry[]>('asset_list_files', {});
  } catch (err) {
    console.warn('[asset_library] list failed:', err);
    return [];
  }
}
