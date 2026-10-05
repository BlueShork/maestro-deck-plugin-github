import type { Change } from "../sdk";

export type Group = "flows" | "screenshots" | "other";
export const GROUPS: { id: Group; label: string }[] = [
  { id: "flows", label: "Flows" },
  { id: "screenshots", label: "Screenshots" },
  { id: "other", label: "Other" },
];

const base = (path: string) => path.slice(path.lastIndexOf("/") + 1).toLowerCase();
const ext = (path: string) => {
  const b = base(path);
  const dot = b.lastIndexOf(".");
  return dot < 0 ? "" : b.slice(dot + 1);
};

export function groupOf(path: string): Group {
  const e = ext(path);
  if (e === "yaml" || e === "yml") return "flows";
  if (["png", "jpg", "jpeg", "webp", "gif"].includes(e)) return "screenshots";
  return "other";
}

export function groupChanges(changes: Change[]): Record<Group, Change[]> {
  const out: Record<Group, Change[]> = { flows: [], screenshots: [], other: [] };
  for (const c of changes) out[groupOf(c.path)].push(c);
  return out;
}

/** File names that usually hold secrets, matched on the basename. */
export function isSensitive(path: string): boolean {
  const b = base(path);
  return (
    b.startsWith(".env") ||
    b.startsWith("id_rsa") ||
    b.includes("credentials") ||
    [".pem", ".key", ".p12", ".keystore"].some((s) => b.endsWith(s))
  );
}

export function describeChanges(selected: Change[]): string {
  const g = groupChanges(selected);
  const lines = ["Files changed from Maestro Deck:", ""];
  for (const { id, label } of GROUPS) {
    if (g[id].length === 0) continue;
    lines.push(`**${label}**`, ...g[id].map((c) => `- ${c.status} \`${c.path}\``));
  }
  lines.push("", "_Opened from Maestro Deck._");
  return lines.join("\n");
}

export function slugify(title: string): string {
  const s = title
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return s || "update";
}

export const branchName = (slug: string, attempt: number) => (attempt === 1 ? `qa/${slug}` : `qa/${slug}-${attempt}`);
