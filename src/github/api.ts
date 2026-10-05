import type { host } from "../sdk";

export type Fetcher = typeof host.http.fetch;
export type ErrorKind = "auth" | "org_restricted" | "rate_limit" | "forbidden" | "not_found" | "validation" | "network" | "other";

export class GitHubError extends Error {
  constructor(
    public readonly kind: ErrorKind,
    message: string,
    public readonly status = 0,
    public readonly org?: string,
  ) {
    super(message);
  }
}

export interface DirEntry {
  name: string;
  path: string;
  sha: string;
  type: string;
}
export interface TreeEntry {
  path: string;
  mode: "100644" | "100755";
  type: "blob";
  sha: string | null;
}

const API = "https://api.github.com";
const MAX_BRANCH_PAGES = 10;
export const encodePath = (p: string) => p.split("/").map(encodeURIComponent).join("/");

function fail(status: number, headers: Record<string, string>, data: unknown): GitHubError {
  const d = (data ?? {}) as { message?: string; errors?: { message?: string }[] };
  const msg = d.message ?? `GitHub answered HTTP ${status}.`;
  if (status === 401) return new GitHubError("auth", "GitHub rejected the sign-in. Sign in again.", status);
  if ((status === 403 || status === 429) && headers["x-ratelimit-remaining"] === "0") {
    const at = new Date(Number(headers["x-ratelimit-reset"] ?? 0) * 1000);
    return new GitHubError("rate_limit", `GitHub rate limit reached. Try again at ${at.toTimeString().slice(0, 5)}.`, status);
  }
  if (status === 403 && /OAuth App access restrictions/i.test(msg)) {
    const org = /`([^`]+)` organization/.exec(msg)?.[1];
    const who = org ? `The ${org} organisation` : "Your organisation";
    return new GitHubError("org_restricted", `${who} must approve Maestro Deck on GitHub.`, status, org);
  }
  if (status === 403) return new GitHubError("forbidden", msg, status);
  if (status === 404) return new GitHubError("not_found", msg, status);
  if (status === 422) {
    const details = (d.errors ?? [])
      .map((e) => e.message)
      .filter(Boolean)
      .join("; ");
    return new GitHubError("validation", details ? `${msg}: ${details}` : msg, status);
  }
  return new GitHubError("other", msg, status);
}

export function createApi(token: string, fetcher: Fetcher) {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res;
    try {
      res = await fetcher({ url: `${API}${path}`, method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "network" || code === "timeout") throw new GitHubError("network", "Could not reach GitHub. Check your connection.");
      throw new GitHubError("other", (err as Error).message);
    }
    let data: unknown = null;
    try {
      data = res.body ? JSON.parse(res.body) : null;
    } catch {
      // A non-JSON error page: the status alone decides.
    }
    if (res.status < 200 || res.status >= 300) throw fail(res.status, res.headers, data);
    return data as T;
  }

  async function or404<T>(p: Promise<T>, fallback: T): Promise<T> {
    try {
      return await p;
    } catch (e) {
      if (e instanceof GitHubError && e.kind === "not_found") return fallback;
      throw e;
    }
  }

  const repoPath = (o: string, r: string) => `/repos/${encodeURIComponent(o)}/${encodeURIComponent(r)}`;
  const at = (ref: string) => `?ref=${encodeURIComponent(ref)}`;

  return {
    user: () => request<{ login: string }>("GET", "/user").then(({ login }) => ({ login })),

    async repo(o: string, r: string) {
      const d = await request<{ default_branch: string; permissions?: { push?: boolean } }>("GET", repoPath(o, r));
      return { defaultBranch: d.default_branch, canPush: d.permissions?.push === true };
    },

    async branches(o: string, r: string): Promise<string[]> {
      const out: string[] = [];
      for (let page = 1; page <= MAX_BRANCH_PAGES; page++) {
        const items = await request<{ name: string }[]>("GET", `${repoPath(o, r)}/branches?per_page=100&page=${page}`);
        out.push(...items.map((b) => b.name));
        if (items.length < 100) break;
      }
      return out;
    },

    branchSha: (o: string, r: string, branch: string) =>
      request<{ object: { sha: string } }>("GET", `${repoPath(o, r)}/git/ref/heads/${encodePath(branch)}`).then((d) => d.object.sha),

    commitTree: (o: string, r: string, sha: string) =>
      request<{ tree: { sha: string } }>("GET", `${repoPath(o, r)}/git/commits/${encodeURIComponent(sha)}`).then((d) => d.tree.sha),

    listDir: (o: string, r: string, dir: string, ref: string) =>
      or404(
        request<DirEntry[] | DirEntry>("GET", `${repoPath(o, r)}/contents/${encodePath(dir)}${at(ref)}`).then((d) => (Array.isArray(d) ? d : [])),
        [] as DirEntry[],
      ),

    fileSha: (o: string, r: string, path: string, ref: string) =>
      or404(
        request<{ sha: string }>("GET", `${repoPath(o, r)}/contents/${encodePath(path)}${at(ref)}`).then((d): string | null => d.sha),
        null,
      ),

    createBlob: (o: string, r: string, base64: string) =>
      request<{ sha: string }>("POST", `${repoPath(o, r)}/git/blobs`, { content: base64, encoding: "base64" }).then((d) => d.sha),

    createTree: (o: string, r: string, baseTree: string, entries: TreeEntry[]) =>
      request<{ sha: string }>("POST", `${repoPath(o, r)}/git/trees`, { base_tree: baseTree, tree: entries }).then((d) => d.sha),

    createCommit: (o: string, r: string, message: string, tree: string, parent: string) =>
      request<{ sha: string }>("POST", `${repoPath(o, r)}/git/commits`, { message, tree, parents: [parent] }).then((d) => d.sha),

    createRef: (o: string, r: string, branch: string, sha: string) =>
      request<unknown>("POST", `${repoPath(o, r)}/git/refs`, { ref: `refs/heads/${branch}`, sha }).then(() => undefined),

    createPull: (o: string, r: string, pr: { title: string; head: string; base: string; body: string }) =>
      request<{ number: number; html_url: string }>("POST", `${repoPath(o, r)}/pulls`, pr).then((d) => ({ number: d.number, url: d.html_url })),
  };
}

export type Api = ReturnType<typeof createApi>;
