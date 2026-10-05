'use client';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
type ChapterTurn = { navigate: (href: string, instant?: boolean) => void; arrived: () => void; turning: boolean; instant: boolean };
const Turns = createContext<ChapterTurn | null>(null);
export const useChapterTurn = () => useContext(Turns);

/** The paper wipe survives route changes because this provider lives in the root layout. */
export function ChapterTurnProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [turning, setTurning] = useState(false), [scale, setScale] = useState(1);
  const [instant, setInstant] = useState(false), [turnId, setTurnId] = useState(0);
  const destination = useRef('');
  const pending = useRef(false), routed = useRef(false);
  const swap = useRef<ReturnType<typeof setTimeout> | null>(null);
  const finish = useRef<ReturnType<typeof setTimeout> | null>(null);
  const release = useCallback(() => {
    pending.current = false; routed.current = false; setTurning(false);
    if (swap.current) clearTimeout(swap.current);
    if (finish.current) clearTimeout(finish.current);
  }, []);
  const arrived = useCallback(() => {
    if (pending.current && routed.current && destination.current === window.location.pathname + window.location.search) {
      if (finish.current) clearTimeout(finish.current);
      finish.current = setTimeout(release, 370);
    }
  }, [release]);
  const navigate = useCallback((href: string, immediate = false) => {
    release(); setInstant(immediate);
    if (href === window.location.pathname + window.location.search) return;
    if (immediate || window.matchMedia('(prefers-reduced-motion: reduce)').matches) { router.push(href); return; }
    destination.current = href;
    pending.current = true; setTurnId(value => value + 1); setTurning(true);
    swap.current = setTimeout(() => {
      routed.current = true; router.push(href);
      finish.current = setTimeout(release, 6000);
    }, 310);
  }, [router, release]);
  useEffect(() => {
    const fit = () => setScale(Math.min(window.innerWidth / 1440, window.innerHeight / 900));
    fit(); window.addEventListener('resize', fit);
    return () => { window.removeEventListener('resize', fit); if (swap.current) clearTimeout(swap.current); if (finish.current) clearTimeout(finish.current); };
  }, []);
  return <Turns.Provider value={{ navigate, arrived, turning, instant }}>
    {children}
    {turning ? <div className="folio-turn-viewport" aria-hidden="true"><div className="folio-turn-stage" style={{ transform: `scale(${scale})` }}><div key={turnId} className="folio-turn-sheet" /></div></div> : null}
  </Turns.Provider>;
}
