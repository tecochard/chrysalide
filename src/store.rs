use crate::engine::{self, Input, Point};
use chrono::{SecondsFormat, Utc};
use image::GenericImageView;
use rusqlite::{
    Connection, OpenFlags, OptionalExtension, TransactionBehavior, backup::Backup, params,
    params_from_iter, types::Value as SqlValue,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::HashSet, fs, io::Write, path::Path, time::Duration};

const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS portrait (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, created TEXT NOT NULL,
    sha TEXT NOT NULL, point_sha TEXT NOT NULL, points TEXT NOT NULL,
    width INTEGER NOT NULL, height INTEGER NOT NULL, mime TEXT NOT NULL,
    original BLOB NOT NULL, display BLOB NOT NULL, UNIQUE(name, sha));
    CREATE TABLE IF NOT EXISTS result (
    id TEXT PRIMARY KEY, created TEXT NOT NULL, recipe TEXT NOT NULL, png BLOB NOT NULL);";
const SUMMARY: &str = "id,name,created,sha,point_sha,width,height";
const PORTRAIT_COLUMNS: &str =
    "id,name,created,sha,point_sha,points,width,height,mime,original,display";
const RESULT_COLUMNS: &str = "id,created,recipe,png";

fn msg(error: impl std::fmt::Display) -> String {
    error.to_string()
}
fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Micros, false)
}
fn new_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}
fn digest(data: &[u8]) -> String {
    format!("{:x}", Sha256::digest(data))
}
fn valid_id(key: &str) -> bool {
    key.len() == 32
        && key
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

pub fn open(path: &Path) -> Result<Connection, String> {
    let db = Connection::open(path).map_err(msg)?;
    db.busy_timeout(Duration::from_secs(5)).map_err(msg)?;
    db.execute_batch("PRAGMA trusted_schema=OFF;")
        .map_err(msg)?;
    Ok(db)
}

pub fn init(path: &Path) -> Result<(), String> {
    let dir = path.parent().ok_or("Dossier SQLite invalide.")?;
    fs::create_dir_all(dir).map_err(msg)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700)).map_err(msg)?;
    }
    open(path)?.execute_batch(SCHEMA).map_err(msg)
}

#[derive(Debug, Serialize)]
pub struct Portrait {
    pub id: String,
    pub name: String,
    created: String,
    sha: String,
    point_sha: String,
    width: u32,
    height: u32,
}

fn portrait_row(row: &rusqlite::Row) -> rusqlite::Result<Portrait> {
    Ok(Portrait {
        id: row.get(0)?,
        name: row.get(1)?,
        created: row.get(2)?,
        sha: row.get(3)?,
        point_sha: row.get(4)?,
        width: row.get(5)?,
        height: row.get(6)?,
    })
}

pub fn import_photo(
    db: &Connection,
    name: &str,
    raw: &[u8],
    points: &[Point],
) -> Result<Portrait, String> {
    let name: String = name
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or_default()
        .trim()
        .chars()
        .take(255)
        .collect();
    let name = if name.is_empty() {
        "portrait".to_string()
    } else {
        name
    };
    let sha = digest(raw);
    let lookup = format!("SELECT {SUMMARY} FROM portrait WHERE name=? AND sha=?");
    if let Some(row) = db
        .query_row(&lookup, params![name, sha], portrait_row)
        .optional()
        .map_err(msg)?
    {
        return Ok(row);
    }
    let (original, mime) = engine::decode(raw)?;
    engine::validate_points(points)?;
    let points = serde_json::to_string(points).map_err(msg)?;
    let point_sha = digest(points.as_bytes());
    let id = new_id();
    let (w, h) = original.dimensions();
    let display = engine::png(engine::thumbnail(original, 1400))?;
    db.execute(
        "INSERT INTO portrait VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(name,sha) DO NOTHING",
        params![
            id,
            name,
            now(),
            sha,
            point_sha,
            points,
            w,
            h,
            mime,
            raw,
            display
        ],
    )
    .map_err(msg)?;
    db.query_row(&lookup, params![name, sha], portrait_row)
        .map_err(msg)
}

#[derive(Deserialize)]
struct Source {
    id: String,
    raw_weight: f64,
    sha: Option<String>,
    point_sha: Option<String>,
}

#[derive(Deserialize)]
struct Composition {
    frame: String,
    alpha: String,
    sources: Vec<Source>,
    name: Option<String>,
    engine: Option<String>,
}

fn compose(db: &Connection, composition: Composition) -> Result<(Value, Vec<u8>), String> {
    if composition
        .engine
        .as_deref()
        .is_some_and(|v| v != engine::VERSION)
    {
        return Err("Recette d’une autre version du moteur. Change un réglage pour la recalculer avec le moteur Rust.".into());
    }
    if !matches!(composition.frame.as_str(), "face" | "full")
        || !matches!(composition.alpha.as_str(), "mean" | "max")
    {
        return Err("Réglages de rendu invalides.".into());
    }
    let mut seen = HashSet::new();
    let total: f64 = composition.sources.iter().map(|s| s.raw_weight).sum();
    if composition.sources.len() < 2
        || total <= 0.
        || composition
            .sources
            .iter()
            .any(|s| !valid_id(&s.id) || !(0. ..=1.).contains(&s.raw_weight) || !seen.insert(&s.id))
    {
        return Err("Choisis au moins deux portraits distincts avec des poids valides.".into());
    }
    let name = composition.name.as_deref().unwrap_or_default().trim();
    if name.chars().count() > 80 {
        return Err("Le nom doit contenir au plus 80 caractères.".into());
    }
    let mut inputs = Vec::new();
    let mut sources = Vec::new();
    for source in &composition.sources {
        let (p, points): (Portrait, String) = db
            .query_row(
                &format!("SELECT {SUMMARY},points FROM portrait WHERE id=?"),
                [&source.id],
                |r| Ok((portrait_row(r)?, r.get(7)?)),
            )
            .optional()
            .map_err(msg)?
            .ok_or("Portrait de la recette introuvable.")?;
        if source.sha.as_ref().is_some_and(|hash| *hash != p.sha)
            || source
                .point_sha
                .as_ref()
                .is_some_and(|hash| *hash != p.point_sha)
        {
            return Err("Les versions des sources ne correspondent pas à la recette.".into());
        }
        let points: Vec<Point> = serde_json::from_str(&points).map_err(msg)?;
        engine::validate_points(&points)?;
        if p.width == 0 || p.height == 0 {
            return Err("Dimensions invalides.".into());
        }
        let weight = source.raw_weight / total;
        inputs.push(Input {
            points,
            width: p.width,
            height: p.height,
            weight,
        });
        sources.push(json!({"id":p.id,"name":p.name,"sha":p.sha,"point_sha":p.point_sha,"raw_weight":source.raw_weight,"weight":weight}));
    }
    let size = engine::canvas_size(&inputs);
    let png = engine::render(
        &inputs,
        size,
        composition.frame == "face",
        composition.alpha == "max",
        |i| {
            db.query_row(
                "SELECT original FROM portrait WHERE id=?",
                [&composition.sources[i].id],
                |r| r.get(0),
            )
            .map_err(msg)
        },
    )?;
    let mut recipe = json!({"engine":engine::VERSION,"width":size.0,"height":size.1,"frame":composition.frame,"alpha":composition.alpha,"sources":sources});
    if !name.is_empty() {
        recipe["name"] = json!(name);
    }
    Ok((recipe, png))
}

pub struct Reply {
    pub body: Vec<u8>,
    pub mime: &'static str,
    pub size: Option<String>,
}
impl Reply {
    fn json(value: impl Serialize) -> Result<Self, String> {
        Ok(Self {
            body: serde_json::to_vec(&value).map_err(msg)?,
            mime: "application/json",
            size: None,
        })
    }
}

pub fn media(db: &Connection, path: &str) -> Result<(Reply, String), String> {
    if let Some(id) = path
        .strip_prefix("/api/history/")
        .and_then(|s| s.strip_suffix(".png"))
        .filter(|s| valid_id(s))
    {
        let body = db
            .query_row("SELECT png FROM result WHERE id=?", [id], |r| r.get(0))
            .optional()
            .map_err(msg)?
            .ok_or("Papillon introuvable.")?;
        return Ok((
            Reply {
                body,
                mime: "image/png",
                size: None,
            },
            format!("morphing-{}.png", &id[..8]),
        ));
    }
    let (id, kind) = path
        .strip_prefix("/api/portraits/")
        .and_then(|s| s.split_once('/'))
        .filter(|(s, _)| valid_id(s))
        .ok_or("Portrait introuvable.")?;
    match kind {
        "original" => {
            let (body, mime, name): (Vec<u8>, String, String) = db
                .query_row(
                    "SELECT original,mime,name FROM portrait WHERE id=?",
                    [id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .optional()
                .map_err(msg)?
                .ok_or("Portrait introuvable.")?;
            Ok((
                Reply {
                    body,
                    mime: if mime == "image/jpeg" {
                        "image/jpeg"
                    } else {
                        "image/png"
                    },
                    size: None,
                },
                name,
            ))
        }
        "display" => {
            let body = db
                .query_row("SELECT display FROM portrait WHERE id=?", [id], |r| {
                    r.get(0)
                })
                .optional()
                .map_err(msg)?
                .ok_or("Portrait introuvable.")?;
            Ok((
                Reply {
                    body,
                    mime: "image/png",
                    size: None,
                },
                format!("{id}.png"),
            ))
        }
        _ => Err("Image introuvable.".into()),
    }
}

const USES_PORTRAIT: &str = "EXISTS (SELECT 1 FROM json_each(result.recipe, '$.sources') AS source WHERE json_extract(source.value, '$.id') = ?1)";

pub fn request(
    db: &Connection,
    method: &str,
    path: &str,
    data: Option<Value>,
) -> Result<Reply, String> {
    match (method, path) {
        ("GET", "/api/portraits") => {
            let mut stmt = db
                .prepare(&format!(
                    "SELECT {SUMMARY} FROM portrait ORDER BY created DESC"
                ))
                .map_err(msg)?;
            Reply::json(
                stmt.query_map([], portrait_row)
                    .map_err(msg)?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(msg)?,
            )
        }
        ("GET", "/api/history") => {
            let mut stmt = db
                .prepare("SELECT id,created,recipe FROM result ORDER BY created DESC")
                .map_err(msg)?;
            let rows = stmt
                .query_map([], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                    ))
                })
                .map_err(msg)?;
            let rows = rows
                .map(|r| {
                    let (id, created, recipe) = r.map_err(msg)?;
                    let recipe: Value = serde_json::from_str(&recipe).map_err(msg)?;
                    Ok(json!({"id":id,"created":created,"recipe":recipe}))
                })
                .collect::<Result<Vec<_>, String>>()?;
            Reply::json(rows)
        }
        ("GET", p) if p.starts_with("/api/portraits/") && p.ends_with("/points") => {
            let id = p
                .trim_start_matches("/api/portraits/")
                .trim_end_matches("/points");
            if !valid_id(id) {
                return Err("Portrait introuvable.".into());
            }
            let points: String = db
                .query_row("SELECT points FROM portrait WHERE id=?", [id], |r| r.get(0))
                .optional()
                .map_err(msg)?
                .ok_or("Portrait introuvable.")?;
            Ok(Reply {
                body: points.into_bytes(),
                mime: "application/json",
                size: None,
            })
        }
        ("GET" | "DELETE", p) if p.starts_with("/api/portraits/") => {
            let id = &p["/api/portraits/".len()..];
            let tx = rusqlite::Transaction::new_unchecked(
                db,
                if method == "DELETE" {
                    TransactionBehavior::Immediate
                } else {
                    TransactionBehavior::Deferred
                },
            )
            .map_err(msg)?;
            if !valid_id(id)
                || !tx
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM portrait WHERE id=?)",
                        [id],
                        |r| r.get::<_, bool>(0),
                    )
                    .map_err(msg)?
            {
                return Err("Portrait introuvable.".into());
            }
            let butterflies: u64 = tx
                .query_row(
                    &format!("SELECT count(*) FROM result WHERE {USES_PORTRAIT}"),
                    [id],
                    |r| r.get(0),
                )
                .map_err(msg)?;
            if method == "DELETE" {
                if data
                    .as_ref()
                    .and_then(|v| v.get("butterflies"))
                    .and_then(Value::as_u64)
                    != Some(butterflies)
                {
                    return Err("Le nombre de papillons associés a changé. Relance la suppression pour le vérifier.".into());
                }
                tx.execute(&format!("DELETE FROM result WHERE {USES_PORTRAIT}"), [id])
                    .map_err(msg)?;
                tx.execute("DELETE FROM portrait WHERE id=?", [id])
                    .map_err(msg)?;
            }
            tx.commit().map_err(msg)?;
            Reply::json(json!({"butterflies": butterflies}))
        }
        ("POST", "/api/preview" | "/api/history") => {
            let c = serde_json::from_value(data.ok_or("Recette manquante.")?).map_err(msg)?;
            let (recipe, body) = compose(db, c)?;
            if path == "/api/preview" {
                return Ok(Reply {
                    body,
                    mime: "image/png",
                    size: Some(format!("{}x{}", recipe["width"], recipe["height"])),
                });
            }
            let id = new_id();
            let created = now();
            let inserted = db.execute(
                "INSERT INTO result SELECT ?1,?2,?3,?4 WHERE NOT EXISTS (
                    SELECT 1 FROM json_each(?3, '$.sources') AS source
                    WHERE NOT EXISTS (SELECT 1 FROM portrait WHERE id=json_extract(source.value, '$.id')))",
                params![id, created, recipe.to_string(), body],
            )
            .map_err(msg)?;
            if inserted == 0 {
                return Err("Un portrait de la recette a été supprimé.".into());
            }
            Reply::json(json!({"id":id,"created":created,"recipe":recipe}))
        }
        ("DELETE", p) if p.starts_with("/api/history/") => {
            let id = &p["/api/history/".len()..];
            if !valid_id(id)
                || db
                    .execute("DELETE FROM result WHERE id=?", [id])
                    .map_err(msg)?
                    == 0
            {
                return Err("Papillon introuvable.".into());
            }
            Reply::json(Value::Null)
        }
        _ => Err("Commande inconnue.".into()),
    }
}

pub fn export_db(db: &Connection, destination: &Path) -> Result<(), String> {
    let temp =
        tempfile::NamedTempFile::new_in(destination.parent().ok_or("Destination invalide.")?)
            .map_err(msg)?;
    {
        let mut copy = open(temp.path())?;
        Backup::new(db, &mut copy)
            .map_err(msg)?
            .run_to_completion(128, Duration::from_millis(10), None)
            .map_err(msg)?;
    }
    temp.as_file().sync_all().map_err(msg)?;
    temp.persist_noclobber(destination).map_err(|e| {
        format!(
            "Impossible d’exporter sans écraser un fichier : {}",
            e.error
        )
    })?;
    Ok(())
}

pub fn import_db(db: &mut Connection, source: &Path) -> Result<(), String> {
    let mut source =
        Connection::open_with_flags(source, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(msg)?;
    source
        .execute_batch("PRAGMA trusted_schema=OFF; PRAGMA query_only=ON;")
        .map_err(msg)?;
    let snapshot = source.transaction().map_err(msg)?;
    let target = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(msg)?;
    let count: u64 = target
        .query_row(
            "SELECT (SELECT count(*) FROM portrait)+(SELECT count(*) FROM result)",
            [],
            |r| r.get(0),
        )
        .map_err(msg)?;
    if count > 0 {
        return Err("Import réservé à une bibliothèque vide. Tes données actuelles n’ont pas été modifiées.".into());
    }
    for (table, columns, n) in [
        ("portrait", PORTRAIT_COLUMNS, 11),
        ("result", RESULT_COLUMNS, 4),
    ] {
        let kind: Option<String> = snapshot
            .query_row(
                "SELECT type FROM sqlite_schema WHERE name=?",
                [table],
                |r| r.get(0),
            )
            .optional()
            .map_err(msg)?;
        if kind.as_deref() != Some("table") {
            return Err("Ce fichier n’est pas une bibliothèque Chrysalide.".into());
        }
        let mut query = snapshot
            .prepare(&format!("SELECT {columns} FROM {table}"))
            .map_err(msg)?;
        let placeholders = vec!["?"; n].join(",");
        let mut insert = target
            .prepare(&format!(
                "INSERT INTO {table} ({columns}) VALUES ({placeholders})"
            ))
            .map_err(msg)?;
        let mut rows = query.query([]).map_err(msg)?;
        while let Some(row) = rows.next().map_err(msg)? {
            let id: String = row.get(0).map_err(msg)?;
            if !valid_id(&id) {
                return Err("Identifiant invalide dans la sauvegarde.".into());
            }
            let values = (0..n)
                .map(|i| row.get::<_, SqlValue>(i))
                .collect::<Result<Vec<_>, _>>()
                .map_err(msg)?;
            insert.execute(params_from_iter(values)).map_err(msg)?;
        }
    }
    target.commit().map_err(msg)
}

pub fn save_media(path: &Path, body: &[u8]) -> Result<(), String> {
    let mut temp = tempfile::NamedTempFile::new_in(path.parent().ok_or("Destination invalide.")?)
        .map_err(msg)?;
    temp.write_all(body).map_err(msg)?;
    temp.persist(path).map_err(msg)?;
    Ok(())
}
