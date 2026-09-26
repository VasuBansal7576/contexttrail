/**
 * Screen 2 — Upload (spec sections 3.3, 4.8).
 *
 * Collects only what an investigation needs: an image plus an optional
 * claim. Handles empty / selected / preparing / unsupported / decode-failure
 * states; keyboard selection, replacement, and removal included.
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { cn } from "@/components/cn";

const CLAIM_MAX = 500;

export interface UploadSelection {
  file: File;
  previewUrl: string;
}

interface UploadFormProps {
  selection: UploadSelection | null;
  claim: string;
  preparing: boolean;
  error: string | null;
  onSelect: (file: File) => void;
  onRemove: () => void;
  onClaimChange: (value: string) => void;
  onSubmit: () => void;
}

export default function UploadForm({
  selection,
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
  const dragCount = useRef(0);

  const acceptFile = useCallback(
    (file: File | undefined | null) => {
      if (file) onSelect(file);
    },
    [onSelect],
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

  const canSubmit = selection !== null && !preparing;

  return (
    <div className="min-h-screen bg-paper text-ink">
      <header className="mx-auto flex max-w-[1280px] items-center justify-between px-5 py-5 sm:px-8">
        <p className="flex items-center gap-2 text-sm font-semibold tracking-tight">
          <span aria-hidden="true" className="inline-block h-4 w-4 rounded-full border-2 border-ink" />
          ContextTrail
        </p>
        <Link href="/" className="text-sm text-ink-soft hover:text-ink">
          ← Back
        </Link>
      </header>

      <main className="mx-auto w-full max-w-[560px] px-5 pt-6 pb-20 sm:pt-10">
        <h1 className="text-center font-serif text-5xl">Trace an image.</h1>
        <p className="mt-3 text-center text-ink/65">
          Upload an image to find where it has appeared online and how its context may have changed.
        </p>

        <form
          className="mt-8"
          onSubmit={(e) => {
            e.preventDefault();
            if (canSubmit) onSubmit();
          }}
        >
          {/* Dropzone: a real button-like label so keyboard users get a native file dialog. */}
          {!selection ? (
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
                "rounded-2xl border-2 border-dashed p-10 text-center transition",
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
              <input
                id="ct-image-input"
                ref={inputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
                className="sr-only"
                aria-describedby="ct-formats"
                onChange={(e) => {
                  acceptFile(e.target.files?.[0]);
                  e.target.value = "";
                }}
              />
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
                    onClick={() => inputRef.current?.click()}
                    className="min-h-[44px] font-medium text-signal-ink underline underline-offset-2"
                  >
                    Replace
                  </button>
                  <button
                    type="button"
                    onClick={onRemove}
                    className="min-h-[44px] font-medium text-ink-soft underline underline-offset-2 hover:text-ink"
                  >
                    Remove
                  </button>
                </div>
              </div>
              <input
                ref={inputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
                className="sr-only"
                aria-label="Replace image"
                onChange={(e) => {
                  acceptFile(e.target.files?.[0]);
                  e.target.value = "";
                }}
              />
            </div>
          )}

          {error ? (
            <p role="alert" className="mt-4 rounded-xl bg-coral/10 px-4 py-3 text-sm text-coral ring-1 ring-coral/25">
              {error}{" "}
              <button type="button" onClick={() => inputRef.current?.click()} className="font-medium underline underline-offset-2">
                Choose a different image
              </button>
            </p>
          ) : null}

          <div className="mt-6">
            <label htmlFor="ct-claim" className="text-sm font-medium">
              Claim or caption (optional)
            </label>
            <textarea
              id="ct-claim"
              value={claim}
              maxLength={CLAIM_MAX}
              rows={3}
              onChange={(e) => onClaimChange(e.target.value)}
              placeholder="E.g. “This shows a recent incident in my city.”"
              aria-describedby="ct-claim-help"
              className="mt-2 w-full resize-y rounded-xl bg-white/70 px-4 py-3 text-[16px] ring-1 ring-ink/15 placeholder:text-ink/40"
            />
            <div className="mt-1 flex items-center justify-between text-xs text-ink-soft">
              <p id="ct-claim-help">Leave blank to trace the image&apos;s history.</p>
              <p aria-label={`${CLAIM_MAX - claim.length} characters remaining`}>
                {claim.length}/{CLAIM_MAX}
              </p>
            </div>
          </div>

          <button
            type="submit"
            disabled={!canSubmit}
            aria-describedby={!selection ? "ct-submit-hint" : undefined}
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
          {!selection && !preparing ? (
            <p id="ct-submit-hint" className="mt-2 text-center text-xs text-ink-soft">
              Select an image to begin.
            </p>
          ) : null}

          <p className="mt-4 flex items-start justify-center gap-2 text-center text-xs leading-relaxed text-ink-soft">
            <span aria-hidden="true">🔒</span>
            <span>
              Your image is sent to SerpApi / Google Lens for visual search. ContextTrail does not
              persist your image.
            </span>
          </p>
        </form>
      </main>
    </div>
  );
}
