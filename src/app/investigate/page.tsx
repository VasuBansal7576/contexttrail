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

import { useCallback, useEffect, useState } from "react";
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
      setSelection((prev) => {
        if (prev) URL.revokeObjectURL(prev.previewUrl);
        return { file, previewUrl: URL.createObjectURL(file) };
      });
    },
    [],
  );

  const handleRemove = useCallback(() => {
    setSelection((prev) => {
      if (prev) URL.revokeObjectURL(prev.previewUrl);
      return null;
    });
    setUploadError(null);
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!selection || preprocessing) return;
    setUploadError(null);
    setPreprocessing(true);
    try {
      const processed = await preprocessImage(selection.file);
      await inv.start({
        media: processed.blob,
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
  }, [selection, claim, preprocessing]);

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

  if (restored) {
    const restoredClaim = str(restored, "claim") ?? str(rec(restored, "input"), "claim");
    return (
      <ResultView
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
        result={inv.result}
        submittedImageUrl={selection?.previewUrl ?? null}
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
        />
        {phase === "failed" ? (
          <div className="bg-deep pb-16 text-white">
            <div className="mx-auto flex max-w-[1280px] flex-wrap gap-3 px-5 sm:px-8">
              <button
                type="button"
                onClick={() => inv.reset()}
                className="inline-flex min-h-[48px] items-center rounded-full bg-paper px-6 py-3 font-medium text-ink transition hover:bg-white"
              >
                ← Return to upload
              </button>
              <button
                type="button"
                onClick={handleNewInvestigation}
                className="inline-flex min-h-[48px] items-center rounded-full px-6 py-3 font-medium ring-1 ring-white/25 transition hover:ring-white/50"
              >
                Start new investigation
              </button>
            </div>
            <p className="mx-auto mt-3 max-w-[1280px] px-5 text-xs text-white/50 sm:px-8">
              Your selected image and claim were kept in this browser tab only.
            </p>
          </div>
        ) : null}
      </div>
    );
  }

  if (phase === "cancelled") {
    return (
      <div className="min-h-screen bg-deep text-white">
        <header className="mx-auto flex max-w-[1280px] items-center justify-between px-5 py-5 sm:px-8">
          <p className="flex items-center gap-2 text-sm font-semibold tracking-tight">
            <span aria-hidden="true" className="inline-block h-4 w-4 rounded-full border-2 border-white" />
            ContextTrail
          </p>
          <Link href="/" className="text-sm text-white/60 hover:text-white">
            ← Home
          </Link>
        </header>
        <main className="mx-auto max-w-xl px-5 pt-16 text-center">
          <h1 className="font-serif text-4xl">Investigation cancelled.</h1>
          <p className="mt-3 text-white/65">
            New work was stopped. Requests already sent may still have consumed provider credits.
            Your image and claim remain in this tab if you want to retry.
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <button
              type="button"
              onClick={() => inv.reset()}
              className="inline-flex min-h-[48px] items-center rounded-full bg-paper px-6 py-3 font-medium text-ink transition hover:bg-white"
            >
              ← Return to upload
            </button>
            <button
              type="button"
              onClick={handleNewInvestigation}
              className="inline-flex min-h-[48px] items-center rounded-full px-6 py-3 font-medium ring-1 ring-white/25 transition hover:ring-white/50"
            >
              Start new investigation
            </button>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="bg-paper">
      {cachedAvailable ? (
        <div className="mx-auto max-w-[560px] px-5 pt-6 sm:pt-10" role="note" aria-label="Restore previous result">
          <div className="rounded-2xl bg-white/70 p-5 ring-1 ring-ink/10">
            <p className="text-sm font-medium">Your last completed result is still in this tab.</p>
            <p className="mt-1 text-sm leading-relaxed text-ink/60">
              Refreshing never keeps your uploaded image — only the completed result text is
              restored.
            </p>
            <div className="mt-3 flex flex-wrap gap-3">
              <button
                type="button"
                onClick={handleRestore}
                className="inline-flex min-h-[44px] items-center rounded-full bg-ink px-5 py-2 text-sm font-medium text-white transition hover:bg-black"
              >
                View last result
              </button>
              <button
                type="button"
                onClick={handleDiscardCached}
                className="inline-flex min-h-[44px] items-center rounded-full px-5 py-2 text-sm font-medium ring-1 ring-ink/20 transition hover:ring-ink/50"
              >
                Discard
              </button>
            </div>
          </div>
        </div>
      ) : null}
      <UploadForm
        selection={selection}
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
