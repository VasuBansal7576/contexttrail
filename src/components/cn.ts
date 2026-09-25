/** Tiny class-names joiner (avoids a dependency for one-liners). */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
