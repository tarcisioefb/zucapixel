# Elementor Companion

App desktop (Tauri) image-first para preparar imagens para Elementor/WordPress: fila de conversão, presets (resize, WebP/AVIF, **compressão JPG/PNG estilo iLoveIMG**) e export.

## Stack

- Tauri v2 + React 18 + Vite 5 + TypeScript 5
- Tailwind 3 + Zustand
- Plugins Tauri: fs, dialog, opener, shell

## Como rodar

```bash
npm install
npm run tauri dev
```

Build:

```bash
npm run tauri build
```

## ffmpeg (sidecar LGPL)

- Colocar o binário em `src-tauri/binaries/` como `ffmpeg-<target-triple>` (ex.: `ffmpeg-x86_64-apple-darwin`, `ffmpeg-x86_64-pc-windows-msvc.exe`).
- Usar build LGPL (sem `--enable-gpl`), ex.: gyan.dev (Windows) / evermeet / homebrew bottle oficial.
- O frontend chama via `plugin-shell` / comando sidecar; nenhum binário versionado (ver `.gitignore`).
