/**
 * Minimal shared UI primitives. Status is always icon + text, never color
 * alone (spec section 4.6).
 */
import type { ReactNode } from "react";
import { cn } from "./cn";

export function StatusDot({ kind, label }: { kind: "ok" | "active" | "idle" | "bad" | "muted"; label: string }) {
  const styles: Record<string, string> = {
    ok: "bg-evidence",
    active: "bg-signal",
    idle: "border border-current opacity-40",
    bad: "bg-coral",
    muted: "bg-mist",
  };
  return (
    <span className="inline-flex items-center gap-2">
      {kind === "ok" ? (
        <span aria-hidden="true" className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-evidence-ink text-sm text-white">
          ✓
        </span>
      ) : kind === "active" ? (
        <span aria-hidden="true" className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-signal">
          <span className="h-2 w-2 animate-pulse rounded-full bg-white" />
        </span>
      ) : (
        <span aria-hidden="true" className={cn("inline-block h-4 w-4 rounded-full", styles[kind])} />
      )}
      <span>{label}</span>
    </span>
  );
}

export function Badge({
  children,
  tone = "neutral",
  className,
}: {
  children: ReactNode;
  tone?: "neutral" | "info" | "link" | "conflict" | "ok";
  className?: string;
}) {
  const tones: Record<string, string> = {
    neutral: "bg-black/5 text-ink/80 ring-black/10",
    /* `info` is dark-surfaces only; pale foreground is AA on the progress card. */
    info: "bg-signal/10 text-signal-pale ring-signal/25",
    link: "bg-signal-ink/10 text-signal-ink ring-signal-ink/25",
    /* Coral text stays AA-safe via coral-ink (U5); the icon may stay coral. */
    conflict: "bg-coral/10 text-coral-ink ring-coral/25",
    ok: "bg-evidence/10 text-evidence-ink ring-evidence/25",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset",
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function SectionHeading({
  eyebrow,
  title,
  intro,
  dark = false,
}: {
  eyebrow?: string;
  title: string;
  intro?: string;
  dark?: boolean;
}) {
  return (
    <div className="max-w-2xl">
      {eyebrow ? (
        <p className={cn("text-xs font-semibold tracking-[0.2em] uppercase", dark ? "text-white/60" : "text-ink/60")}>
          {eyebrow}
        </p>
      ) : null}
      <h2
        className={cn(
          "mt-2 font-serif text-3xl leading-tight text-balance sm:text-4xl",
          dark ? "text-white" : "text-ink",
        )}
      >
        {title}
      </h2>
      {intro ? (
        <p className={cn("mt-3 text-base leading-relaxed", dark ? "text-white/70" : "text-ink/70")}>{intro}</p>
      ) : null}
    </div>
  );
}
