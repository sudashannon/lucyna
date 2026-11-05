// The model selects excerpts; only the host reconstructs source identities and
// quotations. Maps are request-local so an ID can never recover unsent evidence.
function addEvidence(text, sourceId, identity, evidenceMap) {
  if (typeof text !== 'string' || !text.trim()) return [];
  const excerpts = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + 640, text.length);
    if (end < text.length) {
      const newline = text.lastIndexOf('\n', end - 1);
      if (newline >= start + 320) end = newline + 1;
      if (text.length - end < 8) end = text.length;
      // Do not cut a surrogate pair in source text.
      if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    }
    const quote = text.slice(start, end).trim();
    if (quote) {
      const evidenceId = `${sourceId}.${excerpts.length + 1}`;
      // A short trailing line still needs enough context to meet citation bounds.
      let exactQuote = quote;
      if (quote.length < 8 && text.trim().length >= 8) {
        let contextStart = Math.max(0, end - 800);
        if (/[\uDC00-\uDFFF]/.test(text[contextStart])) contextStart++;
        exactQuote = text.slice(contextStart, end).trim();
      }
      // A tiny fragment isolated by over 800 whitespace characters cannot form
      // a bounded, verifiable citation. Keep the other excerpts without it.
      if (exactQuote.length >= Math.min(8, text.trim().length)) {
        evidenceMap.set(evidenceId, {...identity, quote: exactQuote});
        excerpts.push({evidenceId, text: exactQuote});
      }
    }
    start = end;
  }
  return excerpts;
}

function resolveEvidenceCitation(value, evidenceMap) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 1 || typeof value.evidenceId !== 'string') return null;
  const citation = evidenceMap.get(value.evidenceId);
  return citation ? {...citation} : null;
}

module.exports = {addEvidence, resolveEvidenceCitation};
