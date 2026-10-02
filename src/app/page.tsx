import Link from "next/link";
import { CasebookShell } from "@/components/casebook/CasebookShell";

export default function LandingPage() {
  return <CasebookShell>
    <main id="main" tabIndex={-1}>
      <section className="cover-layout">
        <div className="cover-copy">
          <p className="eyebrow">A place for the question</p>
          <h1>Follow the<br /><em>question.</em></h1>
          <p className="cover-description">From a single frame to a changing story.<br />Follow evidence, keep the details,<br />and return with a better question.</p>
          <div className="button-row"><Link className="paper-button primary" href="/investigate">Investigate an image <span aria-hidden="true">↗</span></Link><Link className="text-link" href="/casebook">Return to a saved case</Link></div>
          <div className="button-row automatic-cover-links"><Link className="text-link" href="/questions">Investigate a question ↗</Link><Link className="text-link" href="/video">Investigate a video ↗</Link></div>
          <div className="cover-footnote"><span className="large-number">01</span><div><p className="eyebrow">Your next line of inquiry</p><p>Keep the question open.<br />Let the evidence change the answer.</p></div></div>
        </div>
        <div className="cover-specimen cover-collage">
          <div className="cover-disc" aria-hidden="true" />
          <svg className="cover-orbits" viewBox="0 0 600 570" aria-hidden="true"><ellipse cx="301" cy="273" rx="241" ry="238" transform="rotate(-24 301 273)" /><ellipse cx="301" cy="273" rx="265" ry="115" transform="rotate(-33 301 273)" /></svg>
          <span className="cover-star" aria-hidden="true">✷</span>
          <figure className="cover-photo-sheet">
            <span className="eyebrow">A photograph / a question</span>
            {/* Illustrative reference, never represented as retrieved evidence. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/illustrative-earthrise.jpg" alt="Earthrise above the lunar horizon, photographed on Apollo 8" />
            <figcaption>A view out of time.</figcaption>
            <span className="eyebrow">One image / many ways in</span>
          </figure>
          <span className="cover-strip cover-strip-date">An image with a different date.</span>
          <span className="cover-strip cover-strip-frame">A moment in a travelling clip.</span>
          <span className="cover-strip cover-strip-question">What else could explain it?</span>
          <span className="cover-strip cover-strip-source">A source changes its story.</span>
          {/* Original generated artwork recovered unchanged from the authored cover concept. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="cover-pointing-hand" src="/illustrative-pointing-hand.png" alt="" aria-hidden="true" />
          <p className="specimen-caption">Illustrative cover · NASA / Bill Anders, Apollo 8, 1968<br />Generated pointing-hand artwork from the original concept.<br />These illustrations are not retrieved investigation evidence.</p>
        </div>
      </section>
      <section id="about" className="cover-about">
        <div><p className="eyebrow">Built around the evidence</p><h2>Keep the detail.<br /><em>Leave room to rethink.</em></h2></div>
        <div><p>Investigate an image, a video, or a question. Follow retrieved sources and inspect the evidence behind each result. Use the manual casebook to save your own research and exact findings.</p><p className="fine-print">Saved research uses an explicitly enabled, single-user local service. Supplied evidence and your assessments stay labeled. Source monitoring and AI answers are planned.</p><Link className="text-link" href="/questions">Begin a research question</Link></div>
      </section>
    </main>
  </CasebookShell>;
}
