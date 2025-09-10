export function cn(...args) {
  return args
    .flatMap(a => (Array.isArray(a) ? a : [a]))
    .filter(Boolean)
    .join(" ");
}
