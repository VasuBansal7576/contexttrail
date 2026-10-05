/**
 * Screen 2 — Upload (spec sections 3.3, 4.8).
 *
 * Collects only what an investigation needs: an image plus an optional
 * claim. Handles empty / selected / preparing / unsupported / decode-failure
 * states; keyboard selection, replacement, and removal included.
 */
"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { CasebookShell, ChapterHeading } from "@/components/casebook/CasebookShell";
import { cn } from "@/components/cn";
import { PUBLIC_IMAGES, publicImageUrlFormatError, type PublicImageId } from "@/lib/media/public-images";

const CLAIM_MAX = 500;

export interface UploadSelection {
  file: File;
  previewUrl: string;
}

interface UploadFormProps {
  resumeActions?: ReactNode;
  selection: UploadSelection | null;
  publicImageId?: PublicImageId | null;
  publicImageUrl?: string | null;
  onSelectPublicImageUrl?: (url: string) => void;
  onSelectPublicImage?: (id: PublicImageId) => void;
  claim: string;
  preparing: boolean;
  error: string | null;
  onSelect: (file: File) => void;
  onRemove: () => void;
  onClaimChange: (value: string) => void;
  onSubmit: () => void;
}

export default function UploadForm({
  resumeActions,
  selection,
  publicImageId,
  publicImageUrl,
  onSelectPublicImageUrl,
  onSelectPublicImage,
  claim,
  preparing,
  error,
  onSelect,
  onRemove,
  onClaimChange,
  onSubmit,
}: UploadFormProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [urlDraft, setUrlDraft] = useState("");
  const [urlError, setUrlError] = useState<string | null>(null);
  const dragCount = useRef(0);

  const acceptFile = useCallback(
    (file: File | undefined | null) => {
      if (file && !preparing) onSelect(file);
    },
    [onSelect, preparing],
  );

  // Paste-to-upload convenience; harmless when unused.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const file = Array.from(e.clipboardData?.files ?? []).find((f) => f.type.startsWith("image/"));
      if (file) acceptFile(file);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [acceptFile]);

  const [captionMode,setCaptionMode] = useState(Boolean(claim.trim()));
  const canSubmit = (selection !== null || Boolean(publicImageId) || Boolean(publicImageUrl)) && !preparing && (!captionMode || Boolean(claim.trim()));

  return (
    <CasebookShell chapter="image" dark>
      <main id="main" tabIndex={-1} className="casebook-main workspace-grid image-workspace">
        <aside className="image-specimen-panel">
          <p className="image-specimen-note">The photograph is still the photograph.</p>
          <figure className="image-specimen-sheet">
            {/* Only local previews and the reviewed public catalogue render here. Arbitrary URLs remain server-validated. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {publicImageUrl ? <div className="public-image-preview-pending"><strong>Public image selected</strong><p>Its preview is checked when the investigation starts.</p></div> : <img src={selection?.previewUrl ?? (publicImageId ? PUBLIC_IMAGES[publicImageId].previewUrl : "/illustrative-earthrise.jpg")} alt={selection ? `Your selected image: ${selection.file.name}` : publicImageId ? PUBLIC_IMAGES[publicImageId].title : "Illustrative Earthrise photograph, Apollo 8"} />}
            <figcaption title={claim.trim() || undefined}>{selection || publicImageId || publicImageUrl ? (claim.trim() || "What can this photograph tell us?") : "Start with a photograph. Follow its story."}</figcaption>
          </figure>
          <p className="image-specimen-credit">{selection ? "Your selected image · held in this browser tab" : publicImageId ? PUBLIC_IMAGES[publicImageId].credit : publicImageUrl ? "Already-public image · server validation pending" : "Illustrative reference · NASA / Bill Anders, Apollo 8. Select an image to begin."}</p>
        </aside>
        <form
          className="image-investigation-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (canSubmit) onSubmit();
          }}
        >
          <ChapterHeading number="01" label="Image investigation" description="Follow the image on its own, or examine the story attached to it.">Start with<br /><em>what you see.</em></ChapterHeading>
          {resumeActions}
          <input id="ct-image-input" ref={inputRef} type="file" accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp" disabled={preparing} className="sr-only" aria-label="Choose image" onChange={e => { acceptFile(e.target.files?.[0]); e.target.value = ""; }} />
          {/* Dropzone: a real button-like label so keyboard users get a native file dialog. */}
          {publicImageId ? (
            <div className="image-public-selection">
              <div className="sheet-topline"><strong>{PUBLIC_IMAGES[publicImageId].title}</strong><button type="button" disabled={preparing} onClick={onRemove} className="text-link">Remove</button></div>
              <p>Already public · searched by source URL · no upload</p>
              <a href={PUBLIC_IMAGES[publicImageId].sourceUrl} target="_blank" rel="noopener noreferrer" className="text-link">View NASA source and credit ↗</a>
            </div>
          ) : publicImageUrl ? (
            <div className="rounded-2xl bg-white/70 p-4 ring-1 ring-ink/10">
              <p className="font-medium">Public image URL</p>
              <p className="mt-2 break-all text-sm text-ink-soft">{publicImageUrl}</p>
              <p className="mt-2 text-xs text-ink-soft">Already public · no upload. The server checks public DNS, redirects, image type and size before provider search.</p>
              <button type="button" disabled={preparing} onClick={onRemove} className="mt-2 min-h-[44px] text-sm text-signal-ink underline">Remove</button>
            </div>
          ) : !selection ? (
            <div
              onDragEnter={(e) => {
                e.preventDefault();
                dragCount.current += 1;
                setDragging(true);
              }}
              onDragLeave={(e) => {
                e.preventDefault();
                dragCount.current = Math.max(0, dragCount.current - 1);
                if (dragCount.current === 0) setDragging(false);
              }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                dragCount.current = 0;
                setDragging(false);
                acceptFile(e.dataTransfer.files?.[0]);
              }}
              className={cn(
                "image-dropzone rounded-2xl border-2 border-dashed p-10 text-center transition",
                "focus-within:border-signal focus-within:ring-2 focus-within:ring-signal/50 focus-within:ring-offset-2 focus-within:ring-offset-paper",
                dragging ? "border-signal bg-signal/5" : "border-ink/20 bg-white/60",
              )}
            >
              <p aria-hidden="true" className="mx-auto flex h-10 w-10 items-center justify-center rounded-lg bg-ink/5 text-xl">
                ↑
              </p>
              <label
                htmlFor="ct-image-input"
                className="mt-3 inline-block cursor-pointer text-base font-medium underline decoration-ink/30 underline-offset-4"
              >
                Drop an image here or click to browse
              </label>
              <p id="ct-formats" className="mt-2 text-sm text-ink-soft">
                JPG, PNG or WebP
              </p>
            </div>
          ) : (
            <div className="flex items-center gap-4 rounded-2xl bg-white/70 p-4 ring-1 ring-ink/10">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={selection.previewUrl}
                alt={`Selected image preview: ${selection.file.name}`}
                className="h-20 w-20 shrink-0 rounded-lg object-cover ring-1 ring-ink/10"
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium" title={selection.file.name}>
                  {selection.file.name}
                </p>
                <p className="text-xs text-ink-soft">{Math.max(1, Math.round(selection.file.size / 1024))} KB · will be compressed before upload</p>
                <div className="mt-2 flex gap-3 text-sm">
                  <button
                    type="button"
                    disabled={preparing}
                    onClick={() => inputRef.current?.click()}
                    className="min-h-[44px] font-medium text-signal-ink underline underline-offset-2"
                  >
                    Replace
                  </button>
                  <button
                    type="button"
                    disabled={preparing}
                    onClick={onRemove}
                    className="min-h-[44px] font-medium text-ink-soft underline underline-offset-2 hover:text-ink"
                  >
                    Remove
                  </button>
                </div>
              </div>
            </div>
          )}

          {!selection && !publicImageId && !publicImageUrl && onSelectPublicImage ? (
            <button type="button" disabled={preparing} onClick={() => onSelectPublicImage("nasa-earthrise")} className="image-public-example text-link">
              Try NASA&apos;s public Earthrise image →
            </button>
          ) : null}

          {!selection && !publicImageId && !publicImageUrl && onSelectPublicImageUrl ? (
            <details className="image-url-entry"><summary>Use an already-public image URL ↗</summary>
              <label htmlFor="ct-public-url" className="text-sm font-medium">Already-public image URL</label>
              <input id="ct-public-url" type="url" disabled={preparing} value={urlDraft} onChange={(e) => { setUrlDraft(e.target.value); setUrlError(null); }} maxLength={2048} placeholder="https://example.org/public-photo.jpg" aria-invalid={Boolean(urlError)} aria-describedby="ct-public-url-help ct-public-url-error" className="mt-2 w-full rounded-xl bg-white/70 px-4 py-3 text-[16px] ring-1 ring-ink/15" />
              <p id="ct-public-url-help" className="mt-2 text-xs text-ink-soft">Use a public HTTPS JPEG, PNG or WebP, without login, tokens or query parameters. Do not publish a private image to use this option.</p>
              <button type="button" disabled={preparing || !urlDraft.trim()} onClick={() => { const issue = publicImageUrlFormatError(urlDraft.trim()); setUrlError(issue); if (!issue) onSelectPublicImageUrl(urlDraft.trim()); }} className="mt-2 min-h-[44px] text-sm font-medium text-signal-ink underline disabled:opacity-40">Use public image URL →</button>
              {urlError ? <p id="ct-public-url-error" role="alert" className="error-note">{urlError}</p> : null}
            </details>
          ) : null}

          {error ? (
            <p role="alert" className="mt-4 rounded-xl bg-coral/10 px-4 py-3 text-sm text-coral ring-1 ring-coral/25">
              {error}{" "}
              <button type="button" disabled={preparing} onClick={() => inputRef.current?.click()} className="font-medium underline underline-offset-2">
                Choose a different image
              </button>
            </p>
          ) : null}

          <div className="image-caption-switch" role="group" aria-label="Image investigation intent"><button type="button" disabled={preparing} aria-pressed={!captionMode && !claim.trim()} onClick={() => { setCaptionMode(false); onClaimChange(''); }}><span>Trace this photograph</span><small>NO CLAIM</small></button><button type="button" disabled={preparing} aria-pressed={captionMode || Boolean(claim.trim())} onClick={() => { setCaptionMode(true); }}><span>Check its attached caption</span><small>CHECK CAPTION</small></button></div>
          <div className="image-caption-input" hidden={!captionMode && !claim.trim()}>
            <label htmlFor="ct-claim" className="text-sm font-medium">
              Caption to check
            </label>
            <textarea
              id="ct-claim"
              disabled={preparing}
              value={claim}
              maxLength={CLAIM_MAX}
              rows={2}
              onChange={(e) => onClaimChange(e.target.value)}
              placeholder="E.g. “This shows a recent incident in my city.”"
              aria-describedby="ct-claim-help"
              // The example keeps the `ink-soft` token, which measures 6.98:1 on
              // this composited field. `ink/40` measured 2.58:1 here — an enabled
              // 16px field, not the disabled-button exemption — so the example
              // was unreadable while the field was waiting for input. The
              // persistent label above and the entered value (`ink`) still
              // separate label, example and content.
              className="mt-2 w-full resize-y rounded-xl bg-white/70 px-4 py-3 text-[16px] text-ink ring-1 ring-ink/15 placeholder:text-ink-soft"
            />
            <div className="mt-1 flex items-center justify-between text-xs text-ink-soft">
              <p id="ct-claim-help">Enter the caption to check, or choose “Trace this photograph.”</p>
              <p aria-label={`${CLAIM_MAX - claim.length} characters remaining`}>
                {claim.length}/{CLAIM_MAX}
              </p>
            </div>
          </div>

          <button
            type="submit"
            disabled={!canSubmit}
            aria-describedby={!selection && !publicImageId && !publicImageUrl ? "ct-submit-hint" : undefined}
            className={cn(
              "mt-6 flex min-h-[48px] w-full items-center justify-center gap-2 rounded-full text-base font-medium transition",
              canSubmit ? "bg-ink text-white hover:bg-black" : "cursor-not-allowed bg-ink/15 text-ink/45",
            )}
          >
            {preparing ? (
              <>
                <span aria-hidden="true" className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
                Preparing image…
              </>
            ) : (
              <>Start investigation <span aria-hidden="true">→</span></>
            )}
          </button>
          {!selection && !publicImageId && !publicImageUrl && !preparing ? (
            <p id="ct-submit-hint" className="mt-2 text-center text-xs text-ink-soft">
              Select an image to begin.
            </p>
          ) : null}

          <p className="mt-4 flex items-start justify-center gap-2 text-center text-xs leading-relaxed text-ink-soft">

            <span>
              {publicImageId || publicImageUrl ? "The public image URL is sent to SerpApi / Google Lens. No image is uploaded by ContextTrail." : "Your image is sent to SerpApi / Google Lens for visual search. ContextTrail does not persist your image."}
            </span>
          </p>
        </form>
      </main>
    </CasebookShell>
  );
}
