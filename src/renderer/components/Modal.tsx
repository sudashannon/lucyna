import { useState, type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { Button } from '@cindy/components/ui/button';
import { Input, Textarea } from '@cindy/components/ui/input';
import type { OmpEvent } from '../types';
export function Modal({open, onClose, title, description, children, className = ''}: {open: boolean; onClose: () => void; title: string; description: string; children: ReactNode; className?: string}) {
  return <Dialog.Root open={open} onOpenChange={value => {if (!value) onClose();}}><Dialog.Portal><Dialog.Overlay className="modal-overlay"/><Dialog.Content className={`modal ${className}`}>
    <div className="modal-header"><Dialog.Title>{title}</Dialog.Title><Dialog.Close className="icon-button" aria-label="关闭弹窗"><X size={18}/></Dialog.Close></div>
    <Dialog.Description className="modal-description">{description}</Dialog.Description>{children}
  </Dialog.Content></Dialog.Portal></Dialog.Root>;
}
export function NativeQuestion({question, onAnswer, open=true, onLater}: {question: OmpEvent; onAnswer: (response: OmpEvent) => Promise<void>; open?:boolean; onLater?:()=>void}) {
  const [text, setText] = useState(question.prefill ?? question.initialValue ?? ''), [answers, setAnswers] = useState<Record<string, {selectedOptions: string[]; customInput?: string}>>({}), [error, setError] = useState(''), [sending, setSending] = useState(false);
  const respond = async (answer: OmpEvent) => { setSending(true); setError(''); try {await onAnswer(answer);} catch (e) {setError(String(e));} finally {setSending(false);} };
  const cancel = () => { if (!sending) void respond(question.method === 'confirm' ? {confirmed: false} : {cancelled: true}); };
  return <Modal open={open} title={question.title || 'OMP 需要你的回复'} description={question.message || '回复将交给当前 OMP 会话。'} onClose={onLater||cancel}>
    {question.method === 'select' && <div className="dialog-options">{(question.options || []).map((option: string) => <Button key={option} variant="secondary" disabled={sending} onClick={() => void respond({value: option})}>{option}</Button>)}</div>}
    {['input', 'editor'].includes(question.method) && <Textarea aria-label="回复内容" value={text} onChange={setText} rows={5}/>}
    {question.method === 'ask' && <div className="questions">{(question.questions || []).map((q: OmpEvent) => <fieldset key={q.id}><legend>{q.question || q.header}</legend>
      {(q.options || []).map((option: OmpEvent) => <label className="question-option" key={option.label}><input type={q.multi ? 'checkbox' : 'radio'} name={q.id} checked={answers[q.id]?.selectedOptions.includes(option.label) || false} onChange={e => setAnswers(prev => ({...prev, [q.id]: { ...prev[q.id], selectedOptions: q.multi ? e.target.checked ? [...(prev[q.id]?.selectedOptions || []), option.label] : (prev[q.id]?.selectedOptions || []).filter(x => x !== option.label) : [option.label], ...(!q.multi ? {customInput: ''} : {}) }}))}/><span>{option.label}<small>{option.description}</small></span></label>)}
      <Input aria-label={`${q.question || q.header}：其他回答`} placeholder="其他回答" value={answers[q.id]?.customInput || ''} onChange={value => setAnswers(prev => ({...prev, [q.id]: {selectedOptions: q.multi ? prev[q.id]?.selectedOptions || [] : [], customInput: value}}))}/>
    </fieldset>)}</div>}
    {error && <p role="alert" className="error-text">{error}</p>}
    <div className="modal-actions">{onLater&&<Button variant="secondary" disabled={sending} onClick={onLater}>稍后回复</Button>}<Button variant="secondary" disabled={sending} onClick={cancel}>取消</Button>{question.method !== 'select' && <Button variant="cta" loading={sending} onClick={() => {
      if (question.method === 'confirm') void respond({confirmed: true});
      else if (question.method === 'ask') { const result = (question.questions || []).map((q: OmpEvent) => ({id: q.id, ...answers[q.id], selectedOptions: answers[q.id]?.selectedOptions || []})); if (result.some((a: OmpEvent) => !a.selectedOptions.length && !a.customInput?.trim())) {setError('请回答每个问题'); return;} void respond({answers: result}); }
      else void respond({value: text});
    }}>{question.method === 'confirm' ? '确认' : '提交'}</Button>}</div>
  </Modal>;
}
