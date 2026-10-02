import type { CSSProperties } from 'react';
import { Bot, Pause, Crown, WifiOff, Spade } from 'lucide-react';
import { GAME_LABELS, chips, handGameLabel, isLegacyIndianHand, type RoomView } from '../shared/model';
import { ChipStack, CommunityBoards, PlayingCard } from './ui';

export function PokerTable({ room, now }: { room: RoomView; now: number }) {
  const hand = room.hand;
  const hero = room.players.find(player => player.id === room.youId)!;
  const game = hand?.rules.game ?? room.nextHandRules.game;
  const indian = game === 'indian';
  const active = !!hand && hand.street !== 'complete';
  const legacyIndian = !!hand && isLegacyIndianHand(hand);
  const hiddenOwn = indian && active && !!hero.hand && !hero.hand.folded;
  const vote = active ? hand.runoutVote : null;
  const seats = Array.from({ length: room.settings.maxSeats }, (_, seat) => {
    const relative = (seat - (hero.seat ?? 0) + room.settings.maxSeats) % room.settings.maxSeats;
    const angle = Math.PI / 2 + relative * Math.PI * 2 / room.settings.maxSeats;
    return { seat, x: 50 + Math.cos(angle) * 42, y: 48 + Math.sin(angle) * 39 };
  });
  const winners = new Set(hand?.results.flatMap(result => result.winners));
  const remaining = hand?.deadline ? Math.max(0, Math.ceil((hand.deadline - now) / 1000)) : 0;
  const winnerNames = room.players.filter(player => winners.has(player.id)).map(player => player.name).join(' & ');
  const streetName = hand?.street === 'complete' ? 'HAND COMPLETE' : vote ? 'RUNOUT DECISION'
    : legacyIndian ? 'LEGACY ONE-CARD BETTING' : hand?.street?.toUpperCase() ?? 'THE NIGHT IS YOUNG';

  return <div role="region" className={`table-stage ${hand?.boards.length === 2 ? 'table-double-board' : ''} ${indian ? 'table-indian' : ''} ${room.paused ? 'table-is-paused' : ''}`} aria-label="Poker table">
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
    {seats.map(({ seat, x, y }) => {
      const player = room.players.find(item => item.seat === seat);
      const turn = !!player && active && hand.actorId === player.id && !vote;
      const isYou = player?.id === room.youId;
      const folded = player?.hand?.folded;
      const runoutEligible = !!player && !!vote?.eligible.includes(player.id);
      const runoutChoice = player ? vote?.votes[player.id] : undefined;
      return <div key={seat} className={`seat ${isYou ? 'hero-seat' : ''} ${player?.cards.length === 4 ? 'four-card-seat' : ''} ${turn ? 'seat-active' : ''} ${folded ? 'seat-folded' : ''} ${player && winners.has(player.id) ? 'seat-winner' : ''}`}
        style={{ '--seat-x': `${x}%`, top: `${y}%`, '--seat-color': ['#7973aa', '#368b7c', '#aa785b', '#64799c', '#987947', '#8a6795', '#678c9c', '#839360', '#a2697d'][seat] } as CSSProperties}>
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
          <div className="seat-panel"><span className="seat-name">{player.name}{isYou && <small> YOU</small>}</span>
            <strong className="seat-stack">{chips(player.stack)}</strong>
            <span className={`seat-action ${turn ? 'acting-label' : ''}`}>{room.status === 'closed' ? 'Cashed out' : turn ? room.paused ? 'Turn paused' : `${remaining}s to act`
              : runoutEligible ? runoutChoice ? `Runout: ${runoutChoice === 1 ? 'once' : `up to ${runoutChoice}`}` : 'Runout: pending'
                : folded ? 'Folded' : player.stack === 0 && player.hand && active ? 'ALL IN' : player.sittingOut ? 'Sitting out' : player.hand?.lastAction || (player.stack === 0 ? 'Awaiting buy-in' : player.bot ? 'Practice bot' : 'Ready')}</span>
            {turn && <span className="turn-progress" style={{ width: `${Math.min(100, remaining / room.settings.turnSeconds * 100)}%` }} />}
          </div>
          {!!player.hand?.streetBet && hand?.street !== 'complete' && <div className="seat-bet"><span className="mini-chip" />{chips(player.hand.streetBet)}</div>}
        </> : <div className="empty-seat"><span>+</span><small>OPEN SEAT</small></div>}
      </div>;
    })}
  </div>;
}
