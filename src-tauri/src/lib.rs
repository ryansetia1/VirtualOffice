mod agents;
mod asset_library;
mod terminal;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      agents::init_projects_root(app.handle())?;
      asset_library::init_asset_root(app.handle())?;
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      agents::get_projects_root,
      agents::create_agent_folder,
      agents::ensure_agent_folder,
      agents::delete_agent_folder,
      agents::list_agent_folders,
      agents::agent_folder_path,
      asset_library::asset_get_root,
      asset_library::asset_create_category,
      asset_library::asset_rename_category,
      asset_library::asset_delete_category,
      asset_library::asset_move_file,
      asset_library::asset_list_files,
      terminal::pty_spawn,
      terminal::pty_write,
      terminal::pty_resize,
      terminal::pty_kill,
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
