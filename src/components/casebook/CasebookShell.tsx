'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import PaperDialog from './PaperDialog';
import {ChapterTourStep} from './ChapterTour';

const chapterNames = ['cover', 'image', 'video', 'questions', 'evidence', 'sources', 'changes', 'watch', 'answers'];
const descriptions = ['A place to begin.', 'Follow an image and the caption attached to it.', 'Inspect the visual trail and the spoken context.', 'Keep explanations beside their evidence.', 'Return to exact passages, regions and cells.', 'Follow attribution before counting sources.', 'Read both versions when a source changes.', 'Return when new evidence arrives.', 'Read each assertion beside its source.'];
const TOUR_KEY = 'contexttrail.chapter-tour';
export function CasebookShell({ children, chapter = 'cover', caseId, dark = false }: { children: ReactNode; chapter?: string; caseId?: string; dark?: boolean }) {
  const router = useRouter();
  const content = useRef<HTMLDivElement>(null);
  const [elapsed,setElapsed]=useState(0);
  const [scale, setScale] = useState(1), [desktop, setDesktop] = useState(false), [dialog, setDialog] = useState<'contents' | 'about' | null>(null), [playing, setPlaying] = useState(false);
  const caseHref = (next: string) => caseId ? `/casebook?case=${encodeURIComponent(caseId)}&chapter=${next}` : `/casebook?chapter=${next}`;
  const chapters = chapterNames.map(id => ({ id, title: id === 'answers' ? 'AI answers' : id[0].toUpperCase() + id.slice(1), href: id === 'cover' ? '/' : id === 'image' ? '/investigate' : id === 'video' ? caseId ? caseHref('video') : '/video' : id === 'watch' ? caseId ? `/watch?case=${encodeURIComponent(caseId)}` : '/watch' : id === 'questions' && !caseId ? '/questions' : caseHref(id) }));
  const selected = Math.max(0, chapterNames.indexOf(chapter === 'audio' ? 'video' : chapter === 'families' ? 'sources' : chapter));
  function pause() { setPlaying(false); try { sessionStorage.removeItem(TOUR_KEY); } catch { /* Playback still stops in this view. */ } }
  useEffect(() => {
    const fit = () => { setDesktop(window.innerWidth >= 900); setScale(Math.min(window.innerWidth / 1440, window.innerHeight / 900)); };
    fit(); window.addEventListener('resize', fit);
    try { setPlaying(sessionStorage.getItem(TOUR_KEY) === 'playing'); } catch { /* The tour can run without persisted playback. */ }
    return () => window.removeEventListener('resize', fit);
  }, []);
  useEffect(() => { if (content.current) content.current.scrollTop = 0; }, [chapter,caseId]);
  useEffect(() => {
    if (!playing || dialog) return;
    let readingTime=0;
    setElapsed(0);
    const timer=setInterval(()=>{
      if(document.hidden)return;
      readingTime=Math.min(18_000,readingTime+250);setElapsed(readingTime);
      if(readingTime===18_000){
        clearInterval(timer);
        if(selected===chapters.length-1)pause();
        else router.push(chapters[selected+1].href);
      }
    },250);
    return () => clearInterval(timer);
  }, [playing, dialog, chapter, caseId]); // Each chapter receives its own reading interval.
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (dialog || event.altKey || event.ctrlKey || event.metaKey || (event.target instanceof HTMLElement && (event.target.matches('input,textarea,select,button,a,summary') || event.target.isContentEditable))) return;
      if (event.code === 'Space') { event.preventDefault(); toggleTour(); }
      if (event.key === 'ArrowRight' && selected < chapters.length - 1) { event.preventDefault(); pause(); router.push(chapters[selected + 1].href); }
      if (event.key === 'ArrowLeft' && selected > 0) { event.preventDefault(); pause(); router.push(chapters[selected - 1].href); }
    };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, [chapter, caseId, dialog, playing]);
  function toggleTour() { if (playing) pause(); else { try { sessionStorage.setItem(TOUR_KEY, 'playing'); } catch { /* Playback remains local to this view. */ } if (selected === chapters.length - 1) router.push('/'); else setPlaying(true); } }
  const theme = chapter === 'video' || chapter === 'audio' ? 'night' : chapter === 'answers' ? 'brick' : dark || chapter === 'image' || chapter === 'sources' ? 'blue' : 'paper';
  return <div className={`casebook-viewport${desktop ? ' desktop-folio' : ''}`}>
    <div className={`casebook-app chapter-${chapter} folio-${theme}`} style={{ '--folio-scale': scale } as CSSProperties} onClickCapture={event => { const target = event.target; if (target instanceof Element && target.closest('main button,main input,main textarea,main select,main summary,main a')) pause(); }}>
      <a className="skip-link" href="#main">Skip to content</a>
      <header className="casebook-header">
        <Link className="casebook-brand" href="/" onClick={pause}><svg viewBox="0 0 40 30" fill="none" aria-hidden="true"><path d="M2 7h25v19H2zM11 2h26v18H27M16 11l10 6-10 6M7 17h18" stroke="currentColor" strokeWidth="1.4" /></svg>ContextTrail</Link>
        <div className="casebook-header-end"><span className="eyebrow desktop-only">A place for the question</span><button onClick={() => { pause(); setDialog('contents'); }}>The casebook</button><button onClick={() => { pause(); setDialog('about'); }}>About</button></div>
      </header>
      <ChapterTourStep.Provider value={playing ? Math.min(3,Math.floor(elapsed/4500)) : null}><div className="folio-content" ref={content}>{children}</div></ChapterTourStep.Provider>
      <footer className="chapter-nav">
        <div className="folio-progress" style={{ width: `${Math.min(1,(selected+(playing?elapsed/18_000:0))/(chapters.length-1))*100}%` }} />
        <div className="folio-controls"><button aria-label="Previous chapter" disabled={selected === 0} onClick={() => { pause(); router.push(chapters[selected - 1].href); }}>←</button><button className="folio-play" aria-label={playing ? 'Pause the guided tour' : 'Play the guided tour'} onClick={toggleTour}>{playing ? 'Ⅱ' : '▶'}</button><button aria-label="Next chapter" disabled={selected === chapters.length - 1} onClick={() => { pause(); router.push(chapters[selected + 1].href); }}>→</button></div>
        <nav className="chapter-links" aria-label="Chapters">{chapters.map((item, index) => <Link key={item.id} href={item.href} onClick={pause} aria-current={selected === index ? 'page' : undefined}><span>{String(index).padStart(2, '0')}</span>{item.title}</Link>)}</nav>
        <div className="folio-mode"><strong>{playing ? 'Playing the casebook' : 'Explore at your pace'}</strong><span>← → chapters · pause to inspect</span></div>
      </footer>
    </div>
    {dialog ? <PaperDialog wide title={dialog === 'contents' ? 'Come in through any question.' : 'A wider view. A visible trail.'} description={dialog === 'contents' ? 'Choose a working surface. Your saved case follows you through its evidence, sources and changes.' : 'Bring the question. ContextTrail searches, compares source passages and keeps the evidence where you can inspect it.'} onClose={() => setDialog(null)}>
      {dialog === 'contents' ? <><div className="folio-contents">{chapters.slice(1).map((item, index) => <Link key={item.id} href={item.href} onClick={() => setDialog(null)}><span>{String(index + 1).padStart(2, '0')}</span><div><h3>{item.title}</h3><p>{descriptions[index + 1]}</p></div></Link>)}</div><div className="button-row"><Link href="/audio" className="text-link" onClick={() => setDialog(null)}>Investigate a recording ↗</Link><Link href="/families" className="text-link" onClick={() => setDialog(null)}>Related versions across cases ↗</Link><Link href="/casebook" className="text-link" onClick={() => setDialog(null)}>All saved investigations ↗</Link></div></> : <><div className="folio-about"><div><h3>Start anywhere.</h3><p>A question, a claim, an image, a video or a recording. Follow what was said and the context around it.</p></div><div><h3>Keep the exact thing.</h3><p>Read retained passages inside the casebook. Inspect dates, source links and the reasons behind an assessment.</p></div><div><h3>Let the answer change.</h3><p>Keep earlier evidence and corrections attached. Return to a saved investigation or follow it with a watch.</p></div></div><p className="fine-print">Cover illustration: NASA / Bill Anders, Apollo 8, 1968. Engraved hand from the original concept. The illustrated cover is separate from retrieved evidence.</p></>}
    </PaperDialog> : null}
  </div>;
}
export function ChapterHeading({ number, label, children, description }: { number: string; label: string; children: ReactNode; description?: ReactNode }) {
  return <div className="chapter-heading"><p className="eyebrow">{number} / {label}</p><h1>{children}</h1>{description ? <p className="chapter-description">{description}</p> : null}</div>;
}
