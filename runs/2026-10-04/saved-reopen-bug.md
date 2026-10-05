Observed in a real browser run on 4 October 2026, baseline main d881a58df26a96b3932725402311353297c293e6.

Reproduction:
1. Run automatic question research with the UPI adoption question.
2. Save the completed report.
3. Open The casebook and open the saved investigation.

The default Questions chapter presents an empty manual hypotheses/findings workspace. The already retrieved and assessed report is hidden in Evidence. This makes a successfully saved automatic investigation appear unfinished and sends the reader back to manual assembly.

Expected: reopening a saved automatic investigation leads with its retained report, source passages and limits. Manual notes and findings remain available as an optional workflow.

Baseline case: research-843b9748-f087-42d8-819e-0fc8946eed34. Source and publication/retrieval data were preserved. This is a navigation/presentation defect, separate from the research coverage acceptance gap in #30.

Fix in progress on complete/contexttrail-product: show saved topic/video reports in the default chapter, lead with the retained reading account, collapse optional manual findings. Real browser reopening now exposes the exact saved account without new provider requests. A curated screenshot and final verification will accompany the PR.
