/** Fences render uncolored: the colorizer was Monaco's, and Monaco left with the
 * diff pane. react-markdown routes inline `code` here too, so this one component
 * serves both. */
export function MarkdownCode({
  className,
  children,
}: {
  className?: string;
  children?: React.ReactNode;
}) {
  return <code className={className}>{String(children ?? "").replace(/\n$/, "")}</code>;
}
