import type { Fetcher } from "./api";

export interface DeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  interval: number;
  expiresIn: number;
}

export class DeviceFlowError extends Error {
  constructor(
    public readonly kind: "expired" | "denied" | "cancelled" | "network" | "other",
    message: string,
  ) {
    super(message);
  }
}

const form = (fields: Record<string, string>) =>
  Object.entries(fields)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&");
const headers = { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" };

async function post(fetcher: Fetcher, url: string, body: string): Promise<Record<string, unknown>> {
  let res;
  try {
    res = await fetcher({ url, method: "POST", headers, body });
  } catch {
    throw new DeviceFlowError("network", "Could not reach GitHub. Check your connection.");
  }
  try {
    return JSON.parse(res.body) as Record<string, unknown>;
  } catch {
    throw new DeviceFlowError("other", `GitHub answered HTTP ${res.status}.`);
  }
}

export async function requestCode(fetcher: Fetcher, clientId: string, scope: string): Promise<DeviceCode> {
  const d = await post(fetcher, "https://github.com/login/device/code", form({ client_id: clientId, scope }));
  if (typeof d.device_code !== "string") {
    throw new DeviceFlowError("other", String(d.error_description ?? d.error ?? "GitHub refused the sign-in request."));
  }
  return {
    deviceCode: d.device_code,
    userCode: String(d.user_code),
    verificationUri: String(d.verification_uri),
    interval: Number(d.interval ?? 5),
    expiresIn: Number(d.expires_in ?? 900),
  };
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Polls GitHub until the user enters the code, honouring `slow_down`. */
export async function waitForToken(
  fetcher: Fetcher,
  clientId: string,
  code: DeviceCode,
  opts: { signal: AbortSignal; sleep?: (ms: number) => Promise<void>; now?: () => number },
): Promise<string> {
  const sleep = opts.sleep ?? realSleep;
  const now = opts.now ?? Date.now;
  const deadline = now() + code.expiresIn * 1000;
  let interval = code.interval;
  const body = form({ client_id: clientId, device_code: code.deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" });
  for (;;) {
    await sleep(interval * 1000);
    if (opts.signal.aborted) throw new DeviceFlowError("cancelled", "Sign-in cancelled.");
    if (now() >= deadline) throw new DeviceFlowError("expired", "The code expired. Start again.");
    const d = await post(fetcher, "https://github.com/login/oauth/access_token", body);
    if (typeof d.access_token === "string") return d.access_token;
    switch (d.error) {
      case "authorization_pending":
        continue;
      case "slow_down":
        interval += 5;
        continue;
      case "expired_token":
        throw new DeviceFlowError("expired", "The code expired. Start again.");
      case "access_denied":
        throw new DeviceFlowError("denied", "Sign-in was cancelled on GitHub.");
      default:
        throw new DeviceFlowError("other", String(d.error_description ?? d.error ?? "GitHub refused the sign-in."));
    }
  }
}
