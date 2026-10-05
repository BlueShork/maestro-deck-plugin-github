import { describe, expect, it, vi } from "vitest";
import { createApi, type Fetcher } from "./api";

const res = (status: number, body: unknown, headers: Record<string, string> = {}) => ({
  status,
  headers,
  body: body === undefined ? "" : JSON.stringify(body),
});

describe("github api", () => {
  it("sends bearer auth and the API version", async () => {
    const f = vi.fn<Fetcher>(async () => res(200, { login: "qa" }));
    expect(await createApi("tok", f).user()).toEqual({ login: "qa" });
    expect(f.mock.calls[0][0]).toMatchObject({
      url: "https://api.github.com/user",
      method: "GET",
      headers: { Authorization: "Bearer tok", Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    });
  });

  it("sends a User-Agent, which the GitHub API requires (403 without one)", async () => {
    const f = vi.fn<Fetcher>(async () => res(200, { login: "qa" }));
    await createApi("tok", f).user();
    expect(f.mock.calls[0][0].headers?.["User-Agent"]).toMatch(/^maestro-deck-plugin-github/);
  });

  it("maps repo default branch and push permission", async () => {
    const f = vi.fn<Fetcher>(async () => res(200, { default_branch: "main", permissions: { push: false } }));
    expect(await createApi("t", f).repo("acme", "app")).toEqual({ defaultBranch: "main", canPush: false });
  });

  it("pages branches until a short page", async () => {
    const page = (n: number, from: number) => Array.from({ length: n }, (_, i) => ({ name: `b${from + i}` }));
    const f = vi.fn<Fetcher>().mockResolvedValueOnce(res(200, page(100, 0))).mockResolvedValueOnce(res(200, page(3, 100)));
    const names = await createApi("t", f).branches("acme", "app");
    expect(names).toHaveLength(103);
    expect(f.mock.calls[1][0].url).toBe("https://api.github.com/repos/acme/app/branches?per_page=100&page=2");
  });

  it("encodes paths and treats 404 directories as empty", async () => {
    const f = vi.fn<Fetcher>(async () => res(404, { message: "Not Found" }));
    expect(await createApi("t", f).listDir("acme", "app", "my flows", "abc")).toEqual([]);
    expect(f.mock.calls[0][0].url).toBe("https://api.github.com/repos/acme/app/contents/my%20flows?ref=abc");
    expect(await createApi("t", f).fileSha("acme", "app", "a.png", "abc")).toBeNull();
  });

  it.each([
    [401, {}, {}, "auth"],
    [
      403,
      { message: "Although you appear to have the correct authorization credentials, the `acme` organization has enabled OAuth App access restrictions" },
      {},
      "org_restricted",
    ],
    [403, { message: "API rate limit exceeded" }, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1700000000" }, "rate_limit"],
    [429, { message: "slow" }, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1700000000" }, "rate_limit"],
    [403, { message: "Resource not accessible" }, {}, "forbidden"],
    [404, { message: "Not Found" }, {}, "not_found"],
    [422, { message: "Validation Failed", errors: [{ message: "Reference already exists" }] }, {}, "validation"],
    [500, {}, {}, "other"],
  ])("maps HTTP %i to %s", async (status, body, headers, kind) => {
    const f = vi.fn<Fetcher>(async () => res(status as number, body, headers as Record<string, string>));
    await expect(createApi("t", f).user()).rejects.toMatchObject({ kind });
  });

  it("names the org in org restrictions and keeps 422 details", async () => {
    const f = vi.fn<Fetcher>(async () => res(403, { message: "the `acme` organization has enabled OAuth App access restrictions" }));
    await expect(createApi("t", f).user()).rejects.toMatchObject({ org: "acme" });
    const g = vi.fn<Fetcher>(async () => res(422, { message: "Validation Failed", errors: [{ message: "Reference already exists" }] }));
    await expect(createApi("t", g).createRef("a", "b", "qa/x", "sha")).rejects.toThrow(/Reference already exists/);
  });

  it("maps host network errors", async () => {
    const f = vi.fn<Fetcher>(async () => {
      throw Object.assign(new Error("network: down"), { code: "network" });
    });
    await expect(createApi("t", f).user()).rejects.toMatchObject({ kind: "network" });
  });

  it("builds the tree, commit, ref and pull payloads", async () => {
    const f = vi
      .fn<Fetcher>()
      .mockResolvedValueOnce(res(201, { sha: "tree1" }))
      .mockResolvedValueOnce(res(201, { sha: "c1" }))
      .mockResolvedValueOnce(res(201, { ref: "refs/heads/qa/x" }))
      .mockResolvedValueOnce(res(201, { number: 7, html_url: "https://github.com/acme/app/pull/7" }));
    const api = createApi("t", f);
    await api.createTree("acme", "app", "base", [{ path: "a", mode: "100644", type: "blob", sha: null }]);
    await api.createCommit("acme", "app", "msg", "tree1", "p1");
    await api.createRef("acme", "app", "qa/x", "c1");
    expect(await api.createPull("acme", "app", { title: "T", head: "qa/x", base: "main", body: "B" })).toEqual({
      number: 7,
      url: "https://github.com/acme/app/pull/7",
    });
    expect(JSON.parse(f.mock.calls[0][0].body!)).toEqual({ base_tree: "base", tree: [{ path: "a", mode: "100644", type: "blob", sha: null }] });
    expect(JSON.parse(f.mock.calls[1][0].body!)).toEqual({ message: "msg", tree: "tree1", parents: ["p1"] });
    expect(JSON.parse(f.mock.calls[2][0].body!)).toEqual({ ref: "refs/heads/qa/x", sha: "c1" });
  });
});
