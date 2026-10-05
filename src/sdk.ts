/**
 * Maestro Deck plugin SDK — the plugin side of the host RPC.
 * Copy this file into new plugins; the contract is in maestro-deck/docs/plugins.md.
 */

type Theme = { mode: "light" | "dark"; vars: Record<string, string> };
type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

export class HostError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

export interface WorkspaceInfo {
  name: string;
  git: { branch: string | null; head: string | null; github: { owner: string; repo: string } | null } | null;
}
export interface Change {
  path: string;
  status: "added" | "modified" | "deleted";
  size: number;
  executable: boolean;
}

const pending = new Map<string, Pending>();
const workspaceListeners = new Set<() => void>();
const themeListeners = new Set<(t: Theme) => void>();
let lastTheme: Theme | null = null;
let seq = 0;

window.addEventListener("message", (e: MessageEvent) => {
  if (e.source !== window.parent) return;
  const msg = e.data as { type?: string; id?: string; ok?: boolean; result?: unknown; error?: { code: string; message: string }; name?: string; data?: unknown };
  if (msg?.type === "md-rpc-result" && msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id)!;
    pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new HostError(msg.error?.code ?? "internal", msg.error?.message ?? "Unknown error"));
  } else if (msg?.type === "md-event" && msg.name === "theme") {
    lastTheme = msg.data as Theme;
    themeListeners.forEach((cb) => cb(lastTheme!));
  } else if (msg?.type === "md-event" && msg.name === "workspace") {
    workspaceListeners.forEach((cb) => cb());
  }
});

function call<T>(method: string, params?: unknown): Promise<T> {
  const id = `${Date.now().toString(36)}-${++seq}`;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new HostError("timeout", `${method} timed out`));
    }, 60_000);
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
    window.parent.postMessage({ type: "md-rpc", id, method, params }, "*");
  });
}

export const host = {
  call,
  secrets: {
    get: (key: string) => call<string | null>("secrets.get", { key }),
    set: (key: string, value: string) => call<void>("secrets.set", { key, value }),
    delete: (key: string) => call<void>("secrets.delete", { key }),
  },
  storage: {
    get: <T>(key: string) => call<T | null>("storage.get", { key }),
    set: (key: string, value: unknown) => call<void>("storage.set", { key, value }),
  },
  http: {
    fetch: (req: { url: string; method: string; headers?: Record<string, string>; body?: string }) =>
      call<{ status: number; headers: Record<string, string>; body: string }>("http.fetch", req),
  },
  ui: {
    toast: (t: { kind: "success" | "error" | "info"; message: string; action?: { label: string; url: string } }) => call<void>("ui.toast", t),
    openExternal: (url: string) => call<void>("ui.openExternal", { url }),
  },
  workspace: {
    info: () => call<WorkspaceInfo | null>("workspace.info"),
    changes: () => call<{ files: Change[] }>("workspace.changes"),
    readFile: (path: string) => call<{ base64: string }>("workspace.readFile", { path }),
  },
  onWorkspace(cb: () => void): () => void {
    workspaceListeners.add(cb);
    return () => workspaceListeners.delete(cb);
  },
  onTheme(cb: (t: Theme) => void): () => void {
    themeListeners.add(cb);
    if (lastTheme) cb(lastTheme);
    return () => themeListeners.delete(cb);
  },
};

/** Apply the host theme as CSS variables on :root. */
export function applyHostTheme(): void {
  host.onTheme(({ mode, vars }) => {
    const root = document.documentElement;
    for (const [k, v] of Object.entries(vars)) root.style.setProperty(`--${k}`, v);
    root.dataset.mode = mode;
  });
}
