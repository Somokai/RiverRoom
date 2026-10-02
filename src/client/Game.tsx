import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { io } from 'socket.io-client';
import { ArrowLeft, ArrowRight, ArrowUpRight, Bot, Check, CheckCheck, ChevronDown, Copy, Crown, Download, HandCoins, History, LoaderCircle, LogOut, MessageSquare, Pause, Play, Plus, ReceiptText, Send, Settings2, ShieldCheck, Smile, Users, Volume2, VolumeX, Wifi, WifiOff, X } from 'lucide-react';
import { api, ApiError, getRoom, submit } from './api';
import { BountyNotice, Brand, Modal, Numeric, PlayerName, bountyLabel, ruleSummary, runLabel, signedChips } from './ui';
import { PokerTable } from './Table';
import { Records } from './Records';
import { EmojiPicker } from './EmojiPicker';
import { GAME_LABELS, chips, handAnte, handGameLabel, isLegacyIndianHand, money, presetRaise, type Command, type GameVariant, type HandRules, type Identity, type RoomView, type RunoutCount } from '../shared/model';

export function Game({ initialRoom, user, onHome, onSessionExpired }: {
  initialRoom: RoomView; user: Identity; onHome: () => void; onSessionExpired: () => void;
}) {
  const [room, setRoom] = useState(initialRoom);
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [clock, setClock] = useState(Date.now());
  const [timeOffset, setTimeOffset] = useState(initialRoom.serverTime - Date.now());
  const [panel, setPanel] = useState<'players' | 'chat'>('players');
  const [modal, setModal] = useState<'fund' | 'bot-fund' | 'settings' | 'invite' | 'cashout' | 'close' | 'transfer' | 'ledger' | 'hands' | 'audit' | 'emoji' | null>(null);
  const [amount, setAmount] = useState(initialRoom.settings.bigBlind * 3);
  const [funding, setFunding] = useState(initialRoom.settings.minBuyIn);
  const [botTargetId, setBotTargetId] = useState('');
  const [chat, setChat] = useState('');
  const [draftSettings, setDraftSettings] = useState(initialRoom.settings);
  const [hostTarget, setHostTarget] = useState('');
  const [copied, setCopied] = useState(false);
  const [sound, setSound] = useState(false);
  const sending = useRef(false);
  const expired = useRef(onSessionExpired);
  expired.current = onSessionExpired;
  const lastTurn = useRef('');
  const audio = useRef<AudioContext | null>(null);
  const chatEnd = useRef<HTMLDivElement>(null);
  const requestStates = useRef(new Map(initialRoom.requests.map(request => [request.id, request.status])));
  const acceptRoom = useCallback((next: RoomView) => {
    setRoom(previous => next.id !== previous.id || next.version >= previous.version ? next : previous);
    setTimeOffset(next.serverTime - Date.now());
  }, []);
  useEffect(() => acceptRoom(initialRoom), [initialRoom, acceptRoom]);
  const refresh = useCallback(async () => {
    try { acceptRoom((await getRoom(initialRoom.id)).room); }
    catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) expired.current();
      else setError(reason instanceof Error ? reason.message : 'Unable to refresh your table.');
    }
  }, [initialRoom.id, acceptRoom]);
  useEffect(() => {
    const socket = io({ auth: { csrf: user.csrf }, reconnection: true, reconnectionDelay: 800, reconnectionDelayMax: 4000 });
    socket.on('connect', () => {
      socket.emit('subscribe', initialRoom.id, (response: { ok: boolean; error?: string }) => {
        setConnected(response.ok);
        if (!response.ok) setError(response.error ?? 'Unable to subscribe to the table.');
      });
    });
    socket.on('room', (next: RoomView) => acceptRoom(next));
    socket.on('disconnect', () => setConnected(false));
    socket.on('connect_error', (reason: Error) => {
      setConnected(false);
      if (reason.message === 'Session expired.') expired.current();
    });
    socket.on('server_error', (message: string) => setError(message));
    const interval = setInterval(() => void refresh(), 15000);
    const visibility = () => { if (document.visibilityState === 'visible') void refresh(); };
    document.addEventListener('visibilitychange', visibility);
    return () => { socket.disconnect(); clearInterval(interval); document.removeEventListener('visibilitychange', visibility); };
  }, [initialRoom.id, user.csrf, acceptRoom, refresh]);
  useEffect(() => { const interval = setInterval(() => setClock(Date.now()), 250); return () => clearInterval(interval); }, []);
  useEffect(() => { if (notice) { const timer = setTimeout(() => setNotice(''), 4500); return () => clearTimeout(timer); } }, [notice]);
  useEffect(() => { chatEnd.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, [room.events.length, room.events.at(-1)?.id, panel]);
  const hero = room.players.find(player => player.id === user.id)!;
  const isHost = room.hostId === user.id;
  const hand = room.hand;
  const activeHand = !!hand && hand.street !== 'complete';
  const displayedRules = hand?.rules ?? room.nextHandRules;
  const runoutVote = activeHand ? hand.runoutVote : null;
  const displayedAnte = handAnte(displayedRules, room.settings);
  const legacyIndian = !!hand && isLegacyIndianHand(hand);
  const legal = room.legal;
  const open = room.status === 'open';
  const now = clock + timeOffset;
  const pending = room.requests.filter(request => request.status === 'pending');
  const ownRequest = room.requests.find(request => request.playerId === user.id && ['pending', 'approved'].includes(request.status));
  useEffect(() => {
    for (const request of room.requests) {
      const prior = requestStates.current.get(request.id);
      if (request.playerId === user.id && request.status === 'declined' && (prior === 'pending' || prior === 'approved'))
        setError(`Your ${chips(request.amount)}-chip request was declined or could not be applied. Check the table journal for details.`);
      requestStates.current.set(request.id, request.status);
    }
  }, [room.requests, user.id]);
  const minRaise = Math.min(legal.minRaiseTo, legal.maxRaiseTo);
  const usableAmount = Math.min(legal.maxRaiseTo, Math.max(minRaise, Number.isFinite(amount) ? Math.round(amount) : minRaise));
  const validRaise = Number.isSafeInteger(amount) && amount >= minRaise && amount <= legal.maxRaiseTo;
  const affordableFunding = Math.max(0, room.settings.maxBuyIn - hero.stack);
  const botTarget = room.players.find(player => player.id === botTargetId && player.bot && player.seat !== null);
  const botFundingCap = Math.max(0, room.settings.maxBuyIn - (botTarget?.stack ?? 0));
  const botFundingMin = botTarget?.stack === 0 ? room.settings.minBuyIn : 1;
  const canRefillBot = isHost && !!botTarget && !activeHand && botFundingCap >= botFundingMin &&
    (botTarget.stack > 0 || botTarget.buyIns === 0 || room.settings.allowRebuys) &&
    !room.requests.some(request => request.playerId === botTarget.id && ['pending', 'approved'].includes(request.status));
  const canDeal = room.players.filter(player => player.seat !== null && !player.sittingOut && player.stack > 0).length >= 2;
  useEffect(() => { setAmount(Math.min(legal.maxRaiseTo, Math.max(legal.minRaiseTo, room.settings.bigBlind * 3))); },
    [hand?.id, hand?.street, hand?.currentBet, hero.stack, room.settings.bigBlind, legal.minRaiseTo, legal.maxRaiseTo]);
  useEffect(() => {
    const key = hand?.actorId === user.id && legal.canAct ? `${hand.id}:${hand.turnStartedAt}` : '';
    if (key && lastTurn.current !== key && sound && audio.current) {
      const oscillator = audio.current.createOscillator(); const gain = audio.current.createGain();
      oscillator.connect(gain); gain.connect(audio.current.destination);
      oscillator.frequency.value = 640; gain.gain.setValueAtTime(0.035, audio.current.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audio.current.currentTime + 0.22);
      oscillator.start(); oscillator.stop(audio.current.currentTime + 0.22);
    }
    lastTurn.current = key;
  }, [hand?.actorId, hand?.turnStartedAt, legal.canAct, sound, user.id]);
  useEffect(() => () => { void audio.current?.close(); }, []);

  async function command(value: Command): Promise<boolean> {
    if (sending.current) return false;
    sending.current = true; setBusy(true); setError('');
    try { acceptRoom((await submit(room, value)).room); return true; }
    catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Your action could not be submitted.');
      if (reason instanceof ApiError && reason.status === 401) expired.current();
      else await refresh();
      return false;
    } finally { sending.current = false; setBusy(false); }
  }
  const doAct = (action: 'fold' | 'check' | 'call' | 'raise', raise?: number) => void command({ type: 'act', action, ...(raise !== undefined ? { amount: raise } : {}) });
  function openFunding() {
    setFunding(Math.min(affordableFunding, hero.stack === 0 ? Math.max(room.settings.minBuyIn, room.settings.bigBlind * 100) : room.settings.bigBlind * 20));
    setModal('fund');
  }
  function openBotFunding(playerId: string) {
    const player = room.players.find(item => item.id === playerId);
    if (!isHost || !player?.bot || player.seat === null) return;
    setBotTargetId(playerId);
    setFunding(Math.min(room.settings.maxBuyIn - player.stack,
      player.stack === 0 ? Math.max(room.settings.minBuyIn, room.settings.bigBlind * 100) : room.settings.bigBlind * 20));
    setModal('bot-fund');
  }
  async function copy(text: string) {
    try { await navigator.clipboard.writeText(text); setCopied(true); setNotice('Copied to clipboard.'); }
    catch { setError('Clipboard unavailable. Select the invite code and copy it manually.'); }
  }
  const addBot = () => void command({ type: 'add_bot' });
  const disable = busy || !connected || !open;
  const openEmoji = () => { setError(''); setModal('emoji'); };
  function soundToggle() {
    if (!sound) {
      audio.current ??= new AudioContext();
      void audio.current.resume().catch(() => setError('Your browser could not enable sound.'));
    }
    setSound(!sound);
  }
  const cashValue = hero.stack * room.settings.chipValueCents;
  const errorBanner = error && <div className="error-banner" role="alert"><span>{error}</span><button className="icon-button" aria-label="Dismiss error" onClick={() => setError('')}><X size={16} /></button></div>;

  return <div className="game-shell">
    <header className="game-nav"><button className="brand-link" aria-label="Back to your sessions" onClick={onHome}><Brand compact /></button>
      <div className="game-nav-center"><span className={`connection-dot ${connected ? '' : 'disconnected'}`} />{connected ? 'LIVE TABLE' : 'RECONNECTING'}</div>
      <div className="nav-right"><button className={`icon-button ${sound ? 'sound-enabled' : ''}`} aria-label={sound ? 'Mute turn sounds' : 'Enable turn sounds'} onClick={soundToggle}>{sound ? <Volume2 size={18} /> : <VolumeX size={18} />}</button>
        {open ? <button type="button" className="profile-chip profile-emoji-button" aria-label="Choose table emoji" aria-haspopup="dialog"
          title="Choose table emoji" disabled={disable} onClick={openEmoji}>
          <span className="avatar small-avatar">{user.name.slice(0, 1).toUpperCase()}</span><PlayerName player={hero} />{!hero.emoji && <Smile size={17} />}</button>
          : <span className="profile-chip"><span className="avatar small-avatar">{user.name.slice(0, 1).toUpperCase()}</span><PlayerName player={hero} /></span>}
        <button className="text-button lobby-link" onClick={onHome}><ArrowLeft size={16} /> Lobby</button></div></header>
    <main className="game-main">
      <div className="table-title-row"><div><span className="eyebrow">{open ? 'PRIVATE CASH TABLE' : 'COMPLETED SESSION'} <span className="muted">/</span> {(hand ? handGameLabel(hand) : GAME_LABELS[displayedRules.game]).toUpperCase()}</span><h1>{room.name}{isHost && <span className="host-label"><Crown size={12} /> HOST</span>}</h1></div>
        <div className="table-title-actions"><button className="button button-small button-outline" onClick={() => { setCopied(false); setModal('invite'); }}><Users size={15} /> Invite friends</button>
          {isHost && open && <button className="button button-small button-outline" aria-label="House rules" onClick={() => { setDraftSettings({ ...room.settings, ...room.pendingBlinds }); setModal('settings'); }}><Settings2 size={16} /><span className="label-hide-mobile">House rules</span></button>}</div></div>
      {errorBanner}
      {!connected && <div className="connection-banner"><WifiOff size={15} /> Reconnecting to the table. Your chips are saved; actions are locked until the live connection returns.</div>}
      {room.endAfterHand && <div className="info-banner">This is the final hand. All stacks will be cashed out when it finishes.</div>}
      {ownRequest && <div className="info-banner"><HandCoins size={16} /> {chips(ownRequest.amount)} chips {ownRequest.status === 'approved' ? 'approved; they will arrive after this hand.' : 'requested. Waiting for host approval.'}</div>}
      <div className="game-columns"><section className="table-column">
        <div className="table-meta"><span><span className="tiny-dot" /> {room.players.filter(player => player.seat !== null).length}/{room.settings.maxSeats} seated</span>
          {displayedRules.game === 'omaha_bomb' || legacyIndian
            ? <span>{displayedRules.game === 'omaha_bomb' ? 'Bomb ante' : 'Ante'} <b>{chips(displayedAnte)}</b> / No blinds</span>
            : <span>Blinds <b>{chips(room.settings.smallBlind)} / {chips(room.settings.bigBlind)}</b>{displayedAnte > 0 && <> <span className="middot">/</span> Ante {chips(displayedAnte)}</>}</span>}
          <span>Hand <b>#{room.handNumber.toString().padStart(3, '0')}</b></span></div>
        <PokerTable room={room} now={now} onChooseEmoji={open ? openEmoji : undefined} emojiDisabled={disable} />
        <div className={`action-console ${legal.canAct && !runoutVote ? 'your-turn' : ''}`}>
          <div className="action-heading"><span className={`turn-heading ${legal.canAct && !runoutVote ? 'positive' : ''}`}>{!open ? 'SESSION COMPLETE' : runoutVote ? 'RUNOUT CONSENT' : room.paused ? 'THE TABLE IS PAUSED' : legal.canAct ? 'YOUR MOVE' : activeHand ? `WAITING FOR ${room.players.find(player => player.id === hand.actorId)?.name.toUpperCase() ?? 'THE TABLE'}` : 'BETWEEN HANDS'}</span>
            <span className="muted">{!open ? 'Your final results are in the ledger.' : runoutVote ? room.paused ? 'Decision paused; submitted choices are saved.' : 'Betting is over. Decide before the cards run out.'
              : activeHand ? legal.canAct ? `${chips(legal.callAmount)} to call` : hero.sittingOut ? 'You will sit out the next hand.' : 'A little patience. A good hand is worth it.' : room.nextHandAt && !room.paused && canDeal ? `Next hand in ${Math.max(0, Math.ceil((room.nextHandAt - now) / 1000))}s` : 'Ready when you are.'}</span></div>
          {runoutVote && hand ? <RunoutDecision room={room} hand={hand} now={now} disabled={disable} error={error}
            choose={count => command({ type: 'runouts', handId: hand.id, count })} /> : activeHand ? <>
            {hand.rules.game !== 'holdem' && <p className="variant-guidance">{hand.rules.game === 'indian'
              ? legacyIndian ? 'This saved one-card Indian hand finishes under its original rules. New Indian deals use two cards and normal Hold\u2019em betting.'
                : <>Your two cards are intentionally hidden from you, not a connection problem. Everyone else's cards are visible. Play normal Hold'em: blinds, preflop, flop, turn and river.
                  {' '}{hero.hand?.folded ? 'You folded, so your own cards are now revealed to you.' : 'Your own cards are revealed when you fold or the hand ends.'}</>
              : <><b>Exactly 2 + 3:</b> use exactly two of your four private cards and three from one board.{hand.rules.game === 'omaha_bomb' && ' Two flops are dealt immediately after the bomb ante; no preflop betting or blinds. Each board awards its own share.'}</>}</p>}
            <div className="bet-sizing"><div className="presets"><span className="preset-label">POT</span>{[0.5, 0.75, 1].map((fraction, index) => <button key={fraction} aria-label={['Half pot', 'Three-quarter pot', 'Full pot'][index]}
              disabled={disable || !legal.canRaise} className="preset-button" onClick={() => setAmount(presetRaise(legal, hero.hand?.streetBet ?? 0, room.settings.bigBlind, { pot: fraction }))}>{['\u00bd', '\u00be', '1\u00d7'][index]}</button>)}
              <span className="preset-divider" /><span className="preset-label">BB</span>{[2, 2.5, 3, 4].map(multiplier => <button key={multiplier} disabled={disable || !legal.canRaise} className={`preset-button ${amount === multiplier * room.settings.bigBlind ? 'preset-selected' : ''}`}
                aria-label={`${multiplier} times big blind`} onClick={() => setAmount(presetRaise(legal, hero.hand?.streetBet ?? 0, room.settings.bigBlind, { bb: multiplier }))}>{multiplier}&times;</button>)}</div>
              <label className="raise-input"><span>{hand.currentBet === 0 ? 'BET' : 'RAISE TO'}</span><input aria-label="Raise-to amount" aria-invalid={legal.canRaise && !validRaise} aria-describedby="betting-limits"
                type="number" inputMode="numeric" min={minRaise} max={legal.maxRaiseTo} step={1} value={Number.isFinite(amount) ? amount : ''} disabled={disable || !legal.canRaise} onChange={event => setAmount(event.target.value === '' ? Number.NaN : Number(event.target.value))} /></label></div>
            <input className="bet-slider" aria-label="Raise amount slider" type="range" min={minRaise || 0} max={Math.max(minRaise, legal.maxRaiseTo)} value={usableAmount || 0} step={1} disabled={disable || !legal.canRaise} onChange={event => setAmount(Number(event.target.value))} />
            <div className="action-buttons"><button className="button button-fold" disabled={disable || !legal.canAct} onClick={() => doAct('fold')}>Fold</button>
              <button className="button button-call" disabled={disable || !legal.canAct} onClick={() => doAct(legal.canCheck ? 'check' : 'call')}>{legal.canCheck ? <><CheckCheck size={18} /> Check</> : <>Call <strong>{chips(legal.callAmount)}</strong>{legal.callAmount === hero.stack && legal.callAmount > 0 && <small>ALL IN</small>}</>}</button>
              <button className="button button-raise" disabled={disable || !legal.canRaise || !validRaise} onClick={() => { if (validRaise) doAct('raise', amount); }}>{hand.currentBet === 0 ? 'Bet' : 'Raise to'} <strong>{validRaise ? chips(amount) : '—'}</strong><ArrowUpRight size={17} /></button>
              <button className="button button-allin" disabled={disable || !legal.canAct || !legal.canAllIn}
                aria-describedby="betting-limits" onClick={() => legal.callAmount >= hero.stack ? doAct('call') : doAct('raise', legal.allInTo)}>All in</button></div>
            <p className="sizing-note" id="betting-limits">{legal.canRaise && !validRaise && <span className="negative">Enter a whole-chip total from {chips(minRaise)} to {chips(legal.maxRaiseTo)}. </span>}
              Amounts are total bets for this street. Pot presets include the call; BB presets and sliders respect the server's legal limits.
              {legal.bettingLimit === 'pot_limit' && <span className="limit-explanation">Pot-limit raise-to cap: <b>{chips(legal.maxRaiseTo)}</b> (pot cap {chips(legal.potLimitTo ?? legal.maxRaiseTo)}, including the call).
                {legal.canAct && !legal.canAllIn && legal.allInTo > legal.maxRaiseTo && <> Your full-stack total is {chips(legal.allInTo)}; All in is unavailable above the pot limit.</>}
                {hand.street === 'preflop' && ' Short preflop blinds count as nominal full blinds when calculating the pot limit.'}</span>}</p>
          </> : <div className="between-actions">{open ? <>
            {isHost && <button className="button button-gold" disabled={disable || !canDeal || room.paused} onClick={() => void command({ type: 'deal' })}><Play size={17} /> {room.handNumber ? 'Deal next hand' : 'Deal first hand'}</button>}
            {hero.seat === null ? <button className="button button-outline" disabled={disable} onClick={() => {
              setBusy(true); void api<{ room: RoomView }>('/rooms/join', { code: room.code, commandId: crypto.randomUUID() }).then(result => acceptRoom(result.room)).catch(reason => setError(reason.message)).finally(() => setBusy(false));
            }}>Take a seat again <Plus size={17} /></button> : <button className="button button-outline" disabled={disable || !!ownRequest || affordableFunding <= 0 || (hero.stack === 0 && hero.buyIns > 0 && !room.settings.allowRebuys)} onClick={openFunding}><HandCoins size={18} /> {hero.stack === 0 ? hero.buyIns ? 'Rebuy chips' : 'Buy in' : 'Add chips'}</button>}
            {isHost && room.players.filter(player => player.seat !== null).length < room.settings.maxSeats && <button className="button button-outline" disabled={disable} onClick={addBot}><Bot size={18} /> Add practice bot</button>}
          </> : <><button className="button button-gold" onClick={() => setModal('ledger')}><ReceiptText size={18} /> View final ledger</button><button className="button button-outline" onClick={onHome}>Back to sessions <ArrowRight size={17} /></button></>}</div>}
        </div>
        {hand?.bounty && <BountyNotice bounty={hand.bounty} room={room} />}
        <div className="table-footer"><span><ShieldCheck size={13} /> Server-dealt. Privately held. Every chip recorded.</span><div>
          {open && hero.seat !== null && <button className="text-button" disabled={disable} onClick={() => void command({ type: 'sit_out', value: !hero.sittingOut })}>{hero.sittingOut ? <Play size={14} /> : <Pause size={14} />}{hero.sittingOut ? 'Sit back in' : 'Sit out'}</button>}
          {isHost && open && <button className="text-button" disabled={disable} onClick={() => void command({ type: 'pause', value: !room.paused })}>{room.paused ? 'Resume table' : 'Pause table'}</button>}</div></div>
        <NextHandPanel room={room} disabled={disable} error={error} save={async rules => {
          const ok = await command({ type: 'next_hand', rules });
          if (ok) setNotice('Next-hand rules saved. This selection stays until changed; any current hand is unchanged.');
          return ok;
        }} />
      </section>
      <aside className="game-sidebar">
        <section className="bankroll-card"><div className="bankroll-title"><span>YOUR SESSION</span><span>{money(room.settings.chipValueCents, room.settings.currency)} / chip</span></div>
          <div className="bankroll-main"><div><small>AT THE TABLE</small><strong>{chips(hero.stack)}<span> chips</span></strong><span className="muted">{money(cashValue, room.settings.currency)} recorded value</span></div>
            <span className={`net-badge ${hero.net >= 0 ? 'positive' : 'negative'}`}>{signedChips(hero.net)}<small>TOTAL P/L*</small></span></div>
          <div className="bankroll-details"><span>Buy-ins <b>{chips(hero.buyIns)}</b></span><span>Cashed out <b>{chips(hero.cashOuts)}</b></span><span>In this pot <b>{activeHand ? chips(hero.hand?.committed ?? 0) : '0'}</b></span>
            <span>Chip P/L <b className={hero.chipNet >= 0 ? 'positive' : 'negative'}>{signedChips(hero.chipNet)}</b></span>
            <span>{bountyLabel(hero.bountyNet)} <b className={hero.bountyNet >= 0 ? 'positive' : 'negative'}>{chips(Math.abs(hero.bountyNet))} eq.</b></span></div>
          <p className="balance-note">*Chip P/L plus off-table bounty balance ({money(Math.abs(hero.bountyNet) * room.settings.chipValueCents, room.settings.currency)} {hero.bountyNet < 0 ? 'owed' : 'receivable'}).
            {' '}Bounties are not table chips, cash-outs, or paid debts.</p>
          <div className="bankroll-actions"><button className="button button-small button-outline" disabled={disable || hero.seat === null || !!ownRequest || affordableFunding <= 0 || (hero.stack === 0 && hero.buyIns > 0 && !room.settings.allowRebuys)} onClick={openFunding}><Plus size={15} /> Add / rebuy</button>
            <button className="button button-small button-outline" disabled={disable || activeHand || hero.seat === null} onClick={() => setModal('cashout')}><LogOut size={14} /> Cash out</button></div></section>
        {isHost && pending.length > 0 && <section className="approvals"><div className="section-heading"><h3>Chip requests</h3><span className="count-badge">{pending.length}</span></div>
          {pending.map(request => <div key={request.id} className="approval-row"><div><strong>{room.players.find(player => player.id === request.playerId)?.name}</strong><small>{chips(request.amount)} chips / {money(request.amount * room.settings.chipValueCents, room.settings.currency)} / {request.kind.replaceAll('_', ' ')}</small></div>
            <button className="icon-button approve-button" aria-label={`Approve ${room.players.find(player => player.id === request.playerId)?.name}`} disabled={disable} onClick={() => void command({ type: 'approve', requestId: request.id, approve: true })}><Check size={17} /></button>
            <button className="icon-button" aria-label="Decline request" disabled={disable} onClick={() => void command({ type: 'approve', requestId: request.id, approve: false })}><X size={16} /></button></div>)}
          <p className="form-note">Approval records the funding. No money is transferred.</p></section>}
        <section className="table-panel"><nav className="panel-tabs"><button className={panel === 'players' ? 'tab-active' : ''} onClick={() => setPanel('players')}><Users size={16} /> Players</button>
          <button className={panel === 'chat' ? 'tab-active' : ''} onClick={() => setPanel('chat')}><MessageSquare size={16} /> Table talk</button></nav>
          {panel === 'players' ? <div className="player-list">{room.players.map(player => <div className={`player-row ${player.id === user.id ? 'player-row-you' : ''}`} key={player.id}>
            <span className="avatar list-avatar">{player.bot ? <Bot size={16} /> : player.name.slice(0, 1).toUpperCase()}</span>
            <div className="player-details"><strong><PlayerName player={player} />{player.id === room.hostId && <Crown size={11} />}{player.id === user.id && <small>YOU</small>}</strong><span><i className={`connection-dot ${player.connected ? '' : 'disconnected'}`} />{player.bot ? 'Virtual bot' : player.seat === null ? 'Cashed out' : player.sittingOut ? 'Sitting out' : player.connected ? 'Connected' : 'Away'}</span>
              {isHost && player.bot && player.seat !== null && open && <button className="text-button bot-refill" aria-label={`Refill ${player.name} with virtual chips`}
                disabled={disable || activeHand || player.stack >= room.settings.maxBuyIn || (player.stack === 0 && player.buyIns > 0 && !room.settings.allowRebuys) ||
                  room.requests.some(request => request.playerId === player.id && ['pending', 'approved'].includes(request.status))}
                onClick={() => openBotFunding(player.id)}><Plus size={11} /> Refill virtual chips</button>}</div>
            <div className="player-money"><strong>{chips(player.stack)}</strong><small className={player.chipNet >= 0 ? 'positive' : 'negative'}>Chip P/L {signedChips(player.chipNet)}</small>
              <small className={player.bountyNet < 0 ? 'negative' : 'muted'}>{bountyLabel(player.bountyNet)} {chips(Math.abs(player.bountyNet))} eq.</small>
              <small className={player.net >= 0 ? 'positive' : 'negative'}>Total {signedChips(player.net)}</small></div>
            {isHost && player.bot && player.seat !== null && !activeHand && open && <button className="icon-button remove-bot" aria-label={`Remove ${player.name}`} disabled={disable} onClick={() => void command({ type: 'remove_bot', playerId: player.id })}><X size={13} /></button>}
          </div>)}{room.players.some(player => player.bot && player.seat !== null) && <p className="form-note">Practice chips are virtual. {isHost && 'Refill bots between hands. '}Sit out to watch two or more funded bots; sit back in to play.</p>}</div> : <><div className="chat-log" aria-live="polite" aria-relevant="additions">{room.events.map(event => <div key={event.id} className={`chat-event ${event.kind === 'chat' ? 'chat-message' : ''} ${event.actorId === user.id ? 'own-message' : ''}`}>
            <time>{new Date(event.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time><p>{event.message}</p></div>)}<div ref={chatEnd} /></div>
            <form className="chat-form" onSubmit={event => { event.preventDefault(); if (chat.trim()) void command({ type: 'chat', message: chat }).then(ok => { if (ok) setChat(''); }); }}>
              <input aria-label="Message the table" placeholder="Say something to the table..." maxLength={240} value={chat} onChange={event => setChat(event.target.value)} disabled={!open} /><button aria-label="Send message" disabled={disable || !chat.trim()}><Send size={17} /></button></form></>}
        </section>
        <section className="session-tools"><span className="eyebrow">THE PAPER TRAIL</span><button onClick={() => setModal('ledger')}><ReceiptText size={17} /><span>Session ledger<small>Chip transfers & off-table bounties</small></span><ArrowUpRight size={16} /></button>
          <button onClick={() => setModal('hands')}><History size={17} /><span>Hand history<small>Every completed hand</small></span><ArrowUpRight size={16} /></button>
          <button onClick={() => setModal('audit')}><ShieldCheck size={17} /><span>Full audit journal<small>Hash-linked, exportable records</small></span><ArrowUpRight size={16} /></button></section>
        <div className="sidebar-note">A home game, not a payment service.<br />Settle recorded balances outside the app.</div>
      </aside></div>
    </main>
    {notice && <div className="toast" role="status"><Check size={16} />{notice}</div>}
    {modal === 'emoji' && <EmojiPicker value={hero.emoji} disabled={disable}
      error={error || (!open ? 'This session is closed.' : !connected ? 'Reconnect to change your table emoji.' : '')}
      close={() => { if (!sending.current) setModal(null); }} choose={async emoji => {
        const ok = await command({ type: 'emoji', emoji });
        if (ok) setNotice(emoji ? 'Table emoji updated.' : 'Table emoji removed.');
        return ok;
      }} />}
    {(modal === 'ledger' || modal === 'hands' || modal === 'audit') && <Records room={room} tab={modal} close={() => setModal(null)} />}
    {modal && !['ledger', 'hands', 'audit', 'emoji'].includes(modal) && <Modal
      title={{ fund: hero.stack === 0 ? hero.buyIns ? 'Back in the game.' : 'Bring your chips.' : 'A little more room to play.', 'bot-fund': 'Refill virtual practice chips.', settings: 'Your house. Your rules.', invite: 'Save a seat for your people.', cashout: 'Call it a night?', close: 'Wrap up this session?', transfer: 'Pass the host button.' }[modal as 'fund' | 'bot-fund' | 'settings' | 'invite' | 'cashout' | 'close' | 'transfer']}
      close={() => { if (!busy) setModal(null); }}>
      {errorBanner}
      {modal === 'fund' && <form onSubmit={event => { event.preventDefault(); void command({ type: 'fund', amount: funding }).then(ok => { if (ok) { setModal(null); setNotice(isHost ? activeHand ? 'Funding approved for after this hand.' : 'Your chips have arrived.' : 'Funding request sent to the host.'); } }); }}>
        <p className="form-note">{isHost ? 'Your funding is approved automatically.' : 'The host must approve your request.'} {activeHand ? 'New chips enter play after this hand ends.' : 'Approved chips are available immediately.'}</p>
        <Numeric label="Chips to add" value={funding} onChange={setFunding} min={hero.stack === 0 ? room.settings.minBuyIn : 1} max={affordableFunding} />
        <div className="funding-presets">{[20, 50, 100].map(bb => <button type="button" className="preset-button" key={bb} disabled={room.settings.bigBlind * bb > affordableFunding || (hero.stack === 0 && room.settings.bigBlind * bb < room.settings.minBuyIn)} onClick={() => setFunding(room.settings.bigBlind * bb)}>{bb} BB</button>)}</div>
        <div className="funding-total"><span>Recorded amount</span><strong>{money((Number.isFinite(funding) ? funding : 0) * room.settings.chipValueCents, room.settings.currency)}</strong><small>No payment is collected by the app.</small></div>
        <button className="button button-gold full-width" disabled={disable || !Number.isInteger(funding)}><HandCoins size={18} />{isHost ? 'Add chips to my session' : 'Request host approval'}</button></form>}
      {modal === 'bot-fund' && <form onSubmit={event => {
        event.preventDefault();
        if (!botTarget || !canRefillBot || !Number.isSafeInteger(funding) || funding < botFundingMin || funding > botFundingCap) return;
        void command({ type: 'fund_bot', playerId: botTarget.id, amount: funding }).then(ok => {
          if (ok) { setModal(null); setNotice(`Virtual chips added to ${botTarget.name} and recorded in the ledger.`); }
        });
      }}>
        <p><b>{botTarget?.name ?? 'This bot'}</b> has {chips(botTarget?.stack ?? 0)} virtual chips. This refill records a {botTarget?.stack === 0 ? 'rebuy' : 'virtual add-on'} in the session ledger and audit journal.</p>
        <p className="form-note">Host-only, between hands. Normal buy-in limits and rebuy rules apply. No real money, payments, or prizes are involved.</p>
        {activeHand && <div className="info-banner">Wait for the current hand to finish before refilling a bot.</div>}
        <Numeric label="Virtual chips to add" value={funding} onChange={setFunding} min={botFundingMin} max={botFundingCap} />
        <div className="funding-total"><span>Virtual practice funding</span><strong>{chips(Number.isFinite(funding) ? funding : 0)} chips</strong><small>Every refill is recorded; no chips are added automatically.</small></div>
        <button className="button button-gold full-width" disabled={disable || !canRefillBot || !Number.isSafeInteger(funding) || funding < botFundingMin || funding > botFundingCap}><Bot size={18} /> Confirm virtual refill</button>
      </form>}
      {modal === 'invite' && <><p className="form-note">Share this invite with people you want at your table. They create a player profile and request their own buy-in.</p>
        <div className="invite-code">{room.code}</div><button className="button button-gold full-width" onClick={() => void copy(`${location.origin}/?join=${room.code}`)}>{copied ? <Check size={17} /> : <Copy size={17} />}{copied ? 'Invite copied' : 'Copy invite link'}</button>
        <button className="text-button center-button" onClick={() => void copy(room.code)}>Copy just the code</button></>}
      {modal === 'cashout' && <><p>You will cash out <b>{chips(hero.stack)} chips</b> ({money(cashValue, room.settings.currency)} recorded value) and release your seat. Your complete session history stays available.</p>
        <p className="form-note">The ledger records a cash-out; it does not send a payment. You can rejoin with the same invite code.</p>
        <p className="form-note">{bountyLabel(hero.bountyNet)}: {chips(Math.abs(hero.bountyNet))} chips equivalent. This separate balance is not included in your cash-out and is not marked paid.</p>
        <button className="button button-gold full-width" disabled={disable || activeHand} onClick={() => void command({ type: 'cash_out' }).then(ok => { if (ok) setModal(null); })}>Confirm cash-out <LogOut size={17} /></button></>}
      {modal === 'close' && <><p>{activeHand ? 'The current hand will finish normally. Then' : 'Immediately,'} all remaining stacks will be cashed out to the ledger and this session will become read-only.</p><p className="form-note">This cannot be undone. You can create a new table for your next session.</p>
        <p className="form-note">Off-table bounty balances remain separate. Closing the session does not settle or pay them.</p>
        <button className="button button-danger full-width" disabled={disable} onClick={() => void command({ type: 'close' }).then(ok => { if (ok) setModal(null); })}>{activeHand ? 'Close after this hand' : 'Close and record cash-outs'}</button></>}
      {modal === 'transfer' && <form onSubmit={event => { event.preventDefault(); void command({ type: 'transfer_host', playerId: hostTarget }).then(ok => { if (ok) setModal(null); }); }}>
        <label className="field"><span>New host</span><select required value={hostTarget} onChange={event => setHostTarget(event.target.value)}><option value="">Choose a seated player</option>{room.players.filter(player => !player.bot && player.id !== user.id && player.seat !== null).map(player => <option key={player.id} value={player.id}>{player.name}</option>)}</select></label>
        <p className="form-note">The new host can approve chip requests, change blinds, and close this session. You remain a player.</p><button className="button button-gold full-width" disabled={disable || !hostTarget}>Transfer host privileges <Crown size={17} /></button></form>}
      {modal === 'settings' && <form onSubmit={(event: FormEvent) => { event.preventDefault(); void command({
        type: 'settings', smallBlind: draftSettings.smallBlind, bigBlind: draftSettings.bigBlind, ante: draftSettings.ante,
        autoDeal: draftSettings.autoDeal, turnSeconds: draftSettings.turnSeconds, allowRebuys: draftSettings.allowRebuys,
        minBuyIn: draftSettings.minBuyIn,
      }).then(ok => { if (ok) { setModal(null); setNotice(activeHand ? 'Blind changes take effect next hand.' : 'House rules updated.'); } }); }}>
        <p className="form-note">Blinds and regular antes change between hands. Change game variants in the Next hand panel. Currency, chip value, seat count, and maximum funded stack stay fixed.</p>
        <div className="field-grid"><Numeric label="Small blind" value={draftSettings.smallBlind} min={1} onChange={value => setDraftSettings({ ...draftSettings, smallBlind: value })} />
          <Numeric label="Big blind" value={draftSettings.bigBlind} min={2} onChange={value => setDraftSettings({ ...draftSettings, bigBlind: value })} />
          <Numeric label="Ante" value={draftSettings.ante} max={draftSettings.bigBlind} onChange={value => setDraftSettings({ ...draftSettings, ante: value })} />
          <Numeric label="Turn clock (seconds)" value={draftSettings.turnSeconds} min={15} max={120} onChange={value => setDraftSettings({ ...draftSettings, turnSeconds: value })} />
          <Numeric label="Minimum buy-in" value={draftSettings.minBuyIn} min={1} max={room.settings.maxBuyIn} onChange={value => setDraftSettings({ ...draftSettings, minBuyIn: value })}
            hint={`1–${chips(room.settings.maxBuyIn)} chips. Existing stacks, funding and cash-outs do not change.`} /></div>
        <label className="checkbox"><input type="checkbox" checked={draftSettings.autoDeal} onChange={event => setDraftSettings({ ...draftSettings, autoDeal: event.target.checked })} /> Deal the next hand automatically</label>
        <label className="checkbox"><input type="checkbox" checked={draftSettings.allowRebuys} onChange={event => setDraftSettings({ ...draftSettings, allowRebuys: event.target.checked })} /> Allow rebuys after a player busts</label>
        <button className="button button-gold full-width" disabled={disable || !Number.isSafeInteger(draftSettings.minBuyIn) || draftSettings.minBuyIn < 1 || draftSettings.minBuyIn > room.settings.maxBuyIn}>Save house rules <Check size={17} /></button>
        <div className="host-danger-zone"><button type="button" className="text-button" onClick={() => setModal('transfer')}><Crown size={15} /> Transfer host</button><button type="button" className="text-button negative" onClick={() => setModal('close')}>End session <ArrowRight size={15} /></button></div>
      </form>}
    </Modal>}
  </div>;
}

function RunoutDecision({ room, hand, now, disabled, error, choose }: {
  room: RoomView; hand: NonNullable<RoomView['hand']>; now: number; disabled: boolean; error: string;
  choose: (count: RunoutCount) => Promise<boolean>;
}) {
  const vote = hand.runoutVote;
  if (!vote) return null;
  const ownVote = vote.votes[room.youId];
  const eligible = vote.eligible.includes(room.youId);
  const seconds = vote.deadline === null ? null : Math.max(0, Math.ceil((vote.deadline - now) / 1000));
  const expired = vote.deadline !== null && now >= vote.deadline;
  return <section className="runout-decision" aria-labelledby="runout-heading">
    {error && <div className="error-banner" role="alert">{error}</div>}
    <div className="runout-title"><h2 id="runout-heading">How many times should we run it?</h2>
      <span className={`runout-clock ${room.paused ? 'clock-paused' : ''}`} role="timer" aria-live="off"
        aria-label={room.paused ? 'Runout decision paused' : seconds === null ? 'Runout clock waiting' : `${seconds} seconds to choose`}>
        {room.paused ? <><Pause size={14} /> Paused</> : seconds === null ? 'Clock waiting' : seconds ? `${seconds}s to choose` : 'Resolving choices…'}</span></div>
    <p>All betting has ended due to all-ins. Choices mean <b>up to</b> that many runs; the lowest choice wins.
      {' '}A missing choice after 20 seconds defaults to <b>run once</b>.</p>
    <ul className="runout-players" aria-label="Eligible players">
      {vote.eligible.map(id => {
        const player = room.players.find(item => item.id === id);
        const choice = vote.votes[id];
        return <li key={id}><span>{player?.bot && <Bot size={13} />}{player ? <PlayerName player={player} /> : id}{id === room.youId && <small>YOU</small>}</span>
          <strong className={choice ? 'positive' : 'muted'}>{choice ? runLabel(choice) : 'Pending — defaults to once'}</strong></li>;
      })}
    </ul>
    <p className="runout-own-status" role="status">{!eligible ? 'You are observing. Only the eligible players above choose.'
      : ownVote ? `Your choice is submitted: ${runLabel(ownVote).toLowerCase()}. It is retained if the table pauses.`
        : room.paused ? 'Your decision is pending. The clock is paused; choose after the host resumes the table.'
          : expired ? 'The decision clock has ended. Waiting for the server to apply the once fallback.'
            : 'Your decision is pending. Choose your maximum below.'}</p>
    {eligible && <div className="runout-choices">{([1, 2, 3] as const).filter(count => count <= vote.maxRuns).map(count => <button type="button"
      key={count} className={`button ${ownVote === count ? 'button-gold' : 'button-outline'}`} aria-pressed={ownVote === count}
      disabled={disabled || room.paused || expired || ownVote !== undefined} onClick={() => void choose(count)}>
      {ownVote === count && <Check size={16} />}{runLabel(count)}</button>)}</div>}
    <p className="runout-deck-note"><b>Deck cap: {vote.maxRuns} {vote.maxRuns === 1 ? 'run' : 'runs'} available</b>
      {vote.maxRuns < hand.rules.maxRunouts ? `, reduced from the host's maximum of ${hand.rules.maxRunouts}` : ''}.
      {' '}Dealt cards, remaining board cards and burns limit the number of runs. Every run keeps the already-public board cards.
      {' '}Bots accept the available maximum. No additional private cards are revealed during this decision.</p>
  </section>;
}

function NextHandPanel({ room, disabled, error, save }: {
  room: RoomView; disabled: boolean; error: string; save: (rules: HandRules) => Promise<boolean>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState<HandRules>({ ...room.nextHandRules });
  const [failed, setFailed] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  const gameSelect = useRef<HTMLSelectElement>(null);
  const wasExpanded = useRef(false);
  useEffect(() => {
    if (expanded) gameSelect.current?.focus();
    else if (wasExpanded.current) toggle.current?.focus();
    wasExpanded.current = expanded;
  }, [expanded]);
  const isHost = room.hostId === room.youId;
  const canEdit = isHost && room.status === 'open';
  const editing = expanded && canEdit;
  const active = room.hand && room.hand.street !== 'complete';
  const rules = editing ? draft : room.nextHandRules;
  const valid = Number.isSafeInteger(draft.bombAnte) && draft.bombAnte >= 1 && draft.bombAnte <= 10_000_000 &&
    Number.isSafeInteger(draft.indianAnte) && draft.indianAnte >= 1 && draft.indianAnte <= 10_000_000 &&
    Number.isSafeInteger(draft.omahaAnte) && draft.omahaAnte >= 1 && draft.omahaAnte <= 10_000_000 &&
    Number.isSafeInteger(draft.sevenDeuceBounty) && draft.sevenDeuceBounty >= 0 && draft.sevenDeuceBounty <= 10_000_000;
  return <section className="next-hand-panel" aria-labelledby="next-hand-title">
    <header><div><span className="eyebrow">YOUR NIGHT, YOUR MIX</span><h2 id="next-hand-title">Next hand</h2></div>
      {canEdit && <button type="button" ref={toggle} className="button button-small button-outline"
        aria-expanded={expanded} aria-controls="next-hand-editor" disabled={disabled} onClick={() => {
          if (!expanded) { setDraft({ ...room.nextHandRules }); setFailed(false); }
          setExpanded(!expanded);
        }}>{expanded ? 'Cancel changes' : 'Choose next hand'}<ChevronDown size={15} className={expanded ? 'chevron-open' : ''} /></button>}</header>
    <div className="hand-rules-summary">
      <div className="active-hand-rules"><small>{active ? `ACTIVE HAND #${room.hand!.number} · FROZEN` : room.hand ? `LAST HAND #${room.hand.number}` : 'NO ACTIVE HAND'}</small>
        <strong>{room.hand ? handGameLabel(room.hand) : 'Waiting for the first deal'}</strong>
        <span>{room.hand ? ruleSummary(room.hand.rules, isLegacyIndianHand(room.hand)) : 'The queued rules apply when the host deals.'}</span></div>
      <div className="queued-hand-rules"><small>{room.status === 'closed' ? 'LAST QUEUED SELECTION' : 'QUEUED · NEXT DEAL & EVERY DEAL AFTER'}</small>
        <strong>{GAME_LABELS[room.nextHandRules.game]}</strong><span>{ruleSummary(room.nextHandRules)}</span></div>
    </div>
    <p className="next-hand-explainer">Changes affect future deals only, never the hand already in play. The queued selection stays until the host changes it.</p>
    {editing && <form id="next-hand-editor" aria-label="Next-hand rules" onSubmit={event => {
      event.preventDefault();
      if (!valid || disabled) return;
      setFailed(false);
      void save(draft).then(ok => { if (ok) setExpanded(false); else setFailed(true); });
    }}>
      {failed && <div className="error-banner" role="alert">{error || 'The next-hand selection was not saved. Please try again.'}</div>}
      <div className="field-grid">
        <label className="field next-game-field"><span>Game for future hands</span><select ref={gameSelect} value={draft.game}
          onChange={event => {
            const game = event.target.value as GameVariant;
            setDraft({ ...draft, game, sevenDeuceBounty: game === 'holdem' ? draft.sevenDeuceBounty : 0 });
          }}>{Object.entries(GAME_LABELS).map(([game, label]) => <option value={game} key={game}>{label}</option>)}</select></label>
        {draft.game === 'omaha_bomb' && <Numeric label="Bomb ante (chips per player)" value={draft.bombAnte} min={1}
          onChange={bombAnte => setDraft({ ...draft, bombAnte })} hint="Ante only; both flops are dealt immediately. No blinds or preflop betting." />}
        {draft.game === 'indian' && <Numeric label="Indian round buy-in (ante per player)" value={draft.indianAnte} min={1}
          onChange={indianAnte => setDraft({ ...draft, indianAnte })} hint="Mandatory each hand, from existing chips, before normal blinds. Replaces the regular table ante." />}
        {draft.game === 'omaha' && <Numeric label="PLO round buy-in (ante per player)" value={draft.omahaAnte} min={1}
          onChange={omahaAnte => setDraft({ ...draft, omahaAnte })} hint="Mandatory each hand, from existing chips, before normal blinds. Counts toward the pot limit; replaces the regular table ante." />}
        {draft.game === 'holdem' && <Numeric label="7/2 offsuit bounty (chips per opponent)" value={draft.sevenDeuceBounty}
          onChange={sevenDeuceBounty => setDraft({ ...draft, sevenDeuceBounty })} hint="0 disables. Separate off-table settlement, never taken from a stack." />}
        <label className="field"><span>All-in runout consent</span><select value={draft.maxRunouts}
          onChange={event => setDraft({ ...draft, maxRunouts: Number(event.target.value) as RunoutCount })}>
          <option value={1}>Run once — no vote</option><option value={2}>Allow up to twice</option><option value={3}>Allow up to three times</option>
        </select><small>Offered only after all betting ends due to all-ins, subject to deck capacity.</small></label>
      </div>
      {!valid && <p className="negative form-note" role="status">Use whole-chip amounts: antes from 1 to 10,000,000; bounty from 0 to 10,000,000.</p>}
      <button className="button button-gold" disabled={disabled || !valid}>Save next-hand rules <Check size={16} /></button>
    </form>}
    <div className="mixed-house-rules" aria-label={editing ? 'Draft game house rules' : 'Queued game house rules'}>
      <strong>{editing ? 'DRAFT HOUSE RULES' : 'QUEUED HOUSE RULES'}</strong>
      {rules.game === 'holdem' ? <p>Texas Hold'em: two private cards, no-limit betting.
        {rules.sevenDeuceBounty > 0 ? <> A sole winner of the entire hand with 7/2 offsuit is owed {chips(rules.sevenDeuceBounty)} chips equivalent by <b>each other dealt-in player</b>.
          {' '}Split or partial wins do not qualify. The winning 7/2 is shown even when everyone folds. The bonus is off-table; no stacks change and no payment is collected.</>
          : ' The 7/2 offsuit bounty is off.'}</p>
        : rules.game === 'indian' ? <p>Two-card Indian Hold'em: everyone else can see both of your cards, but you cannot until you fold or the hand ends.
          {' '}Normal no-limit Hold'em blinds and preflop, flop, turn and river betting. Best five-card poker hand wins, using any combination of hole and board cards.</p>
          : <p>Four private cards. Use <b>exactly two private cards and three cards from one board</b>.
            {rules.game === 'omaha_bomb' && ' Each player posts the bomb ante; two flops are dealt immediately, with no blinds or preflop betting. Each board awards a separate share.'}
            {' '}Betting is pot limit; a full-stack all-in must fit that limit. The 7/2 bounty is Hold'em-only.</p>}
      {(rules.game === 'indian' || rules.game === 'omaha') && <p>Mandatory round buy-in: <b>{chips(rules.game === 'indian' ? rules.indianAnte : rules.omahaAnte)} chips per dealt-in player</b>,
        {' '}posted automatically as an ante from existing stacks, in addition to blinds. It replaces the regular table ante, never buys extra chips, and does not count toward calling a bet.
        {' '}A short stack posts its remaining chips and is all-in. Table buy-in limits remain separate.</p>}
      <p>{rules.maxRunouts === 1 ? 'Run once: normal dealing, without a runout vote.' : `After betting is over due to all-ins, eligible players may consent to up to ${rules.maxRunouts} runs. Lowest choice wins; missing choices after 20 seconds mean once. Deck capacity may lower the maximum.`}</p>
    </div>
  </section>;
}
