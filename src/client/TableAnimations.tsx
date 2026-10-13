import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { RoomView } from '../shared/model';
import { chips } from '../shared/model';
import { ChipStack, PlayingCard } from './ui';
import { CARD_FLIGHT_MS, CARD_REVEAL_MS, CHIP_FLIGHT_MS, collectedPot, planTableMotion, streetWagers, type TableMotionPlan } from './tableMotion';
import { positionWagers } from './wagerLayout';

interface MotionBatch { id: number; handId: string; plan: TableMotionPlan }
interface Point { x: number; y: number }

export function useTableAnimations(room: RoomView, live: boolean, enabled: boolean) {
  const surface = useRef<HTMLDivElement>(null);
  const previous = useRef<{ room: RoomView; watching: boolean } | null>(null);
  const [batch, setBatch] = useState<MotionBatch | null>(null);
  const [collected, setCollected] = useState<MotionBatch | null>(null);
  const cancel = useCallback(() => setBatch(null), []);
  useLayoutEffect(() => {
    const watching = live && enabled && !document.hidden;
    const before = previous.current;
    previous.current = { room, watching };
    if (!watching || !before?.watching) { cancel(); return; }
    if (before.room.version === room.version && before.room.id === room.id && before.room.youId === room.youId) return;
    const plan = planTableMotion(before.room, room);
    if (plan.cards.length || plan.chips.length) setBatch({ id: room.version, handId: room.hand!.id, plan });
    else if (before.room.hand?.id !== room.hand?.id || room.version !== before.room.version + 1 ||
      before.room.players.some(player => player.seat !== room.players.find(next => next.id === player.id)?.seat)) cancel();
  }, [room, live, enabled, cancel]);
  useLayoutEffect(() => {
    if (surface.current) positionWagers(surface.current);
  }, [room, batch, collected]);

  useEffect(() => {
    let frame: number | undefined;
    const observer = new ResizeObserver(() => { if (surface.current) positionWagers(surface.current); });
    if (surface.current) {
      observer.observe(surface.current);
      for (const seat of surface.current.querySelectorAll('.seat')) observer.observe(seat);
    }
    const visibility = () => { previous.current = null; cancel(); };
    const resize = () => {
      cancel();
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => { if (surface.current) positionWagers(surface.current); });
    };
    window.addEventListener('resize', resize);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      observer.disconnect();
      if (frame !== undefined) cancelAnimationFrame(frame);
      window.removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [cancel, room.settings.maxSeats]);
  const activeBatch = batch && live && enabled && batch.handId === room.hand?.id ? batch : null;
  const wagers = streetWagers(room);
  let pendingPot = 0;
  if (activeBatch && collected !== activeBatch) {
    for (const chip of activeBatch.plan.chips) {
      if (chip.kind !== 'collect') continue;
      wagers[chip.playerId] = (wagers[chip.playerId] ?? 0) + chip.amount;
      pendingPot += chip.amount;
    }
  }
  return {
    surface, cancel, wagers, pot: collectedPot(room) - pendingPot,
    layer: activeBatch ? <AnimationLayer batch={activeBatch} surface={surface}
      collected={() => setCollected(activeBatch)}
      complete={() => setBatch(current => current === batch ? null : current)} /> : null,
  };
}

function AnimationLayer({ batch, surface, complete, collected }: {
  batch: MotionBatch; surface: RefObject<HTMLDivElement | null>; complete: () => void; collected: () => void;
}) {
  const layer = useRef<HTMLDivElement>(null);
  const done = useRef(complete);
  done.current = complete;
  const collectionDone = useRef(collected);
  collectionDone.current = collected;
  useLayoutEffect(() => {
    const table = surface.current;
    const root = layer.current;
    if (!table || !root) throw new Error('The table animation surface is missing.');
    positionWagers(table);
    const bounds = table.getBoundingClientRect();
    const point = (element: HTMLElement): Point => {
      const rect = element.getBoundingClientRect();
      return { x: rect.left + rect.width / 2 - bounds.left, y: rect.top + rect.height / 2 - bounds.top };
    };
    const pot = table.querySelector<HTMLElement>('[data-motion-pot]');
    const deck = table.querySelector<HTMLElement>('[data-motion-deck]');
    const stacks = new Map([...table.querySelectorAll<HTMLElement>('[data-motion-stack]')].map(element => [element.dataset.motionStack, element]));
    const wagers = new Map([...table.querySelectorAll<HTMLElement>('[data-motion-wager]')].map(element => [element.dataset.motionWager, element]));
    const cards = new Map([...table.querySelectorAll<HTMLElement>('[data-motion-card]')].map(element => [element.dataset.motionCard, element]));
    const animations: Animation[] = [];
    const touched = new Set<HTMLElement>();
    let pending = 0;
    let disposed = false;
    const play = (element: HTMLElement, frames: Keyframe[], options: KeyframeAnimationOptions, finished?: () => void) => {
      const animation = element.animate(frames, options);
      animations.push(animation); pending++;
      animation.onfinish = () => {
        pending--;
        if (disposed) return;
        finished?.();
        if (!pending) done.current();
      };
    };
    const fly = (element: HTMLElement, from: Point, to: Point, delay: number, duration: number, card: boolean, finished?: () => void) => {
      play(element, [
        { transform: `translate(${from.x}px, ${from.y}px) translate(-50%, -50%) rotate(${card ? -18 : -7}deg) scale(.65)`, opacity: 0, offset: 0 },
        { opacity: 1, offset: .12 },
        { transform: `translate(${(from.x + to.x) / 2}px, ${(from.y + to.y) / 2 - 16}px) translate(-50%, -50%) rotate(${card ? -7 : 3}deg) scale(.95)`, opacity: 1, offset: .55 },
        { opacity: 1, offset: .94 },
        { transform: `translate(${to.x}px, ${to.y}px) translate(-50%, -50%) rotate(0deg) scale(1)`, opacity: 0, offset: 1 },
      ], { duration, delay, easing: 'cubic-bezier(.22,.65,.28,1)', fill: 'backwards' }, finished);
    };
    let collections = batch.plan.chips.filter(chip => chip.kind === 'collect').length;
    for (const [index, motion] of batch.plan.chips.entries()) {
      const stack = stacks.get(motion.playerId);
      const wager = wagers.get(motion.playerId);
      const flight = root.querySelector<HTMLElement>(`[data-chip-flight="${index}"]`);
      // A player who has cashed out no longer has a visible seat.
      const anchors = { stack, wager, pot };
      const source = anchors[motion.from];
      const destination = anchors[motion.to];
      if (!source || !destination || !flight) {
        if (motion.kind === 'collect' && --collections === 0) collectionDone.current();
        continue;
      }
      fly(flight, point(source), point(destination), motion.delay, CHIP_FLIGHT_MS, false, () => {
        if (motion.kind === 'collect' && --collections === 0) collectionDone.current();
      });
      if (motion.kind === 'collect')
        play(source, [{ opacity: 0 }, { opacity: 0 }], { duration: CHIP_FLIGHT_MS, delay: motion.delay, fill: 'none' });
      play(destination, [{ scale: '1', color: '#e4c17d' }, { scale: '1.06', offset: .4 }, { scale: '1' }],
        { duration: 260, delay: motion.delay + CHIP_FLIGHT_MS, fill: 'none' });
    }
    for (const [index, motion] of batch.plan.cards.entries()) {
      const target = cards.get(motion.key);
      // Only the selected board run is mounted; never animate an unseen run.
      if (!target || target.classList.contains('card-placeholder')) continue;
      touched.add(target);
      target.dataset.cardAnimation = motion.kind;
      if (motion.kind === 'reveal') {
        play(target, [{ scale: '0 1', opacity: 0 }, { scale: '1 1', opacity: 1 }],
          { duration: CARD_REVEAL_MS, delay: motion.delay, easing: 'ease-out', fill: 'backwards' });
      } else {
        const flight = root.querySelector<HTMLElement>(`[data-card-flight="${index}"]`);
        if (!flight || !deck) continue;
        const size = target.getBoundingClientRect();
        flight.style.width = `${size.width}px`;
        flight.style.height = `${size.height}px`;
        fly(flight, point(deck), point(target), motion.delay, CARD_FLIGHT_MS, true);
        play(target, [{ opacity: 0 }, { opacity: 0 }],
          { duration: motion.delay + CARD_FLIGHT_MS, fill: 'none' }, () => {
            if (target.classList.contains('card-face'))
              play(target, [{ scale: '0 1' }, { scale: '1 1' }], { duration: 160, easing: 'ease-out' });
          });
      }
    }
    if (!pending) done.current();
    return () => {
      disposed = true;
      for (const animation of animations) { animation.onfinish = null; animation.cancel(); }
      for (const element of touched) delete element.dataset.cardAnimation;
    };
  }, [batch, surface]);

  return <div ref={layer} className="table-motion-layer" aria-hidden="true" data-motion-version={batch.id}>
    {batch.plan.chips.map((motion, index) => <div key={`chip:${index}`} className="moving-chips" data-chip-flight={index}
      data-motion-kind={motion.kind} data-player-id={motion.playerId} data-amount={motion.amount} data-from={motion.from} data-to={motion.to}>
      <ChipStack gold={motion.kind === 'payout'} /><span className="moving-chip-amount">{chips(motion.amount)}{motion.kind === 'refund' && <small>Returned</small>}</span>
    </div>)}
    {batch.plan.cards.map((motion, index) => motion.kind === 'deal' &&
      <div key={`card:${index}`} className="moving-card" data-card-flight={index} data-card-target={motion.key}><PlayingCard card={null} /></div>)}
  </div>;
}
