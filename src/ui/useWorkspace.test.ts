import { describe, expect, it, vi } from "vitest";
import type { WorkspaceInfo } from "../sdk";
import { loadWorkspace, resolveState } from "./useWorkspace";

const gh = { owner: "acme", repo: "app" };
const at = (name: string, head: string, owner = "acme"): WorkspaceInfo => ({ name, git: { branch: "main", head, github: { owner, repo: "app" } } });

function deps(infos: (WorkspaceInfo | null)[]) {
  const info = vi.fn<() => Promise<WorkspaceInfo | null>>();
  for (const i of infos) info.mockResolvedValueOnce(i);
  return {
    info,
    changes: vi.fn(async () => ({ files: [{ path: "a.yaml", status: "added" as const, size: 1, executable: false }] })),
    api: {
      repo: vi.fn(async () => ({ defaultBranch: "main", canPush: true })),
      branches: vi.fn(async () => ["main", "dev"]),
    },
  };
}

describe("loadWorkspace", () => {
  it("loads state, branches and files when the folder stays put", async () => {
    const d = deps([at("app", "h"), at("app", "h")]);
    expect(await loadWorkspace(d)).toEqual({
      state: { kind: "ready", owner: "acme", repo: "app", head: "h", defaultBranch: "main" },
      branches: ["main", "dev"],
      files: [{ path: "a.yaml", status: "added", size: 1, executable: false }],
    });
  });

  it("reports a move when the folder or its HEAD changed while loading", async () => {
    // The host answers each call from the folder open at that moment, so the
    // file list may come from the new folder: it must not be shown as A's.
    expect(await loadWorkspace(deps([at("app", "h"), at("other", "x", "acme2")]))).toBe("moved");
    expect(await loadWorkspace(deps([at("app", "h"), at("app", "h2")]))).toBe("moved");
  });

  it("does not list files for a folder it cannot send from", async () => {
    const d = deps([{ name: "x", git: null }]);
    expect(await loadWorkspace(d)).toEqual({ state: { kind: "not_github" }, branches: [], files: [] });
    expect(d.changes).not.toHaveBeenCalled();
  });

  it("treats a 404 repo as no access", async () => {
    const d = deps([at("app", "h")]);
    d.api.repo.mockRejectedValueOnce(Object.assign(new Error("Not Found"), { kind: "not_found" }));
    expect((await loadWorkspace(d)) as { state: unknown }).toMatchObject({ state: { kind: "no_access", slug: "acme/app" } });
  });
});

describe("resolveState", () => {
  it("walks the empty states in order", () => {
    expect(resolveState(null, null)).toEqual({ kind: "no_folder" });
    expect(resolveState({ name: "x", git: null }, null)).toEqual({ kind: "not_github" });
    expect(resolveState({ name: "x", git: { branch: "main", head: "h", github: null } }, null)).toEqual({ kind: "not_github" });
    expect(resolveState({ name: "x", git: { branch: "main", head: null, github: gh } }, null)).toEqual({ kind: "no_commits" });
    expect(resolveState({ name: "x", git: { branch: "main", head: "h", github: gh } }, "not_found")).toEqual({ kind: "no_access", slug: "acme/app" });
    expect(resolveState({ name: "x", git: { branch: "main", head: "h", github: gh } }, { defaultBranch: "main", canPush: false })).toEqual({
      kind: "no_access",
      slug: "acme/app",
    });
    expect(resolveState({ name: "x", git: { branch: "dev", head: "h", github: gh } }, { defaultBranch: "main", canPush: true })).toEqual({
      kind: "ready",
      owner: "acme",
      repo: "app",
      head: "h",
      defaultBranch: "main",
    });
  });
});
