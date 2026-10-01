import Link from "next/link";
import type { ReactNode } from "react";

export function CasebookShell({ children, chapter = "cover", caseId, dark = false }: { children: ReactNode; chapter?: string; caseId?: string; dark?: boolean }) {
  const caseHref = (next: string) => caseId ? `/casebook?case=${encodeURIComponent(caseId)}&chapter=${next}` : `/casebook?chapter=${next}`;
  const chapters = [
    { id: "cover", title: "Cover", href: "/" },
    { id: "image", title: "Image", href: "/investigate" },
    { id: "video", title: "Video", href: "/compare" },
    ...["questions", "evidence", "sources", "changes", "watch", "answers"].map(id => ({ id, title: id === "answers" ? "AI answers" : id[0].toUpperCase() + id.slice(1), href: caseHref(id) })),
  ];
  return <div className={`casebook-app${dark ? " casebook-blue" : ""}`}>
    <a className="skip-link" href="#main">Skip to content</a>
    <header className="casebook-header">
      <Link className="casebook-brand" href="/">ContextTrail</Link>
      <div className="casebook-header-end"><span className="eyebrow desktop-only">A place for the question</span><Link href="/casebook">The casebook</Link><Link href="/#about">About</Link></div>
    </header>
    {children}
    <nav className="chapter-nav" aria-label="Chapters">
      <span className="chapter-nav-label eyebrow">One case.<br />Many ways in.</span>
      <div className="chapter-links">{chapters.map((item, index) => <Link key={item.id} href={item.href} aria-current={chapter === item.id ? "page" : undefined}><span>{String(index).padStart(2, "0")}</span>{item.title}</Link>)}</div>
      <span className="chapter-nav-note eyebrow">Follow at your pace</span>
    </nav>
  </div>;
}

export function ChapterHeading({ number, label, children, description }: { number: string; label: string; children: ReactNode; description?: ReactNode }) {
  return <div className="chapter-heading"><p className="eyebrow">{number} / {label}</p><h1>{children}</h1>{description ? <p className="chapter-description">{description}</p> : null}</div>;
}
