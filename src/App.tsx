import { useState } from "react";
import { IMAGE_PRESETS } from "./lib/convert/presets";
import { CompressTab } from "./components/CompressTab";
import { ConverterTab } from "./components/ConverterTab";

type Tab = "Fila" | "Comprimir" | "Presets" | "Export";

const TABS: Tab[] = ["Fila", "Comprimir", "Presets", "Export"];

export default function App() {
  const [tab, setTab] = useState<Tab>("Fila");

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
          <p>{IMAGE_PRESETS.length} presets carregados</p>
        </div>
      </aside>

      {/* Main */}
      <main className="flex min-w-0 flex-1 flex-col">
        {tab === "Comprimir" ? (
          <CompressTab />
        ) : tab === "Fila" ? (
          <ConverterTab />
        ) : (
          <div className="flex flex-1 items-center justify-center p-6">
            <p className="text-sm text-zinc-500">
              Tab {tab} — ainda não implementada. Use Fila ou Comprimir.
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
