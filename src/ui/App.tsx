import { useEffect, useState } from "preact/hooks";
import { host } from "../sdk";
import { PrScreen } from "./PrScreen";
import { SignInScreen } from "./SignInScreen";

export interface Credentials {
  token: string;
  login: string;
}
type State = { kind: "loading" } | { kind: "signin"; notice?: string } | { kind: "main"; creds: Credentials };

export function App() {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    host.secrets
      .get("credentials")
      .then((raw) => setState(raw ? { kind: "main", creds: JSON.parse(raw) as Credentials } : { kind: "signin" }))
      .catch(() => setState({ kind: "signin", notice: "Could not read the saved sign-in." }));
  }, []);

  if (state.kind === "loading") return <p class="muted pad">Loading…</p>;
  if (state.kind === "signin") return <SignInScreen notice={state.notice} onSignedIn={(creds) => setState({ kind: "main", creds })} />;
  return (
    <PrScreen
      creds={state.creds}
      onSignOut={async () => {
        await host.secrets.delete("credentials");
        setState({ kind: "signin" });
      }}
      onAuthFailed={async () => {
        await host.secrets.delete("credentials");
        setState({ kind: "signin", notice: "GitHub rejected the sign-in. Sign in again." });
      }}
    />
  );
}
