/**
 * Investigation flow container: upload → live investigation → result.
 *
 * One in-memory flow per visit. The selected image (File + object URL) and
 * claim live only in component state for the active flow and are revoked on
 * removal, replacement, or restart. Server image persistence never happens
 * here — the client sends the preprocessed bytes once via multipart POST.
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
import { useInvestigation } from "@/lib/stream/useInvestigation";

export default function InvestigatePage() {
  const [selection, setSelection] = useState<UploadSelection | null>(null);
  const [claim, setClaim] = useState("");
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [preprocessing, setPreprocessing] = useState(false);
  const inv = useInvestigation();

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handleRemove]);

  const phase = inv.phase;

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
  );
}
