/** Identity wash — the visual-design skill's named recipe for coloring a surface
 * by *which repo or checkout it is*: two literal Tailwind accents (the JIT must
 * see them), picked by hashing a stable identity key so a given identity keeps
 * its hue everywhere it appears. Quiet blue and slate only — never red, green or
 * teal (success), brown, amber (needs-you), violet (agent-ness) or cyan (busy),
 * so identity can't pass for a signal. Status/attention hues always win over it. */
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
    badge: "border-slate-500/40 bg-slate-500/10 text-slate-700 dark:text-slate-300",
    text: "text-slate-700 dark:text-slate-300",
    wash: "bg-slate-500/10 border-b-slate-500/40",
  },
];

export function identityColor(key: string): IdentityAccent {
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) | 0;
  return IDENTITY_ACCENTS[Math.abs(hash) % IDENTITY_ACCENTS.length];
}
