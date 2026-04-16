import type { RoomState } from '../hooks/useGrid';

const STORAGE_KEY = 'virtualOffice_room';

export function saveRoom(room: RoomState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(room));
  } catch {
    console.warn('Failed to save room to localStorage');
  }
}

export function loadRoom(): RoomState | null {
  try {
    const data = localStorage.getItem(STORAGE_KEY);
    if (!data) return null;
    const parsed = JSON.parse(data);
    // Migrate from old cell-based format
    if (parsed.cells && !parsed.placements) {
      return null;
    }
    return parsed as RoomState;
  } catch {
    console.warn('Failed to load room from localStorage');
    return null;
  }
}

export function clearSavedRoom(): void {
  localStorage.removeItem(STORAGE_KEY);
}
