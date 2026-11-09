# Elementor Companion — Backlog

Foco: **imagem primeiro** (uso diário), vídeo como secundário.

## Must (MVP local, sem auth WP)
- [x] Smart Drop + rename slugify + resize (800/1200/1920w) + WebP/AVIF
- [x] **Comprimir JPG/PNG (estilo iLoveIMG)**: presets `compress-jpg` (q75, mantém dims) e `compress-png` (level 9, mantém dims); preflight modo compress aceita até 10MB e avisa economia esperada (-40/-70% JPG, -20/-50% PNG)
- [x] Tabela alt editável + export CSV
- [x] Pre-flight gate (peso/dims/nome/alt/upscale)
- [ ] Presets por cliente (JSON local)
- [ ] Export `.zip` + `report.csv` (antes/depois, % economia)

## Should (pós-MVP)
- [ ] Fase 2 AVIF/PNG batch via vips sidecar (pngquant/oxipng, mais taxa que ffmpeg)
- [ ] Video-to-Elementor (MP4 + WebM VP9 + poster + AV1 opt-in)
- [ ] Detector duplicadas por hash
- [ ] WP Connect via REST (`/wp-json/wp/v2/media` + `alt_text`, Application Passwords)
- [ ] Audit URL (LCP/lazy/dims)

## Won't (agora)
- XML-RPC, escrita em `_elementor_data`, SEO meta via app, AVIF como único formato.
