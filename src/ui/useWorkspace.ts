import type { WorkspaceInfo } from "../sdk";

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
