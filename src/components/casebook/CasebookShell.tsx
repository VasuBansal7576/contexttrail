'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import PaperDialog from './PaperDialog';
import {ChapterTourStep} from './ChapterTour';
import { chapterTiming, chapterPosition, tourClock, tourDuration } from './chapter-timing';
import { useChapterTurn } from './ChapterTurn';

const chapterNames = ['cover', 'image', 'video', 'questions', 'evidence', 'sources', 'changes', 'watch', 'answers'];
const descriptions = ['A place to begin.', 'Follow an image and the caption attached to it.', 'Inspect the visual trail and the spoken context.', 'Keep explanations beside their evidence.', 'Return to exact passages, regions and cells.', 'Follow attribution before counting sources.', 'Read both versions when a source changes.', 'Return when new evidence arrives.', 'Read each assertion beside its source.'];
const TOUR_KEY = 'contexttrail.chapter-tour';
const ACTIVE_CASE_KEY = 'contexttrail.chapter-case';
const ACTIVE_MEDIA_CASE_KEY = 'contexttrail.chapter-media-case';
const SavedCaseNavigation = createContext<((caseId: string, hasVideo: boolean) => void) | null>(null);
export function useSavedCaseNavigation() { return useContext(SavedCaseNavigation); }
const CoverNavigation = createContext<{ start: () => void; contents: () => void } | null>(null);
export function CoverActions() {
  const navigation = useContext(CoverNavigation);
  return <div className="button-row cover-actions"><button className="paper-button primary" onClick={() => navigation?.start()}>Walk through the casebook <span aria-hidden="true">↗</span></button><button className="text-link" onClick={() => navigation?.contents()}>Choose a chapter</button></div>;
}
export function CasebookShell({ children, chapter = 'cover', caseId, mediaCase, dark = false }: { children: ReactNode; chapter?: string; caseId?: string; mediaCase?: boolean; dark?: boolean }) {
  const router = useRouter();
  const turn = useChapterTurn();
  const content = useRef<HTMLDivElement>(null);
  const elapsedRef = useRef(0);
  const [elapsed,setElapsed]=useState(0), [activeCase,setActiveCase]=useState(caseId);
  const [activeMediaCase, setActiveMediaCase] = useState<string>();
  const rememberSavedCase = useCallback((savedId: string, hasVideo: boolean) => {
    setActiveCase(savedId);
    setActiveMediaCase(hasVideo ? savedId : undefined);
    try {
      sessionStorage.setItem(ACTIVE_CASE_KEY, savedId);
      if (hasVideo) sessionStorage.setItem(ACTIVE_MEDIA_CASE_KEY, savedId);
      else sessionStorage.removeItem(ACTIVE_MEDIA_CASE_KEY);
    } catch { /* The active saved case still follows this mounted view. */ }
  }, []);
  const [scale, setScale] = useState(1), [dialog, setDialog] = useState<'contents' | 'about' | null>(null), [playing, setPlaying] = useState(false);
  const currentCase = caseId ?? activeCase;
  const caseHref = (next: string) => currentCase ? `/casebook?case=${encodeURIComponent(currentCase)}&chapter=${next}` : `/casebook?chapter=${next}`;
  const hasSavedVideo = mediaCase ?? (Boolean(currentCase) && currentCase === activeMediaCase);
  const chapters = chapterNames.map(id => ({ id, title: id === 'answers' ? 'AI answers' : id[0].toUpperCase() + id.slice(1), href: id === 'cover' ? '/' : id === 'image' ? '/investigate' : id === 'video' ? currentCase && hasSavedVideo ? caseHref('video') : '/video' : id === 'watch' ? currentCase ? `/watch?case=${encodeURIComponent(currentCase)}` : '/watch' : id === 'questions' && !currentCase ? '/questions' : caseHref(id) }));
  const selected = Math.max(0, chapterNames.indexOf(chapter === 'audio' ? 'video' : chapter === 'families' ? 'sources' : chapter));
  const timing = chapterTiming[selected], position = chapterPosition(selected, elapsed);
  const keyboardChapter = useRef(selected);
  useEffect(() => { keyboardChapter.current = selected; }, [selected]);
  const navigate = (href: string, instant = false) => turn ? turn.navigate(href, instant) : router.push(href);
  function pause() { setPlaying(false); try { sessionStorage.removeItem(TOUR_KEY); } catch { /* Playback still stops in this view. */ } }
  useEffect(() => {
    // The authored HTML scales the entire 1440 × 900 stage at every viewport size.
    const fit = () => setScale(Math.min(window.innerWidth / 1440, window.innerHeight / 900));
    fit(); window.addEventListener('resize', fit);
    try { setPlaying(sessionStorage.getItem(TOUR_KEY) === 'playing'); } catch { /* The tour can run without persisted playback. */ }
    return () => window.removeEventListener('resize', fit);
  }, []);
  useEffect(() => {
    try { if (caseId) sessionStorage.setItem(ACTIVE_CASE_KEY, caseId); setActiveCase(caseId ?? sessionStorage.getItem(ACTIVE_CASE_KEY) ?? undefined); } catch { /* Navigation can work without a remembered case. */ }
    elapsedRef.current = 0; setElapsed(0);
    if (content.current) content.current.scrollTop = 0;
    turn?.arrived();
  }, [chapter,caseId,turn?.arrived]);
  useEffect(() => {
    try {
      const remembered = sessionStorage.getItem(ACTIVE_MEDIA_CASE_KEY);
      if (caseId && mediaCase === true) {
        sessionStorage.setItem(ACTIVE_MEDIA_CASE_KEY, caseId);
        setActiveMediaCase(caseId);
      } else if (caseId && mediaCase === false && remembered === caseId) {
        sessionStorage.removeItem(ACTIVE_MEDIA_CASE_KEY);
        setActiveMediaCase(undefined);
      } else {
        setActiveMediaCase(remembered ?? undefined);
      }
    } catch { /* The selected case still works without persisted media navigation. */ }
  }, [caseId, mediaCase]);
  useEffect(() => {
    if (!playing || dialog || turn?.turning) return;
    let readingTime=elapsedRef.current;
    const timer=setInterval(()=>{
      if(document.hidden || document.querySelector('[role="dialog"]'))return;
      readingTime=Math.min(timing.duration,readingTime+250);elapsedRef.current=readingTime;setElapsed(readingTime);
      if(readingTime===timing.duration){
        clearInterval(timer);
        if(selected===chapters.length-1)pause();
        else navigate(chapters[selected+1].href);
      }
    },250);
    return () => clearInterval(timer);
  }, [playing, dialog, chapter, currentCase, hasSavedVideo, turn?.turning]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (dialog || document.querySelector('[role="dialog"]') || event.altKey || event.ctrlKey || event.metaKey || (event.target instanceof HTMLElement && (event.target.matches('input,textarea,select,button,a,summary') || event.target.isContentEditable))) return;
      if (event.code === 'Space') { event.preventDefault(); toggleTour(); }
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
        const next = Math.max(0, Math.min(chapters.length - 1, keyboardChapter.current + (event.key === 'ArrowRight' ? 1 : -1)));
        if (next !== keyboardChapter.current) { event.preventDefault(); keyboardChapter.current = next; pause(); navigate(chapters[next].href, true); }
      }
    };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, [chapter, currentCase, hasSavedVideo, dialog, playing, turn?.turning]);
  function play() { try { sessionStorage.setItem(TOUR_KEY, 'playing'); } catch { /* Playback remains local to this view. */ } setPlaying(true); }
  function toggleTour() { if (playing) pause(); else { play(); if (selected === chapters.length - 1) navigate('/'); } }
  function startTour() { play(); if (selected === 0) navigate(chapters[1].href); else if (selected === chapters.length - 1) navigate('/'); }
  const theme = chapter === 'video' || chapter === 'audio' ? 'night' : chapter === 'answers' ? 'brick' : dark || chapter === 'image' || chapter === 'sources' ? 'blue' : 'paper';
  const folioStyle: CSSProperties & Record<'--folio-scale', number> = { '--folio-scale': scale };
  return <div className="casebook-viewport desktop-folio">
    <div className={`casebook-app chapter-${chapter} folio-${theme}${turn?.instant ? ' instant-navigation' : ''}`} style={folioStyle} onClickCapture={event => { const target = event.target; if (target instanceof Element && target.closest('main button,main input,main textarea,main select,main summary,main a')) pause(); }}>
      <a className="skip-link" href="#main">Skip to content</a>
      <header className="casebook-header">
        <Link className="casebook-brand" href="/" onClick={event => { event.preventDefault(); pause(); navigate('/', event.detail === 0); }}><svg viewBox="0 0 40 30" fill="none" aria-hidden="true"><path d="M2 7h25v19H2zM11 2h26v18H27M16 11l10 6-10 6M7 17h18" stroke="currentColor" strokeWidth="1.4" /></svg>ContextTrail</Link>
        <div className="casebook-header-end"><span className="desktop-only">A PLACE FOR THE QUESTION</span><button onClick={() => { pause(); setDialog('contents'); }}>The casebook</button><button onClick={() => { pause(); setDialog('about'); }}>About</button></div>
      </header>
      <SavedCaseNavigation.Provider value={rememberSavedCase}><CoverNavigation.Provider value={{ start: startTour, contents: () => { pause(); setDialog('contents'); } }}><ChapterTourStep.Provider value={playing && timing.selectionInterval ? Math.floor(elapsed/timing.selectionInterval) : null}><div className="folio-content" ref={content}>{children}</div></ChapterTourStep.Provider></CoverNavigation.Provider></SavedCaseNavigation.Provider>
      <footer className="chapter-nav">
        <div className={`folio-progress${playing && elapsed > 0 ? ' playing' : ''}`} style={{ transform: `scaleX(${position/tourDuration})` }} />
        <div className="folio-controls"><button aria-label="Previous chapter" disabled={selected === 0} onClick={event => { pause(); navigate(chapters[selected - 1].href, event.detail === 0); }}>←</button><button className="folio-play" aria-label={playing ? 'Pause the guided tour' : 'Play the guided tour'} onClick={toggleTour}>{playing ? 'Ⅱ' : '▶'}</button><button aria-label="Next chapter" disabled={selected === chapters.length - 1} onClick={event => { pause(); navigate(chapters[selected + 1].href, event.detail === 0); }}>→</button></div>
        <nav className="chapter-links" aria-label="Chapters">{chapters.map((item, index) => <Link key={item.id} href={item.href} onClick={event => { event.preventDefault(); pause(); navigate(item.href, event.detail === 0); }} aria-current={selected === index ? 'page' : undefined}><span>{String(index).padStart(2, '0')}</span>{item.title}</Link>)}</nav>
        <div className="folio-mode"><strong>{playing ? 'Playing the casebook' : 'Explore at your pace'}</strong><span>{playing ? `${tourClock(position)} / ${tourClock(tourDuration)}` : '← → chapters · space to play'}</span></div>
      </footer>
    </div>
    {dialog ? <PaperDialog wide title={dialog === 'contents' ? 'Come in through any question.' : 'A wider view. A visible trail.'} description={dialog === 'contents' ? 'Choose a working surface. Your saved case follows you through its evidence, sources and changes.' : 'Bring the question. ContextTrail searches, compares source passages and keeps the evidence where you can inspect it.'} onClose={() => setDialog(null)}>
      {dialog === 'contents' ? <><div className="folio-contents">{chapters.slice(1).map((item, index) => <Link key={item.id} href={item.href} onClick={event => { event.preventDefault(); setDialog(null); pause(); navigate(item.href); }}><span>{String(index + 1).padStart(2, '0')}</span><div><h3>{item.title}</h3><p>{descriptions[index + 1]}</p></div></Link>)}</div><div className="button-row"><Link href="/audio" className="text-link" onClick={() => setDialog(null)}>Investigate a recording ↗</Link><Link href="/families" className="text-link" onClick={() => setDialog(null)}>Related versions across cases ↗</Link><Link href="/casebook" className="text-link" onClick={() => setDialog(null)}>All saved investigations ↗</Link></div></> : <><div className="folio-about"><div><h3>Start anywhere.</h3><p>A question, a claim, an image, a video or a recording. Follow what was said and the context around it.</p></div><div><h3>Keep the exact thing.</h3><p>Read retained passages inside the casebook. Inspect dates, source links and the reasons behind an assessment.</p></div><div><h3>Let the answer change.</h3><p>Keep earlier evidence and corrections attached. Return to a saved investigation or follow it with a watch.</p></div></div><p className="fine-print">Cover illustration: NASA / Bill Anders, Apollo 8, 1968. Engraved hand from the original concept. The illustrated cover is separate from retrieved evidence.</p></>}
    </PaperDialog> : null}
  </div>;
}
export function ChapterHeading({ number, label, children, description }: { number: string; label: string; children: ReactNode; description?: ReactNode }) {
  return <div className="chapter-heading"><p className="eyebrow">{number} / {label}</p><h1>{children}</h1>{description ? <p className="chapter-description">{description}</p> : null}</div>;
}
