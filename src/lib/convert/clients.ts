/**
 * clients.ts — Presets por cliente (JSON em localStorage, sem backend).
 *
 * Cada cliente guarda as qualidades usadas nos sliders (WebP/AVIF/JPG).
 * Trocar de cliente aplica os valores e reconverte a fila; "salvar"
 * captura os sliders atuais com um nome.
 */

export interface ClientPreset {
  id: string;
  name: string;
  webpQuality: number;
  avifQuality: number;
  jpgQuality: number;
  updatedAt: number;
}

const LIST_KEY = "elementor-companion.clients.v1";
const ACTIVE_KEY = "elementor-companion.active-client.v1";

export const DEFAULT_CLIENT: ClientPreset = {
  id: "padrao",
  name: "Padrão",
  webpQuality: 85,
  avifQuality: 65,
  jpgQuality: 75,
  updatedAt: 0,
};

function clampQ(q: number, fallback: number): number {
  if (!Number.isFinite(q)) return fallback;
  return Math.min(95, Math.max(50, Math.round(q)));
}

function normalize(raw: unknown): ClientPreset | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r["id"] !== "string" || typeof r["name"] !== "string") return null;
  return {
    id: r["id"],
    name: r["name"].slice(0, 40) || "Sem nome",
    webpQuality: clampQ(Number(r["webpQuality"]), DEFAULT_CLIENT.webpQuality),
    avifQuality: clampQ(Number(r["avifQuality"]), DEFAULT_CLIENT.avifQuality),
    jpgQuality: clampQ(Number(r["jpgQuality"]), DEFAULT_CLIENT.jpgQuality),
    updatedAt: Number(r["updatedAt"]) || 0,
  };
}

/** Lê a lista (sempre inclui o Padrão primeiro). */
export function loadClients(): ClientPreset[] {
  try {
    const raw = localStorage.getItem(LIST_KEY);
    if (!raw) return [{ ...DEFAULT_CLIENT }];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [{ ...DEFAULT_CLIENT }];
    const list = parsed
      .map(normalize)
      .filter((c): c is ClientPreset => c !== null && c.id !== DEFAULT_CLIENT.id);
    return [{ ...DEFAULT_CLIENT }, ...list];
  } catch {
    return [{ ...DEFAULT_CLIENT }];
  }
}

/** Persiste a lista (sem o Padrão, que é fixo). */
export function saveClients(list: ClientPreset[]): void {
  try {
    const custom = list.filter((c) => c.id !== DEFAULT_CLIENT.id);
    localStorage.setItem(LIST_KEY, JSON.stringify(custom));
  } catch {
    /* storage cheio/bloqueado: segue sem persistir */
  }
}

export function getActiveClientId(): string {
  try {
    return localStorage.getItem(ACTIVE_KEY) ?? DEFAULT_CLIENT.id;
  } catch {
    return DEFAULT_CLIENT.id;
  }
}

export function setActiveClientId(id: string): void {
  try {
    localStorage.setItem(ACTIVE_KEY, id);
  } catch {
    /* segue sem persistir */
  }
}

/** Cria um id estável a partir do nome + timestamp. */
export function makeClient(name: string, qualities: Omit<ClientPreset, "id" | "name" | "updatedAt">): ClientPreset {
  const slug = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30);
  return {
    id: `${slug || "cliente"}-${Date.now().toString(36)}`,
    name: name.trim().slice(0, 40) || "Sem nome",
    webpQuality: clampQ(qualities.webpQuality, DEFAULT_CLIENT.webpQuality),
    avifQuality: clampQ(qualities.avifQuality, DEFAULT_CLIENT.avifQuality),
    jpgQuality: clampQ(qualities.jpgQuality, DEFAULT_CLIENT.jpgQuality),
    updatedAt: Date.now(),
  };
}
