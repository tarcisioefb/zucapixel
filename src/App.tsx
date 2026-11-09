import { useState } from "react";
import type { ImagePreset } from "./lib/convert/presets";
import { CompressTab } from "./components/CompressTab";

// TODO(image): implementar src/lib/convert/presets.ts com os presets
// WebP/AVIF + larguras Elementor. Enquanto não existe, usa fallback vazio.
// (import type é apagado em build, então não quebra em runtime.)
const FALLBACK_PRESETS: ImagePreset[] = [];

type JobStatus = "na-fila" | "convertendo" | "pronto" | "erro";

type Job = {
  id: string;
  arquivo: string;
  preset: string;
  dimensoes: string;
  antes: string;
  depois: string;
  status: JobStatus;
};

type Tab = "Fila" | "Comprimir" | "Presets" | "Export";

const TABS: Tab[] = ["Fila", "Comprimir", "Presets", "Export"];

const STATUS_STYLE: Record<JobStatus, string> = {
  "na-fila": "bg-zinc-700/60 text-zinc-300",
  convertendo: "bg-amber-500/20 text-amber-300",
  pronto: "bg-emerald-500/20 text-emerald-300",
  erro: "bg-red-500/20 text-red-300",
};

const MOCK_JOBS: Job[] = [
  {
    id: "1",
    arquivo: "hero-homepage.png",
    preset: "Elementor WebP 1920",
    dimensoes: "1920×1080",
    antes: "2,4 MB",
    depois: "—",
    status: "na-fila",
  },
  {
    id: "2",
    arquivo: "galeria-produto-01.jpg",
    preset: "Elementor AVIF 1280",
    dimensoes: "1280×853",
    antes: "1,1 MB",
    depois: "—",
    status: "convertendo",
  },
];

export default function App() {
  const [tab, setTab] = useState<Tab>("Fila");
  const [jobs, setJobs] = useState<Job[]>(MOCK_JOBS);
  const [progresso, setProgresso] = useState(35);

  const presets = FALLBACK_PRESETS;
  void setProgresso;

  function removerJob(id: string) {
    setJobs((prev) => prev.filter((j) => j.id !== id));
  }

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Sidebar */}
      <aside className="flex w-56 shrink-0 flex-col border-r border-zinc-800 bg-zinc-900">
        <div className="px-5 pb-4 pt-6">
          <h1 className="text-sm font-bold tracking-wide">Elementor Companion</h1>
          <p className="mt-1 text-xs text-zinc-500">image-first</p>
        </div>
        <nav className="flex flex-col gap-1 px-3">
          {TABS.map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`rounded-lg px-3 py-2 text-left text-sm transition ${
                tab === t
                  ? "bg-zinc-800 font-medium text-white"
                  : "text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200"
              }`}
            >
              {t}
            </button>
          ))}
        </nav>
        <div className="mt-auto p-4 text-xs text-zinc-600">
          {presets.length === 0 ? (
            <p>presets: aguardando ./lib/convert/presets</p>
          ) : (
            <p>{presets.length} presets carregados</p>
          )}
        </div>
      </aside>

      {/* Main */}
      <main className="flex min-w-0 flex-1 flex-col">
        {tab === "Comprimir" ? (
          <CompressTab />
        ) : (
          <>
        {/* DropZone grande */}
        <section className="p-6 pb-4">
          <div className="flex min-h-44 flex-col items-center justify-center rounded-2xl border-2 border-dashed border-zinc-700 bg-zinc-900/50 px-6 py-10 text-center transition hover:border-zinc-500">
            <p className="text-lg font-medium">Arraste imagens aqui</p>
            <p className="mt-1 text-sm text-zinc-500">
              PNG · JPG · WebP · AVIF — conversão local via ffmpeg sidecar
            </p>
            <button className="mt-4 rounded-lg bg-white px-4 py-2 text-sm font-medium text-zinc-950 hover:bg-zinc-200">
              Selecionar arquivos
            </button>
          </div>
        </section>

        {/* Barra de progresso */}
        <section className="px-6 pb-4">
          <div className="flex items-center justify-between text-xs text-zinc-500">
            <span>Progresso da fila</span>
            <span>{progresso}%</span>
          </div>
          <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-zinc-800">
            <div
              className="h-full rounded-full bg-emerald-400 transition-all"
              style={{ width: `${progresso}%` }}
            />
          </div>
        </section>

        {/* Tabela de jobs */}
        <section className="min-h-0 flex-1 overflow-auto px-6 pb-6">
          <div className="overflow-hidden rounded-xl border border-zinc-800">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-zinc-800 bg-zinc-900 text-xs uppercase tracking-wide text-zinc-500">
                  <th className="px-4 py-3 font-medium">Arquivo</th>
                  <th className="px-4 py-3 font-medium">Preset</th>
                  <th className="px-4 py-3 font-medium">Dimensões</th>
                  <th className="px-4 py-3 font-medium">Antes → Depois</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {jobs.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-10 text-center text-zinc-500">
                      Fila vazia — solte imagens no DropZone acima.
                    </td>
                  </tr>
                ) : (
                  jobs.map((job) => (
                    <tr key={job.id} className="border-b border-zinc-800/60 last:border-0">
                      <td className="px-4 py-3 font-medium">{job.arquivo}</td>
                      <td className="px-4 py-3 text-zinc-400">{job.preset}</td>
                      <td className="px-4 py-3 text-zinc-400">{job.dimensoes}</td>
                      <td className="px-4 py-3 text-zinc-400">
                        {job.antes} → {job.depois}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-block rounded-full px-2.5 py-0.5 text-xs ${STATUS_STYLE[job.status]}`}
                        >
                          {job.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          onClick={() => removerJob(job.id)}
                          className="text-xs text-zinc-600 hover:text-red-400"
                        >
                          remover
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
          </>
        )}
      </main>
    </div>
  );
}
