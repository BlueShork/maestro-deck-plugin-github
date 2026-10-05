import { describe, expect, it } from "vitest";
import { resolveState } from "./useWorkspace";

const gh = { owner: "acme", repo: "app" };

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
