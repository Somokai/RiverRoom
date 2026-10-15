import { useEffect, useRef, useState } from 'react';
import { BarChart3, LoaderCircle, LockKeyhole, RefreshCw } from 'lucide-react';
import { api, ApiError } from './api';
import { Modal } from './ui';
import { GAME_LABELS, chips, type PlayerStats } from '../shared/model';

const percent = (count: number, opportunities: number) => opportunities ? `${(count * 100 / opportunities).toFixed(1)}%` : '\u2014';

export function PlayerStatsDialog({ userId, close, onSessionExpired, refreshKey }: {
  userId: string; close: () => void; onSessionExpired: () => void; refreshKey?: string;
}) {
  const [stats, setStats] = useState<PlayerStats | null>(null);
  const [game, setGame] = useState('all');
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const expired = useRef(onSessionExpired);
  expired.current = onSessionExpired;
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(''); setStats(null);
    void api<{ stats: PlayerStats }>('/me/stats', undefined, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      if (result.stats.userId !== userId) { expired.current(); return; }
      setStats(result.stats);
    }).catch(reason => {
      if (controller.signal.aborted) return;
      if (reason instanceof ApiError && reason.status === 401) expired.current();
      else setError(reason instanceof Error ? reason.message : 'Unable to load your advanced stats.');
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [userId, refresh, refreshKey]);
  useEffect(() => {
    const visible = () => {
      if (document.visibilityState === 'visible') { setStats(null); setRefresh(value => value + 1); }
    };
    document.addEventListener('visibilitychange', visible);
    return () => document.removeEventListener('visibilitychange', visible);
  }, []);
  const selected = game === 'all' ? stats?.totals : stats?.games.find(group => group.game === game)?.counts;
  const bomb = game === 'omaha_bomb';
  return <Modal wide title="My advanced stats" subtitle="Your play across your tables, saved with your player profile." close={close}>
    <p className="stats-privacy"><LockKeyhole size={17} /> Private to you. Other players and table hosts cannot view your advanced stats.</p>
    <div className="stats-toolbar">
      <label className="field"><span>Stats game</span><select value={game} onChange={event => setGame(event.target.value)}>
        <option value="all">All games</option>
        {Object.entries(GAME_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label>
      <button type="button" className="button button-small button-outline" disabled={loading} onClick={() => setRefresh(value => value + 1)}>
        <RefreshCw size={15} /> Refresh stats</button>
    </div>
    {loading && <div className="empty-state" role="status"><LoaderCircle className="spin" size={24} /><p>Loading your private stats...</p></div>}
    {error && <div className="error-banner" role="alert"><span>{error}</span>
      <button type="button" className="button button-small button-outline" onClick={() => setRefresh(value => value + 1)}>Retry stats</button></div>}
    {!loading && !error && selected && <>
      <p className="stats-sample"><strong>{chips(selected.hands)}</strong> completed tracked {selected.hands === 1 ? 'hand' : 'hands'}
        <span>Small samples vary. These describe your play, not a rating.</span></p>
      {selected.hands === 0 ? <div className="empty-state"><BarChart3 size={28} /><p>No completed tracked hands yet{game === 'all' ? '.' : ' for this game.'}</p>
        <p>Finish a newly dealt hand to start building your stats.</p></div> :
        <div className="stats-grid">
          <Stat label="VPIP" name="Voluntarily put chips in pot" value={bomb ? 'N/A' : percent(selected.vpipHands, selected.preflopOpportunities)}
            sample={`${chips(selected.vpipHands)} of ${chips(selected.preflopOpportunities)} preflop opportunities`}
            description={bomb ? 'Bomb pots have no preflop decisions.' : 'Hands where you called or raised preflop, out of hands where you had a preflop decision. Blinds, antes, walks and forced-only all-ins do not count as voluntary play.'} />
          <Stat label="PFR" name="Preflop raise" value={bomb ? 'N/A' : percent(selected.pfrHands, selected.preflopOpportunities)}
            sample={`${chips(selected.pfrHands)} of ${chips(selected.preflopOpportunities)} preflop opportunities`}
            description={bomb ? 'Bomb pots have no preflop raises.' : 'Hands where you raised preflop, out of hands where you had a preflop decision. Multiple raises in one hand count once.'} />
          <Stat label="AF" name="Postflop aggression factor"
            value={selected.postflopCalls ? (selected.postflopBetsRaises / selected.postflopCalls).toFixed(2) : selected.postflopBetsRaises ? '\u221e' : '\u2014'}
            sample={`${chips(selected.postflopBetsRaises)} bets / raises, ${chips(selected.postflopCalls)} calls`}
            description="Postflop bets plus raises divided by calls. Checks and folds are excluded. Infinity means bets or raises but no calls; a dash means neither." />
          <Stat label="WTSD" name="Went to showdown" value={percent(selected.showdowns, selected.flopsSeen)}
            sample={`${chips(selected.showdowns)} of ${chips(selected.flopsSeen)} flops seen`}
            description="Hands where you reached showdown without folding, out of hands where you saw a flop. All-in runouts count as seeing a flop." />
          <Stat label="W$SD" name="Won at showdown" value={percent(selected.showdownsWon, selected.showdowns)}
            sample={`${chips(selected.showdownsWon)} of ${chips(selected.showdowns)} showdowns`}
            description="Showdowns where you received any pot share, including ties and side pots. A win is not necessarily a net chip profit." />
          <Stat label="Hands won" name="Received a pot share" value={percent(selected.handsWon, selected.hands)}
            sample={`${chips(selected.handsWon)} of ${chips(selected.hands)} completed hands`}
            description="Hands where you received any pot share, including uncontested pots. Multiple boards, side pots and runouts still count as one hand; bounties do not count." />
        </div>}
    </>}
    <div className="stats-notes">
      <p>Tracking starts with hands dealt after this feature is installed. Older hands are not backfilled, and unfinished hands are excluded. Keep your recovery key to retain these stats across browsers.</p>
      <p>Practice hands against bots are included. Sitting-out, unfunded and observing players are not counted. A dash means no eligible sample, not 0%.</p>
      {stats?.trackedSince && <p>First tracked hand: {new Date(stats.trackedSince).toLocaleString()}. Latest completed hand: {new Date(stats.lastHandAt!).toLocaleString()}.</p>}
    </div>
  </Modal>;
}

function Stat({ label, name, value, sample, description }: {
  label: string; name: string; value: string; sample: string; description: string;
}) {
  return <article className="stat-card" aria-label={label}>
    <h3>{label}<small>{name}</small></h3><strong className="stat-value">{value}</strong>
    <span className="stat-sample">{sample}</span><p>{description}</p>
  </article>;
}
