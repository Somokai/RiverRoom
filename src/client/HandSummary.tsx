import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { Crown, LockKeyhole } from 'lucide-react';
import { chips, isIndian, isOmaha, type RoomView } from '../shared/model';
import { currentHands, winningHands } from './handPresentation';
import { planTableMotion } from './tableMotion';
import { PlayerName, PlayingCard } from './ui';

export function CurrentHand({ room }: { room: RoomView }) {
  const hands = useMemo(() => currentHands(room), [room]);
  const hero = room.players.find(player => player.id === room.youId);
  const hand = room.hand;
  if (!hand || hand.street === 'complete' || !hero?.hand || hero.hand.folded) return null;
  const hidden = isIndian(hand.rules);
  const hint = `Only you can see this. ${isOmaha(hand.rules) ? 'Use exactly two hole cards and three board cards.' : 'Best hand right now, not a prediction.'}`;
  return <section className="current-hand" aria-label="Your current hand" aria-description={hint}
    title={hint} aria-live="polite" aria-atomic="true">
    <span className="current-hand-label"><LockKeyhole size={12} aria-hidden="true" /> Your hand:</span>
    {hidden ? <span>Your cards are hidden in Indian poker.</span> : hands.map(item => <span key={item.boardIndex}>
      {hands.length > 1 && <span>Board {item.boardIndex + 1}: </span>}<strong>{item.description}</strong>
    </span>)}
  </section>;
}

export function HandResults({ room, table, live, animations }: {
  room: RoomView; table: RefObject<HTMLDivElement | null>; live: boolean; animations: boolean;
}) {
  const root = useRef<HTMLElement>(null);
  const previous = useRef<{ room: RoomView; watching: boolean } | null>(null);
  const [gather, setGather] = useState<{ handId: string; delay: number } | null>(null);
  const wins = useMemo(() => winningHands(room), [room]);
  useEffect(() => {
    const visibility = () => { previous.current = null; setGather(null); };
    document.addEventListener('visibilitychange', visibility);
    return () => document.removeEventListener('visibilitychange', visibility);
  }, []);
  useLayoutEffect(() => {
    const before = previous.current;
    const watching = live && animations && !document.hidden;
    previous.current = { room, watching };
    if (!watching || !before?.watching) { setGather(null); return; }
    if (before.room.id === room.id && before.room.youId === room.youId && before.room.version === room.version) return;
    const hand = room.hand;
    if (before.room.id !== room.id || before.room.youId !== room.youId || room.version !== before.room.version + 1 ||
        !hand || hand.id !== before.room.hand?.id) { setGather(null); return; }
    if (hand.street === 'complete' && before.room.hand.street !== 'complete') {
      const plan = planTableMotion(before.room, room);
      setGather({ handId: hand.id, delay: plan.chips.find(chip => chip.kind === 'payout')?.delay ?? 0 });
    }
  }, [room, live, animations]);
  const handId = room.hand?.id;
  useLayoutEffect(() => {
    if (!gather || gather.handId !== handId || !live || !animations || !root.current || !table.current) return;
    const sources = new Map([...table.current.querySelectorAll<HTMLElement>('[data-motion-card]')]
      .map(element => [element.dataset.motionCard, element]));
    const flights: Array<{ card: HTMLElement; animation: Animation }> = [];
    for (const [index, slot] of root.current.querySelectorAll<HTMLElement>('[data-winning-source]').entries()) {
      const source = sources.get(slot.dataset.winningSource);
      const card = slot.querySelector<HTMLElement>('.playing-card');
      // Other board runs may not be mounted, and hidden cards are never animation sources.
      if (!source?.classList.contains('card-face') || !card) continue;
      const from = source.getBoundingClientRect();
      const to = card.getBoundingClientRect();
      card.dataset.winningAnimation = 'gather';
      const animation = card.animate([
        { transform: `translate(${from.x + from.width / 2 - to.x - to.width / 2}px, ${from.y + from.height / 2 - to.y - to.height / 2}px) scale(${from.height / to.height})`, opacity: 0 },
        { opacity: 1, offset: .12 },
        { transform: 'translate(0, 0) scale(1)', opacity: 1 },
      ], { duration: 650, delay: gather.delay + index % 5 * 65, easing: 'cubic-bezier(.22,.65,.28,1)', fill: 'backwards' });
      animation.onfinish = () => { delete card.dataset.winningAnimation; };
      flights.push({ card, animation });
    }
    const cancel = () => {
      for (const { card, animation } of flights) {
        animation.onfinish = null; animation.cancel(); delete card.dataset.winningAnimation;
      }
    };
    window.addEventListener('resize', cancel);
    return () => {
      cancel();
      window.removeEventListener('resize', cancel);
    };
  }, [gather, handId, live, animations, table]);
  if (!wins.length) return null;
  const groups = new Map<string, typeof wins>();
  for (const win of wins) {
    const key = `${win.runoutIndex}:${win.boardIndex}`;
    const group = groups.get(key) ?? [];
    group.push(win); groups.set(key, group);
  }
  return <section ref={root} className="hand-results" aria-label="Hand results">
    <header><Crown size={18} aria-hidden="true" /><h2>Hand #{room.hand!.number} results</h2></header>
    <div className="winning-boards">{[...groups].map(([key, group]) => <article key={key} className="winning-board"
      aria-label={`Run ${group[0]!.runoutIndex + 1}, board ${group[0]!.boardIndex + 1} winners`}>
      <h3>Run {group[0]!.runoutIndex + 1} <span>/</span> Board {group[0]!.boardIndex + 1}</h3>
      {group.map(win => {
        const player = room.players.find(item => item.id === win.playerId);
        const label = `${player?.name ?? win.playerId} wins ${chips(win.amount)} chips with ${win.description}`;
        return <div key={win.key} className="winning-hand" role="group" aria-label={label} data-winner-id={win.playerId}>
          <div className="winning-player"><strong>{player ? <PlayerName player={player} /> : win.playerId}</strong>
            <span>{win.split ? 'Shares' : 'Wins'} <b>{chips(win.amount)}</b> chips</span></div>
          <p className="winning-description">{win.description === 'Uncontested' ? 'Uncontested (no showdown)' : win.description}</p>
          <p className="winning-pots">{win.pots.map(pot => pot === 0 ? 'Main pot' : `Side pot ${pot}`).join(' + ')}
            {win.playsBoard && ' / Plays the board'}{win.split && ' / Split pot'}</p>
          {win.cards.length > 0 && <div className="winning-cards" role="group" aria-label={`${player?.name ?? win.playerId}'s winning cards`}>
            {win.cards.map(({ card, source, hole }) => <div key={card} className={`winning-card ${hole ? 'winning-hole-card' : ''}`} data-winning-source={source}>
              <PlayingCard card={card} /><small>{hole ? 'Hole' : 'Board'}</small>
            </div>)}
          </div>}
        </div>;
      })}
    </article>)}</div>
  </section>;
}
