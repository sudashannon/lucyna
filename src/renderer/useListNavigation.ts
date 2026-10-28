import {useEffect, useRef, useState, type KeyboardEvent} from 'react';

export function useListNavigation(count: number, resetKey: string, select: (index: number) => void) {
  const [selected, setSelected] = useState(0), listRef = useRef<HTMLDivElement>(null);
  const activeIndex = Math.min(selected, Math.max(0, count - 1));
  useEffect(() => {setSelected(0);}, [resetKey]);
  useEffect(() => {listRef.current?.children[activeIndex]?.scrollIntoView({block: 'nearest'});}, [activeIndex]);
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (!count || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); setSelected((activeIndex + (event.key === 'ArrowDown' ? 1 : -1) + count) % count);
    } else if (event.key === 'Enter') {event.preventDefault(); select(activeIndex);}
  };
  return {activeIndex, listRef, onKeyDown, setSelected};
}
