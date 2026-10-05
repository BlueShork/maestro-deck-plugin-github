// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { host } from "./sdk";

describe("sdk workspace", () => {
  it("calls workspace.readFile with the path", () => {
    const post = vi.spyOn(window.parent, "postMessage");
    void host.workspace.readFile("flows/a.yaml");
    expect(post.mock.lastCall![0]).toMatchObject({ type: "md-rpc", method: "workspace.readFile", params: { path: "flows/a.yaml" } });
  });

  it("notifies workspace listeners on the host event", () => {
    const cb = vi.fn();
    const off = host.onWorkspace(cb);
    window.dispatchEvent(new MessageEvent("message", { data: { type: "md-event", name: "workspace" }, source: window.parent }));
    off();
    window.dispatchEvent(new MessageEvent("message", { data: { type: "md-event", name: "workspace" }, source: window.parent }));
    expect(cb).toHaveBeenCalledTimes(1);
  });
});
