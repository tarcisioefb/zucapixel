//! Backend Tauri v2 — Elementor Companion (image-first, lógica mínima).
//! Todos os comentários em pt-BR. Compile-safe: sem crates extras além de
//! tauri / plugins / serde / tokio (sem ffprobe-deps, sem image-deps).

use serde::Serialize;
use std::path::Path;
use tauri::Emitter;
use tauri_plugin_shell::ShellExt;

// ---------------------------------------------------------------------------
// Tipos (contrato com o frontend)
// ---------------------------------------------------------------------------

/// Resultado de `probe_media`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProbeResult {
    kind: String,
    width: Option<u32>,
    height: Option<u32>,
    size_bytes: u64,
    duration_sec: Option<f64>,
}

/// Payload do evento `ffmpeg-progress`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FfmpegProgress {
    job_id: String,
    progress: f64, // 0.0 ..= 1.0
}

/// Item retornado por `list_outputs`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OutputItem {
    name: String,
    path: String,
    size_bytes: u64,
}

// ---------------------------------------------------------------------------
// Helpers internos
// ---------------------------------------------------------------------------

/// Classifica o tipo de mídia pela extensão (fase 1).
/// Fase 2: trocar por ffprobe/vips real sem mudar o contrato.
fn kind_from_extension(path: &Path) -> String {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "png" | "jpg" | "jpeg" | "webp" | "avif" | "tif" | "tiff" | "gif" | "svg" => {
            "image".to_string()
        }
        "mp4" | "mov" | "m4v" | "webm" | "mkv" => "video".to_string(),
        _ => "unknown".to_string(),
    }
}

/// Converte `HH:MM:SS.cs` (linha `Duration:` do ffmpeg) para segundos.
fn parse_ffmpeg_duration(line: &str) -> Option<f64> {
    // Ex.: "  Duration: 00:00:12.50, start: 0.000000, bitrate: ..."
    let marker = "Duration:";
    let start = line.find(marker)? + marker.len();
    let rest = line[start..].trim();
    let token = rest.split(',').next()?.trim(); // "00:00:12.50"
    let parts: Vec<&str> = token.split(':').collect();
    if parts.len() != 3 {
        return None;
    }
    let h: f64 = parts[0].parse().ok()?;
    let m: f64 = parts[1].parse().ok()?;
    let s: f64 = parts[2].parse().ok()?;
    Some(h * 3600.0 + m * 60.0 + s)
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Saudação simples (smoke test do bridge frontend <-> Rust).
#[tauri::command]
fn greeting(name: Option<String>) -> String {
    match name {
        Some(n) if !n.trim().is_empty() => format!("Olá, {}! Backend pronto.", n.trim()),
        _ => "Olá! Backend pronto.".to_string(),
    }
}

/// Inspeciona um arquivo: tipo (por extensão), tamanho em bytes.
/// Largura/altura/duração ficam `None` na fase 1 (hook p/ ffprobe/vips na fase 2).
#[tauri::command]
fn probe_media(path: String) -> Result<ProbeResult, String> {
    let p = Path::new(&path);

    // Tamanho via metadados do FS (sem ler o arquivo inteiro).
    let meta = std::fs::metadata(p).map_err(|e| format!("Falha ao ler metadados: {e}"))?;

    if !meta.is_file() {
        return Err("Caminho não é um arquivo.".to_string());
    }

    Ok(ProbeResult {
        kind: kind_from_extension(p),
        width: None,        // fase 2: vipsheader / ffprobe
        height: None,       // fase 2: vipsheader / ffprobe
        size_bytes: meta.len(),
        duration_sec: None, // fase 2: ffprobe (vídeo)
    })
}

/// Roda o sidecar `ffmpeg` (externalBin `binaries/ffmpeg`) com os args dados e emite progresso.
///
/// Evento: `ffmpeg-progress` -> `{ job_id, progress: 0.0..=1.0 }`.
/// Progresso é estimado via `out_time_ms=...` dividido pela `Duration:` do log.
/// Se a duração for desconhecida, emite valores crescentes capped em 0.99
/// até concluir (quando emite 1.0).
#[tauri::command]
async fn run_ffmpeg(
    app: tauri::AppHandle,
    args: Vec<String>,
    job_id: String,
) -> Result<String, String> {
    use tauri_plugin_shell::process::CommandEvent;

    // Monta o sidecar empacotado em `src-tauri/binaries/ffmpeg-*`.
    // NOTA: `sidecar()` espera só o nome-base ("ffmpeg"), não o path do
    // `externalBin` ("binaries/ffmpeg"). Ver `develop/sidecar` na doc Tauri v2.
    let sidecar = app
        .shell()
        .sidecar("ffmpeg")
        .map_err(|e| format!("Sidecar ffmpeg indisponível: {e}"))?;

    let (mut rx, _child) = sidecar
        .args(&args)
        .spawn()
        .map_err(|e| format!("Falha ao iniciar ffmpeg: {e}"))?;

    // Estado do parse: duração total (segundos) quando o ffmpeg logar.
    let mut duration_sec: Option<f64> = None;
    // Fallback monotônico caso `Duration:` não apareça.
    let mut fallback_ticks: u64 = 0;

    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stderr(line) | CommandEvent::Stdout(line) => {
                let text = String::from_utf8_lossy(&line).to_string();

                // 1) Captura a duração total uma vez.
                if duration_sec.is_none() {
                    if let Some(d) = parse_ffmpeg_duration(&text) {
                        if d > 0.0 {
                            duration_sec = Some(d);
                        }
                    }
                }

                // 2) Cada `out_time_ms=N` vira um emit de progresso.
                for chunk in text.split("out_time_ms=") {
                    let digits: String = chunk.chars().take_while(|c| c.is_ascii_digit()).collect();
                    if digits.is_empty() {
                        continue;
                    }
                    if let Ok(out_ms) = digits.parse::<f64>() {
                        let progress = match duration_sec {
                            Some(d) if d > 0.0 => (out_ms / (d * 1_000_000.0)).clamp(0.0, 1.0),
                            _ => {
                                fallback_ticks += 1;
                                // Cresce devagar e nunca chega a 1.0 antes do fim.
                                (fallback_ticks as f64 * 0.02).clamp(0.0, 0.99)
                            }
                        };
                        let _ = app.emit(
                            "ffmpeg-progress",
                            FfmpegProgress {
                                job_id: job_id.clone(),
                                progress,
                            },
                        );
                    }
                }
            }
            CommandEvent::Error(msg) => {
                return Err(format!("Erro no ffmpeg: {msg}"));
            }
            CommandEvent::Terminated(status) => {
                if let Some(code) = status.code {
                    if code != 0 {
                        return Err(format!("ffmpeg saiu com código {code}"));
                    }
                }
                break;
            }
            _ => {}
        }
    }

    // Conclusão: progresso 1.0 para fechar a barra do job.
    let _ = app.emit(
        "ffmpeg-progress",
        FfmpegProgress {
            job_id: job_id.clone(),
            progress: 1.0,
        },
    );

    Ok(job_id)
}

/// Devolve o pixel format do primeiro stream de vídeo (`ffmpeg -i`).
/// Usado para detectar alpha (rgba/bgra/yuva…) antes de escolher o encoder:
/// o libaom-av1/svtav1 deste sidecar NÃO aceitam YUVA — o front pula o AVIF
/// quando há transparência (WebP preserva via yuva420p).
#[tauri::command]
async fn probe_pix_fmt(app: tauri::AppHandle, path: String) -> Result<Option<String>, String> {
    let output = app
        .shell()
        .sidecar("ffmpeg")
        .map_err(|e| format!("Sidecar ffmpeg indisponível: {e}"))?
        .args(["-hide_banner", "-i", &path, "-f", "null", "-"])
        .output()
        .await
        .map_err(|e| format!("Falha ao inspecionar mídia: {e}"))?;

    let stderr = String::from_utf8_lossy(&output.stderr);
    for line in stderr.lines() {
        if let Some(idx) = line.find("Video:") {
            // "png, rgba(pc, ..." -> codec, depois pix_fmt
            let rest = line[idx + "Video:".len()..].trim_start();
            let mut parts = rest.split(',');
            parts.next(); // codec ("png")
            if let Some(pix) = parts.next() {
                let token: String = pix
                    .trim()
                    .split(|c: char| c == '(' || c.is_whitespace())
                    .next()
                    .unwrap_or("")
                    .to_ascii_lowercase();
                if !token.is_empty() {
                    return Ok(Some(token));
                }
            }
            break;
        }
    }
    Ok(None)
}

/// Inspeciona um vídeo: duração (s), largura e altura (via `ffmpeg -i`).
/// Usado pelo preflight (corte em 6/8/10s) e pela barra de progresso.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct VideoProbe {
    duration_sec: Option<f64>,
    width: Option<u32>,
    height: Option<u32>,
}

#[tauri::command]
async fn probe_video(app: tauri::AppHandle, path: String) -> Result<VideoProbe, String> {
    let output = app
        .shell()
        .sidecar("ffmpeg")
        .map_err(|e| format!("Sidecar ffmpeg indisponível: {e}"))?
        .args(["-hide_banner", "-i", &path, "-f", "null", "-"])
        .output()
        .await
        .map_err(|e| format!("Falha ao inspecionar vídeo: {e}"))?;

    let stderr = String::from_utf8_lossy(&output.stderr);
    let mut duration_sec: Option<f64> = None;
    let mut width: Option<u32> = None;
    let mut height: Option<u32> = None;

    for line in stderr.lines() {
        if duration_sec.is_none() {
            duration_sec = parse_ffmpeg_duration(line);
        }
        // "Video: h264 (...), yuv420p(...), 1920x1080 [SAR ..." — acha WxH.
        if width.is_none() && line.contains("Video:") {
            for part in line.split(',') {
                let token = part.trim().split_whitespace().next().unwrap_or("");
                if let Some((w, h)) = token.split_once('x') {
                    if let (Ok(w), Ok(h)) = (w.parse::<u32>(), h.parse::<u32>()) {
                        if w > 0 && h > 0 && w <= 16384 && h <= 16384 {
                            width = Some(w);
                            height = Some(h);
                            break;
                        }
                    }
                }
            }
        }
    }

    Ok(VideoProbe {
        duration_sec,
        width,
        height,
    })
}

/// Roda o sidecar `binaries/avifenc` (libavif de referência, COM alpha).
/// Mesmo protocolo de progresso do `run_ffmpeg` (avifenc não emite
/// `out_time_ms`, então a barra usa o fallback até concluir com 1.0).
#[tauri::command]
async fn run_avifenc(
    app: tauri::AppHandle,
    args: Vec<String>,
    job_id: String,
) -> Result<String, String> {
    use tauri_plugin_shell::process::CommandEvent;

    let sidecar = app
        .shell()
        .sidecar("avifenc")
        .map_err(|e| format!("Sidecar avifenc indisponível: {e}"))?;

    let (mut rx, _child) = sidecar
        .args(&args)
        .spawn()
        .map_err(|e| format!("Falha ao iniciar avifenc: {e}"))?;

    let mut fallback_ticks: u64 = 0;

    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stderr(_) | CommandEvent::Stdout(_) => {
                fallback_ticks += 1;
                let progress = (fallback_ticks as f64 * 0.05).clamp(0.0, 0.99);
                let _ = app.emit(
                    "ffmpeg-progress",
                    FfmpegProgress {
                        job_id: job_id.clone(),
                        progress,
                    },
                );
            }
            CommandEvent::Error(msg) => {
                return Err(format!("Erro no avifenc: {msg}"));
            }
            CommandEvent::Terminated(status) => {
                if let Some(code) = status.code {
                    if code != 0 {
                        return Err(format!("avifenc saiu com código {code}"));
                    }
                }
                break;
            }
            _ => {}
        }
    }

    let _ = app.emit(
        "ffmpeg-progress",
        FfmpegProgress {
            job_id: job_id.clone(),
            progress: 1.0,
        },
    );

    Ok(job_id)
}

/// Roda o sidecar `binaries/pngquant` (quantização PNG lossy p/ paleta 256).
/// Mesmo protocolo de progresso dos demais (fallback até 1.0 ao concluir).
/// Com `--skip-if-larger`, saída maior nem é escrita (código 98) — o front
/// detecta pela ausência do arquivo e marca como descartado.
#[tauri::command]
async fn run_pngquant(
    app: tauri::AppHandle,
    args: Vec<String>,
    job_id: String,
) -> Result<String, String> {
    use tauri_plugin_shell::process::CommandEvent;

    let sidecar = app
        .shell()
        .sidecar("pngquant")
        .map_err(|e| format!("Sidecar pngquant indisponível: {e}"))?;

    let (mut rx, _child) = sidecar
        .args(&args)
        .spawn()
        .map_err(|e| format!("Falha ao iniciar pngquant: {e}"))?;

    let mut fallback_ticks: u64 = 0;

    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stderr(_) | CommandEvent::Stdout(_) => {
                fallback_ticks += 1;
                let progress = (fallback_ticks as f64 * 0.05).clamp(0.0, 0.99);
                let _ = app.emit(
                    "ffmpeg-progress",
                    FfmpegProgress {
                        job_id: job_id.clone(),
                        progress,
                    },
                );
            }
            CommandEvent::Error(msg) => {
                return Err(format!("Erro no pngquant: {msg}"));
            }
            CommandEvent::Terminated(status) => {
                if let Some(code) = status.code {
                    // 98 = --skip-if-larger pulou (saída seria maior): não é erro.
                    if code != 0 && code != 98 {
                        return Err(format!("pngquant saiu com código {code}"));
                    }
                }
                break;
            }
            _ => {}
        }
    }

    let _ = app.emit(
        "ffmpeg-progress",
        FfmpegProgress {
            job_id: job_id.clone(),
            progress: 1.0,
        },
    );

    Ok(job_id)
}

/// Lista arquivos de um diretório de saída (`$APPDATA/out`, `~/Downloads`, ...).
/// Retorna nome + caminho + tamanho. Ignora subdiretórios e erros por arquivo.
#[tauri::command]
fn list_outputs(out_dir: String) -> Result<Vec<OutputItem>, String> {
    let dir = Path::new(&out_dir);
    let entries = std::fs::read_dir(dir).map_err(|e| format!("Falha ao listar pasta: {e}"))?;

    let mut items = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        // Tamanho individual: se falhar, pula o arquivo sem abortar a lista.
        let size_bytes = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        items.push(OutputItem {
            name: path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("arquivo")
                .to_string(),
            path: path.to_string_lossy().to_string(),
            size_bytes,
        });
    }

    // Ordem estável por nome para a UI não "piscar".
    items.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(items)
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            greeting,
            probe_media,
            probe_pix_fmt,
            probe_video,
            run_ffmpeg,
            run_avifenc,
            run_pngquant,
            list_outputs
        ])
        .run(tauri::generate_context!())
        .expect("Falha ao iniciar o Elementor Companion");
}
