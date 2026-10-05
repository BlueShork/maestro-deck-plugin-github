// @vitest-environment jsdom
// (sdk.ts, imported for HostError, listens on `window` at import.)
import { describe, expect, it, vi } from "vitest";
import { GitHubError, type Api, type DirEntry } from "../github/api";
import { HostError, type Change } from "../sdk";
import { findConflicts, submit } from "./submit";

const entry = (path: string, sha: string): DirEntry => ({ name: path.split("/").pop()!, path, sha, type: "file" });

/** A fake Api backed by trees (ref → path → sha). */
function fakeApi(trees: Record<string, Record<string, string>>, over: Partial<Api> = {}): Api {
  const listDir = vi.fn(async (_o: string, _r: string, dir: string, ref: string) =>
    Object.entries(trees[ref] ?? {})
      .filter(([p]) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "") === dir)
      .map(([p, s]) => entry(p, s)),
  );
  return {
    user: vi.fn(),
    repo: vi.fn(),
    branches: vi.fn(),
    branchSha: vi.fn(async () => "T"),
    commitTree: vi.fn(async (_o: string, _r: string, sha: string) => {
      if (!(sha in trees)) throw new GitHubError("not_found", "No commit", 404);
      return `tree-${sha}`;
    }),
    listDir,
    fileSha: vi.fn(async (_o: string, _r: string, p: string, ref: string) => trees[ref]?.[p] ?? null),
    createBlob: vi.fn(async (_o: string, _r: string, b64: string) => `blob-${b64}`),
    createTree: vi.fn(async () => "newtree"),
    createCommit: vi.fn(async () => "newcommit"),
    createRef: vi.fn(async () => {}),
    createPull: vi.fn(async () => ({ number: 42, url: "https://github.com/acme/app/pull/42" })),
    ...over,
  } as unknown as Api;
}
const c = (path: string, status: Change["status"] = "modified", executable = false): Change => ({ path, status, size: 1, executable });
const input = (files: Change[]) => ({ owner: "acme", repo: "app", head: "H", target: "main", files, message: "msg", title: "Fix login", body: "B" });
const read = vi.fn(async (p: string) => `b64:${p}`);
/** The open folder still sits on the commit the form was built from. */
const here = async () => "H";

describe("findConflicts", () => {
  it("flags files whose sha differs between head and target, including add/add and deletions", async () => {
    const api = fakeApi({
      H: { "flows/a.yaml": "1", "flows/same.yaml": "s", "gone.txt": "g" },
      T: { "flows/a.yaml": "2", "flows/same.yaml": "s", "flows/new.yaml": "n" },
    });
    expect(await findConflicts(api, "acme", "app", "H", "T", ["flows/a.yaml", "flows/same.yaml", "flows/new.yaml", "gone.txt", "fresh.png"])).toEqual([
      "flows/a.yaml",
      "flows/new.yaml",
      "gone.txt",
    ]);
  });

  it("lists each directory once per ref", async () => {
    const api = fakeApi({ H: { "f/a": "1", "f/b": "1" }, T: { "f/a": "1", "f/b": "1" } });
    await findConflicts(api, "acme", "app", "H", "T", ["f/a", "f/b"]);
    expect(api.listDir).toHaveBeenCalledTimes(2);
  });

  it("falls back to a per-file lookup when a listing hits GitHub's 1000 cap", async () => {
    const big = Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`d/${i}`, "x"]));
    const api = fakeApi({ H: { ...big }, T: { ...big } });
    vi.mocked(api.fileSha).mockImplementation(async (_o, _r, _p, ref) => (ref === "T" ? "changed" : null));
    expect(await findConflicts(api, "acme", "app", "H", "T", ["d/late.png"])).toEqual(["d/late.png"]);
  });
});

describe("submit", () => {
  it("uploads, commits on the target head, branches and opens the PR", async () => {
    const api = fakeApi({ H: { "a.yaml": "1", "old.txt": "o" }, T: { "a.yaml": "1", "old.txt": "o" } });
    const steps: string[] = [];
    read.mockClear();
    const out = await submit(input([c("a.yaml"), c("run.sh", "added", true), c("old.txt", "deleted")]), {
      api,
      currentHead: here,
      readFile: read,
      onStep: (s) => steps.push(s),
    });
    expect(out).toEqual({ number: 42, url: "https://github.com/acme/app/pull/42", branch: "qa/fix-login" });
    expect(api.createTree).toHaveBeenCalledWith("acme", "app", "tree-T", [
      { path: "a.yaml", mode: "100644", type: "blob", sha: "blob-b64:a.yaml" },
      { path: "run.sh", mode: "100755", type: "blob", sha: "blob-b64:run.sh" },
      { path: "old.txt", mode: "100644", type: "blob", sha: null },
    ]);
    expect(api.createCommit).toHaveBeenCalledWith("acme", "app", "msg", "newtree", "T");
    expect(api.createPull).toHaveBeenCalledWith("acme", "app", { title: "Fix login", head: "qa/fix-login", base: "main", body: "B" });
    expect(steps).toEqual(["checking", "uploading", "committing", "branching", "opening"]);
    expect(read).not.toHaveBeenCalledWith("old.txt");
  });

  it("blocks on conflicts before uploading anything", async () => {
    const api = fakeApi({ H: { "a.yaml": "1" }, T: { "a.yaml": "2" } });
    await expect(submit(input([c("a.yaml")]), { api, currentHead: here, readFile: read })).rejects.toMatchObject({ kind: "conflict", paths: ["a.yaml"] });
    expect(api.createBlob).not.toHaveBeenCalled();
  });

  it("blocks when the local commit is not on GitHub", async () => {
    const api = fakeApi({ T: {} });
    await expect(submit(input([c("a.yaml", "added")]), { api, currentHead: here, readFile: read })).rejects.toMatchObject({ kind: "local_commit" });
  });

  it("stops on the first failed upload without creating a ref or PR", async () => {
    const api = fakeApi(
      { H: {}, T: {} },
      {
        createBlob: vi.fn(async () => {
          throw new GitHubError("validation", "blob too big", 422);
        }),
      },
    );
    await expect(submit(input([c("a.png", "added"), c("b.png", "added")]), { api, currentHead: here, readFile: read })).rejects.toThrow("blob too big");
    expect(api.createTree).not.toHaveBeenCalled();
    expect(api.createRef).not.toHaveBeenCalled();
    expect(api.createPull).not.toHaveBeenCalled();
  });

  it("maps a too_large read to a SubmitError naming the file", async () => {
    const api = fakeApi({ H: {}, T: {} });
    const readFile = vi.fn(async () => {
      throw new HostError("too_large", "big.png is over 25 MB");
    });
    await expect(submit(input([c("big.png", "added")]), { api, currentHead: here, readFile })).rejects.toMatchObject({ kind: "too_large", paths: ["big.png"] });
  });

  it("retries the branch name when it already exists", async () => {
    const createRef = vi
      .fn()
      .mockRejectedValueOnce(new GitHubError("validation", "Validation Failed: Reference already exists", 422))
      .mockResolvedValueOnce(undefined);
    const api = fakeApi({ H: {}, T: {} }, { createRef });
    const out = await submit(input([c("a.yaml", "added")]), { api, currentHead: here, readFile: read });
    expect(out.branch).toBe("qa/fix-login-2");
    expect(createRef.mock.calls.map((call) => call[2])).toEqual(["qa/fix-login", "qa/fix-login-2"]);
  });

  it("gives up after qa/<slug>-9", async () => {
    const createRef = vi.fn(async () => {
      throw new GitHubError("validation", "Reference already exists", 422);
    });
    const api = fakeApi({ H: {}, T: {} }, { createRef });
    await expect(submit(input([c("a.yaml", "added")]), { api, currentHead: here, readFile: read })).rejects.toMatchObject({ kind: "branch_taken" });
    expect(createRef).toHaveBeenCalledTimes(9);
  });

  it("refuses to send when the folder moved to another commit since the list was shown", async () => {
    // Pulled or switched branch outside the app: the overwrite check would
    // compare against a commit the files no longer come from.
    const api = fakeApi({ H: {}, H2: {}, T: {} });
    await expect(submit(input([c("a.yaml", "added")]), { api, currentHead: async () => "H2", readFile: read })).rejects.toMatchObject({
      kind: "stale",
    });
    expect(api.createBlob).not.toHaveBeenCalled();
  });

  it("refuses to commit when the open folder changed during the upload", async () => {
    const api = fakeApi({ H: {}, T: {} });
    const currentHead = vi.fn().mockResolvedValueOnce("H").mockResolvedValueOnce(null);
    await expect(submit(input([c("a.yaml", "added")]), { api, currentHead, readFile: read })).rejects.toMatchObject({ kind: "stale" });
    expect(api.createTree).not.toHaveBeenCalled();
    expect(api.createRef).not.toHaveBeenCalled();
  });
});
