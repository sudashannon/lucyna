import {useEffect, useRef, useState} from 'react';
import {Check, Copy} from 'lucide-react';
import {api} from '../api';

export function CopyButton({label, text, onError}: {label: string; text: () => string; onError: (error: unknown) => void}) {
  const [copied, setCopied] = useState(false), timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return <button type="button" className="copy-button" aria-label={label} title={copied ? '已复制' : label} onClick={() => {
    void api.copyText(text()).then(() => {setCopied(true); clearTimeout(timer.current); timer.current = setTimeout(() => setCopied(false), 1800);}).catch(onError);
  }}>{copied ? <Check size={13}/> : <Copy size={13}/>}<span>{copied ? '已复制' : '复制'}</span></button>;
}
