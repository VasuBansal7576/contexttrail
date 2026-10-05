'use client';
import {createContext,useContext,useEffect,useRef} from 'react';

export const ChapterTourStep=createContext<number|null>(null);

/** Playback changes only the displayed selection. It never invokes a user action. */
export function useChapterTour(select:(step:number)=>void) {
  const step=useContext(ChapterTourStep), latest=useRef(select);
  latest.current=select;
  useEffect(()=>{if(step!==null)latest.current(step);},[step]);
}
