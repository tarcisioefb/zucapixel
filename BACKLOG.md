# ZucaPixel — Backlog

Foco: **imagem primeiro** (uso diário), vídeo como secundário.

## Feito
- [x] App desktop Tauri (ffmpeg 9.0.2 + avifenc 1.4.2 sidecars ARM64)
- [x] Converter imagens: resize opcional (800/1200/1920w/Original) + WebP/AVIF(c/ alpha)/JPG, nomes slugificados, saída em `Imagens/Otimizadas`, dedup `-2/-3` sem sobrescrever
- [x] Comprimir JPG/PNG estilo iLoveIMG (q slider, mantém dims/formato)
- [x] Tab Vídeo: MP4 + WebM VP9 + poster + AV1 opcional (incl. preset Original sem corte/resize), presets hero-light/bg-720p/hq-1080p/av1-ultra
- [x] Qualidade configurável (WebP 85 / AVIF 65 default, sliders por preset atrás de engrenagem)
- [x] Streaming assíncrono por formato + totais de economia por formato
- [x] Pre-flight (5MB hard, hero 150KB warn, upscale, WP -scaled 2560px)
- [x] Overlay de drop na janela inteira; correções: drop duplicado, transparência AVIF, jobId camelCase, fs.exists

## Must (MVP local, sem auth WP)
- [ ] Export `.zip` + `report.csv` (antes/depois, % economia)
- [ ] Presets por cliente (JSON local: prefixo, qualidades, pasta)

## Should (pós-MVP)
- [ ] PNG quantizado (pngquant/oxipng via vips sidecar ou oxipng estático — ffmpeg sozinho comprime pouco PNG)
- [ ] Detector duplicadas por hash (evita re-converter o mesmo arquivo)
- [ ] Audit URL (cola URL Elementor → checa LCP/lazy/dims/OG)
- [ ] `tauri build` → `.app`/`.dmg` instalável + updater

## Won't (agora)
- XML-RPC, escrita em `_elementor_data`, SEO meta via app, AVIF como único formato.
- WP Connect (upload automático via REST) — decisão do usuário: upload manual no WP.
- Tabela de alt + CSV — decisão do usuário: alt é escrito direto no WP, sem ganho em etapa extra no app.
- vips sidecar p/ AVIF (avifenc resolveu melhor).
