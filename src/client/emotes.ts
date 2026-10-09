import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { Socket } from 'socket.io-client';
import { EMOTE_COOLDOWN_MS, EMOTE_DURATION_MS, type EmoteId, type EmoteResult, type TableEmote } from '../shared/emotes';

interface ActiveEmote { event: TableEmote; expiresAt: number }

function loadMutes(key: string): { players: Set<string>; error: string } {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
    if (!Array.isArray(saved) || !saved.every(id => typeof id === 'string' && id.length > 0 && id.length <= 80))
      return { players: new Set(), error: 'Saved emote mutes are invalid. Mute those players again for this table.' };
    return { players: new Set(saved), error: '' };
  } catch (error) {
    if (!(error instanceof SyntaxError) && !(error instanceof DOMException)) throw error;
    return { players: new Set(), error: 'Saved emote mutes could not be loaded in this browser. Mute those players again for this visit.' };
  }
}

export function useEmotes(
  roomId: string, userId: string, timeOffset: number, socket: RefObject<Socket | null>,
  reportError: (message: string) => void,
) {
  const storageKey = `river-room:emote-mutes:${userId}:${roomId}`;
  const [initial] = useState(() => loadMutes(storageKey));
  const [muted, setMuted] = useState(initial.players);
  const mutedRef = useRef(muted);
  const [active, setActive] = useState<Record<string, ActiveEmote>>({});
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const sendingRef = useRef(false);
  const offset = useRef(timeOffset);
  offset.current = timeOffset;
  useEffect(() => { if (initial.error) reportError(initial.error); }, [initial.error, reportError]);
  useEffect(() => {
    const update = (event: StorageEvent) => {
      if (event.key !== null && event.key !== storageKey) return;
      const next = loadMutes(storageKey);
      if (next.error) { reportError(next.error); return; }
      mutedRef.current = next.players;
      setMuted(next.players);
      setActive(previous => Object.fromEntries(Object.entries(previous).filter(([id]) => !next.players.has(id))));
    };
    window.addEventListener('storage', update);
    return () => window.removeEventListener('storage', update);
  }, [storageKey, reportError]);

  const receive = useCallback((event: TableEmote) => {
    if (event.roomId !== roomId) return;
    const now = Date.now();
    if (event.playerId === userId)
      setCooldownUntil(previous => Math.max(previous, now + Math.max(0, Math.min(EMOTE_COOLDOWN_MS, event.at + EMOTE_COOLDOWN_MS - now - offset.current))));
    if (mutedRef.current.has(event.playerId)) return;
    const remaining = Math.min(EMOTE_DURATION_MS, event.at + EMOTE_DURATION_MS - now - offset.current);
    if (remaining <= 0) return;
    setActive(previous => previous[event.playerId]?.event.id === event.id ? previous : {
      ...previous, [event.playerId]: { event, expiresAt: now + remaining },
    });
  }, [roomId, userId]);

  useEffect(() => {
    const entries = Object.values(active);
    if (!entries.length) return;
    const timer = setTimeout(() => {
      setActive(previous => Object.fromEntries(Object.entries(previous).filter(([, value]) => value.expiresAt > Date.now())));
    }, Math.max(0, Math.min(...entries.map(value => value.expiresAt)) - Date.now()));
    return () => clearTimeout(timer);
  }, [active]);

  const clear = useCallback(() => setActive({}), []);
  const toggleMute = useCallback((playerId: string) => {
    if (playerId === userId) return;
    const next = new Set(mutedRef.current);
    if (next.has(playerId)) next.delete(playerId);
    else next.add(playerId);
    mutedRef.current = next;
    setMuted(next);
    setActive(previous => Object.fromEntries(Object.entries(previous).filter(([id]) => id !== playerId)));
    try { localStorage.setItem(storageKey, JSON.stringify([...next])); }
    catch (reason) {
      if (!(reason instanceof DOMException)) throw reason;
      reportError('Emote preferences changed for this visit, but could not be saved in this browser. They may reset after reloading.');
    }
  }, [storageKey, userId, reportError]);

  const send = useCallback((emote: EmoteId): Promise<boolean> => {
    const current = socket.current;
    if (!current?.connected) {
      setError('Reconnect to the table before sending an emote.');
      return Promise.resolve(false);
    }
    if (sendingRef.current) return Promise.resolve(false);
    sendingRef.current = true;
    setSending(true); setError('');
    return new Promise(resolve => {
      // Volatile events are not queued for a later reconnect or retried like poker commands.
      current.volatile.timeout(5000).emit('emote', { roomId, emote }, (failure: Error | null, result: EmoteResult) => {
        sendingRef.current = false;
        setSending(false);
        if (socket.current !== current || !current.connected) { resolve(false); return; }
        if (failure) {
          setError('Could not confirm that emote. It will not be resent automatically.');
          resolve(false); return;
        }
        if (!result.ok) {
          if (result.retryAfterMs !== undefined) setCooldownUntil(Date.now() + result.retryAfterMs);
          setError(result.error); resolve(false); return;
        }
        receive(result.event);
        resolve(true);
      });
    });
  }, [socket, roomId, receive]);

  return { active, muted, receive, clear, toggleMute, send, sending, cooldownUntil, error };
}
