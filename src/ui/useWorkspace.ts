import type { Api } from "../github/api";
import type { Change, WorkspaceInfo } from "../sdk";

export type WsState =
  | { kind: "no_folder" }
  | { kind: "not_github" }
  | { kind: "no_commits" }
  | { kind: "no_access"; slug: string }
  | { kind: "ready"; owner: string; repo: string; head: string; defaultBranch: string };

export type RepoMeta = { defaultBranch: string; canPush: boolean } | "not_found" | null;

/** What the panel can do with the open folder, in the order the checks apply. */
export function resolveState(info: WorkspaceInfo | null, meta: RepoMeta): WsState {
  if (!info) return { kind: "no_folder" };
  const gh = info.git?.github;
  if (!info.git || !gh) return { kind: "not_github" };
  if (!info.git.head) return { kind: "no_commits" };
  const slug = `${gh.owner}/${gh.repo}`;
  if (!meta || meta === "not_found" || !meta.canPush) return { kind: "no_access", slug };
  return { kind: "ready", owner: gh.owner, repo: gh.repo, head: info.git.head, defaultBranch: meta.defaultBranch };
}

export interface Loaded {
  state: WsState;
  branches: string[];
  files: Change[];
}

export interface LoadDeps {
  info(): Promise<WorkspaceInfo | null>;
  changes(): Promise<{ files: Change[] }>;
  api: Pick<Api, "repo" | "branches">;
}

const spot = (i: WorkspaceInfo | null) => JSON.stringify(i && [i.name, i.git?.head, i.git?.github]);

/**
 * Everything the form needs, read as one snapshot. The host answers each call
 * from the folder open at that moment, so if the folder (or its HEAD) is not
 * the same at the end as at the start, the pieces may come from two places:
 * the result is "moved" and the caller loads again.
 */
export async function loadWorkspace(d: LoadDeps): Promise<Loaded | "moved"> {
  const info = await d.info();
  const gh = info?.git?.github;
  let meta: RepoMeta = null;
  if (gh && info?.git?.head) {
    try {
      meta = await d.api.repo(gh.owner, gh.repo);
    } catch (e) {
      if ((e as { kind?: string }).kind !== "not_found") throw e;
      meta = "not_found";
    }
  }
  const state = resolveState(info, meta);
  if (state.kind !== "ready") return { state, branches: [], files: [] };
  const branches = await d.api.branches(state.owner, state.repo);
  const { files } = await d.changes();
  if (spot(await d.info()) !== spot(info)) return "moved";
  return { state, branches, files };
}
