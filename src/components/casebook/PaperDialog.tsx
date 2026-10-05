"use client";
import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
export default function PaperDialog({ title, description, children, onClose, onRestoreFocus, wide = false, busy = false, editing = false }: { title: string; description: string; children: ReactNode; onClose: () => void; onRestoreFocus?: () => void; wide?: boolean; busy?: boolean; editing?: boolean }) {
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const fit = () => setScale(Math.min(window.innerWidth / 1440, window.innerHeight / 900));
    fit(); window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);
  const style: CSSProperties & Record<'--dialog-scale', number> = { '--dialog-scale': scale };
  const opener = useRef(typeof document === "undefined" ? null : document.activeElement);
  return <Dialog.Root open onOpenChange={open => { if (!open && !busy) onClose(); }}><Dialog.Portal><Dialog.Overlay className="paper-dialog-overlay" /><Dialog.Content onCloseAutoFocus={event => { event.preventDefault(); if (onRestoreFocus) { onRestoreFocus(); return; } const target = opener.current; if (target instanceof HTMLElement && target.isConnected && !target.hasAttribute("disabled") && target.getClientRects().length) target.focus(); else document.getElementById("main")?.focus(); }} style={style} className={`paper-dialog${wide ? " wide" : ""}`} onEscapeKeyDown={event => { if (busy || editing) event.preventDefault(); }} onInteractOutside={event => { if (busy || editing) event.preventDefault(); }}><div className="dialog-topline"><p className="eyebrow">ContextTrail / case record</p><Dialog.Close className="dialog-close" aria-label={editing ? "Discard draft" : "Close"} disabled={busy}>{editing ? "Discard draft" : "×"}</Dialog.Close></div><Dialog.Title>{title}</Dialog.Title><Dialog.Description className="fine-print">{description}</Dialog.Description>{children}</Dialog.Content></Dialog.Portal></Dialog.Root>;
}
