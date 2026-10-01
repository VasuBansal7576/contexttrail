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
          <div className="button-row"><Link className="paper-button primary" href="/casebook">Open your casebook</Link><Link className="text-link" href="/investigate">Start with an image</Link></div>
          <div className="cover-footnote"><span className="large-number">01</span><div><p className="eyebrow">Your next line of inquiry</p><p>Keep the question open.<br />Let the evidence change the answer.</p></div></div>
        </div>
        <div className="cover-specimen">
          <p className="specimen-kicker eyebrow">An illustration of a question</p>
          <figure className="cover-photo-sheet">
            <span className="eyebrow">One photograph / changing context</span>
            {/* Project-owned NASA reference image. This is never presented as retrieved evidence. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/illustrative-earthrise.jpg" alt="Earthrise above the lunar horizon, photographed on Apollo 8" />
            <figcaption>A view out of time.</figcaption>
            <span className="eyebrow">What changes when the caption does?</span>
          </figure>
          <p className="specimen-caption">Illustration only · NASA / Bill Anders, Apollo 8, 1968<br />No investigation has run. No NASA endorsement.</p>
        </div>
      </section>
      <section id="about" className="cover-about">
        <div><p className="eyebrow">Built around the evidence</p><h2>Keep the detail.<br /><em>Leave room to rethink.</em></h2></div>
        <div><p>Trace an image with the existing investigation tools, or start a saved question. Add sources, compare explanations, and pin the exact passage, image region, or table cell behind a finding.</p><p className="fine-print">Saved research uses an explicitly enabled, single-user local service. Supplied evidence and your assessments stay labeled. Source monitoring and AI answers are planned.</p><Link className="text-link" href="/casebook">Begin a research question</Link></div>
      </section>
    </main>
  </CasebookShell>;
}
