import { CasebookShell, CoverActions } from '@/components/casebook/CasebookShell';
export default function LandingPage() {
  return <CasebookShell><main id="main" tabIndex={-1}>
    <section className="cover-layout">
      <div className="cover-rule" />
      <div className="cover-copy"><p className="eyebrow">A place for the question</p><h1>Follow the<br /><em>question.</em></h1>
        <p className="cover-description">From a single frame to a changing story.<br />A place to follow evidence, keep the details,<br />and return when something moves.</p>
        <CoverActions />
      </div>
      <div className="cover-specimen cover-collage">
        <svg className="cover-orbits" viewBox="0 0 695 602" aria-hidden="true"><ellipse cx="337" cy="293" rx="296" ry="259" fill="#b7c5c0" transform="rotate(-20 337 293)" /><ellipse cx="337" cy="293" rx="270" ry="102" fill="none" stroke="currentColor" transform="rotate(-20 337 293)" /><ellipse cx="337" cy="293" rx="128" ry="240" fill="none" stroke="currentColor" transform="rotate(-20 337 293)" /><path className="cover-orbit-trail" d="M31 142C161-52 656 46 617 415S164 645 70 456" fill="none" stroke="#b44833" strokeWidth="2" strokeDasharray="4 8" /></svg>
        <figure className="cover-photo-sheet">
          {/* The cover artwork is illustrative; it is not an investigation result. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/illustrative-earthrise.jpg" alt="Earthrise above the lunar horizon, photographed on Apollo 8" /><figcaption>A view out of time.</figcaption><span className="eyebrow">One case / many ways in</span>
        </figure>
        <span className="cover-strip cover-strip-date">An image with a different date.</span><span className="cover-strip cover-strip-frame">00:14 in a travelling clip</span><span className="cover-strip cover-strip-question">What else could explain it?</span><span className="cover-strip cover-strip-source">A source changes its story.</span>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="cover-pointing-hand" src="/illustrative-pointing-hand.png" alt="" aria-hidden="true" /><span className="cover-star" aria-hidden="true">✷</span>
      </div>
      <div className="cover-footnote"><span className="large-number">009</span><p>THE CONTEXTTRAIL CASEBOOK<br />Nine ways to follow a question.<br />Explore freely, or play the guided tour.</p></div>
    </section>
  </main></CasebookShell>;
}
