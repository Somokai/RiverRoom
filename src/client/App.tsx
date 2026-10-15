import { useCallback, useEffect, useState } from 'react';
import { ArrowRight, BarChart3, Plus, Users, ShieldCheck, ReceiptText, ArrowUpRight, LogOut, KeyRound, LoaderCircle, Check, Copy, X } from 'lucide-react';
import { api, ApiError, getRoom, repeatable, useIdentity } from './api';
import { Brand, ChipStack, Modal, Numeric, PlayingCard, bountyLabel, signedChips } from './ui';
import { Game } from './Game';
import { PlayerStatsDialog } from './PlayerStats';
import { DEFAULT_SETTINGS, chips, money, type Identity, type RoomSettings, type RoomSummary, type RoomView } from '../shared/model';

export function App() {
  const [user, setUser] = useState<Identity | null>(null);
  const [ready, setReady] = useState(false);
  const [hostKeyRequired, setHostKeyRequired] = useState(false);
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [room, setRoom] = useState<RoomView | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [modal, setModal] = useState<'create' | 'join' | 'recover' | null>(null);
  const [recoveryKey, setRecoveryKey] = useState('');
  const [copied, setCopied] = useState(false);
  const [name, setName] = useState('');
  const [joinCode, setJoinCode] = useState(new URLSearchParams(location.search).get('join')?.toUpperCase() ?? '');
  const [recoverInput, setRecoverInput] = useState('');
  const [tableName, setTableName] = useState("Friday night poker");
  const [settings, setSettings] = useState<RoomSettings>({ ...DEFAULT_SETTINGS });
  const [buyIn, setBuyIn] = useState(10000);
  const [hostKey, setHostKey] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [statsOpen, setStatsOpen] = useState(false);
  const practiceBots = Math.max(0, Math.min(3, settings.maxSeats - 1));
  const acceptUser = useCallback((identity: Identity | null) => { useIdentity(identity); setUser(identity); setStatsOpen(false); if (!identity) setRooms([]); }, []);

  useEffect(() => {
    let active = true;
    api<{ user: Identity | null; hostKeyRequired: boolean }>('/me')
      .then(async result => {
        if (!active) return;
        acceptUser(result.user); setHostKeyRequired(result.hostKeyRequired);
        const tableId = new URLSearchParams(location.search).get('table');
        if (tableId && result.user) {
          try { const saved = await getRoom(tableId); if (active) setRoom(saved.room); }
          catch (reason) { if (active) setError(reason instanceof Error ? reason.message : 'Unable to reopen your table.'); }
        }
        if (active) setReady(true);
      })
      .catch(reason => { if (active) { setError(reason.message); setReady(true); } });
    return () => { active = false; };
  }, [acceptUser]);
  useEffect(() => {
    if (!ready) return;
    const url = new URL(location.href);
    if (room) { url.searchParams.set('table', room.id); url.searchParams.delete('join'); }
    else url.searchParams.delete('table');
    history.replaceState(null, '', url);
  }, [room?.id, ready]);
  const refreshRooms = useCallback(async () => {
    const result = await api<{ rooms: RoomSummary[] }>('/rooms');
    setRooms(result.rooms);
  }, []);
  useEffect(() => {
    if (user) void refreshRooms().catch(reason => setError(reason.message));
  }, [user, room === null, refreshRooms]);

  async function run(operation: () => Promise<void>) {
    setBusy(true); setError('');
    try { await operation(); }
    catch (reason) {
      setError(reason instanceof Error ? reason.message : 'That request could not be completed.');
      if (reason instanceof ApiError && reason.status === 401) acceptUser(null);
    } finally { setBusy(false); }
  }
  async function ensureUser() {
    if (user) return user;
    const result = await api<{ user: Identity; recoveryCode?: string }>('/auth/guest', { name: name.trim() });
    acceptUser(result.user);
    if (result.recoveryCode) setRecoveryKey(result.recoveryCode);
    return result.user;
  }
  async function create(practice = false) {
    await ensureUser();
    const created = await repeatable<{ room: RoomView }>('/rooms', {
      name: practice ? `${name || user?.name || 'My'}'s practice table` : tableName,
      settings, buyIn, hostKey, commandId: crypto.randomUUID(),
    });
    let current = created.room;
    setRoom(current); setModal(null);
    if (practice) {
      const availableSeats = current.settings.maxSeats - current.players.filter(player => player.seat !== null).length;
      for (let i = 0; i < Math.min(3, availableSeats); i++) {
        const result = await repeatable<{ room: RoomView }>(`/rooms/${current.id}/commands`, {
          commandId: crypto.randomUUID(), expectedVersion: current.version, command: { type: 'add_bot' },
        });
        current = result.room;
        setRoom(current);
      }
    }
  }
  async function join() {
    await ensureUser();
    const result = await repeatable<{ room: RoomView }>('/rooms/join', { code: joinCode.trim().toUpperCase(), commandId: crypto.randomUUID() });
    setRoom(result.room); setModal(null);
    history.replaceState(null, '', location.pathname);
  }
  const loginFields = !user && <label className="field"><span>Your player name</span><input required minLength={2} maxLength={24} value={name} onChange={event => setName(event.target.value)} placeholder="What should we call you?" autoComplete="nickname" /></label>;
  const errorBanner = error && <div className="error-banner" role="alert"><span>{error}</span><button className="icon-button" aria-label="Dismiss error" onClick={() => setError('')}><X size={17} /></button></div>;
  if (!ready) return <main className="loading-screen"><Brand /><LoaderCircle className="spin" /><p>Finding your seat...</p></main>;

  return <>
    {room && user ? <Game key={room.id} initialRoom={room} user={user} onHome={() => setRoom(null)} onSessionExpired={() => { acceptUser(null); setRoom(null); }} /> :
      <div className="lobby-shell">
        <header className="lobby-nav"><Brand /><div className="nav-right"><span className="private-pill"><ShieldCheck size={14} /> PRIVATE TABLES</span>
          {user ? <><button className="text-button stats-nav-button" aria-label="My stats" onClick={() => setStatsOpen(true)}><BarChart3 size={18} /><span>My stats</span></button>
            <span className="profile-chip"><span className="avatar small-avatar">{user.name.slice(0, 1).toUpperCase()}</span>{user.name}</span>
            <button className="icon-button" aria-label="Sign out" onClick={() => void run(async () => { await api('/auth/logout', {}); acceptUser(null); setRooms([]); })}><LogOut size={18} /></button></>
            : <button className="text-button" onClick={() => setModal('recover')}><KeyRound size={15} /> Recover profile</button>}</div></header>
        <main className="lobby-main">
          {errorBanner}
          <section className="hero">
            <div className="hero-copy"><span className="eyebrow"><span className="tiny-dot" /> YOUR PEOPLE. YOUR POKER NIGHT.</span>
              <h1>Good cards.<br />Better <em>company.</em></h1>
              <p>A proper poker room for your favorite people. Hold'em, Omaha, double-board bomb pots, and two-card Indian poker. One table, your choice of next hand.</p>
              <div className="hero-actions"><button className="button button-gold" onClick={() => setModal('create')}><Plus size={18} /> Create a table <ArrowUpRight size={17} /></button>
                <button className="button button-outline" onClick={() => setModal('join')}>Join with a code <ArrowRight size={17} /></button></div>
              <div className="hero-note"><span className="avatar-pile"><b>J</b><b>M</b><b>A</b></span><span>2-9 players <span className="middot">/</span> Private by invitation</span></div>
            </div>
            <div className="hero-art" aria-hidden="true"><div className="art-orbit orbit-one" /><div className="art-orbit orbit-two" /><div className="art-felt">
              <div className="art-label">RIVER ROOM <span>NO LIMIT HOLD'EM</span></div>
              <div className="hero-cards"><PlayingCard card="As" /><PlayingCard card="Ks" /></div>
              <div className="art-chips"><ChipStack /><ChipStack gold /><ChipStack /></div>
              <span className="floating-badge"><span className="tiny-dot" /> A good night is in the cards.</span>
              <span className="art-dealer">D</span>
            </div></div>
          </section>
          <section className="feature-grid">
            <article><span className="feature-icon"><Users size={21} /></span><div><h3>A real seat at the table</h3><p>Live multiplayer, private cards, side pots, and a rotating button. Practice bots are welcome, too.</p></div></article>
            <article><span className="feature-icon"><ReceiptText size={21} /></span><div><h3>Every chip accounted for</h3><p>Buy-ins, rebuys, add-ons, and cash-outs. A complete session ledger, not a napkin full of numbers.</p></div></article>
            <article><span className="feature-icon"><ShieldCheck size={21} /></span><div><h3>Your night, your rules</h3><p>Queue the next game, offer all-in runout consent, or track a separate 7/2 bounty. Hold'em, run once, and bounties off by default.</p></div></article>
          </section>
          {user && <section className="sessions-section"><div className="section-heading"><div><span className="eyebrow">PICK UP WHERE YOU LEFT OFF</span><h2>Your sessions</h2></div><span className="muted">{rooms.length} {rooms.length === 1 ? 'session' : 'sessions'}</span></div>
            {rooms.length ? <div className="session-grid">{rooms.map(item => <button key={item.id} className="session-card" disabled={busy} onClick={() => void run(async () => setRoom((await getRoom(item.id)).room))}>
              <div className="session-title"><span className={`status-tag ${item.status === 'closed' ? 'tag-muted' : ''}`}>{item.status === 'closed' ? 'FINISHED' : 'OPEN TABLE'}</span>{item.host && <span className="muted">Host</span>}</div>
              <h3>{item.name}</h3><p>{item.playerCount} seats occupied <span className="middot">/</span> Hand {item.handNumber}</p>
              <div className="session-bottom"><span><small>YOUR STACK</small><strong>{chips(item.stack)}</strong></span><span className={item.net >= 0 ? 'positive' : 'negative'}><span><small>TOTAL P/L</small>{signedChips(item.net)}</span><ArrowRight size={17} /></span></div>
              <div className="session-breakdown"><span>Chip P/L <b className={item.chipNet >= 0 ? 'positive' : 'negative'}>{signedChips(item.chipNet)}</b></span>
                <span>{bountyLabel(item.bountyNet)} <b className={item.bountyNet < 0 ? 'negative' : 'muted'}>{chips(Math.abs(item.bountyNet))} chips equivalent</b></span>
                <small>Total includes off-table bounties, not payments or cash-outs.</small></div>
            </button>)}</div> : <div className="empty-state"><ReceiptText size={28} /><p>Your tables and session results will live here.</p><button className="text-button" onClick={() => setModal('create')}>Deal something new <ArrowRight size={16} /></button></div>}
          </section>}
        </main>
        <footer className="lobby-footer"><span>Made for the home game. Built for the whole night.</span><span>Private play & bookkeeping only. No payments or prizes processed.</span></footer>
      </div>}

    {statsOpen && user && <PlayerStatsDialog key={user.id} userId={user.id} close={() => setStatsOpen(false)}
      onSessionExpired={() => { acceptUser(null); setRoom(null); }} />}
    {modal && <Modal title={modal === 'create' ? 'Make it your table.' : modal === 'join' ? 'Your seat is waiting.' : 'Welcome back.'}
      subtitle={modal === 'create' ? 'A few house rules, then you are ready to deal.' : modal === 'join' ? 'Enter the eight-character code shared by your host.' : 'Use your recovery key to restore your player identity and sessions.'}
      close={() => { if (!busy) { setModal(null); setError(''); } }}>
      {errorBanner}
      {modal === 'recover' ? <form onSubmit={event => { event.preventDefault(); void run(async () => {
        const result = await api<{ user: Identity }>('/auth/recover', { recoveryCode: recoverInput.trim() });
        acceptUser(result.user); setRecoverInput(''); setModal(null);
      }); }}><label className="field"><span>Recovery key</span><input required type="password" autoComplete="off" value={recoverInput} onChange={event => setRecoverInput(event.target.value)} placeholder="RR-..." /></label>
        <p className="form-note">Recovering your profile signs out your other browser sessions.</p><button className="button button-gold full-width" disabled={busy}>Recover my profile <ArrowRight size={17} /></button></form>
        : modal === 'join' ? <form onSubmit={event => { event.preventDefault(); void run(join); }}>{loginFields}
          <label className="field"><span>Invite code</span><input className="code-input" required minLength={8} maxLength={8} value={joinCode} onChange={event => setJoinCode(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))} placeholder="ABCD2345" autoComplete="off" /></label>
          <p className="form-note">Once seated, request a buy-in from your host.</p><button className="button button-gold full-width" disabled={busy}>{busy ? <LoaderCircle size={18} className="spin" /> : <ArrowRight size={18} />} Join the table</button></form>
          : <form onSubmit={event => { event.preventDefault(); void run(() => create()); }}>{loginFields}
            <label className="field"><span>Table name</span><input required minLength={2} maxLength={60} value={tableName} onChange={event => setTableName(event.target.value)} /></label>
            <div className="field-grid"><Numeric label="Small blind" value={settings.smallBlind} onChange={value => setSettings({ ...settings, smallBlind: value })} min={1} />
              <Numeric label="Big blind" value={settings.bigBlind} onChange={value => setSettings({ ...settings, bigBlind: value })} min={2} /></div>
            <div className="field-grid"><Numeric label="Your starting chips" value={buyIn} min={settings.minBuyIn} max={settings.maxBuyIn} onChange={setBuyIn} />
              <Numeric label="Value of 1 chip (cents)" value={settings.chipValueCents} min={1} max={10000} onChange={value => setSettings({ ...settings, chipValueCents: value })} hint={`${money(buyIn * settings.chipValueCents, settings.currency)} recorded buy-in`} /></div>
            {hostKeyRequired && <label className="field"><span>Host-creation key</span><input type="password" required value={hostKey} onChange={event => setHostKey(event.target.value)} autoComplete="off" placeholder="Provided by your app administrator" /></label>}
            <button className="text-button advanced-toggle" type="button" onClick={() => setAdvanced(!advanced)}>{advanced ? 'Hide' : 'Show'} house rules <Plus size={14} /></button>
            {advanced && <div className="advanced-fields"><div className="field-grid"><Numeric label="Minimum buy-in" value={settings.minBuyIn} min={1} max={settings.maxBuyIn} onChange={value => setSettings({ ...settings, minBuyIn: value })} />
              <Numeric label="Maximum funded stack" value={settings.maxBuyIn} min={1} onChange={value => setSettings({ ...settings, maxBuyIn: value })} />
              <Numeric label="Ante" value={settings.ante} max={settings.bigBlind} onChange={value => setSettings({ ...settings, ante: value })} />
              <Numeric label="Seats" value={settings.maxSeats} min={2} max={9} onChange={value => setSettings({ ...settings, maxSeats: value })} />
              <Numeric label="Turn clock (seconds)" value={settings.turnSeconds} min={15} max={120} onChange={value => setSettings({ ...settings, turnSeconds: value })} />
              <label className="field"><span>Bookkeeping currency</span><select value={settings.currency} onChange={event => setSettings({ ...settings, currency: event.target.value as RoomSettings['currency'] })}>{['USD', 'EUR', 'GBP', 'CAD'].map(currency => <option key={currency}>{currency}</option>)}</select></label></div>
              <label className="checkbox"><input type="checkbox" checked={settings.autoDeal} onChange={event => setSettings({ ...settings, autoDeal: event.target.checked })} /> Automatically deal the next hand</label>
              <label className="checkbox"><input type="checkbox" checked={settings.allowRebuys} onChange={event => setSettings({ ...settings, allowRebuys: event.target.checked })} /> Allow rebuys</label></div>}
            <div className="form-actions"><button className="button button-gold full-width" disabled={busy}>{busy ? <LoaderCircle size={17} className="spin" /> : <Plus size={17} />} Create private table</button>
              <button className="button button-outline full-width" type="button" disabled={busy} onClick={() => void run(() => create(true))}>Or practice with {practiceBots} {practiceBots === 1 ? 'bot' : 'bots'} <Users size={17} /></button></div>
            <p className="form-note">Chip values are records only. This app does not collect or transfer money.</p>
            <p className="form-note">Practice bots use virtual chips. The host can refill them between hands, or sit out to watch two or more funded bots play.</p>
          </form>}
    </Modal>}
    {recoveryKey && <Modal title="Keep your seat. Save this key." subtitle="This is your one-time recovery key. It restores your chips and player identity if you change browsers or lose your cookies."
      close={() => { setRecoveryKey(''); setCopied(false); }}>
      <div className="recovery-box"><KeyRound size={25} /><code>{recoveryKey}</code></div>
      <button className="button button-outline full-width" onClick={() => void navigator.clipboard.writeText(recoveryKey).then(() => setCopied(true)).catch(() => setError('Clipboard unavailable. Select and copy the recovery key manually.'))}>{copied ? <Check size={17} /> : <Copy size={17} />}{copied ? 'Copied securely' : 'Copy recovery key'}</button>
      {error && <p className="negative" role="alert">{error}</p>}
      <p className="form-note">Keep it private, like a password. It is not your table invite code. The server stores only a hash of this key.</p>
      <button className="button button-gold full-width" onClick={() => { setRecoveryKey(''); setCopied(false); }}>I have saved my key <ArrowRight size={17} /></button>
    </Modal>}
  </>;
}
