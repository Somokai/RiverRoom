import { useEffect, useId, useRef, useState, type CSSProperties, type PropsWithChildren } from 'react';
import { X, Spade } from 'lucide-react';
import { boardRuns, chips, money, type BountyAward, type Card, type Hand, type HandRules, type Player, type RoomView } from '../shared/model';
import { findPlayerEmoji } from '../shared/emoji';

export function Modal({ title, subtitle, close, children, wide = false }: PropsWithChildren<{
  title: string; subtitle?: string; close: () => void; wide?: boolean;
}>) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current!;
    const previousFocus = document.activeElement;
    dialog.showModal();
    document.body.classList.add('modal-open');
    return () => {
      dialog.close();
      document.body.classList.remove('modal-open');
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);
  return <dialog ref={ref} className={`modal ${wide ? 'modal-wide' : ''}`} aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); close(); }} onClick={event => { if (event.target === ref.current) close(); }}>
    <header className="modal-heading"><div><h2 id={titleId}>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>
      <button className="icon-button" aria-label="Close dialog" onClick={close}><X size={20} /></button></header>
    {children}
  </dialog>;
}

export function PlayerEmoji({ value }: { value?: string | null }) {
  const choice = findPlayerEmoji(value);
  return choice ? <span className="player-emoji" role="img" aria-label={choice.label} title={choice.label}>{choice.value}</span> : null;
}

export function PlayerName({ player }: { player: Pick<Player, 'name' | 'emoji'> }) {
  return <span className="player-label"><span className="player-name-text" title={player.name}>{player.name}</span><PlayerEmoji value={player.emoji} /></span>;
}

const suits: Record<string, string> = { s: '\u2660', h: '\u2665', d: '\u2666', c: '\u2663' };
const suitNames: Record<string, string> = { s: 'spades', h: 'hearts', d: 'diamonds', c: 'clubs' };
const rankNames: Record<string, string> = { A: 'Ace', K: 'King', Q: 'Queen', J: 'Jack', T: '10' };
export function PlayingCard({ card, small = false, index = 0, placeholder = false }: {
  card?: Card | null; small?: boolean; index?: number; placeholder?: boolean;
}) {
  if (placeholder) return <div className={`playing-card card-placeholder ${small ? 'card-small' : ''}`} aria-hidden="true"><Spade size={24} strokeWidth={1} /></div>;
  if (!card) return <div role="img" className={`playing-card card-back ${small ? 'card-small' : ''}`} aria-label="Face-down card"><Spade size={small ? 16 : 28} strokeWidth={1.25} /></div>;
  const red = card[1] === 'h' || card[1] === 'd';
  const rank = card[0] === 'T' ? '10' : card[0];
  const rankName = rankNames[card[0]!] ?? rank;
  return <div role="img" className={`playing-card card-face ${red ? 'red-suit' : 'black-suit'} ${small ? 'card-small' : ''}`}
    aria-label={`${rankName} of ${suitNames[card[1]!]}`} style={{ '--delay': `${index * 65}ms` } as CSSProperties}>
    <div className="card-corner"><strong>{rank}</strong><span>{suits[card[1]!]}</span></div>
    <span className="card-suit">{suits[card[1]!]}</span>
    <div className="card-corner corner-bottom"><strong>{rank}</strong><span>{suits[card[1]!]}</span></div>
  </div>;
}
export function ChipStack({ gold = false, small = false }: { gold?: boolean; small?: boolean }) {
  return <span className={`chip-stack ${gold ? 'gold-chips' : ''} ${small ? 'small-chips' : ''}`} aria-hidden="true">
    <i /><i /><i /><i />
  </span>;
}
export function Brand({ compact = false }: { compact?: boolean }) {
  return <div className={`brand ${compact ? 'compact-brand' : ''}`}><span className="brand-mark"><Spade size={25} fill="currentColor" strokeWidth={1} /></span>
    <span>river<span className="brand-light">room</span><small>THE GOOD KIND OF ALL IN.</small></span></div>;
}
export function Numeric({ label, value, onChange, min = 0, max = 10_000_000, step = 1, hint }: {
  label: string; value: number; onChange: (value: number) => void; min?: number; max?: number; step?: number; hint?: string;
}) {
  const id = useId();
  return <label className="field" htmlFor={id}><span id={`${id}-label`}>{label}</span>
    <input id={id} aria-labelledby={`${id}-label`} aria-describedby={hint ? `${id}-hint` : undefined}
      type="number" inputMode="numeric" required value={Number.isFinite(value) ? value : ''} min={min} max={max} step={step}
      onChange={event => onChange(event.currentTarget.value === '' ? Number.NaN : Number(event.currentTarget.value))} />
    {hint && <small id={`${id}-hint`}>{hint}</small>}</label>;
}

export const signedChips = (value: number) => `${value >= 0 ? '+' : ''}${chips(value)}`;
export const bountyLabel = (value: number) => value > 0 ? 'Bounty receivable' : value < 0 ? 'Bounty owed' : 'Bounty balance';
export const runLabel = (count: number) => count === 1 ? 'Run once' : count === 2 ? 'Up to twice' : 'Up to three times';

export function ruleSummary(rules: HandRules, legacyIndian = false): string {
  const runs = rules.maxRunouts === 1 ? 'run once' : `consent for up to ${rules.maxRunouts} runs`;
  if (rules.game === 'indian') return legacyIndian
    ? `${chips(rules.indianAnte)} ante · legacy one-card hand · one betting round`
    : `${chips(rules.indianAnte)} round ante · two face-out cards · Hold'em betting · ${runs}`;
  if (rules.game === 'omaha_bomb') return `${chips(rules.bombAnte)} ante · two boards · pot limit · ${runs}`;
  if (rules.game === 'omaha') return `${rules.omahaAnte > 0 ? `${chips(rules.omahaAnte)} round ante` : 'Legacy table ante'} · four private cards · pot limit · ${runs}`;
  return `No limit · ${rules.sevenDeuceBounty ? `${chips(rules.sevenDeuceBounty)} per opponent for 7/2` : '7/2 bounty off'} · ${runs}`;
}

export function CommunityBoards({ hand, small = false, complete = false }: {
  hand: Pick<Hand, 'id' | 'boards' | 'runoutBoards'> & Partial<Pick<Hand, 'runoutVote'>>;
  small?: boolean; complete?: boolean;
}) {
  const id = useId();
  const [selection, setSelection] = useState({ handId: hand.id, run: 0 });
  const runs = boardRuns(hand.runoutVote ? { boards: hand.boards, runoutBoards: [] } : hand);
  const selected = selection.handId === hand.id ? Math.min(selection.run, runs.length - 1) : 0;
  const boards = runs[selected] ?? [];
  if (!boards.length) return null;
  return <div className={`community-boards ${boards.length > 1 ? 'dual-board' : ''} ${small ? 'history-boards' : ''}`}>
    {runs.length > 1 && <div className="run-tabs" role="tablist" aria-label="Board runs">
      {runs.map((_, index) => <button key={index} type="button" role="tab" id={`${id}-tab-${index}`}
        aria-selected={selected === index} aria-controls={`${id}-panel`} tabIndex={selected === index ? 0 : -1}
        onClick={() => setSelection({ handId: hand.id, run: index })}
        onKeyDown={event => {
          const next = event.key === 'ArrowRight' ? (index + 1) % runs.length
            : event.key === 'ArrowLeft' ? (index + runs.length - 1) % runs.length
              : event.key === 'Home' ? 0 : event.key === 'End' ? runs.length - 1 : null;
          if (next === null) return;
          event.preventDefault();
          setSelection({ handId: hand.id, run: next });
          document.getElementById(`${id}-tab-${next}`)?.focus();
        }}>Run {index + 1}</button>)}
    </div>}
    <div className="boards-panel" id={`${id}-panel`} role={runs.length > 1 ? 'tabpanel' : undefined}
      aria-labelledby={runs.length > 1 ? `${id}-tab-${selected}` : undefined} tabIndex={runs.length > 1 ? 0 : undefined}>
      {boards.map((cards, boardIndex) => <div className="community-board" role="group"
        aria-label={`Run ${selected + 1}, board ${boardIndex + 1}`} key={boardIndex}>
        {boards.length > 1 && <span className="board-label">Board {boardIndex + 1}</span>}
        {complete && !cards.length ? <span className="empty-board">Won without community cards</span>
          : <div className="board-cards">{Array.from({ length: 5 }, (_, index) => <PlayingCard
            key={`${hand.id}:${selected}:${boardIndex}:${cards[index] ?? index}`}
            card={cards[index]} placeholder={!cards[index]} small={small} index={index} />)}</div>}
      </div>)}
    </div>
  </div>;
}

export function BountyNotice({ bounty, room }: { bounty: BountyAward; room: Pick<RoomView, 'players' | 'settings'> }) {
  const name = (id: string) => room.players.find(player => player.id === id)?.name ?? id;
  return <div className="bounty-award" role="note" aria-label="Seven-deuce bounty">
    <strong>7/2 offsuit bonus: {name(bounty.winnerId)} is owed {chips(bounty.totalAmount)} chips equivalent
      {' '}({money(bounty.totalAmount * room.settings.chipValueCents, room.settings.currency)}).</strong>
    <p>{chips(bounty.amount)} each from {bounty.payerIds.map(name).join(', ')}. The winning 7/2 is intentionally revealed, even on an uncontested win.</p>
    <small>Off-table settlement only. This bonus does not change stacks or cash-outs; no payment has been collected.</small>
  </div>;
}
