/**
 * Investigation flow container: upload → live investigation → result.
 *
 * One in-memory flow per visit. The selected image (File + object URL) and
 * claim live only in component state for the active flow and are revoked on
 * removal, replacement, or restart. Server image persistence never happens
 * here — the client sends the preprocessed bytes once via multipart POST.
 *
 * A completed result additionally survives a refresh via the latest-result
 * session cache (never image bytes): the upload screen offers an explicit
 * resume action that restores the serialized result with a clear
 * submitted-image-unavailable state (F17).
 */
"use client";

import { CasebookShell } from "@/components/casebook/CasebookShell";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import UploadForm, { type UploadSelection } from "@/components/upload/UploadForm";
import InvestigationView from "@/components/investigation/InvestigationView";
import ResultView from "@/components/result/ResultView";
import {
  isSupportedImageFile,
  preprocessImage,
  PreprocessError,
} from "@/lib/media/image-preprocess.client";
import { readCachedResult, useInvestigation } from "@/lib/stream/useInvestigation";
import { rec, str, type JsonRecord } from "@/lib/stream/result-view";
import { PUBLIC_IMAGES, type PublicImageId } from "@/lib/media/public-images";

/**
 * Mirrors the backend-owned RESULT_CACHE_KEY in useInvestigation
 * ("contexttrail.latest-result"). Frontend use only until the shared typed
 * result contract lands; do not change one without the other.
 */
const RESULT_CACHE_KEY = "contexttrail.latest-result";

const RESTORED_NOTICE =
  "Restored after refresh. The submitted image preview is unavailable — uploaded images are never stored. " +
  "Stage history and retrieval counts from the live run were not preserved with this result.";

export default function InvestigatePage() {
  const [selection, setSelection] = useState<UploadSelection | null>(null);
  const [publicImageId, setPublicImageId] = useState<PublicImageId | null>(null);
  const [publicImageUrl, setPublicImageUrl] = useState<string | null>(null);
  const [claim, setClaim] = useState("");
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [preprocessing, setPreprocessing] = useState(false);
  /** Serialized completed result restored after a refresh (F17); never image bytes. */
  const [restored, setRestored] = useState<JsonRecord | null>(null);
  const [cachedAvailable, setCachedAvailable] = useState(false);
  const inv = useInvestigation();

  // After a refresh there is no active flow; offer the cached completed
  // result explicitly instead of silently dropping it.
  useEffect(() => {
    if (readCachedResult() !== null) setCachedAvailable(true);
  }, []);

  // Revoke the preview object URL when it is replaced or on unmount.
  useEffect(() => {
    const url = selection?.previewUrl;
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [selection?.previewUrl]);

  const handleSelect = useCallback(
    (file: File) => {
      if (!isSupportedImageFile(file)) {
        setUploadError("Unsupported file. Choose a JPG, JPEG, PNG, or WebP image.");
        return;
      }
      setUploadError(null);
      setPublicImageId(null);
      setPublicImageUrl(null);
      setSelection((prev) => {
        if (prev) URL.revokeObjectURL(prev.previewUrl);
        return { file, previewUrl: URL.createObjectURL(file) };
      });
    },
    [],
  );

  const handleRemove = useCallback(() => {
    setPublicImageId(null);
    setPublicImageUrl(null);
    setSelection((prev) => {
      if (prev) URL.revokeObjectURL(prev.previewUrl);
      return null;
    });
    setUploadError(null);
  }, []);

  const handleSubmit = useCallback(async () => {
    if ((!selection && !publicImageId && !publicImageUrl) || preprocessing) return;
    setUploadError(null);
    setPreprocessing(true);
    try {
      const processed = selection ? await preprocessImage(selection.file) : null;
      await inv.start({
        ...(publicImageId ? { publicImageId } : publicImageUrl ? { publicImageUrl } : { media: processed!.blob }),
        claim: claim.trim().length > 0 ? claim.trim() : null,
      });
    } catch (err) {
      if (err instanceof PreprocessError) {
        // Claim text is preserved; only the image needs replacing.
        setUploadError(err.message);
      } else {
        setUploadError("Something went wrong while preparing the image. Please try again.");
      }
    } finally {
      setPreprocessing(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection, publicImageId, publicImageUrl, claim, preprocessing]);

  const handleNewInvestigation = useCallback(() => {
    inv.reset();
    handleRemove();
    setClaim("");
    setRestored(null);
    try {
      // A new run supersedes the stored completed result.
      sessionStorage.removeItem(RESULT_CACHE_KEY);
    } catch {
      // Best-effort only.
    }
    setCachedAvailable(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handleRemove]);

  const handleRestore = useCallback(() => {
    const cached = readCachedResult();
    if (cached) {
      setRestored(cached);
      setCachedAvailable(false);
    } else {
      setCachedAvailable(false);
    }
  }, []);

  const handleDiscardCached = useCallback(() => {
    try {
      sessionStorage.removeItem(RESULT_CACHE_KEY);
    } catch {
      // Best-effort only.
    }
    setCachedAvailable(false);
  }, []);

  const phase = inv.phase;
  const viewHeading = useRef<HTMLHeadingElement>(null);
  const visiblePhase = restored || (phase === "completed" && inv.result)
    ? "result" : phase === "preparing" || phase === "streaming" ? "running"
    : phase === "failed" ? "failed" : phase === "cancelled" ? "cancelled" : "input";
  useEffect(() => {
    if (visiblePhase === "input") return;
    viewHeading.current?.focus({ preventScroll: true });
    // Reset the old form's scroll position once. Keeping the whole view start
    // visible includes the result tabs and the progress Cancel control.
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
  }, [visiblePhase]);

  if (restored) {
    const restoredClaim = str(restored, "claim") ?? str(rec(restored, "input"), "claim");
    return (
      <ResultView
        headingRef={viewHeading}
        result={restored}
        submittedImageUrl={null}
        claim={restoredClaim}
        searchCounts={[]}
        stages={[]}
        onNewInvestigation={handleNewInvestigation}
        restoredNotice={RESTORED_NOTICE}
      />
    );
  }

  if (phase === "completed" && inv.result) {
    return (
      <ResultView
        headingRef={viewHeading}
        result={inv.result}
        submittedImageUrl={publicImageId ? PUBLIC_IMAGES[publicImageId].previewUrl : publicImageUrl ?? selection?.previewUrl ?? null}
        claim={claim.trim().length > 0 ? claim.trim() : null}
        searchCounts={inv.searchCounts}
        stages={inv.stages}
        onNewInvestigation={handleNewInvestigation}
      />
    );
  }

  if (phase === "streaming" || phase === "preparing" || phase === "failed") {
    return (
      <div>
        <InvestigationView
          stages={inv.stages}
          searchCounts={inv.searchCounts}
          evidence={inv.evidence}
          error={inv.error}
          onCancel={inv.cancel}
          headingRef={viewHeading}
          recoveryActions={phase === "failed" ? <div className="image-recovery-actions"><div className="button-row"><button type="button" onClick={() => inv.reset()} className="paper-button primary">← Return to upload</button><button type="button" onClick={handleNewInvestigation} className="paper-button">Start new investigation</button></div><p className="fine-print">Your selected image and claim were kept in this browser tab only.</p></div> : null}
        />

      </div>
    );
  }

  if (phase === "cancelled") {
    return (
      <CasebookShell chapter="image" dark>
        <main id="main" tabIndex={-1} className="casebook-main">
          <h1 ref={viewHeading} tabIndex={-1} className="font-serif text-4xl">Investigation cancelled.</h1>
          <p className="mt-3 text-white/65">
            New work was stopped. Requests already sent may still have consumed provider credits.
            Your image and claim remain in this tab if you want to retry.
          </p>
          <div className="button-row">
            <button
              type="button"
              onClick={() => inv.reset()}
              className="paper-button primary"
            >
              ← Return to upload
            </button>
            <button
              type="button"
              onClick={handleNewInvestigation}
              className="paper-button"
            >
              Start new investigation
            </button>
          </div>
        </main>
      </CasebookShell>
    );
  }

  return (
    <div className="bg-paper">
      <UploadForm
        resumeActions={cachedAvailable ? (
        <div className="resume-result" role="note" aria-label="Restore previous result">
          <div className="rounded-2xl bg-white/70 p-5 ring-1 ring-ink/10">
            <p className="text-sm font-medium">Your last completed result is still in this tab.</p>
            <p className="mt-1 text-sm leading-relaxed text-ink/60">
              Refreshing never keeps your uploaded image — only the completed result text is
              restored.
            </p>
            <div className="mt-3 flex flex-wrap gap-3">
              <button
                type="button"
                disabled={preprocessing}
                onClick={handleRestore}
                className="inline-flex min-h-[44px] items-center rounded-full bg-ink px-5 py-2 text-sm font-medium text-white transition hover:bg-black"
              >
                View last result
              </button>
              <button
                type="button"
                disabled={preprocessing}
                onClick={handleDiscardCached}
                className="inline-flex min-h-[44px] items-center rounded-full px-5 py-2 text-sm font-medium ring-1 ring-ink/20 transition hover:ring-ink/50"
              >
                Discard
              </button>
            </div>
          </div>
        </div>
      ) : null}
        selection={selection}
        publicImageId={publicImageId}
        publicImageUrl={publicImageUrl}
        onSelectPublicImageUrl={(url) => { handleRemove(); setPublicImageUrl(url); }}
        onSelectPublicImage={(id) => { handleRemove(); setPublicImageId(id); }}
        claim={claim}
        preparing={preprocessing}
        error={uploadError}
        onSelect={handleSelect}
        onRemove={handleRemove}
        onClaimChange={setClaim}
        onSubmit={handleSubmit}
      />
    </div>
  );
}
