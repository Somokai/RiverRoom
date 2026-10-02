import { useEffect, useRef, useState } from 'react';
import { Search, Smile, X } from 'lucide-react';
import { EMOJI_GROUPS, findPlayerEmoji } from '../shared/emoji';
import { Modal, PlayerEmoji } from './ui';

export function EmojiPicker({ value, disabled, error, choose, close }: {
  value: string | null | undefined; disabled: boolean; error: string;
  choose: (emoji: string | null) => Promise<boolean>; close: () => void;
}) {
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('All');
  const searchInput = useRef<HTMLInputElement>(null);
  useEffect(() => { searchInput.current?.focus(); }, []);
  const query = search.trim().toLowerCase();
  const groups = EMOJI_GROUPS.filter(group => category === 'All' || group.name === category)
    .map(group => ({
      ...group,
      choices: group.choices.filter(choice => `${choice.label} ${choice.keywords} ${choice.value}`.toLowerCase().includes(query)),
    })).filter(group => group.choices.length > 0);
  const count = groups.reduce((total, group) => total + group.choices.length, 0);
  const selected = findPlayerEmoji(value);
  const select = (emoji: string | null) => {
    void choose(emoji).then(ok => { if (ok) close(); });
  };

  return <Modal title="Choose your table emoji" subtitle="A little personality beside your name. Only for this table, visible to everyone." close={close}>
    {error && <div className="error-banner" role="alert">{error}</div>}
    <label className="emoji-search"><Search size={18} aria-hidden="true" /><input ref={searchInput} type="search" aria-label="Search emojis"
      placeholder="Search emojis..." value={search} onChange={event => { setSearch(event.target.value); setCategory('All'); }} /></label>
    <div className="emoji-categories" role="group" aria-label="Emoji categories">
      {['All', ...EMOJI_GROUPS.map(group => group.name)].map(name => <button type="button" key={name}
        className="preset-button" aria-pressed={category === name} onClick={() => { setCategory(name); setSearch(''); }}>{name}</button>)}
    </div>
    <p className="emoji-count" role="status">{count ? `${count} emojis` : 'No emojis found. Try another search.'}</p>
    <div className="emoji-results">
      {groups.map(group => <section className="emoji-group" key={group.name} aria-label={group.name}>
        <h3>{group.name}</h3><div className="emoji-grid">{group.choices.map(choice => <button type="button" className="emoji-choice"
          key={choice.value} title={choice.label} aria-label={`Choose ${choice.label}`} aria-pressed={value === choice.value}
          disabled={disabled} onClick={() => select(choice.value)}><span aria-hidden="true">{choice.value}</span></button>)}</div>
      </section>)}
    </div>
    <div className="emoji-footer"><span>{selected ? <><PlayerEmoji value={value} />{selected.label}</> : <><Smile size={18} />No emoji selected</>}</span>
      <button type="button" className="text-button" disabled={disabled || !selected} onClick={() => select(null)}><X size={15} /> Remove emoji</button></div>
  </Modal>;
}
