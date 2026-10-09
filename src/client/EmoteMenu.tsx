import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MessageCircle, Volume2, VolumeX } from 'lucide-react';
import { EMOTES, type EmoteId } from '../shared/emotes';
import { useCountdown } from './clock';

export function EmoteMenu({ anchor, own, name, muted, disabled, sending, cooldownUntil, error, send, toggleMute, close }: {
  anchor: HTMLElement; own: boolean; name: string; muted: boolean; disabled: boolean; sending: boolean;
  cooldownUntil: number; error: string; send: (emote: EmoteId) => Promise<boolean>;
  toggleMute: () => void; close: (restoreFocus?: boolean) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const seconds = useCountdown(own && cooldownUntil > 0 ? cooldownUntil : null, 0) ?? 0;
  const unavailable = disabled || sending || seconds > 0;
  const closeRef = useRef(close);
  closeRef.current = close;
  useLayoutEffect(() => {
    const menu = ref.current!;
    const positionMenu = () => {
      const target = anchor.getBoundingClientRect();
      const bounds = menu.getBoundingClientRect();
      const left = Math.max(8, Math.min(innerWidth - bounds.width - 8, target.left + target.width / 2 - bounds.width / 2));
      const top = Math.max(8, Math.min(innerHeight - bounds.height - 8,
        target.top >= bounds.height + 12 ? target.top - bounds.height - 12 : target.bottom + 12));
      setPosition(previous => previous.left === left && previous.top === top ? previous : { left, top });
    };
    positionMenu();
    const observer = new ResizeObserver(positionMenu);
    observer.observe(menu);
    menu.querySelector<HTMLElement>('[role="menuitem"]')?.focus({ preventScroll: true });
    const outside = (event: Event) => {
      if (event.target instanceof Node && !menu.contains(event.target)) closeRef.current(false);
    };
    const reposition = (event: Event) => {
      if (!(event.target instanceof Node) || !menu.contains(event.target)) closeRef.current();
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      observer.disconnect();
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('focusin', outside);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [anchor]);

  return createPortal(<div ref={ref} className={`emote-menu ${own ? 'emote-menu-own' : ''}`}
    role="menu" aria-label={own ? 'Your emotes' : `${name}'s emotes`} aria-busy={sending}
    style={position} onContextMenu={event => event.preventDefault()} onKeyDown={event => {
      if (event.key === 'Escape' || event.key === 'Tab') {
        if (event.key === 'Escape') event.preventDefault();
        close(); return;
      }
      const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]')];
      const index = document.activeElement instanceof HTMLElement ? items.indexOf(document.activeElement) : -1;
      let next: number;
      if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = items.length - 1;
      else if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = (index + 1) % items.length;
      else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = (index + items.length - 1) % items.length;
      else return;
      event.preventDefault(); items[next]?.focus();
    }}>
    <div className="emote-menu-heading"><MessageCircle size={16} /><span>{own ? 'A little table talk' : name}</span></div>
    {own ? <div className="emote-choices">{(Object.keys(EMOTES) as EmoteId[]).map(emote =>
      <button key={emote} className="emote-choice" type="button" role="menuitem" tabIndex={-1}
        aria-disabled={unavailable} onClick={() => {
          if (!unavailable) void send(emote).then(ok => { if (ok) close(); });
        }}>{EMOTES[emote]}</button>
    )}</div> : <button className="emote-mute-choice" type="button" role="menuitem" tabIndex={-1}
      onClick={() => { toggleMute(); close(); }}>
      {muted ? <Volume2 size={17} /> : <VolumeX size={17} />}{muted ? 'Unmute emotes' : 'Mute emotes'}
    </button>}
    {own ? <p className="emote-menu-note" role="status">{disabled ? 'Reconnect to an open table to emote.'
      : sending ? 'Sending...' : seconds > 0 ? `Next emote in ${seconds}s` : 'One emote every 3 seconds'}</p>
      : <p className="emote-menu-note">Only for you, in this browser and table.</p>}
    {own && error && <p className="emote-menu-error" role="alert">{error}</p>}
  </div>, document.body);
}
