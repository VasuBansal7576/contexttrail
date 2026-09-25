/**
 * Screen 1 — Landing (spec sections 3.2, 4.5, 4.8).
 *
 * Dark editorial canvas. The hero visual is an abstract, clearly labeled
 * illustrative composition — it must never look like retrieved evidence, so
 * it uses no photographs, no publishers, no dates presented as findings.
 */
"use client";

import Link from "next/link";
import { motion, useReducedMotion } from "framer-motion";
import { Badge, SectionHeading } from "@/components/ui";

const CARDS = [
  { label: "Earlier report", note: "One image, first seen in an earlier context." },
  { label: "Later reuse", note: "The same image, reused with a new context." },
  { label: "Submitted claim", note: "What someone says it shows today." },
];

/** Abstract placeholder motif: layered frames, not a photograph. */
function IllustrativeMotif({ index }: { index: number }) {
  return (
    <svg
      viewBox="0 0 200 120"
      role="img"
      aria-label={`Abstract illustration placeholder ${index + 1} of 3`}
      className="h-24 w-full rounded-md bg-ink/5"
    >
      <rect x="12" y="12" width="176" height="96" rx="6" fill="none" stroke="currentColor" strokeOpacity="0.25" />
      <circle cx="60" cy="52" r="14" fill="none" stroke="currentColor" strokeOpacity="0.35" strokeWidth="2" />
      <path
        d="M20 100 L80 60 L120 88 L145 70 L188 100 Z"
        fill="currentColor"
        fillOpacity="0.12"
        stroke="currentColor"
        strokeOpacity="0.3"
      />
    </svg>
  );
}

function HeroCards() {
  const reduce = useReducedMotion();
  return (
    <figure aria-labelledby="hero-illustration-caption" className="relative">
      <div className="grid gap-4 sm:grid-cols-3 sm:gap-0">
        {CARDS.map((card, i) => (
          <motion.div
            key={card.label}
            initial={reduce ? false : { opacity: 0, y: 24, rotate: 0 }}
            animate={reduce ? {} : { opacity: 1, y: 0, rotate: i === 1 ? 1.5 : i === 2 ? -1.5 : 0 }}
            transition={{ delay: 0.15 * i, duration: 0.5 }}
            className={
              "rounded-xl bg-paper p-4 text-ink shadow-2xl ring-1 ring-black/10 " +
              (i > 0 ? "sm:-ml-6 sm:mt-8 " : "")
            }
          >
            <IllustrativeMotif index={i} />
            <figcaption className="mt-3">
              <p className="text-sm font-semibold">{card.label}</p>
              <p className="mt-1 text-xs leading-relaxed text-ink/60">{card.note}</p>
            </figcaption>
          </motion.div>
        ))}
      </div>
      <p id="hero-illustration-caption" className="mt-4 text-right">
        <Badge tone="neutral" className="bg-white/10 text-white/80 ring-white/20">
          Illustrative example — not retrieved evidence
        </Badge>
      </p>
    </figure>
  );
}

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-deep text-white">
      <header className="mx-auto flex max-w-[1280px] items-center justify-between px-5 py-5 sm:px-8">
        <p className="flex items-center gap-2 text-sm font-semibold tracking-tight">
          <span aria-hidden="true" className="inline-block h-4 w-4 rounded-full border-2 border-white" />
          ContextTrail
        </p>
        <nav aria-label="Primary" className="flex items-center gap-5 text-sm text-white/70">
          <a href="#how-it-works" className="hidden hover:text-white sm:inline">How it works</a>
          <a href="#example" className="hidden hover:text-white sm:inline">Example</a>
          <a href="#about" className="hidden hover:text-white sm:inline">About</a>
          <Link
            href="/investigate"
            className="rounded-full bg-paper px-4 py-2 font-medium text-ink transition hover:bg-white"
          >
            Start investigating
          </Link>
        </nav>
      </header>

      <main>
        {/* Hero */}
        <section className="mx-auto grid max-w-[1280px] items-center gap-12 px-5 pt-10 pb-16 sm:px-8 lg:grid-cols-2 lg:pt-20">
          <div>
            <h1 className="font-serif text-6xl leading-[1.02] text-balance sm:text-7xl lg:text-[5.5rem]">
              Every image has a history.
            </h1>
            <p className="mt-6 max-w-xl text-lg leading-relaxed text-white/70">
              ContextTrail traces where an image has appeared across the web, reconstructs how its
              context changed, and shows you the evidence trail.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-4">
              <Link
                href="/investigate"
                className="inline-flex min-h-[44px] items-center gap-2 rounded-full bg-paper px-6 py-3 font-medium text-ink transition hover:bg-white"
              >
                Start investigating <span aria-hidden="true">→</span>
              </Link>
              <a
                href="#example"
                className="inline-flex min-h-[44px] items-center gap-2 rounded-full px-6 py-3 font-medium text-white ring-1 ring-white/30 transition hover:ring-white/60"
              >
                <span aria-hidden="true">▷</span> See an example
              </a>
            </div>
            {/* Product-truth strip: truthful capabilities only, no vanity metrics. */}
            <ul className="mt-12 flex flex-wrap gap-x-6 gap-y-2 text-xs tracking-[0.18em] text-white/50 uppercase">
              <li>Trace earlier appearances</li>
              <li aria-hidden="true">·</li>
              <li>Follow the timeline</li>
              <li aria-hidden="true">·</li>
              <li>Compare contexts</li>
              <li aria-hidden="true">·</li>
              <li>Inspect the evidence</li>
            </ul>
          </div>
          <HeroCards />
        </section>

        {/* How it works */}
        <section id="how-it-works" className="border-t border-white/10">
          <div className="mx-auto max-w-[1280px] px-5 py-16 sm:px-8">
            <SectionHeading
              dark
              eyebrow="How it works"
              title="Search first. Conclusions second."
              intro="Live web search discovers where an image appeared. Retrieved evidence is classified, dated, and arranged into a provenance timeline you can inspect — before any claim is compared."
            />
            <ol className="mt-10 grid gap-6 md:grid-cols-3">
              {[
                { step: "1", title: "Upload an image", text: "Add an optional claim or caption. Your image is used for visual search and is not persisted by ContextTrail." },
                { step: "2", title: "Watch the live trace", text: "Google Lens, exact-match retrieval, web and news context arrive as streamed evidence with real counts — never a fake progress bar." },
                { step: "3", title: "Inspect the trail", text: "Read the timeline, open each occurrence, and check dates, excerpts, and reporting origins for yourself." },
              ].map((item) => (
                <li key={item.step} className="rounded-xl bg-white/5 p-6 ring-1 ring-white/10">
                  <p aria-hidden="true" className="font-serif text-4xl text-white/30">{item.step}</p>
                  <h3 className="mt-3 text-lg font-semibold">{item.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-white/65">{item.text}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* Example: static illustrative walkthrough, never a simulated investigation. */}
        <section id="example" className="border-t border-white/10">
          <div className="mx-auto max-w-[1280px] px-5 py-16 sm:px-8">
            <SectionHeading
              dark
              eyebrow="Illustrative example"
              title="One image, three contexts."
              intro="A static illustration of what a completed trace looks like. Sample labels are generic — this walkthrough runs no investigation and implies no live API calls."
            />
            <ol className="mt-10 space-y-0">
              {[
                { year: "2019", title: "Earlier observed report", text: "An occurrence of the image appears in an earlier report. The timeline records its date, source, and excerpt." },
                { year: "2023", title: "Reused in another context", text: "The same image reappears framed by a different event. The comparison marks the divergence — in retrieved evidence, never as an accusation." },
                { year: "2026", title: "Current submitted claim", text: "A new caption asserts a new context. The result compares the claim against the retrieved history and shows its evidence limits." },
              ].map((item, i) => (
                <li key={item.year} className="relative grid gap-2 border-l border-white/15 pb-10 pl-8 last:pb-0 sm:grid-cols-[80px_1fr] sm:gap-6">
                  <span aria-hidden="true" className="absolute top-1 -left-[5px] h-2.5 w-2.5 rounded-full bg-signal" />
                  <p className="font-serif text-2xl text-white/85">{item.year}</p>
                  <div>
                    <h3 className="font-semibold">{i === 2 ? `${item.title} (illustrative)` : item.title}</h3>
                    <p className="mt-1 max-w-2xl text-sm leading-relaxed text-white/65">{item.text}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* About */}
        <section id="about" className="border-t border-white/10">
          <div className="mx-auto max-w-[1280px] px-5 py-16 sm:px-8">
            <SectionHeading
              dark
              eyebrow="About"
              title="Evidence before explanation."
              intro="ContextTrail reports observed evidence relationships. It never outputs fake-news probabilities, never calls a source malicious, and never presents a fixture as a live result. When evidence is weak, insufficient evidence is the honest — and successful — outcome."
            />
            <div className="mt-8 flex flex-wrap gap-4">
              <Link
                href="/investigate"
                className="inline-flex min-h-[44px] items-center gap-2 rounded-full bg-paper px-6 py-3 font-medium text-ink transition hover:bg-white"
              >
                Start investigating <span aria-hidden="true">→</span>
              </Link>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-white/10">
        <p className="mx-auto max-w-[1280px] px-5 py-8 text-sm text-white/50 sm:px-8">
          ContextTrail · Media sent for visual search goes to SerpApi / Google Lens. ContextTrail does not persist your image.
        </p>
      </footer>
    </div>
  );
}
