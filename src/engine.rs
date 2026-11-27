use image::{
    DynamicImage, GenericImageView, ImageDecoder, ImageFormat, ImageReader, RgbaImage,
    imageops::FilterType,
};
use rayon::prelude::*;
use std::io::Cursor;

pub const VERSION: &str = "chrysalide-rust-1";
pub const UPLOAD_LIMIT: usize = 24 * 1024 * 1024;
pub type Point = [f32; 2];
const FEATURES: &[&[usize]] = &[
    &[10, 127, 234, 172, 152, 397, 454, 356, 10],
    &[70, 105, 107],
    &[336, 334, 300],
    &[33, 159, 133, 145, 33],
    &[362, 386, 263, 374, 362],
    &[168, 6, 1],
    &[98, 2, 327],
    &[61, 40, 0, 270, 291, 321, 17, 91, 61],
    &[78, 13, 308, 14, 78],
];
const OVAL: [usize; 36] = [
    10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152,
    148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109,
];

pub fn decode(bytes: &[u8]) -> Result<(DynamicImage, &'static str), String> {
    if bytes.len() > UPLOAD_LIMIT {
        return Err("Fichier trop volumineux (24 Mio maximum).".into());
    }
    let invalid = || "Image JPEG ou PNG illisible.".to_string();
    let format = image::guess_format(bytes).map_err(|_| invalid())?;
    let mime = match format {
        ImageFormat::Jpeg => "image/jpeg",
        ImageFormat::Png => "image/png",
        _ => return Err(invalid()),
    };
    let mut decoder = ImageReader::with_format(Cursor::new(bytes), format)
        .into_decoder()
        .map_err(|_| invalid())?;
    let (w, h) = decoder.dimensions();
    if u64::from(w) * u64::from(h) > 32_000_000 {
        return Err("Image trop grande (32 mégapixels maximum).".into());
    }
    let orientation = decoder.orientation().map_err(|_| invalid())?;
    let mut image = DynamicImage::from_decoder(decoder).map_err(|_| invalid())?;
    image.apply_orientation(orientation);
    Ok((image, mime))
}

pub fn png(image: RgbaImage) -> Result<Vec<u8>, String> {
    let mut bytes = Cursor::new(Vec::new());
    DynamicImage::ImageRgba8(image)
        .write_to(&mut bytes, ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    Ok(bytes.into_inner())
}

pub fn thumbnail(image: DynamicImage, max: u32) -> RgbaImage {
    if image.width().max(image.height()) <= max {
        image.into_rgba8()
    } else {
        image.resize(max, max, FilterType::Lanczos3).into_rgba8()
    }
}

pub fn validate_points(points: &[Point]) -> Result<(), String> {
    if points.len() != 478
        || points
            .iter()
            .flatten()
            .any(|p| !p.is_finite() || p.abs() > 10.)
    {
        return Err("Repères faciaux invalides.".into());
    }
    Ok(())
}

pub struct Input {
    pub points: Vec<Point>,
    pub width: u32,
    pub height: u32,
    pub weight: f64,
}

pub fn canvas_size(inputs: &[Input]) -> (u32, u32) {
    let ratio = inputs
        .iter()
        .filter(|p| p.weight > 0.)
        .map(|p| p.weight * (f64::from(p.width) / f64::from(p.height)).ln())
        .sum::<f64>()
        .exp();
    if ratio >= 1. {
        (640, (640. / ratio).round_ties_even().max(2.) as u32)
    } else {
        ((640. * ratio).round_ties_even().max(2.) as u32, 640)
    }
}

fn placement(input: &Input, (w, h): (u32, u32)) -> ((u32, u32), (u32, u32), Vec<Point>) {
    let scale = (f64::from(w) / f64::from(input.width)).min(f64::from(h) / f64::from(input.height));
    let iw = (f64::from(input.width) * scale).round_ties_even().max(1.) as u32;
    let ih = (f64::from(input.height) * scale).round_ties_even().max(1.) as u32;
    let (x, y) = ((w - iw) / 2, (h - ih) / 2);
    let points = input
        .points
        .iter()
        .map(|p| [p[0] * iw as f32 + x as f32, p[1] * ih as f32 + y as f32])
        .collect();
    ((iw, ih), (x, y), points)
}

type Segment = [Point; 2];
type Pixel = [f32; 4];

fn segments(points: &[Point], (w, h): (u32, u32)) -> Vec<Segment> {
    let (x, y) = ((w - 1) as f32, (h - 1) as f32);
    FEATURES
        .iter()
        .flat_map(|chain| chain.windows(2).map(|idx| [points[idx[0]], points[idx[1]]]))
        .chain([
            [[0., 0.], [x, 0.]],
            [[0., y], [x, y]],
            [[0., 0.], [0., y]],
            [[x, 0.], [x, y]],
        ])
        .collect()
}

fn bilinear(pixels: &[Pixel], (w, h): (u32, u32), x: f32, y: f32) -> Pixel {
    let (x, y) = (x.clamp(0., (w - 1) as f32), y.clamp(0., (h - 1) as f32));
    let (x0, y0) = (x as u32, y as u32);
    let (x1, y1) = ((x0 + 1).min(w - 1), (y0 + 1).min(h - 1));
    let (fx, fy) = (x - x0 as f32, y - y0 as f32);
    let at = |x, y| pixels[(y * w + x) as usize];
    let (a, b, c, d) = (at(x0, y0), at(x1, y0), at(x0, y1), at(x1, y1));
    std::array::from_fn(|i| {
        (1. - fy) * ((1. - fx) * a[i] + fx * b[i]) + fy * ((1. - fx) * c[i] + fx * d[i])
    })
}

struct Mapping {
    p: Point,
    source: Point,
    dx: f32,
    dy: f32,
    sx: f32,
    sy: f32,
    length: f32,
    sl: f32,
}

fn mappings(source: &[Segment], target: &[Segment]) -> Vec<Mapping> {
    source
        .iter()
        .zip(target)
        .filter_map(|([sp, sq], [p, q])| {
            let (dx, dy, sx, sy) = (q[0] - p[0], q[1] - p[1], sq[0] - sp[0], sq[1] - sp[1]);
            let (length, sl) = (dx.hypot(dy), sx.hypot(sy));
            (length.min(sl) >= 1e-4).then_some(Mapping {
                p: *p,
                source: *sp,
                dx,
                dy,
                sx,
                sy,
                length,
                sl,
            })
        })
        .collect()
}

fn warp(pixels: &[Pixel], size: (u32, u32), maps: &[Mapping], x: f32, y: f32) -> Pixel {
    let (mut dx, mut dy, mut total) = (0., 0., 0.);
    let a = 0.005 * size.0.min(size.1) as f32;
    for m in maps {
        let (rx, ry) = (x - m.p[0], y - m.p[1]);
        let u = (rx * m.dx + ry * m.dy) / (m.length * m.length);
        let v = (ry * m.dx - rx * m.dy) / m.length;
        let bx = m.source[0] + u * m.sx - v * m.sy / m.sl;
        let by = m.source[1] + u * m.sy + v * m.sx / m.sl;
        let t = u.clamp(0., 1.);
        let (ex, ey) = (rx - t * m.dx, ry - t * m.dy);
        let q = a + (ex * ex + ey * ey).sqrt();
        let weight = m.length / (q * q);
        dx += (bx - x) * weight;
        dy += (by - y) * weight;
        total += weight;
    }
    if total > 0. {
        bilinear(pixels, size, x + dx / total, y + dy / total)
    } else {
        bilinear(pixels, size, x, y)
    }
}

fn face_opacity(outline: &[Point], x: f32, y: f32, feather: f32) -> f32 {
    let mut inside = false;
    let mut distance = f32::INFINITY;
    for (p, q) in outline.iter().zip(outline.iter().cycle().skip(1)) {
        let (vx, vy) = (q[0] - p[0], q[1] - p[1]);
        let (rx, ry) = (x - p[0], y - p[1]);
        if (p[1] > y) != (q[1] > y) && x < p[0] + (y - p[1]) * vx / vy {
            inside = !inside;
        }
        let len = vx * vx + vy * vy;
        let t = if len > 0. {
            ((rx * vx + ry * vy) / len).clamp(0., 1.)
        } else {
            0.
        };
        distance = distance.min((rx - t * vx).powi(2) + (ry - t * vy).powi(2));
    }
    if !inside {
        return 0.;
    }
    let t = (distance.sqrt() / feather).clamp(0., 1.);
    t * t * (3. - 2. * t)
}

pub fn render(
    inputs: &[Input],
    size: (u32, u32),
    face: bool,
    max_alpha: bool,
    mut load: impl FnMut(usize) -> Result<Vec<u8>, String>,
) -> Result<Vec<u8>, String> {
    let (w, h) = size;
    let active = inputs
        .iter()
        .enumerate()
        .filter(|(_, p)| p.weight > 0.)
        .map(|(i, p)| (i, p, placement(p, size)))
        .collect::<Vec<_>>();
    let target: Vec<Point> = (0..478)
        .map(|i| {
            std::array::from_fn(|axis| {
                active
                    .iter()
                    .map(|(_, p, (_, _, points))| p.weight * f64::from(points[i][axis]))
                    .sum::<f64>() as f32
            })
        })
        .collect();
    let destination = segments(&target, size);
    let mut blend = vec![([0.; 4], 0.); (w * h) as usize];
    for (i, input, (inner, offset, points)) in &active {
        let (image, _) = decode(&load(*i)?)?;
        if image.dimensions() != (input.width, input.height) {
            return Err("Dimensions du portrait incohérentes.".into());
        }
        let image = image
            .resize_exact(inner.0, inner.1, FilterType::Lanczos3)
            .into_rgba8();
        let mut canvas = vec![[0.; 4]; blend.len()];
        for (x, y, p) in image.enumerate_pixels() {
            let a = f32::from(p[3]);
            canvas[((y + offset.1) * w + x + offset.0) as usize] = [
                f32::from(p[0]) * a / 255.,
                f32::from(p[1]) * a / 255.,
                f32::from(p[2]) * a / 255.,
                a,
            ];
        }
        let maps = mappings(&segments(points, size), &destination);
        blend
            .par_iter_mut()
            .enumerate()
            .for_each(|(j, (sum, maximum))| {
                let p = if active.len() == 1 {
                    canvas[j]
                } else {
                    warp(
                        &canvas,
                        size,
                        &maps,
                        (j as u32 % w) as f32,
                        (j as u32 / w) as f32,
                    )
                };
                for k in 0..4 {
                    sum[k] += p[k] * input.weight as f32;
                }
                if p[3] > *maximum {
                    *maximum = p[3];
                }
            });
    }
    let outline = OVAL.map(|i| target[i]);
    let span = |axis: usize| {
        outline
            .iter()
            .map(|p| p[axis])
            .fold(f32::NEG_INFINITY, f32::max)
            - outline
                .iter()
                .map(|p| p[axis])
                .fold(f32::INFINITY, f32::min)
    };
    let feather = (span(0).min(span(1)) / 32.).clamp(1., 6.);
    let to_u8 = |value: f32| value.round_ties_even().clamp(0., 255.) as u8;
    let bytes: Vec<u8> = blend
        .into_par_iter()
        .enumerate()
        .flat_map_iter(|(i, (sum, max))| {
            let mut a = if max_alpha { max } else { sum[3] };
            if face {
                a *= face_opacity(
                    &outline,
                    (i as u32 % w) as f32 + 0.5,
                    (i as u32 / w) as f32 + 0.5,
                    feather,
                );
            }
            let alpha = to_u8(a);
            if alpha == 0 || sum[3] <= 0. {
                [0; 4]
            } else {
                [
                    to_u8(sum[0] * 255. / sum[3]),
                    to_u8(sum[1] * 255. / sum[3]),
                    to_u8(sum[2] * 255. / sum[3]),
                    alpha,
                ]
            }
        })
        .collect();
    png(RgbaImage::from_raw(w, h, bytes).ok_or("Rendu invalide.")?)
}
