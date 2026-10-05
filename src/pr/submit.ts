import { GitHubError, type Api, type TreeEntry } from "../github/api";
import { HostError, type Change } from "../sdk";
import { branchName, slugify } from "./files";

export type Step = "checking" | "uploading" | "committing" | "branching" | "opening";

export class SubmitError extends Error {
  constructor(
    public readonly kind: "conflict" | "local_commit" | "too_large" | "branch_taken",
    message: string,
    public readonly paths: string[] = [],
  ) {
    super(message);
  }
}

export interface SubmitInput {
  owner: string;
  repo: string;
  /** The QA's local HEAD commit. */
  head: string;
  /** Target branch name. */
  target: string;
  files: Change[];
  message: string;
  title: string;
  body: string;
}
export interface SubmitDeps {
  api: Api;
  /** Base64 content of a workspace file. */
  readFile(path: string): Promise<string>;
  onStep?(s: Step): void;
}

const LISTING_CAP = 1000;
const UPLOAD_CONCURRENCY = 2;
const MAX_BRANCH_ATTEMPTS = 9;
const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

/**
 * Selected paths whose blob differs between the QA's commit (`head`) and the
 * target head commit (`target`): sending them would silently overwrite a
 * change made on the target since the QA's copy. Directory listings keep this
 * to one request per directory and ref; a listing at GitHub's 1000-entry cap
 * may be truncated, so a path missing from it is looked up on its own.
 */
export async function findConflicts(api: Api, owner: string, repo: string, head: string, target: string, paths: string[]): Promise<string[]> {
  const listings = new Map<string, Promise<Map<string, string>>>();
  const listing = (dir: string, ref: string) => {
    const key = `${ref}\0${dir}`;
    let l = listings.get(key);
    if (!l) {
      l = api.listDir(owner, repo, dir, ref).then((es) => new Map(es.map((e) => [e.path, e.sha] as const)));
      listings.set(key, l);
    }
    return l;
  };
  const shaAt = async (path: string, ref: string): Promise<string | null> => {
    const l = await listing(dirOf(path), ref);
    const sha = l.get(path);
    if (sha !== undefined) return sha;
    return l.size >= LISTING_CAP ? api.fileSha(owner, repo, path, ref) : null;
  };
  const out: string[] = [];
  for (const p of paths) {
    const [a, b] = await Promise.all([shaAt(p, head), shaAt(p, target)]);
    if (a !== b) out.push(p);
  }
  return out;
}

/** Runs `fn` over `items`, `limit` at a time, in order; stops at the first failure. */
async function pool<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  let failed: { error: unknown } | null = null;
  const worker = async () => {
    while (next < items.length && failed === null) {
      const i = next++;
      try {
        out[i] = await fn(items[i]);
      } catch (error) {
        failed ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failed !== null) throw (failed as { error: unknown }).error;
  return out;
}

export async function submit(input: SubmitInput, deps: SubmitDeps): Promise<{ number: number; url: string; branch: string }> {
  const { api } = deps;
  const { owner, repo } = input;
  const step = (s: Step) => deps.onStep?.(s);

  step("checking");
  const targetSha = await api.branchSha(owner, repo, input.target);
  const baseTree = await api.commitTree(owner, repo, targetSha);
  try {
    await api.commitTree(owner, repo, input.head);
  } catch (e) {
    if (e instanceof GitHubError && e.kind === "not_found") {
      throw new SubmitError("local_commit", "Your local commit isn't on GitHub. Ask a developer to push it.");
    }
    throw e;
  }
  const conflicts = await findConflicts(
    api,
    owner,
    repo,
    input.head,
    targetSha,
    input.files.map((f) => f.path),
  );
  if (conflicts.length > 0) {
    throw new SubmitError("conflict", `${conflicts.join(", ")} changed on ${input.target} since your copy. Update your folder first (pull).`, conflicts);
  }

  step("uploading");
  const entries = await pool(input.files, UPLOAD_CONCURRENCY, async (f): Promise<TreeEntry> => {
    const mode = f.executable ? "100755" : "100644";
    if (f.status === "deleted") return { path: f.path, mode, type: "blob", sha: null };
    let b64: string;
    try {
      b64 = await deps.readFile(f.path);
    } catch (e) {
      if (e instanceof HostError && e.code === "too_large") throw new SubmitError("too_large", `${f.path} is over 25 MB.`, [f.path]);
      throw e;
    }
    return { path: f.path, mode, type: "blob", sha: await api.createBlob(owner, repo, b64) };
  });

  step("committing");
  const tree = await api.createTree(owner, repo, baseTree, entries);
  const commit = await api.createCommit(owner, repo, input.message, tree, targetSha);

  step("branching");
  const slug = slugify(input.title);
  let branch = "";
  for (let attempt = 1; ; attempt++) {
    branch = branchName(slug, attempt);
    try {
      await api.createRef(owner, repo, branch, commit);
      break;
    } catch (e) {
      const taken = e instanceof GitHubError && e.kind === "validation" && /already exists/i.test(e.message);
      if (!taken) throw e;
      if (attempt === MAX_BRANCH_ATTEMPTS) {
        throw new SubmitError("branch_taken", `Branches qa/${slug} to qa/${slug}-${MAX_BRANCH_ATTEMPTS} already exist. Change the title.`);
      }
    }
  }

  step("opening");
  const pr = await api.createPull(owner, repo, { title: input.title, head: branch, base: input.target, body: input.body });
  return { ...pr, branch };
}
