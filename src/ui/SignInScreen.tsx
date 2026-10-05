import { useEffect, useRef, useState } from "preact/hooks";
import { CLIENT_ID, SCOPE } from "../config";
import { createApi } from "../github/api";
import { DeviceFlowError, requestCode, waitForToken, type DeviceCode } from "../github/device";
import { host } from "../sdk";
import type { Credentials } from "./App";

export function SignInScreen({ notice, onSignedIn }: { notice?: string; onSignedIn: (c: Credentials) => void }) {
  const [code, setCode] = useState<DeviceCode | null>(null);
  const [error, setError] = useState<string | null>(notice ?? null);
  const [busy, setBusy] = useState(false);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => () => abort.current?.abort(), []);

  const start = async () => {
    setError(null);
    setBusy(true);
    abort.current?.abort();
    const ac = new AbortController();
    abort.current = ac;
    try {
      const c = await requestCode(host.http.fetch, CLIENT_ID, SCOPE);
      setCode(c);
      const token = await waitForToken(host.http.fetch, CLIENT_ID, c, { signal: ac.signal });
      const { login } = await createApi(token, host.http.fetch).user();
      const creds = { token, login };
      await host.secrets.set("credentials", JSON.stringify(creds));
      onSignedIn(creds);
    } catch (e) {
      if (!(e instanceof DeviceFlowError && e.kind === "cancelled")) setError((e as Error).message);
      setCode(null);
    } finally {
      setBusy(false);
    }
  };

  if (!CLIENT_ID) return <p class="error pad">This build has no GitHub OAuth Client ID configured (src/config.ts).</p>;

  return (
    <div class="pad stack">
      <h1>Connect GitHub</h1>
      <p class="muted">Open pull requests from the files you changed in this project.</p>
      {error ? <p class="error">{error}</p> : null}
      {code ? (
        <div class="stack">
          <p class="muted small">Enter this code on GitHub:</p>
          <div class="row">
            <code class="usercode">{code.userCode}</code>
            <button class="link" onClick={() => void navigator.clipboard?.writeText(code.userCode).catch(() => {})}>
              Copy
            </button>
          </div>
          <button class="primary" onClick={() => void host.ui.openExternal(code.verificationUri)}>
            Open github.com
          </button>
          <p class="muted small">Waiting for GitHub…</p>
          <button class="link" onClick={() => abort.current?.abort()}>
            Cancel
          </button>
        </div>
      ) : (
        <button class="primary" disabled={busy} onClick={() => void start()}>
          Sign in with GitHub
        </button>
      )}
    </div>
  );
}
