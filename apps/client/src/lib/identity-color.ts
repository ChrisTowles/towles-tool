/** Identity wash — the visual-design skill's named recipe for coloring a surface
 * by *which repo or checkout it is*: six literal Tailwind accents (the JIT must
 * see them), picked by hashing a stable identity key so a given identity keeps
 * its hue everywhere it appears. Status/attention hues always win over it. */
export type IdentityAccent = {
  badge: string;
  text: string;
  wash: string;
};

export const IDENTITY_ACCENTS: IdentityAccent[] = [
  {
    badge: "border-blue-500/40 bg-blue-500/10 text-blue-700 dark:text-blue-300",
    text: "text-blue-700 dark:text-blue-300",
    wash: "bg-blue-500/10 border-b-blue-500/40",
  },
  {
    badge: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    text: "text-emerald-700 dark:text-emerald-300",
    wash: "bg-emerald-500/10 border-b-emerald-500/40",
  },
  {
    badge: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    text: "text-amber-700 dark:text-amber-300",
    wash: "bg-amber-500/10 border-b-amber-500/40",
  },
  {
    badge: "border-violet-500/40 bg-violet-500/10 text-violet-700 dark:text-violet-300",
    text: "text-violet-700 dark:text-violet-300",
    wash: "bg-violet-500/10 border-b-violet-500/40",
  },
  {
    badge: "border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-300",
    text: "text-rose-700 dark:text-rose-300",
    wash: "bg-rose-500/10 border-b-rose-500/40",
  },
  {
    badge: "border-cyan-500/40 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300",
    text: "text-cyan-700 dark:text-cyan-300",
    wash: "bg-cyan-500/10 border-b-cyan-500/40",
  },
];

export function identityColor(key: string): IdentityAccent {
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) | 0;
  return IDENTITY_ACCENTS[Math.abs(hash) % IDENTITY_ACCENTS.length];
}
