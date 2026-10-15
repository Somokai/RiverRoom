import { useEffect, useState } from 'react';

export type MotionPreference = 'system' | 'on' | 'off';
const storageKey = 'river-room:table-motion';
function readPreference(): { setting: MotionPreference; error: string } {
  try {
    const setting = localStorage.getItem(storageKey) ?? 'system';
    if (setting === 'system' || setting === 'on' || setting === 'off') return { setting, error: '' };
    return { setting: 'system', error: 'The saved animation preference is invalid. Following your system setting.' };
  } catch (error) {
    if (!(error instanceof DOMException)) throw error;
    return { setting: 'system', error: 'The animation preference could not be loaded. Following your system setting.' };
  }
}

export function useMotionPreference() {
  const [initial] = useState(readPreference);
  const [setting, setSetting] = useState(initial.setting);
  const [error, setError] = useState(initial.error);
  const [reduced, setReduced] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const query = matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(query.matches);
    query.addEventListener('change', update);
    update();
    return () => query.removeEventListener('change', update);
  }, []);
  const change = (next: MotionPreference) => {
    setSetting(next); setError('');
    try { localStorage.setItem(storageKey, next); }
    catch (reason) {
      if (!(reason instanceof DOMException)) throw reason;
      setError('Animations changed for this visit, but the preference could not be saved in this browser.');
    }
  };
  return { setting, change, error, enabled: setting === 'on' || (setting === 'system' && !reduced) };
}
