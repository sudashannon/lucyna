# Knowledge review queue

Mode: Operate, with a Read area for checking the current original.

Target: `src/renderer/components/knowledge/Reviews.tsx` and `src/renderer/knowledge-reviews.css`.

Users work through many automated findings. The primary path is to locate a document, understand why it was flagged, inspect the original, and choose the available action. Preserve Lucyna's four themes and the library navigation.

Use a compact queue with one title per row and translated issue labels. Keep the reader left aligned, with issue explanation and actions together above the original excerpt. Raw lint expressions are secondary diagnostic details, not the main explanation. At narrow widths preserve list-to-detail navigation and an obvious return path.

Do not imply a structural warning means the document is incorrect. Preserve the original content, input-revision guards, and differences between ignoring a finding, creating a todo, confirming evidence, and retracting a conclusion.

Offer Agent handling advice as one section before the original preview. Load existing valid advice without starting model generation; the explicit generate button requests document-specific steps based on the issue type, document type, and current evidence. Use short prose, lists, and readable citations rather than nested cards. Keep loading, failures, and regeneration within the section, and never show another finding's or an outdated version's advice.

The isolated render check is `test/knowledge-review-desktop.cjs`, run with Electron after `node tools/build-renderer.cjs`. It uses a disposable knowledge profile and writes captures to `.runtime/knowledge-review-desktop/`.

For documents the user no longer needs, expose a quiet destructive “删除文档” action. Its confirmation names the exact document, source and path, explains that all of its findings are removed, and retains local history. Freeze the selected target and operation identity through retries. Show version conflicts inside the dialog; never silently delete an updated document or treat an index refresh failure as if deletion had not happened.
