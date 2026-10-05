import { describe, expect, it, vi } from "vitest";
import type { Fetcher } from "./api";
import { DeviceFlowError, requestCode, waitForToken, type DeviceCode } from "./device";

const res = (body: unknown, status = 200) => ({ status, headers: {}, body: JSON.stringify(body) });
const code: DeviceCode = { deviceCode: "dc", userCode: "ABCD-1234", verificationUri: "https://github.com/login/device", interval: 5, expiresIn: 900 };

describe("device flow", () => {
  it("requests a code as a form post and maps the response", async () => {
    const f = vi.fn<Fetcher>(async () =>
      res({ device_code: "dc", user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", interval: 5, expires_in: 900 }),
    );
    expect(await requestCode(f, "cid", "repo")).toEqual(code);
    const req = f.mock.calls[0][0];
    expect(req).toMatchObject({ url: "https://github.com/login/device/code", method: "POST", body: "client_id=cid&scope=repo" });
    expect(req.headers).toMatchObject({ Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" });
  });

  it("polls until a token arrives, slowing down when asked", async () => {
    const sleeps: number[] = [];
    const f = vi
      .fn<Fetcher>()
      .mockResolvedValueOnce(res({ error: "authorization_pending" }))
      .mockResolvedValueOnce(res({ error: "slow_down" }))
      .mockResolvedValueOnce(res({ access_token: "tok", token_type: "bearer" }));
    const token = await waitForToken(f, "cid", code, {
      signal: new AbortController().signal,
      sleep: async (ms) => void sleeps.push(ms),
      now: () => 0,
    });
    expect(token).toBe("tok");
    expect(sleeps).toEqual([5000, 5000, 10000]);
    expect(f.mock.calls[0][0].body).toBe("client_id=cid&device_code=dc&grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code");
  });

  it.each([
    ["expired_token", "expired"],
    ["access_denied", "denied"],
    ["incorrect_device_code", "other"],
  ])("maps %s to %s", async (error, kind) => {
    const f = vi.fn<Fetcher>(async () => res({ error, error_description: "nope" }));
    await expect(waitForToken(f, "cid", code, { signal: new AbortController().signal, sleep: async () => {}, now: () => 0 })).rejects.toMatchObject({ kind });
  });

  it("stops when cancelled", async () => {
    const ac = new AbortController();
    const f = vi.fn<Fetcher>(async () => res({ error: "authorization_pending" }));
    const p = waitForToken(f, "cid", code, { signal: ac.signal, sleep: async () => ac.abort(), now: () => 0 });
    await expect(p).rejects.toBeInstanceOf(DeviceFlowError);
    await expect(p).rejects.toMatchObject({ kind: "cancelled" });
    expect(f).not.toHaveBeenCalled();
  });

  it("gives up after expires_in", async () => {
    let t = 0;
    const f = vi.fn<Fetcher>(async () => res({ error: "authorization_pending" }));
    await expect(
      waitForToken(f, "cid", code, { signal: new AbortController().signal, sleep: async (ms) => void (t += ms), now: () => t }),
    ).rejects.toMatchObject({ kind: "expired" });
  });

  it("reports an unreachable GitHub as a network error", async () => {
    const f = vi.fn<Fetcher>(async () => {
      throw new Error("network: down");
    });
    await expect(requestCode(f, "cid", "repo")).rejects.toMatchObject({ kind: "network" });
  });
});
