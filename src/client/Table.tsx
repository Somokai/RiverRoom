import { memo, useEffect, useState, type CSSProperties } from 'react';
import { Bot, Pause, Crown, WifiOff, Spade, MessageCircle, VolumeX } from 'lucide-react';
import { GAME_LABELS, chips, handGameLabel, isLegacyIndianHand, type RoomView } from '../shared/model';
import { EMOTES, type EmoteId, type TableEmote } from '../shared/emotes';
import { ChipStack, CommunityBoards, PlayerName, PlayingCard } from './ui';
import { useCountdown } from './clock';
import { EmoteMenu } from './EmoteMenu';

export const PokerTable = memo(function PokerTable({ room, timeOffset, onChooseEmoji, emojiDisabled = false,
  emotes, mutedEmotes, onEmote, onToggleMute, emoteDisabled, emoteSending, emoteCooldownUntil, emoteError }: {
  room: RoomView; timeOffset: number; onChooseEmoji?: () => void; emojiDisabled?: boolean;
  emotes: Readonly<Record<string, { event: TableEmote }>>; mutedEmotes: ReadonlySet<string>;
  onEmote: (emote: EmoteId) => Promise<boolean>; onToggleMute: (playerId: string) => void;
  emoteDisabled: boolean; emoteSending: boolean; emoteCooldownUntil: number; emoteError: string;
}) {
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
  const game = hand?.rules.game ?? room.nextHandRules.game;
  const indian = game === 'indian';
  const active = !!hand && hand.street !== 'complete';
  const legacyIndian = !!hand && isLegacyIndianHand(hand);
  const hiddenOwn = indian && active && !!hero.hand && !hero.hand.folded;
  const vote = active ? hand.runoutVote : null;
  const doubleBoard = hand?.boards.length === 2;
  const compactPairs = Math.floor((room.settings.maxSeats - 1) / 2);
  const upperRows = Math.max(1, Math.ceil(compactPairs / 2));
  const lowerRows = Math.floor(compactPairs / 2);
  // Narrow tables reserve a clear middle band for boards, with opponent rows above and below.
  const compactCommunity = upperRows * 130 + (doubleBoard ? 100 : 65);
  const lowerStart = compactCommunity + (doubleBoard ? 160 : 120);
  const compactHero = lowerRows ? lowerStart + (lowerRows - 1) * 130 + 140
    : compactCommunity + (doubleBoard ? 160 : 140);
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
  const streetName = hand?.street === 'complete' ? 'HAND COMPLETE' : vote ? 'RUNOUT DECISION'
    : legacyIndian ? 'LEGACY ONE-CARD BETTING' : hand?.street?.toUpperCase() ?? 'THE NIGHT IS YOUNG';

  return <div role="region" className={`table-stage ${room.settings.maxSeats >= 8 ? 'table-crowded' : ''} ${doubleBoard ? 'table-double-board' : ''} ${indian ? 'table-indian' : ''} ${room.paused ? 'table-is-paused' : ''}`}
    style={{ '--compact-table-height': `${compactHero + 95}px`, '--compact-community-y': `${compactCommunity}px` } as CSSProperties} aria-label="Poker table">
    <div className="table-shadow" /><div className="table-rail"><div className="table-felt"><span className="felt-wordmark">RIVER ROOM <Spade size={14} fill="currentColor" /></span>
      <span className="felt-subtitle">{(hand ? handGameLabel(hand) : GAME_LABELS[game]).toUpperCase()}</span></div></div>
    <div className="community">
      <span className="street-label">{streetName}</span>
      {hand ? <><div className="pot-display"><ChipStack small gold /><span><small>{hand.street === 'complete' ? 'POT AWARDED' : 'TOTAL POT'}</small><strong>{chips(hand.street === 'complete' ? hand.awardedPot : hand.pot)}</strong></span></div>
        {legacyIndian ? <div className="indian-table-note"><strong>Saved one-card hand.</strong>
          <span>Finishes under its original ante-only rules. New Indian deals use two cards and a Hold'em board.</span></div>
          : <CommunityBoards hand={hand} />}
        {hand.street === 'complete' ? <div className="hand-outcome"><Crown size={14} /><span>{winnerNames || 'Hand complete'}
          {hand.boards.length > 1 || hand.runoutCount > 1 ? <small>{hand.boards.length} {hand.boards.length === 1 ? 'board' : 'boards'} / {hand.runoutCount} {hand.runoutCount === 1 ? 'run' : 'runs'} — pot shares in Hand history</small>
            : hand.results[0]?.description !== 'Uncontested' && <small>{hand.results[0]?.description}</small>}</span></div>
          : <div className="pot-caption">{vote ? 'Betting is over. Public cards stay in place while players decide.' : `${hand.players.filter(player => !player.folded).length} players in the hand`}</div>}
      </> : <div className="waiting-table"><Spade size={35} strokeWidth={1} /><h2>Pull up a chair.</h2><p>Invite your people or add practice bots.<br />The host deals when everyone is ready.</p></div>}
      {room.paused && <span className="paused-overlay"><Pause size={14} /> TABLE PAUSED</span>}
    </div>
    {seats.map(({ seat, x, y, compactX, compactY }) => {
      const player = room.players.find(item => item.seat === seat);
      const turn = !!player && active && hand.actorId === player.id && !vote;
      const isYou = player?.id === room.youId;
      const folded = player?.hand?.folded;
      const runoutEligible = !!player && !!vote?.eligible.includes(player.id);
      const runoutChoice = player ? vote?.votes[player.id] : undefined;
      const emote = player && !mutedEmotes.has(player.id) ? emotes[player.id]?.event : undefined;
      const openEmotes = (anchor: HTMLElement) => { if (player) setMenu({ playerId: player.id, anchor }); };
      return <div key={seat} className={`seat ${isYou ? 'hero-seat' : ''} ${player?.cards.length === 4 ? 'four-card-seat' : ''} ${turn ? 'seat-active' : ''} ${folded ? 'seat-folded' : ''} ${player && winners.has(player.id) ? 'seat-winner' : ''} ${emote ? 'seat-emoting' : ''}`}
        style={{ '--seat-x': `${x}%`, '--seat-y': `${y}%`, '--compact-seat-x': `${compactX}%`, '--compact-seat-y': `${compactY}px`,
          '--seat-color': ['#7973aa', '#368b7c', '#aa785b', '#64799c', '#987947', '#8a6795', '#678c9c', '#839360', '#a2697d'][seat] } as CSSProperties}>
        {player ? <>
          <div className="seat-cards" role="group" aria-label={isYou && hiddenOwn ? 'Your Indian poker cards, intentionally hidden from you' : `${player.name}'s cards`}>
            {player.cards.map((card, index) => <PlayingCard key={index} card={(isYou && hiddenOwn) || (vote && !isYou && !indian) ? null : card} small={!isYou} />)}</div>
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
            <strong className="seat-stack">{chips(player.stack)}</strong>
            {turn ? <TurnClock deadline={hand.deadline} timeOffset={timeOffset} paused={room.paused} turnSeconds={room.settings.turnSeconds} />
              : <span className="seat-action">{room.status === 'closed' ? 'Cashed out'
              : runoutEligible ? runoutChoice ? `Runout: ${runoutChoice === 1 ? 'once' : `up to ${runoutChoice}`}` : 'Runout: pending'
                : folded ? 'Folded' : player.stack === 0 && player.hand && active ? 'ALL IN' : player.sittingOut ? 'Sitting out' : player.hand?.lastAction || (player.stack === 0 ? 'Awaiting buy-in' : player.bot ? 'Practice bot' : 'Ready')}</span>
            }
          </div>
          {!!player.hand?.streetBet && hand?.street !== 'complete' && <div className="seat-bet"><span className="mini-chip" />{chips(player.hand.streetBet)}</div>}
          {emote && <div key={emote.id} className="seat-emote-bubble" role="status" aria-label={`${player.name} says ${EMOTES[emote.emote]}`}>{EMOTES[emote.emote]}</div>}
        </> : <div className="empty-seat"><span>+</span><small>OPEN SEAT</small></div>}
      </div>;
    })}
    {menu && menuPlayer && room.status === 'open' && <EmoteMenu anchor={menu.anchor} own={menu.playerId === room.youId}
      name={menuPlayer.name} muted={mutedEmotes.has(menu.playerId)} disabled={emoteDisabled}
      sending={emoteSending} cooldownUntil={emoteCooldownUntil} error={emoteError} send={onEmote}
      toggleMute={() => onToggleMute(menu.playerId)} close={closeMenu} />}
  </div>;
});

function TurnClock({ deadline, timeOffset, paused, turnSeconds }: {
  deadline: number | null; timeOffset: number; paused: boolean; turnSeconds: number;
}) {
  const remaining = useCountdown(paused ? null : deadline, timeOffset) ?? 0;
  return <><span className="seat-action acting-label">{paused ? 'Turn paused' : `${remaining}s to act`}</span>
    <span className="turn-progress" style={{ width: `${Math.min(100, remaining / turnSeconds * 100)}%` }} /></>;
}
