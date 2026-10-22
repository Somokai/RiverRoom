import { useEffect, useState } from 'react';
import { Download, RefreshCw, ShieldCheck, LoaderCircle, ArrowDown } from 'lucide-react';
import { api } from './api';
import { BountyNotice, CommunityBoards, Modal, PlayingCard, bountyLabel, ruleSummary, signedChips } from './ui';
import { chips, handGameLabel, isLegacyIndianHand, money, type AuditRow, type HandHistory, type LedgerRow, type RoomView } from '../shared/model';

export function Records({ room, tab, close }: { room: RoomView; tab: 'ledger' | 'hands' | 'audit'; close: () => void }) {
  const [ledger, setLedger] = useState<LedgerRow[]>([]);
  const [hands, setHands] = useState<HandHistory[]>([]);
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [integrity, setIntegrity] = useState('');
  const name = (id: string) => room.players.find(player => player.id === id)?.name ?? id;
  const account = (id: string) => id === 'bank' ? 'House bank'
    : id.startsWith('pot:') ? 'Hand pot'
      : id.startsWith('bounty:') ? `${name(id.slice('bounty:'.length))} · bounty balance`
        : id.startsWith('player:') ? `${name(id.slice('player:'.length))} · stack` : name(id);
  async function load(before?: number) {
    setBusy(true); setError('');
    try {
      const url = `/rooms/${room.id}/${tab}${before ? `?before=${before}` : ''}`;
      if (tab === 'ledger') {
        const result = await api<{ entries: LedgerRow[]; nextCursor: number | null }>(url);
        setLedger(previous => before ? [...previous, ...result.entries] : result.entries); setCursor(result.nextCursor);
      } else if (tab === 'hands') {
        const result = await api<{ entries: HandHistory[]; nextCursor: number | null }>(url);
        setHands(previous => before ? [...previous, ...result.entries] : result.entries); setCursor(result.nextCursor);
      } else {
        const result = await api<{ entries: AuditRow[]; nextCursor: number | null }>(url);
        setAudit(previous => before ? [...previous, ...result.entries] : result.entries); setCursor(result.nextCursor);
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to load records.'); }
    finally { setBusy(false); }
  }
  useEffect(() => { if (tab !== 'ledger') void load(); }, [tab, room.id]);
  async function verify() {
    setBusy(true); setError('');
    try {
      const result = await api<{ valid: boolean; count: number; brokenAt?: number }>(`/rooms/${room.id}/integrity`);
      setIntegrity(result.valid ? `Hash chain verified: ${chips(result.count)} records.` : `Integrity check failed at record ${result.brokenAt}.`);
      if (!result.valid) setError('The stored audit history failed verification. Export it and contact the administrator.');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to verify history.'); }
    finally { setBusy(false); }
  }
  const DetailContainer = tab === 'ledger' ? 'details' : 'div';
  const recordActions = <>
    <button className="button button-small button-outline" disabled={busy} onClick={() => void load()}><RefreshCw size={15} /> Refresh</button>
    <a className="button button-small button-outline" href={`/api/rooms/${room.id}/export.csv`}><Download size={15} /> Ledger CSV</a>
    <a className="button button-small button-outline" href={`/api/rooms/${room.id}/export.json`}><Download size={15} /> Audit JSON</a>
    <button className="button button-small button-outline" disabled={busy} onClick={() => void verify()}><ShieldCheck size={15} /> Verify history</button>
  </>;
  return <Modal wide title={tab === 'ledger' ? 'Session results' : tab === 'hands' ? 'The hands that happened.' : 'The complete table journal.'}
    subtitle={`${room.name} / Session ${room.code} / ${tab === 'ledger' ? 'What everyone bought in for, cashed out, and won or lost.' : tab === 'hands' ? 'Completed hands, every board and run, and publicly revealed cards.' : 'Append-only actions with a linked integrity hash.'}`} close={close}>
    {tab !== 'ledger' && <div className="record-tools">{recordActions}</div>}
    {tab === 'ledger' && <section className="session-results" aria-label="Player session results">
      <p className="session-results-note">All amounts are in chips. Bought in includes funded rebuys and add-ons; pending or queued requests are not included.</p>
      <table className="session-results-table"><caption className="session-results-caption">
        {room.status === 'closed' ? 'Final session results' : 'Session results so far'}
      </caption><thead><tr><th scope="col">Player</th><th scope="col">Bought in</th><th scope="col">Cashed out</th><th scope="col">Net gain / loss</th></tr></thead>
        <tbody>{room.players.map(player => <tr key={player.id}><th scope="row">{player.name}{player.bot && <small>Virtual practice chips</small>}</th>
          <td data-label="Bought in">{chips(player.buyIns)}</td>
          <td data-label="Cashed out">{chips(player.cashOuts)}</td>
          <td data-label="Net gain / loss" className={player.chipNet >= 0 ? 'positive' : 'negative'}>{signedChips(player.chipNet)}</td>
        </tr>)}</tbody></table>
      {room.status === 'open' && <p className="session-results-note">Cashed out means chips already taken off the table, not chips still in play.
        {' '}Net gain / loss includes current stacks and chips committed to an unfinished hand, so it is not final until play finishes and everyone cashes out.</p>}
      {room.players.some(player => player.bountyNet !== 0) && <aside className="session-bounties" aria-label="Separate bounty obligations">
        <h3>Separate bounty obligations</h3>
        <p>These amounts are owed off-table, not paid. They are not included in the chip cash-outs or net gains/losses above.</p>
        <dl>{room.players.filter(player => player.bountyNet !== 0).map(player => <div key={player.id}><dt>{player.name}{player.bot && ' (virtual practice)'}</dt>
          <dd>{bountyLabel(player.bountyNet)}: {chips(Math.abs(player.bountyNet))} chips equivalent</dd></div>)}</dl>
      </aside>}
    </section>}
    <DetailContainer className={tab === 'ledger' ? 'ledger-details' : undefined} onToggle={event => {
      if (tab === 'ledger' && event.currentTarget instanceof HTMLDetailsElement && event.currentTarget.open) void load();
    }}>
    {tab === 'ledger' && <><summary>Detailed transfers, exports &amp; verification</summary>
      <p className="record-bounty-note">The full chip-transfer ledger and separate off-table bounty obligations are shown below, newest first. Bounty entries do not fund a stack, increase a cash-out, or record a payment.</p>
      <div className="record-tools">{recordActions}</div></>}
    {integrity && <p className="form-note">{integrity}</p>}
    {error && <div className="error-banner" role="alert">{error}</div>}
    <div className="record-scroll">
      {tab === 'ledger' && <table className="data-table"><thead><tr><th>Time</th><th>Player / entry</th><th>Transfer / obligation</th><th className="number-cell">Chips / equivalent</th><th className="number-cell">Recorded value</th></tr></thead>
        <tbody>{ledger.map(entry => <tr key={entry.id}><td className="nowrap">{new Date(entry.at).toLocaleTimeString()}<small>{new Date(entry.at).toLocaleDateString()}</small></td>
          <td>{name(entry.playerId)}<small className="title-case">{entry.kind === 'bounty' ? '7/2 bounty · owed, not paid' : entry.kind.replaceAll('_', ' ')}</small></td>
          <td className="transfer-cell">{account(entry.from)} <span>&rarr;</span> {account(entry.to)}<small>{entry.note}</small>
            {entry.kind === 'bounty' && <small className="bounty-ledger-label">Off-table obligation only; no chips or payment moved.</small>}</td>
          <td className="number-cell">{chips(entry.chips)}{entry.kind === 'bounty' && <small>Equivalent only</small>}</td><td className="number-cell muted">{entry.cashCents ? money(entry.cashCents, room.settings.currency) : '\u2014'}</td></tr>)}</tbody></table>}
      {tab === 'hands' && <div className="hand-history">{hands.map(hand => <article key={hand.id}><header><div><strong>Hand #{hand.number}</strong><small>{handGameLabel(hand)}</small></div><span>{new Date(hand.completedAt).toLocaleString()}</span></header>
        <p className="history-rules">{ruleSummary(hand.rules, isLegacyIndianHand(hand))}</p>
        <div className="history-board">{isLegacyIndianHand(hand) ? <span className="muted">Legacy one-card forehead poker · no community cards</span>
          : <CommunityBoards hand={hand} small complete />}<span className="history-pot">{chips(hand.pot)}<small>CHIPS AWARDED</small></span></div>
        {hand.runoutCount > 1 && <p className="history-rules">Run tabs share the already-public prefix. Pot shares below cover all {hand.runoutCount} runs.</p>}
        {hand.results.map((pot, index) => <div className="history-result" key={`${pot.potIndex}:${pot.boardIndex}:${pot.runoutIndex}:${index}`}>
          <span>{pot.potIndex === 0 ? 'Main pot' : `Side pot ${pot.potIndex}`}
            {!isLegacyIndianHand(hand) && <small>Run {pot.runoutIndex + 1} · Board {pot.boardIndex + 1}</small>}</span>
          <strong>{pot.winners.map(id => `${name(id)} +${chips(pot.shares[id] ?? 0)}`).join(' & ')}</strong><span>{chips(pot.amount)} / {pot.description}</span></div>)}
        {hand.bounty && <BountyNotice bounty={hand.bounty} room={room} />}
        {Object.entries(hand.revealed).map(([id, cards]) => <div className="showdown-row" key={id}><span>{name(id)}</span>{cards.map(card => <PlayingCard key={card} card={card} small />)}<small>Publicly revealed</small></div>)}
        <details className="history-balances"><summary>After-hand balances: chips &amp; bounty</summary>
          {Object.entries(hand.balanceAfter).map(([id, stack]) => <div key={id}><strong>{name(id)}</strong><span>Stack {chips(stack)}</span>
            <span>{bountyLabel(hand.bountyAfter[id] ?? 0)} {chips(Math.abs(hand.bountyAfter[id] ?? 0))} eq.</span></div>)}
          <p>Off-table bounty balances are separate from the stacks above and are not marked paid.</p></details>
      </article>)}</div>}
      {tab === 'audit' && <div className="audit-list">{audit.map(entry => <article key={entry.seq}><header><span>#{entry.seq} / <b>{entry.command.replaceAll('_', ' ')}</b></span><time>{new Date(entry.at).toLocaleString()}</time></header>
        {entry.events.map(event => <p key={event.id}>{event.message}</p>)}
        <code title={entry.hash}>SHA-256 {entry.hash.slice(0, 22)}...</code></article>)}</div>}
      {!busy && !(ledger.length + hands.length + audit.length) && <div className="empty-state"><p>{tab === 'hands' ? 'Completed hands will appear here after the first pot is awarded.' : 'No entries yet.'}</p></div>}
    </div>
    <div className="record-footer"><span className="muted">Bookkeeping only, not payments. Bounties are separate off-table obligations. Bot balances are virtual.</span>
      {busy ? <LoaderCircle className="spin" size={20} /> : cursor && <button className="button button-small button-outline" onClick={() => void load(cursor)}><ArrowDown size={15} /> Older entries</button>}</div>
    </DetailContainer>
  </Modal>;
}
