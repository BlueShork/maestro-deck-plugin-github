import { describe, expect, it } from "vitest";
import type { Change } from "../sdk";
import { branchName, confirmationKey, describeChanges, groupChanges, groupOf, isSensitive, slugify } from "./files";

const c = (path: string, status: Change["status"] = "modified"): Change => ({ path, status, size: 1, executable: false });

describe("files", () => {
  it("groups by extension", () => {
    expect(groupOf("flows/login.yaml")).toBe("flows");
    expect(groupOf(".maestro/x.YML")).toBe("flows");
    expect(groupOf("shots/a.PNG")).toBe("screenshots");
    expect(groupOf("shots/a.webp")).toBe("screenshots");
    expect(groupOf("README.md")).toBe("other");
    expect(groupOf("Makefile")).toBe("other");
    const g = groupChanges([c("a.yaml"), c("b.png"), c("c.txt")]);
    expect([g.flows.length, g.screenshots.length, g.other.length]).toEqual([1, 1, 1]);
  });

  it.each([".env", "config/.env.local", "certs/server.pem", "a.key", "store.p12", "release.keystore", "id_rsa", "id_rsa.pub", "aws-credentials.json", "CREDENTIALS"])(
    "flags %s as sensitive",
    (p) => expect(isSensitive(p)).toBe(true),
  );
  it.each(["flows/env.yaml", "keyboard.png", "monkey.yaml", "docs/credits.md"])("does not flag %s", (p) => expect(isSensitive(p)).toBe(false));

  it("keys a sensitive-file confirmation to the exact set confirmed", () => {
    // Confirming .env must not also wave through an id_rsa ticked afterwards.
    expect(confirmationKey([c(".env"), c("a.yaml")])).toBe(confirmationKey([c("b.png"), c(".env")]));
    expect(confirmationKey([c(".env")])).not.toBe(confirmationKey([c(".env"), c("id_rsa")]));
    expect(confirmationKey([c("a.yaml")])).toBe("");
  });

  it("describes the selection grouped, skipping empty groups", () => {
    expect(describeChanges([c("shots/home.png"), c("flows/login.yaml", "added"), c("old.txt", "deleted")])).toBe(
      [
        "Files changed from Maestro Deck:",
        "",
        "**Flows**",
        "- added `flows/login.yaml`",
        "**Screenshots**",
        "- modified `shots/home.png`",
        "**Other**",
        "- deleted `old.txt`",
        "",
        "_Opened from Maestro Deck._",
      ].join("\n"),
    );
    expect(describeChanges([c("a.png")])).not.toContain("**Flows**");
  });

  it("slugs titles for branch names", () => {
    expect(slugify("Fix login flow & screenshots!")).toBe("fix-login-flow-screenshots");
    expect(slugify("Écran d'accueil")).toBe("ecran-d-accueil");
    expect(slugify("!!!")).toBe("update");
    expect(slugify("a".repeat(60))).toHaveLength(40);
    expect(slugify(`${"a".repeat(39)} b`)).toBe("a".repeat(39));
    expect(branchName("x", 1)).toBe("qa/x");
    expect(branchName("x", 3)).toBe("qa/x-3");
  });
});
