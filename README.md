# ZucaPixel

App desktop (Tauri) para deixar mídias prontas pra web: conversão de imagens (resize opcional, WebP/AVIF/JPG), **compressão JPG/PNG estilo iLoveIMG** e vídeo web-friendly (MP4/WebM/AVIF + poster). Saída em `Imagens/Otimizadas`.

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
