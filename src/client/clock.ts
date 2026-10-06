import { useEffect, useState } from 'react';

export function useCountdown(deadline: number | null, timeOffset: number): number | null {
  const remaining = () => deadline === null ? null : Math.max(0, Math.ceil((deadline - Date.now() - timeOffset) / 1000));
  const [snapshot, setSnapshot] = useState(() => ({ deadline, timeOffset, seconds: remaining() }));
  useEffect(() => {
    const update = () => {
      const seconds = deadline === null ? null : Math.max(0, Math.ceil((deadline - Date.now() - timeOffset) / 1000));
      setSnapshot(previous => previous.deadline === deadline && previous.timeOffset === timeOffset && previous.seconds === seconds
        ? previous : { deadline, timeOffset, seconds });
      return seconds;
    };
    const seconds = update();
    if (seconds === null || seconds === 0) return;
    const interval = setInterval(() => { if (update() === 0) clearInterval(interval); }, 250);
    return () => clearInterval(interval);
  }, [deadline, timeOffset]);
  return snapshot.deadline === deadline && snapshot.timeOffset === timeOffset ? snapshot.seconds : remaining();
}
