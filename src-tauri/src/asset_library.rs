use std::fs;
use std::path::{Path, PathBuf};

use once_cell::sync::OnceCell;
use serde::Serialize;
#[cfg(not(debug_assertions))]
use tauri::Manager;

static ASSET_ROOT: OnceCell<PathBuf> = OnceCell::new();

pub fn init_asset_root(_app: &tauri::AppHandle) -> Result<(), String> {
    if ASSET_ROOT.get().is_some() {
        return Ok(());
    }

    // 1) Explicit env var override.
    if let Ok(dir) = std::env::var("VIRTUAL_OFFICE_ASSET_DIR") {
        let p = PathBuf::from(dir);
        fs::create_dir_all(&p).map_err(|e| format!("Failed to create asset dir: {}", e))?;
        ASSET_ROOT
            .set(p)
            .map_err(|_| "Asset root already set".to_string())?;
        return Ok(());
    }

    // 2) Debug: `<repo>/assets/modern_office`.
    #[cfg(debug_assertions)]
    {
        let manifest_dir = env!("CARGO_MANIFEST_DIR");
        let repo_root = Path::new(manifest_dir)
            .parent()
            .ok_or("Failed to resolve repo root".to_string())?;
        let p = repo_root.join("assets").join("modern_office");
        if !p.exists() {
            fs::create_dir_all(&p).map_err(|e| format!("Failed to create asset dir: {}", e))?;
        }
        ASSET_ROOT
            .set(p)
            .map_err(|_| "Asset root already set".to_string())?;
        return Ok(());
    }

    // 3) Release: app data dir + assets/modern_office.
    #[cfg(not(debug_assertions))]
    {
        let base = _app
            .path()
            .app_data_dir()
            .map_err(|e| format!("Failed to resolve app data dir: {}", e))?;
        let p = base.join("assets").join("modern_office");
        fs::create_dir_all(&p).map_err(|e| format!("Failed to create asset dir: {}", e))?;
        ASSET_ROOT
            .set(p)
            .map_err(|_| "Asset root already set".to_string())?;
        Ok(())
    }
}

fn asset_root() -> Result<PathBuf, String> {
    ASSET_ROOT
        .get()
        .cloned()
        .ok_or_else(|| "Asset root not initialized".to_string())
}

fn validate_category_path(path: &str) -> Result<(), String> {
    if path.is_empty() {
        return Err("Category path cannot be empty.".to_string());
    }
    if path.len() > 255 {
        return Err("Category path too long.".to_string());
    }
    for segment in path.split('/') {
        if segment.is_empty() {
            return Err("Category path has empty segment.".to_string());
        }
        if segment == "." || segment == ".." {
            return Err("Category path cannot contain '.' or '..'".to_string());
        }
        for ch in segment.chars() {
            let ok = ch.is_alphanumeric()
                || ch == ' '
                || ch == '-'
                || ch == '_'
                || ch == '&'
                || ch == '(' || ch == ')';
            if !ok {
                return Err(format!("Invalid character '{}' in category segment.", ch));
            }
        }
    }
    Ok(())
}

fn validate_file_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("File name cannot be empty.".to_string());
    }
    if name.contains('/') || name.contains('\\') {
        return Err("File name cannot contain path separators.".to_string());
    }
    if name == "." || name == ".." || name.contains("..") {
        return Err("File name cannot contain '..'".to_string());
    }
    Ok(())
}

fn resolve_category(path: &str) -> Result<PathBuf, String> {
    validate_category_path(path)?;
    let root = asset_root()?;
    Ok(root.join(path))
}

fn ensure_inside_root(path: &Path) -> Result<(), String> {
    let root = asset_root()?;
    let canonical_root = fs::canonicalize(&root).map_err(|e| e.to_string())?;
    let start_from = if path.exists() {
        fs::canonicalize(path).map_err(|e| e.to_string())?
    } else if let Some(parent) = path.parent() {
        fs::canonicalize(parent).map_err(|e| e.to_string())?
    } else {
        return Err("Invalid path.".to_string());
    };
    if !start_from.starts_with(&canonical_root) {
        return Err("Path escapes asset root.".to_string());
    }
    Ok(())
}

#[tauri::command]
pub fn asset_get_root() -> Result<String, String> {
    Ok(asset_root()?.to_string_lossy().to_string())
}

#[tauri::command]
pub fn asset_create_category(path: String) -> Result<(), String> {
    let dir = resolve_category(&path)?;
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create category: {}", e))?;
    ensure_inside_root(&dir)?;
    Ok(())
}

#[tauri::command]
pub fn asset_rename_category(old_path: String, new_path: String) -> Result<(), String> {
    let from = resolve_category(&old_path)?;
    let to = resolve_category(&new_path)?;
    if !from.exists() {
        // Just materialize the new location if needed.
        fs::create_dir_all(&to).map_err(|e| e.to_string())?;
        return Ok(());
    }
    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::rename(&from, &to).map_err(|e| format!("Rename failed: {}", e))?;
    ensure_inside_root(&to)?;
    Ok(())
}

#[tauri::command]
pub fn asset_delete_category(path: String) -> Result<(), String> {
    let dir = resolve_category(&path)?;
    if !dir.exists() {
        return Ok(());
    }
    let root = asset_root()?;
    // Move any files inside back to root so nothing is lost.
    move_files_to_root_recursive(&dir, &root)?;
    // Now the directory should be empty (possibly with empty subdirs).
    fs::remove_dir_all(&dir).map_err(|e| format!("Remove failed: {}", e))?;
    Ok(())
}

fn move_files_to_root_recursive(dir: &Path, root: &Path) -> Result<(), String> {
    if !dir.exists() {
        return Ok(());
    }
    let entries = fs::read_dir(dir).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let p = entry.path();
        if p.is_dir() {
            move_files_to_root_recursive(&p, root)?;
        } else if p.is_file() {
            if let Some(name) = p.file_name() {
                let dest = root.join(name);
                if !dest.exists() {
                    fs::rename(&p, &dest).map_err(|e| format!("Move failed: {}", e))?;
                }
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub fn asset_move_file(file_name: String, target_path: Option<String>) -> Result<(), String> {
    validate_file_name(&file_name)?;
    let root = asset_root()?;
    let src = find_file_recursive(&root, &file_name)?
        .ok_or_else(|| format!("File not found: {}", file_name))?;
    let dest_dir = match target_path.as_deref() {
        None | Some("") => root.clone(),
        Some(p) => {
            let d = resolve_category(p)?;
            fs::create_dir_all(&d).map_err(|e| e.to_string())?;
            d
        }
    };
    let dest = dest_dir.join(&file_name);
    if src == dest {
        return Ok(());
    }
    fs::rename(&src, &dest).map_err(|e| format!("Move failed: {}", e))?;
    Ok(())
}

fn find_file_recursive(dir: &Path, name: &str) -> Result<Option<PathBuf>, String> {
    if !dir.exists() {
        return Ok(None);
    }
    let entries = fs::read_dir(dir).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let p = entry.path();
        if p.is_dir() {
            if let Some(found) = find_file_recursive(&p, name)? {
                return Ok(Some(found));
            }
        } else if p.is_file() {
            if p.file_name().map(|n| n == name).unwrap_or(false) {
                return Ok(Some(p));
            }
        }
    }
    Ok(None)
}

#[derive(Serialize, Clone)]
pub struct AssetFileEntry {
    pub file_name: String,
    pub category_path: Option<String>, // None = root (uncategorized)
}

#[tauri::command]
pub fn asset_list_files() -> Result<Vec<AssetFileEntry>, String> {
    let root = asset_root()?;
    let mut out = Vec::new();
    list_files_recursive(&root, &root, &mut out)?;
    Ok(out)
}

fn list_files_recursive(
    root: &Path,
    dir: &Path,
    out: &mut Vec<AssetFileEntry>,
) -> Result<(), String> {
    if !dir.exists() {
        return Ok(());
    }
    let entries = fs::read_dir(dir).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let p = entry.path();
        if p.is_dir() {
            list_files_recursive(root, &p, out)?;
        } else if p.is_file() {
            if let (Some(parent), Some(name)) = (p.parent(), p.file_name()) {
                let rel = parent
                    .strip_prefix(root)
                    .map_err(|e| e.to_string())?
                    .to_path_buf();
                let cat = if rel.as_os_str().is_empty() {
                    None
                } else {
                    // Use forward slashes on all platforms.
                    let mut parts: Vec<String> = Vec::new();
                    for c in rel.components() {
                        if let Some(s) = c.as_os_str().to_str() {
                            parts.push(s.to_string());
                        }
                    }
                    Some(parts.join("/"))
                };
                out.push(AssetFileEntry {
                    file_name: name.to_string_lossy().to_string(),
                    category_path: cat,
                });
            }
        }
    }
    Ok(())
}
