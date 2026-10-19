import { memo, useEffect, useState, type CSSProperties } from 'react';
import { Bot, Pause, Crown, WifiOff, Spade, MessageCircle, VolumeX } from 'lucide-react';
import { chips, handGameLabel, isIndian, isLegacyIndianHand, isOmaha, postflopCapRemaining, rulesGameLabel, type RoomView } from '../shared/model';
import { EMOTES, type EmoteId, type TableEmote } from '../shared/emotes';
import { ChipStack, CommunityBoards, PlayerName, PlayingCard, cardLabel } from './ui';
import { useCountdown } from './clock';
import { useTableAnimations } from './TableAnimations';
import { holeCardKey } from './tableMotion';
import { EmoteMenu } from './EmoteMenu';

export const PokerTable = memo(function PokerTable({ room, timeOffset, onChooseEmoji, emojiDisabled = false, live = false, animations = true,
  emotes, mutedEmotes, onEmote, onToggleMute, emoteDisabled, emoteSending, emoteCooldownUntil, emoteError, onReveal, revealDisabled }: {
  room: RoomView; timeOffset: number; onChooseEmoji?: () => void; emojiDisabled?: boolean;
  live?: boolean; animations?: boolean;
  emotes: Readonly<Record<string, { event: TableEmote }>>; mutedEmotes: ReadonlySet<string>;
  onEmote: (emote: EmoteId) => Promise<boolean>; onToggleMute: (playerId: string) => void;
  emoteDisabled: boolean; emoteSending: boolean; emoteCooldownUntil: number; emoteError: string;
  onReveal: (handId: string, cardIndexes: number[]) => void; revealDisabled: boolean;
}) {
  const motion = useTableAnimations(room, live, animations, Object.values(emotes).map(item => item.event.id).join(':'));
  const [menu, setMenu] = useState<{ playerId: string; anchor: HTMLElement } | null>(null);
  const menuPlayer = room.players.find(player => player.id === menu?.playerId && player.seat !== null);
  const closeMenu = (restoreFocus = true) => {
    if (restoreFocus && menu?.anchor.isConnected) menu.anchor.focus({ preventScroll: true });
    setMenu(null);
  };
  useEffect(() => {
    if (menu && (!menuPlayer || room.status === 'closed')) setMenu(null);
  }, [menu, menuPlayer, room.status]);
  const hand = room.hand;
  const hero = room.players.find(player => player.id === room.youId)!;
  const rules = hand?.rules ?? room.nextHandRules;
  const indian = isIndian(rules);
  const active = !!hand && hand.street !== 'complete';
  const legacyIndian = !!hand && isLegacyIndianHand(hand);
  const hiddenOwn = indian && active && !!hero.hand && !hero.hand.folded;
  const publicCards = hand?.revealed[room.youId] ?? [];
  const revealCount = hero.cards.length || (legacyIndian ? 1 : isOmaha(rules) ? 4 : 2);
  const hiddenCardIndexes = hero.cards.flatMap((card, index) => card && !publicCards.includes(card) ? [index] : []);
  const revealAvailable = !revealDisabled && hand?.street === 'complete' && !!hero.hand;
  const vote = active ? hand.runoutVote : null;
  const doubleBoard = hand?.boards.length === 2;
  const compactPairs = Math.floor((room.settings.maxSeats - 1) / 2);
  const upperRows = Math.max(1, Math.ceil(compactPairs / 2));
  const lowerRows = Math.floor(compactPairs / 2);
  // Narrow tables reserve a clear middle band for boards, with opponent rows above and below.
  const compactCommunity = upperRows * 130 + (doubleBoard ? 110 : 55);
  const lowerStart = compactCommunity + (doubleBoard ? 180 : 120);
  const compactHero = lowerRows ? lowerStart + (lowerRows - 1) * 130 + 160
    : compactCommunity + (doubleBoard ? 180 : 140);
  const seats = Array.from({ length: room.settings.maxSeats }, (_, seat) => {
    const relative = (seat - (hero.seat ?? 0) + room.settings.maxSeats) % room.settings.maxSeats;
    const angle = Math.PI / 2 + relative * Math.PI * 2 / room.settings.maxSeats;
    const centered = relative === 0 || relative === room.settings.maxSeats / 2;
    const row = compactPairs - Math.min(relative, room.settings.maxSeats - relative);
    const compactY = relative === 0 ? compactHero : centered ? 60
      : row < upperRows ? 60 + row * 130 : lowerStart + (row - upperRows) * 130;
    return {
      seat, x: 50 + Math.cos(angle) * 42, y: 48 + Math.sin(angle) * 39,
      compactX: centered ? 50 : relative < room.settings.maxSeats / 2 ? 0 : 100, compactY,
    };
  });
  const winners = new Set(hand?.results.flatMap(result => result.winners));
  const winnerNames = room.players.filter(player => winners.has(player.id)).map(player => player.name).join(' & ');
  const winnerLabel = winnerNames ? `Hand won by ${winnerNames}` : 'Hand complete';
  const streetName = hand?.street === 'complete' ? 'Hand complete' : vote ? 'Runout decision'
    : legacyIndian ? 'Legacy one-card betting' : hand ? `${hand.street} betting` : 'Waiting for the first hand';

  return <div ref={motion.surface} role="region" data-room-version={room.version} data-street={hand?.street ?? 'waiting'} data-table-motion={animations ? 'on' : 'off'} className={`table-stage ${room.settings.maxSeats >= 8 ? 'table-crowded' : ''} ${doubleBoard ? 'table-double-board' : ''} ${indian ? 'table-indian' : ''} ${room.paused ? 'table-is-paused' : ''}`}
    aria-description={`${hand ? handGameLabel(hand) : rulesGameLabel(rules)}. ${streetName}.${room.paused ? ' Table paused.' : ''}`}
    style={{ '--compact-table-height': `${compactHero + 95}px`, '--compact-community-y': `${compactCommunity}px` } as CSSProperties} aria-label="Poker table">
    <div className="table-shadow" /><div className="table-rail"><div className="table-felt" /></div>
    <div className="community">
      {hand ? <><div className="pot-display" data-motion-pot role="group"
        aria-label={`${hand.street === 'complete' ? 'Pot awarded' : 'Collected pot'}: ${chips(motion.pot)} chips`}
        aria-description={active ? `Total including street wagers: ${chips(hand.pot)} chips` : undefined}>
        <span className="table-deck" data-motion-deck aria-hidden="true"><i /><i /><i /></span>
        <span className={`collected-chips ${motion.pot === 0 ? 'collected-chips-empty' : ''}`}><ChipStack small gold /></span>
        <strong>{chips(motion.pot)}</strong></div>
        {!legacyIndian && <CommunityBoards hand={hand} motion onRunChange={motion.cancel} />}
        {hand.street === 'complete' && <div className="hand-outcome" role="img"
          aria-label={winnerLabel} title={winnerLabel}><Crown size={14} aria-hidden="true" /></div>}
      </> : <div className="waiting-table" role="img" aria-label="Waiting for the first hand"><Spade size={35} strokeWidth={1} aria-hidden="true" /></div>}
      {room.paused && <span className="paused-overlay" role="img" aria-label="Table paused" title="Table paused"><Pause size={14} aria-hidden="true" /></span>}
    </div>
    {seats.map(({ seat, x, y, compactX, compactY }) => {
      const player = room.players.find(item => item.seat === seat);
      const turn = !!player && active && hand.actorId === player.id && !vote;
      const isYou = player?.id === room.youId;
      const folded = player?.hand?.folded;
      const showing = !!player && !!hand?.revealed[player.id]?.length;
      const runoutEligible = !!player && !!vote?.eligible.includes(player.id);
      const runoutChoice = player ? vote?.votes[player.id] : undefined;
      const wager = player ? motion.wagers[player.id] ?? 0 : 0;
      const emote = player && !mutedEmotes.has(player.id) ? emotes[player.id]?.event : undefined;
      const openEmotes = (anchor: HTMLElement) => { if (player) setMenu({ playerId: player.id, anchor }); };
      return <div key={seat} className={`seat ${isYou ? 'hero-seat' : ''} ${player?.cards.length === 4 ? 'four-card-seat' : ''} ${turn ? 'seat-active' : ''} ${folded ? 'seat-folded' : ''} ${showing ? 'seat-showing' : ''} ${player && winners.has(player.id) ? 'seat-winner' : ''} ${emote ? 'seat-emoting' : ''}`}
        style={{ '--seat-x': `${x}%`, '--seat-y': `${y}%`, '--compact-seat-x': `${compactX}%`, '--compact-seat-y': `${compactY}px`,
          '--seat-color': ['#7973aa', '#368b7c', '#aa785b', '#64799c', '#987947', '#8a6795', '#678c9c', '#839360', '#a2697d'][seat] } as CSSProperties}>
        {player ? <>
          <div className="seat-cards" role="group" aria-label={isYou && hiddenOwn ? 'Your Indian poker cards, intentionally hidden from you' : `${player.name}'s cards`}>
            {player.cards.map((card, index) => <PlayingCard key={`${hand?.id}:${index}`} motionKey={holeCardKey(player.id, index)}
              card={(isYou && hiddenOwn) || (vote && !isYou && !indian) ? null : card} small={!isYou} />)}</div>
          <div className="seat-avatar-wrap"><span className="avatar seat-avatar">{player.bot ? <Bot size={18} /> : player.name.slice(0, 2).toUpperCase()}</span>
            {!player.connected && !player.bot && <span className="offline-mark" title="Disconnected"><WifiOff size={10} /></span>}
            {room.hostId === player.id && <span className="host-crown" title="Table host"><Crown size={11} /></span>}
            {player.hand && hand?.buttonSeat === seat && <span className="position-badge dealer-badge" title="Dealer button">D</span>}
            {player.hand && hand?.smallBlindSeat === seat && <span className="position-badge blind-badge" title="Small blind">SB</span>}
            {player.hand && hand?.bigBlindSeat === seat && <span className="position-badge blind-badge" title="Big blind">BB</span>}
          </div>
          <div className="seat-panel"><div className="seat-name-row">
            <button type="button" className="seat-name seat-name-button"
              aria-label={isYou ? 'Change your table emoji' : `${player.name}'s emote options`}
              aria-haspopup={isYou ? 'dialog' : 'menu'}
              aria-disabled={isYou && (emojiDisabled || !onChooseEmoji) ? true : undefined}
              title={isYou ? 'Click to change emoji; right-click for emotes' : 'Right-click for emote options'}
              onClick={isYou ? () => { if (!emojiDisabled) onChooseEmoji?.(); } : event => openEmotes(event.currentTarget)}
              onContextMenu={event => { event.preventDefault(); openEmotes(event.currentTarget); }}
              onKeyDown={event => {
                if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                  event.preventDefault(); openEmotes(event.currentTarget);
                }
              }}><PlayerName player={player} />{isYou && <small>YOU</small>}{!isYou && mutedEmotes.has(player.id) &&
                <VolumeX className="emote-muted-icon" size={10} aria-label="Emotes muted" />}</button>
            {isYou && room.status === 'open' && <button type="button" className="seat-emote-trigger" aria-label="Open emote menu" aria-haspopup="menu"
              title="Emotes (or right-click your name)" onClick={event => openEmotes(event.currentTarget)}><MessageCircle size={12} /></button>}
          </div>
            <strong className="seat-stack" data-motion-stack={player.id}>{chips(player.stack)}</strong>
            {turn ? <TurnClock deadline={hand.deadline} baseDeadline={hand.baseDeadline} timeOffset={timeOffset} paused={room.paused} turnSeconds={hand.clock.turnSeconds} />
              : <span className="seat-action">{room.status === 'closed' ? 'Cashed out'
              : runoutEligible ? runoutChoice ? `Runout: ${runoutChoice === 1 ? 'once' : `up to ${runoutChoice}`}` : 'Runout: pending'
                : folded ? 'Folded' : player.stack === 0 && player.hand && active ? 'ALL IN'
                  : active && player.hand && postflopCapRemaining(hand, player.hand) === 0 ? 'CAPPED'
                    : player.sittingOut ? 'Sitting out' : player.hand?.lastAction || (player.stack === 0 ? 'Awaiting buy-in' : player.bot ? 'Practice bot' : 'Ready')}</span>
            }
          </div>
          <div className={`seat-bet ${wager === 0 ? 'wager-empty' : ''}`} data-motion-wager={player.id} data-wager-amount={wager}
            role="group" aria-label={`${player.name}'s street wager: ${chips(wager)} chips`} aria-hidden={wager === 0}
            title={`${chips(wager)} chips committed on this street`}>
            <span className="wager-chips"><ChipStack /></span><span className="wager-value">{chips(wager)}</span>
          </div>
          {emote && <div key={emote.id} className="seat-emote-bubble" role="status" aria-label={`${player.name} says ${EMOTES[emote.emote]}`}>{EMOTES[emote.emote]}</div>}
        </> : <div className="empty-seat"><span>+</span><small>OPEN SEAT</small></div>}
      </div>;
    })}
    <section className="reveal-controls" aria-label="Reveal your cards" aria-describedby="reveal-help">
      <span className="reveal-label" title="After the hand, show cards individually from left to right, or show all. Reveals stay public in hand history.">Show cards</span>
      {Array.from({ length: revealCount }, (_, index) => {
        const card = hiddenOwn ? null : hero.cards[index];
        const shown = !!card && publicCards.includes(card);
        const label = `${shown ? 'Card' : 'Reveal card'} ${index + 1}${shown ? ' already shown' : ''}${card ? `: ${cardLabel(card)}` : ''}`;
        return <button key={index} type="button" className={`reveal-card-button ${shown ? 'card-revealed' : ''}`}
          disabled={!revealAvailable || !card || shown} aria-label={label} title={label}
          onClick={() => { if (hand && revealAvailable) onReveal(hand.id, [index]); }}>{index + 1}</button>;
      })}
      <button type="button" className="reveal-all-button" disabled={!revealAvailable || hiddenCardIndexes.length === 0}
        onClick={() => { if (hand && revealAvailable) onReveal(hand.id, hiddenCardIndexes); }}>Reveal all</button>
      <span id="reveal-help" hidden>After the hand ends, optionally reveal cards from left to right, even if you folded. Revealed cards stay public in hand history.</span>
    </section>
    {motion.layer}
    {menu && menuPlayer && room.status === 'open' && <EmoteMenu anchor={menu.anchor} own={menu.playerId === room.youId}
      name={menuPlayer.name} muted={mutedEmotes.has(menu.playerId)} disabled={emoteDisabled}
      sending={emoteSending} cooldownUntil={emoteCooldownUntil} error={emoteError} send={onEmote}
      toggleMute={() => onToggleMute(menu.playerId)} close={closeMenu} />}
  </div>;
});

function TurnClock({ deadline, baseDeadline, timeOffset, paused, turnSeconds }: {
  deadline: number | null; baseDeadline: number | null; timeOffset: number; paused: boolean; turnSeconds: number;
}) {
  const normal = useCountdown(paused ? null : baseDeadline, timeOffset) ?? 0;
  const total = useCountdown(paused ? null : deadline, timeOffset) ?? 0;
  const usingBank = !paused && normal === 0 && deadline !== null && baseDeadline !== null && deadline > baseDeadline;
  const remaining = usingBank ? total : normal;
  const duration = usingBank ? (deadline - baseDeadline) / 1000 : turnSeconds;
  return <><span className={`seat-action acting-label ${usingBank ? 'time-bank-active' : ''}`} role="timer" aria-live="off"
    aria-label={paused ? 'Turn paused' : `${usingBank ? 'Time bank' : 'Turn clock'}: ${remaining} seconds remaining`}>
    {paused ? 'Turn paused' : usingBank ? `Bank: ${remaining}s` : `${remaining}s to act`}</span>
    <span className={`turn-progress ${usingBank ? 'time-bank-progress' : ''}`} style={{ width: `${Math.min(100, remaining / duration * 100)}%` }} /></>;
}
