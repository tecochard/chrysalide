use chrysalide::{engine, store};
use image::{Rgb, RgbImage, Rgba, RgbaImage, codecs::jpeg::JpegEncoder};
use rusqlite::params;
use serde_json::{Value, json};
use std::f32::consts::{FRAC_PI_2, TAU};

const TEST_OVAL: [usize; 36] = [
    10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152,
    148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109,
];
const RADIUS_X: f32 = 0.25;
const RADIUS_Y: f32 = 0.32;

fn synthetic_points(center_x: f32) -> Vec<engine::Point> {
    let mut points = vec![[center_x, 0.5]; 478];
    for (i, index) in TEST_OVAL.into_iter().enumerate() {
        let angle = TAU * i as f32 / TEST_OVAL.len() as f32 - FRAC_PI_2;
        points[index] = [
            center_x + RADIUS_X * angle.cos(),
            0.5 + RADIUS_Y * angle.sin(),
        ];
    }
    points
}

fn parse(reply: store::Reply) -> Value {
    serde_json::from_slice(&reply.body).unwrap()
}

#[test]
fn deleting_portrait_requires_current_count_and_removes_only_linked_results() {
    let tmp = tempfile::tempdir().unwrap();
    let base = tmp.path().join("test/atelier.sqlite3");
    store::init(&base).unwrap();
    let db = store::open(&base).unwrap();
    let ids = ["a".repeat(32), "b".repeat(32)];
    for id in &ids {
        db.execute("INSERT INTO portrait VALUES (?1,?1,'date','sha','point_sha','[]',1,1,'image/png',X'00',X'00')", [id]).unwrap();
    }
    for (id, sources) in [
        (
            "c".repeat(32),
            json!([{"id":ids[0],"raw_weight":0},{"id":ids[1]}]),
        ),
        ("d".repeat(32), json!([{"id":ids[1]}])),
    ] {
        db.execute(
            "INSERT INTO result VALUES (?1,'date',?2,X'00')",
            params![id, json!({"sources":sources}).to_string()],
        )
        .unwrap();
    }
    let path = format!("/api/portraits/{}", ids[0]);
    assert_eq!(
        parse(store::request(&db, "GET", &path, None).unwrap())["butterflies"],
        1
    );
    assert!(store::request(&db, "DELETE", &path, Some(json!({"butterflies":0}))).is_err());
    assert_eq!(
        parse(store::request(&db, "GET", "/api/history", None).unwrap())
            .as_array()
            .unwrap()
            .len(),
        2
    );
    store::request(&db, "DELETE", &path, Some(json!({"butterflies":1}))).unwrap();
    assert!(store::request(&db, "GET", &format!("{path}/points"), None).is_err());
    assert!(store::media(&db, &format!("{path}/original")).is_err());
    assert_eq!(
        parse(store::request(&db, "GET", "/api/history", None).unwrap())[0]["id"],
        "d".repeat(32)
    );
    let independent = format!("/api/portraits/{}", ids[1]);
    assert_eq!(
        parse(store::request(&db, "GET", &independent, None).unwrap())["butterflies"],
        1
    );
}

#[test]
fn render_and_transfer_library() {
    let tmp = tempfile::tempdir().unwrap();
    let base = tmp.path().join("original/atelier.sqlite3");
    store::init(&base).unwrap();
    let db = store::open(&base).unwrap();
    let mut one = Vec::new();
    JpegEncoder::new(&mut one)
        .encode_image(&RgbImage::from_pixel(64, 64, Rgb([200, 60, 40])))
        .unwrap();
    let two = engine::png(RgbaImage::from_pixel(64, 64, Rgba([40, 100, 200, 255]))).unwrap();
    let a = store::import_photo(&db, "carré rouge.jpg", &one, &synthetic_points(0.46)).unwrap();
    let b = store::import_photo(&db, "carré bleu.png", &two, &synthetic_points(0.54)).unwrap();
    let request = json!({"frame":"face", "alpha":"max", "name":"Écaille de lune", "sources":[{"id":a.id,"raw_weight":0.5},{"id":b.id,"raw_weight":0.5}]});
    let preview = store::request(&db, "POST", "/api/preview", Some(request.clone())).unwrap();
    assert_eq!(preview.size.as_deref(), Some("640x640"));
    let image = image::load_from_memory(&preview.body).unwrap().into_rgba8();
    assert_eq!(image.dimensions(), (640, 640));
    // Equal weights put the expected mask halfway between the two synthetic outlines.
    let (mut overlap, mut union) = (0, 0);
    for (x, y, actual) in image.enumerate_pixels() {
        let dx = ((x as f32 + 0.5) / 640.0 - 0.5) / RADIUS_X;
        let dy = ((y as f32 + 0.5) / 640.0 - 0.5) / RADIUS_Y;
        let (a, b) = (actual[3] >= 128, dx * dx + dy * dy <= 1.0);
        overlap += usize::from(a && b);
        union += usize::from(a || b);
    }
    assert!(overlap as f64 / union as f64 > 0.93);
    assert_eq!(image.get_pixel(0, 0)[3], 0);
    let center = image.get_pixel(320, 320);
    assert_eq!(center[3], 255);
    for (actual, expected) in center.0.into_iter().zip([120, 80, 120]) {
        assert!(
            actual.abs_diff(expected) <= 3,
            "unexpected blend: {center:?}"
        );
    }
    let saved = parse(store::request(&db, "POST", "/api/history", Some(request)).unwrap());
    let id = saved["id"].as_str().unwrap();
    let png = format!("/api/history/{id}.png");
    assert_eq!(store::media(&db, &png).unwrap().0.body, preview.body);

    let old_id = "123456789012345678901234567890ab";
    db.execute(
        "INSERT INTO result VALUES (?,?,?,?)",
        params![
            old_id,
            "2025-01-01T00:00:00.000000+00:00",
            json!({"engine":"atelier-1:legacy"}).to_string(),
            &preview.body
        ],
    )
    .unwrap();
    let backup = tmp.path().join("sauvegarde.sqlite3");
    store::export_db(&db, &backup).unwrap();
    assert!(store::export_db(&db, &backup).is_err());
    let dest = tmp.path().join("import/atelier.sqlite3");
    store::init(&dest).unwrap();
    let mut dest = store::open(&dest).unwrap();
    store::import_db(&mut dest, &backup).unwrap();
    assert!(store::import_db(&mut dest, &backup).is_err());
    let get = |db, path| parse(store::request(db, "GET", path, None).unwrap());
    assert_eq!(get(&db, "/api/portraits"), get(&dest, "/api/portraits"));
    assert_eq!(get(&db, "/api/history"), get(&dest, "/api/history"));
    let original = format!("/api/portraits/{}/original", a.id);
    assert_eq!(store::media(&dest, &original).unwrap().0.body, one);
    let points = format!("/api/portraits/{}/points", a.id);
    assert_eq!(get(&db, &points), get(&dest, &points));
    assert_eq!(
        store::media(&dest, &format!("/api/history/{old_id}.png"))
            .unwrap()
            .0
            .body,
        preview.body
    );
    store::request(&dest, "DELETE", &format!("/api/history/{id}"), None).unwrap();
    assert!(store::media(&dest, &png).is_err());
    assert!(store::media(&db, &png).is_ok());
}
