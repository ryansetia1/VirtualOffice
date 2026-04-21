use std::fs;
#[cfg(debug_assertions)]
use std::path::Path;
use std::path::PathBuf;
use once_cell::sync::OnceCell;
#[cfg(not(debug_assertions))]
use tauri::Manager;

static PROJECTS_ROOT: OnceCell<PathBuf> = OnceCell::new();

pub fn init_projects_root(_app: &tauri::AppHandle) -> Result<(), String> {
    if PROJECTS_ROOT.get().is_some() {
        return Ok(());
    }
    // 1) Explicit env var wins.
    if let Ok(dir) = std::env::var("VIRTUAL_OFFICE_PROJECTS_DIR") {
        let p = PathBuf::from(dir);
        fs::create_dir_all(&p).map_err(|e| format!("Failed to create projects dir: {}", e))?;
        PROJECTS_ROOT.set(p).map_err(|_| "Projects root already set".to_string())?;
        return Ok(());
    }

    // 2) Debug: repo_root/projects (CARGO_MANIFEST_DIR points at src-tauri during dev).
    #[cfg(debug_assertions)]
    {
        let manifest_dir = env!("CARGO_MANIFEST_DIR");
        let repo_root = Path::new(manifest_dir)
            .parent()
            .ok_or("Failed to resolve repo root".to_string())?;
        let p = repo_root.join("projects");
        fs::create_dir_all(&p).map_err(|e| format!("Failed to create projects dir: {}", e))?;
        PROJECTS_ROOT.set(p).map_err(|_| "Projects root already set".to_string())?;
        return Ok(());
    }

    // 3) Release: app data dir.
    #[cfg(not(debug_assertions))]
    {
        let base = _app
            .path()
            .app_data_dir()
            .map_err(|e| format!("Failed to resolve app data dir: {}", e))?;
        let p = base.join("projects");
        fs::create_dir_all(&p).map_err(|e| format!("Failed to create projects dir: {}", e))?;
        PROJECTS_ROOT.set(p).map_err(|_| "Projects root already set".to_string())?;
        Ok(())
    }
}

fn projects_root() -> Result<PathBuf, String> {
    PROJECTS_ROOT
        .get()
        .cloned()
        .ok_or_else(|| "Projects root not initialized".to_string())
}

fn validate_folder_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("Folder name cannot be empty.".to_string());
    }
    if name.len() > 64 {
        return Err("Folder name too long (max 64).".to_string());
    }
    for ch in name.chars() {
        let ok = ch.is_ascii_lowercase()
            || ch.is_ascii_digit()
            || ch == '-'
            || ch == '_';
        if !ok {
            return Err(format!(
                "Invalid character '{}'. Use a-z, 0-9, '-', '_' only.",
                ch
            ));
        }
    }
    if name.contains("..") {
        return Err("Folder name cannot contain '..'".to_string());
    }
    Ok(())
}

fn resolve_under_root(folder_name: &str) -> Result<PathBuf, String> {
    validate_folder_name(folder_name)?;
    let root = projects_root()?;
    let candidate = root.join(folder_name);
    // Extra safety: make sure the canonical path stays inside root.
    let parent = candidate
        .parent()
        .ok_or_else(|| "Invalid path".to_string())?;
    let _ = fs::create_dir_all(parent);
    let canonical_parent = fs::canonicalize(parent)
        .map_err(|e| format!("Failed to canonicalize parent: {}", e))?;
    let canonical_root = fs::canonicalize(&root)
        .map_err(|e| format!("Failed to canonicalize root: {}", e))?;
    if !canonical_parent.starts_with(&canonical_root) {
        return Err("Folder escapes projects directory.".to_string());
    }
    Ok(candidate)
}

#[tauri::command]
pub fn get_projects_root() -> Result<String, String> {
    let root = projects_root()?;
    Ok(root.to_string_lossy().to_string())
}

#[tauri::command]
pub fn create_agent_folder(folder_name: String) -> Result<String, String> {
    let path = resolve_under_root(&folder_name)?;
    if path.exists() {
        return Err(format!("Folder '{}' already exists.", folder_name));
    }
    fs::create_dir_all(&path).map_err(|e| format!("Failed to create folder: {}", e))?;
    Ok(path.to_string_lossy().to_string())
}

/// Idempotent variant of `create_agent_folder`: returns the folder path if it
/// already exists, otherwise creates it. Used when more than one agent is
/// allowed to share the same project directory.
#[tauri::command]
pub fn ensure_agent_folder(folder_name: String) -> Result<String, String> {
    let path = resolve_under_root(&folder_name)?;
    if !path.exists() {
        fs::create_dir_all(&path).map_err(|e| format!("Failed to create folder: {}", e))?;
    }
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn delete_agent_folder(folder_name: String) -> Result<(), String> {
    let path = resolve_under_root(&folder_name)?;
    if !path.exists() {
        return Ok(());
    }
    fs::remove_dir_all(&path).map_err(|e| format!("Failed to remove folder: {}", e))
}

#[tauri::command]
pub fn list_agent_folders() -> Result<Vec<String>, String> {
    let root = projects_root()?;
    let mut result = Vec::new();
    if !root.exists() {
        return Ok(result);
    }
    let entries = fs::read_dir(&root).map_err(|e| format!("Failed to read projects dir: {}", e))?;
    for entry in entries.flatten() {
        if let Ok(ft) = entry.file_type() {
            if ft.is_dir() {
                if let Some(name) = entry.file_name().to_str() {
                    result.push(name.to_string());
                }
            }
        }
    }
    result.sort();
    Ok(result)
}

#[tauri::command]
pub fn agent_folder_path(folder_name: String) -> Result<String, String> {
    let path = resolve_under_root(&folder_name)?;
    Ok(path.to_string_lossy().to_string())
}
