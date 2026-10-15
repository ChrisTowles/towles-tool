/** Identity wash — the visual-design skill's named recipe for coloring a surface
 * by *which repo or checkout it is*: two `index.css` tokens as literal classes (the JIT must
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
    badge: "border-ident-a/40 bg-ident-a/10 text-ident-a",
    text: "text-ident-a",
    wash: "bg-ident-a/10 border-b-ident-a/40",
  },
  {
    badge: "border-ident-b/40 bg-ident-b/10 text-ident-b",
    text: "text-ident-b",
    wash: "bg-ident-b/10 border-b-ident-b/40",
  },
];

export function identityColor(key: string): IdentityAccent {
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) | 0;
  return IDENTITY_ACCENTS[Math.abs(hash) % IDENTITY_ACCENTS.length];
}
