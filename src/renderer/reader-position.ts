// Pixel offsets are exact at the same width. Across reader sizes, preserve the
// first visible character instead: wrapped paragraphs can change height a lot.
export type ReaderPosition = {top: number; width: number; text?: number; offset?: number};

function textNodes(body: HTMLElement) {
  return document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {acceptNode: node =>
    node.textContent?.trim() && !node.parentElement?.closest('button,script,style')
      ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT});
}

function verticalScale(body: HTMLElement, bounds: DOMRect) {
  // The reading dialog enters with a scale animation. Range coordinates include
  // that transform, whereas scrollTop is in unscaled CSS pixels.
  const style = getComputedStyle(body);
  let height = Number.parseFloat(style.height);
  if (style.boxSizing !== 'border-box') height += ['paddingTop', 'paddingBottom', 'borderTopWidth', 'borderBottomWidth'].reduce((sum, key) => sum + (Number.parseFloat(style[key as keyof CSSStyleDeclaration] as string) || 0), 0);
  return height > 0 ? bounds.height / height || 1 : 1;
}

export function captureReaderPosition(body: HTMLElement): ReaderPosition {
  const position: ReaderPosition = {top: body.scrollTop, width: body.clientWidth};
  if (position.top < 1 || !body.clientHeight) return position;
  const bounds = body.getBoundingClientRect(), walker = textNodes(body), range = document.createRange();
  let node: Node | null, text = 0;
  while ((node = walker.nextNode())) {
    const length = node.textContent!.length;
    range.selectNodeContents(node);
    const box = range.getBoundingClientRect();
    if (box.height && box.bottom > bounds.top + 1 && box.top < bounds.bottom) {
      let start = 0, end = length - 1;
      if (box.top < bounds.top) {
        while (start < end) {
          const middle = Math.floor((start + end) / 2);
          range.setStart(node, middle); range.setEnd(node, middle + 1);
          if (range.getBoundingClientRect().bottom <= bounds.top + 1) start = middle + 1;
          else end = middle;
        }
      }
      range.setStart(node, start); range.setEnd(node, start + 1);
      return {...position, text: text + start, offset: (range.getBoundingClientRect().top - bounds.top) / verticalScale(body, bounds)};
    }
    text += length;
  }
  return position;
}

export function restoreReaderPosition(body: HTMLElement, position?: ReaderPosition) {
  if (!position) {body.scrollTop = 0; return;}
  body.scrollTop = position.top;
  if (position.text === undefined || position.width === body.clientWidth) return;
  const walker = textNodes(body), range = document.createRange();
  let node: Node | null, remaining = position.text;
  while ((node = walker.nextNode())) {
    const length = node.textContent!.length;
    if (remaining < length) {
      range.setStart(node, remaining); range.setEnd(node, remaining + 1);
      const bounds = body.getBoundingClientRect();
      body.scrollTop += (range.getBoundingClientRect().top - bounds.top) / verticalScale(body, bounds) - (position.offset || 0);
      return;
    }
    remaining -= length;
  }
}
