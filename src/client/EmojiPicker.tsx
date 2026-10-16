import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Search, Smile, X } from 'lucide-react';
import { EMOJI_GROUPS, findPlayerEmoji } from '../shared/emoji';
import { Modal, PlayerEmoji } from './ui';

const categories = ['All', ...EMOJI_GROUPS.map(group => group.name)];
const searchText = new Map(EMOJI_GROUPS.flatMap(group => group.choices.map(choice =>
  [choice.value, `${choice.label} ${choice.keywords} ${choice.value}`.toLowerCase()] as const)));

const EmojiGroup = memo(function EmojiGroup({ group, visible, value, disabled, select }: {
  group: (typeof EMOJI_GROUPS)[number]; visible: boolean; value: string | null | undefined; disabled: boolean;
  select: (emoji: string | null) => void;
}) {
  return <section className="emoji-group" aria-label={group.name}>
    <h3>{group.name}</h3><div className="emoji-grid">{group.choices.map(choice => <button type="button" className="emoji-choice"
      key={choice.value} title={choice.label} aria-label={`Choose ${choice.label}`} aria-pressed={value === choice.value}
      disabled={disabled} onClick={() => select(choice.value)}><span aria-hidden="true">{visible ? choice.value : ''}</span></button>)}</div>
  </section>;
});

const EmojiGrid = memo(function EmojiGrid({ groups, defer, value, disabled, select }: {
  groups: typeof EMOJI_GROUPS; defer: boolean; value: string | null | undefined; disabled: boolean;
  select: (emoji: string | null) => void;
}) {
  const results = useRef<HTMLDivElement>(null);
  const [visibleGroups, setVisibleGroups] = useState<ReadonlySet<string>>(() => new Set());
  const revealGroups = useCallback((names: string[]) => {
    setVisibleGroups(previous => names.every(name => previous.has(name)) ? previous : new Set([...previous, ...names]));
  }, []);
  useEffect(() => {
    if (!defer) return;
    const root = results.current!;
    const observer = new IntersectionObserver(entries => {
      const visible = entries.filter(entry => entry.isIntersecting);
      revealGroups(visible.flatMap(entry => {
        observer.unobserve(entry.target);
        const name = entry.target.getAttribute('aria-label');
        return name ? [name] : [];
      }));
    }, { root, rootMargin: '96px 0px' });
    for (const group of root.querySelectorAll('.emoji-group')) observer.observe(group);
    return () => observer.disconnect();
  }, [defer, groups, revealGroups]);
  return <div ref={results} className="emoji-results" onFocusCapture={event => {
    const name = event.target.closest('.emoji-group')?.getAttribute('aria-label');
    if (name) revealGroups([name]);
  }}>
    {groups.map((group, index) => <EmojiGroup key={group.name} group={group}
      visible={!defer || index === 0 || visibleGroups.has(group.name)} value={value} disabled={disabled} select={select} />)}
  </div>;
});

export function EmojiPicker({ value, disabled, error, choose, close }: {
  value: string | null | undefined; disabled: boolean; error: string;
  choose: (emoji: string | null) => Promise<boolean>; close: () => void;
}) {
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('All');
  const searchInput = useRef<HTMLInputElement>(null);
  const chooseRef = useRef(choose);
  chooseRef.current = choose;
  const select = useCallback((emoji: string | null) => { void chooseRef.current(emoji); }, []);
  useLayoutEffect(() => { searchInput.current?.focus(); }, []);
  const query = search.trim().toLowerCase();
  const groups = useMemo(() => {
    const matching = EMOJI_GROUPS.filter(group => category === 'All' || group.name === category);
    return query ? matching.map(group => ({
      ...group, choices: group.choices.filter(choice => searchText.get(choice.value)!.includes(query)),
    })).filter(group => group.choices.length > 0) : matching;
  }, [category, query]);
  const count = groups.reduce((total, group) => total + group.choices.length, 0);
  const selected = findPlayerEmoji(value);

  return <Modal title="Choose your table emoji" subtitle="A little personality beside your name. Only for this table, visible to everyone." close={close}>
    {error && <div className="error-banner" role="alert">{error}</div>}
    <label className="emoji-search"><Search size={18} aria-hidden="true" /><input ref={searchInput} type="search" aria-label="Search emojis"
      placeholder="Search emojis..." value={search} onChange={event => { setSearch(event.target.value); setCategory('All'); }} /></label>
    <div className="emoji-categories" role="group" aria-label="Emoji categories">
      {categories.map(name => <button type="button" key={name}
        className="preset-button" aria-pressed={category === name} onClick={() => { setCategory(name); setSearch(''); }}>{name}</button>)}
    </div>
    <p className="emoji-count" role="status">{count ? `${count} emojis` : 'No emojis found. Try another search.'}</p>
    <EmojiGrid groups={groups} defer={category === 'All' && !query} value={value} disabled={disabled} select={select} />
    <div className="emoji-footer"><span>{selected ? <><PlayerEmoji value={value} />{selected.label}</> : <><Smile size={18} />No emoji selected</>}</span>
      <button type="button" className="text-button" disabled={disabled || !selected} onClick={() => select(null)}><X size={15} /> Remove emoji</button></div>
  </Modal>;
}
