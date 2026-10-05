import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { CLIENT_ID } from "../config";
import { createApi, GitHubError } from "../github/api";
import { describeChanges, GROUPS, groupChanges, isSensitive } from "../pr/files";
import { submit, SubmitError, type Step } from "../pr/submit";
import { host, type Change } from "../sdk";
import type { Credentials } from "./App";
import { resolveState, type RepoMeta, type WsState } from "./useWorkspace";

const STEP_LABEL: Record<Step, string> = {
  checking: "Checking for conflicts…",
  uploading: "Uploading files…",
  committing: "Creating the commit…",
  branching: "Creating the branch…",
  opening: "Opening the pull request…",
};
const STATUS_LETTER = { added: "A", modified: "M", deleted: "D" } as const;

interface Props {
  creds: Credentials;
  onSignOut: () => void;
  onAuthFailed: () => void;
}

export function PrScreen({ creds, onSignOut, onAuthFailed }: Props) {
  const api = useMemo(() => createApi(creds.token, host.http.fetch), [creds.token]);
  const [ws, setWs] = useState<WsState | null>(null);
  const [files, setFiles] = useState<Change[]>([]);
  const [branches, setBranches] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [target, setTarget] = useState("");
  const [message, setMessage] = useState("");
  const [title, setTitle] = useState<string | null>(null); // null: mirrors the commit message
  const [body, setBody] = useState<string | null>(null); // null: generated from the selection
  const [confirmSensitive, setConfirmSensitive] = useState(false);
  const [step, setStep] = useState<Step | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  // The parent passes a new callback each render; a ref keeps `load` stable.
  const authFailed = useRef(onAuthFailed);
  authFailed.current = onAuthFailed;
  const handle = useCallback((e: unknown) => {
    if (e instanceof GitHubError && e.kind === "auth") return authFailed.current();
    setError((e as Error).message);
  }, []);

  const loadChanges = useCallback(async () => {
    const { files } = await host.workspace.changes();
    setFiles(files);
    setSelected((prev) => new Set([...prev].filter((p) => files.some((f) => f.path === p))));
  }, []);

  const load = useCallback(async () => {
    setError(null);
    setWs(null);
    try {
      const info = await host.workspace.info();
      const gh = info?.git?.github;
      let meta: RepoMeta = null;
      if (gh && info?.git?.head) {
        try {
          meta = await api.repo(gh.owner, gh.repo);
        } catch (e) {
          if (e instanceof GitHubError && e.kind === "not_found") meta = "not_found";
          else throw e;
        }
      }
      const state = resolveState(info, meta);
      if (state.kind === "ready") {
        const names = await api.branches(state.owner, state.repo);
        setBranches(names);
        setTarget((t) => (t && names.includes(t) ? t : state.defaultBranch));
        await loadChanges();
      }
      setWs(state);
    } catch (e) {
      handle(e);
    }
  }, [api, handle, loadChanges]);

  useEffect(() => {
    void load();
    return host.onWorkspace(() => {
      setSelected(new Set());
      setDone(null);
      void load();
    });
  }, [load]);

  const chosen = files.filter((f) => selected.has(f.path));
  const sensitive = chosen.filter((f) => isSensitive(f.path));
  const effectiveTitle = title ?? message;
  const effectiveBody = body ?? describeChanges(chosen);
  const canSend =
    ws?.kind === "ready" &&
    chosen.length > 0 &&
    message.trim() !== "" &&
    effectiveTitle.trim() !== "" &&
    target !== "" &&
    (sensitive.length === 0 || confirmSensitive) &&
    step === null;

  const toggle = (paths: string[], on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const p of paths) {
        if (on) next.add(p);
        else next.delete(p);
      }
      return next;
    });

  const send = async () => {
    if (ws?.kind !== "ready") return;
    setError(null);
    setDone(null);
    try {
      const pr = await submit(
        {
          owner: ws.owner,
          repo: ws.repo,
          head: ws.head,
          target,
          files: chosen,
          message: message.trim(),
          title: effectiveTitle.trim(),
          body: effectiveBody,
        },
        { api, readFile: async (p) => (await host.workspace.readFile(p)).base64, onStep: setStep },
      );
      void host.ui.toast({ kind: "success", message: `Pull request #${pr.number} opened`, action: { label: "Open on GitHub", url: pr.url } });
      setDone(`#${pr.number} is open from ${pr.branch}. These files stay "modified" in your folder until you update it after the merge.`);
      setSelected(new Set());
      setMessage("");
      setTitle(null);
      setBody(null);
      setConfirmSensitive(false);
    } catch (e) {
      if (e instanceof SubmitError && e.kind === "too_large") toggle(e.paths, false);
      handle(e);
    } finally {
      setStep(null);
    }
  };

  const footer = (
    <div class="row small muted footer">
      <span>@{creds.login}</span>
      <span class="row">
        <button class="link" onClick={() => void host.ui.openExternal(`https://github.com/settings/connections/applications/${CLIENT_ID}`)}>
          Manage access
        </button>
        <button class="link" onClick={onSignOut}>
          Sign out
        </button>
      </span>
    </div>
  );

  if (!ws) {
    return (
      <div class="pad stack">
        {error ? <p class="error">{error}</p> : <p class="muted">Loading…</p>}
        {error ? (
          <button class="link" onClick={() => void load()}>
            Retry
          </button>
        ) : null}
        {footer}
      </div>
    );
  }
  if (ws.kind !== "ready") {
    const empty = {
      no_folder: "Open a project folder in Maestro Deck.",
      not_github: "This folder is not a GitHub repository.",
      no_commits: "This repository has no commits yet.",
      no_access: `You don't have write access to ${ws.kind === "no_access" ? ws.slug : ""}.`,
    }[ws.kind];
    return (
      <div class="pad stack">
        <p class="muted">{empty}</p>
        {footer}
      </div>
    );
  }

  const groups = groupChanges(files);
  return (
    <div class="pad stack">
      <div class="row">
        <h1>
          {ws.owner}/{ws.repo}
        </h1>
        <button class="link" title="Refresh changes" onClick={() => void loadChanges().catch(handle)}>
          ↻
        </button>
      </div>
      {files.length === 0 ? <p class="muted">No changes to send.</p> : null}
      {GROUPS.filter((g) => groups[g.id].length > 0).map((g) => {
        const paths = groups[g.id].map((f) => f.path);
        const all = paths.every((p) => selected.has(p));
        return (
          <fieldset class="group" key={g.id}>
            <legend class="row">
              <span>{g.label}</span>
              <button class="link" onClick={() => toggle(paths, !all)}>
                {all ? "None" : "All"}
              </button>
            </legend>
            {groups[g.id].map((f) => (
              <label class="file" key={f.path}>
                <input type="checkbox" checked={selected.has(f.path)} onChange={(e) => toggle([f.path], (e.target as HTMLInputElement).checked)} />
                <span class={`status s-${f.status}`}>{STATUS_LETTER[f.status]}</span>
                <span class="path" title={f.path}>
                  {f.path}
                </span>
              </label>
            ))}
          </fieldset>
        );
      })}
      {sensitive.length > 0 ? (
        <div class="banner stack">
          <span class="error">These look like secrets: {sensitive.map((f) => f.path).join(", ")}</span>
          <label class="inline">
            <input type="checkbox" checked={confirmSensitive} onChange={(e) => setConfirmSensitive((e.target as HTMLInputElement).checked)} />
            Send them anyway
          </label>
        </div>
      ) : null}
      <label>
        Target branch
        <select value={target} onChange={(e) => setTarget((e.target as HTMLSelectElement).value)}>
          {branches.map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </select>
      </label>
      <label>
        Commit message
        <input value={message} onInput={(e) => setMessage((e.target as HTMLInputElement).value)} />
      </label>
      <label>
        Pull request title
        <input value={effectiveTitle} onInput={(e) => setTitle((e.target as HTMLInputElement).value)} />
      </label>
      <label>
        Description
        <textarea rows={8} value={effectiveBody} onInput={(e) => setBody((e.target as HTMLTextAreaElement).value)} />
      </label>
      {error ? <p class="error">{error}</p> : null}
      {done ? <p class="banner small">{done}</p> : null}
      <button class="primary" disabled={!canSend} onClick={() => void send()}>
        {step ? STEP_LABEL[step] : "Open pull request"}
      </button>
      {footer}
    </div>
  );
}
