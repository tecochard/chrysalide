use chrysalide::{engine, store};
use serde::Deserialize;
use serde_json::Value;
use std::path::PathBuf;
use tauri::{
    AppHandle, Manager, State, http,
    ipc::{InvokeBody, Request, Response},
};
use tauri_plugin_dialog::DialogExt;

mod photo_drop;

struct Database(PathBuf);

async fn blocking<T: Send + 'static>(
    action: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(action)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn workshop(
    method: String,
    path: String,
    data: Option<Value>,
    db: State<'_, Database>,
) -> Result<Response, String> {
    let file = db.0.clone();
    blocking(move || {
        let reply = store::request(&store::open(&file)?, &method, &path, data)?;
        // En-tête JSON, saut de ligne, puis octets de la réponse.
        let mut bytes =
            serde_json::to_vec(&serde_json::json!({"mime":reply.mime,"size":reply.size}))
                .map_err(|e| e.to_string())?;
        bytes.push(b'\n');
        bytes.extend(reply.body);
        Ok(Response::new(bytes))
    })
    .await
}

fn raw(request: Request<'_>) -> Result<Vec<u8>, String> {
    match request.body() {
        InvokeBody::Raw(bytes) if bytes.len() <= engine::UPLOAD_LIMIT + 65536 => Ok(bytes.clone()),
        _ => Err("Fichier absent ou trop volumineux.".into()),
    }
}

#[tauri::command]
async fn prepare_portrait(request: Request<'_>) -> Result<Response, String> {
    let bytes = raw(request)?;
    blocking(move || {
        let (image, _) = engine::decode(&bytes)?;
        Ok(Response::new(engine::png(engine::thumbnail(image, 1600))?))
    })
    .await
}

#[derive(Deserialize)]
struct Import {
    name: String,
    points: Vec<engine::Point>,
}

#[tauri::command]
async fn add_portrait(
    request: Request<'_>,
    db: State<'_, Database>,
) -> Result<store::Portrait, String> {
    let bytes = raw(request)?;
    let file = db.0.clone();
    blocking(move || {
        let split = bytes
            .iter()
            .take(65536)
            .position(|&b| b == b'\n')
            .ok_or("Métadonnées absentes.")?;
        let meta: Import = serde_json::from_slice(&bytes[..split]).map_err(|e| e.to_string())?;
        store::import_photo(
            &store::open(&file)?,
            &meta.name,
            &bytes[split + 1..],
            &meta.points,
        )
    })
    .await
}

#[tauri::command]
async fn transfer_library(
    import: bool,
    app: AppHandle,
    db: State<'_, Database>,
) -> Result<bool, String> {
    let file = db.0.clone();
    blocking(move || {
        let dialog = app
            .dialog()
            .file()
            .add_filter("Bibliothèque SQLite", &["sqlite3", "sqlite", "db"]);
        let choice = if import {
            dialog.blocking_pick_file()
        } else {
            dialog
                .set_file_name("chrysalide-sauvegarde.sqlite3")
                .blocking_save_file()
        };
        let Some(path) = choice else { return Ok(false) };
        let path = path.into_path().map_err(|e| e.to_string())?;
        let mut db = store::open(&file)?;
        if import {
            store::import_db(&mut db, &path)?;
        } else {
            store::export_db(&db, &path)?;
        }
        Ok(true)
    })
    .await
}

#[tauri::command]
async fn download_media(
    path: String,
    app: AppHandle,
    db: State<'_, Database>,
) -> Result<bool, String> {
    let file = db.0.clone();
    blocking(move || {
        let (reply, name) = store::media(&store::open(&file)?, &path)?;
        let dialog = app.dialog().file().set_file_name(name);
        let Some(destination) = dialog.blocking_save_file() else {
            return Ok(false);
        };
        store::save_media(
            &destination.into_path().map_err(|e| e.to_string())?,
            &reply.body,
        )?;
        Ok(true)
    })
    .await
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri::plugin::Builder::<tauri::Wry>::new("local-navigation")
                .on_navigation(|_, url| url.scheme() != "file")
                .build(),
        )
        .manage(photo_drop::DroppedPhotos::default())
        .setup(|app| {
            let path = app.path().app_data_dir()?.join("atelier.sqlite3");
            store::init(&path).map_err(std::io::Error::other)?;
            app.manage(Database(path));
            #[cfg(target_os = "linux")]
            if let Some(window) = app.get_webview_window("main") {
                photo_drop::install(window)?;
            }
            Ok(())
        })
        .register_asynchronous_uri_scheme_protocol(
            "chrysalide-media",
            |context, request, responder| {
                let file = context.app_handle().state::<Database>().0.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    let path = request.uri().path();
                    let result = if request.method() == http::Method::GET
                        && (path.ends_with("/display") || path.ends_with(".png"))
                    {
                        store::open(&file).and_then(|db| store::media(&db, path))
                    } else {
                        Err("Image introuvable.".into())
                    };
                    let (status, mime, body) = match result {
                        Ok((reply, _)) => (200, reply.mime, reply.body),
                        Err(_) => (404, "text/plain", Vec::new()),
                    };
                    if let Ok(response) = http::Response::builder()
                        .status(status)
                        .header("Content-Type", mime)
                        .header("Access-Control-Allow-Origin", "*")
                        .header("X-Content-Type-Options", "nosniff")
                        .body(body)
                    {
                        responder.respond(response);
                    }
                });
            },
        )
        .invoke_handler(tauri::generate_handler![
            workshop,
            photo_drop::read_dropped_photo,
            prepare_portrait,
            add_portrait,
            download_media,
            transfer_library
        ])
        .run(tauri::generate_context!())?;
    Ok(())
}
