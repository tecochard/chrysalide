use crate::{blocking, engine};
use std::{
    collections::HashMap,
    fs,
    io::Read,
    path::PathBuf,
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{State, ipc::Response};
use uuid::Uuid;

#[derive(Default)]
pub struct DroppedPhotos(Mutex<HashMap<Uuid, (Instant, PathBuf)>>);

#[tauri::command]
pub async fn read_dropped_photo(
    id: String,
    drops: State<'_, DroppedPhotos>,
) -> Result<Response, String> {
    let id = Uuid::parse_str(&id).map_err(|_| "Fichier déposé introuvable.")?;
    let (_, path) = drops
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&id)
        .filter(|(expiry, _)| *expiry > Instant::now())
        .ok_or("Fichier déposé introuvable.")?;
    blocking(move || {
        let err = |_| "Impossible de lire le fichier déposé.".to_string();
        if !fs::metadata(&path).map_err(err)?.is_file() {
            return Err("Dépose un fichier JPEG ou PNG, pas un dossier.".into());
        }
        let mut bytes = Vec::new();
        fs::File::open(path)
            .map_err(err)?
            .take((engine::UPLOAD_LIMIT + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(err)?;
        if bytes.len() > engine::UPLOAD_LIMIT {
            return Err("Fichier trop volumineux (24 Mio maximum).".into());
        }
        if !matches!(
            image::guess_format(&bytes),
            Ok(image::ImageFormat::Jpeg | image::ImageFormat::Png)
        ) {
            return Err("Image JPEG ou PNG illisible.".into());
        }
        Ok(Response::new(bytes))
    })
    .await
}

#[cfg(target_os = "linux")]
pub fn install(window: tauri::WebviewWindow) -> tauri::Result<()> {
    use gtk::{gdk, prelude::*};
    use std::{cell::Cell, rc::Rc};
    use tauri::{Emitter, Manager};

    let target_window = window.clone();
    window.with_webview(move |platform| {
        let view = platform.inner();
        let uri_target = gdk::Atom::intern("text/uri-list");
        view.drag_dest_unset();
        view.drag_dest_set(
            gtk::DestDefaults::empty(),
            &[gtk::TargetEntry::new(
                "text/uri-list",
                gtk::TargetFlags::empty(),
                0,
            )],
            gdk::DragAction::COPY,
        );

        // Demander les URI seulement au dépôt, sans dépendre de l’ordre drag-leave/drag-drop.
        let hovering = Rc::new(Cell::new(false));
        let motion_hovering = hovering.clone();
        let motion_window = target_window.clone();
        let motion_target = uri_target.clone();
        view.connect_drag_motion(move |_, context, _, _, time| {
            let accepts = context.list_targets().contains(&motion_target)
                && context.actions().contains(gdk::DragAction::COPY);
            context.drag_status(
                if accepts {
                    gdk::DragAction::COPY
                } else {
                    gdk::DragAction::empty()
                },
                time,
            );
            if motion_hovering.replace(accepts) != accepts {
                let _ = motion_window.emit("photo-drag-hover", accepts);
            }
            true
        });
        let leave_window = target_window.clone();
        view.connect_drag_leave(move |view, _, _| {
            view.stop_signal_emission_by_name("drag-leave");
            hovering.set(false);
            let _ = leave_window.emit("photo-drag-hover", false);
        });
        view.connect_drag_drop(move |view, context, _, _, time| {
            if context.list_targets().contains(&uri_target) {
                view.drag_get_data(context, &uri_target, time);
            } else {
                context.drag_finish(false, false, time);
            }
            true
        });
        view.connect_drag_data_received(move |view, context, _, _, data, _, time| {
            view.stop_signal_emission_by_name("drag-data-received");
            let now = Instant::now();
            let state = target_window.state::<DroppedPhotos>();
            let Ok(mut photos) = state.0.lock() else {
                context.drag_finish(false, false, time);
                return;
            };
            photos.retain(|_, (expiry, _)| *expiry > now);
            let files = data
                .uris()
                .iter()
                .filter_map(|uri| {
                    let (path, host) = gtk::glib::filename_from_uri(uri).ok()?;
                    if host.is_some_and(|host| !host.is_empty() && host != "localhost")
                        || !path.is_absolute()
                    {
                        return None;
                    }
                    let name = path.file_name()?.to_string_lossy().into_owned();
                    let id = Uuid::new_v4();
                    photos.insert(id, (now + Duration::from_secs(600), path));
                    Some(serde_json::json!({"id": id.to_string(), "name": name}))
                })
                .collect::<Vec<_>>();
            drop(photos);
            context.drag_finish(!files.is_empty(), false, time);
            let _ = target_window.emit("photos-dropped", files);
        });
    })
}
