interface Point { x: number; y: number }
interface Box { left: number; top: number; right: number; bottom: number }
const center = (box: Box): Point => ({ x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 });
const overlaps = (a: Box, b: Box, gap = 5) =>
  a.left < b.right + gap && a.right > b.left - gap && a.top < b.bottom + gap && a.bottom > b.top - gap;

export function positionWagers(table: HTMLElement) {
  const pot = table.querySelector<HTMLElement>('[data-motion-pot]');
  if (!pot) return;
  const bounds = table.getBoundingClientRect();
  const middle = center(pot.getBoundingClientRect());
  const obstacles = [...table.querySelectorAll<HTMLElement>('.seat-panel, .seat-cards, .seat-cards .playing-card, .seat-avatar-wrap, .community, [data-motion-deck]')]
    .map(element => element.getBoundingClientRect());
  const seats = [...table.querySelectorAll<HTMLElement>('.seat')].flatMap(seat => {
    const wager = seat.querySelector<HTMLElement>('[data-motion-wager]');
    const stack = seat.querySelector<HTMLElement>('[data-motion-stack]');
    return wager && stack ? [{ seat, wager, origin: center(stack.getBoundingClientRect()) }] : [];
  });
  const placements = seats.filter(({ wager }) => Number(wager.dataset.wagerAmount) > 0).map(item => {
    const size = item.wager.getBoundingClientRect();
    const direction = Math.atan2(middle.y - item.origin.y, middle.x - item.origin.x);
    const otherSeats = seats.filter(other => other !== item);
    const candidates: Array<{ point: Point; box: Box; score: number }> = [];
    // Find the nearest clear spot on the felt facing the pot, rather than relying
    // on fixed offsets that overlap cards or neighboring seats at small widths.
    for (let distance = 24; distance <= 280; distance += 8) {
      for (const degrees of [0, -15, 15, -30, 30, -45, 45, -60, 60, -75, 75, -90, 90]) {
        const angle = direction + degrees * Math.PI / 180;
        const point = { x: item.origin.x + Math.cos(angle) * distance, y: item.origin.y + Math.sin(angle) * distance };
        const box = { left: point.x - size.width / 2, right: point.x + size.width / 2,
          top: point.y - size.height / 2, bottom: point.y + size.height / 2 };
        if (box.left < Math.max(0, bounds.left) + 4 || box.right > Math.min(innerWidth, bounds.right) - 4 ||
          box.top < bounds.top + 4 || box.bottom > bounds.bottom - 4 || obstacles.some(obstacle => overlaps(box, obstacle))) continue;
        let nearestOther = Infinity;
        for (const other of otherSeats)
          nearestOther = Math.min(nearestOther, Math.hypot(other.origin.x - point.x, other.origin.y - point.y));
        candidates.push({ point, box, score: distance + Math.abs(degrees) * .7 + Math.max(0, distance - nearestOther) * 2 });
      }
    }
    candidates.sort((a, b) => a.score - b.score);
    const seatSize = item.seat.getBoundingClientRect();
    return { ...item, candidates, size: seatSize, scaleX: seatSize.width / item.seat.offsetWidth, scaleY: seatSize.height / item.seat.offsetHeight };
  });
  const occupied: Box[] = [];
  // Place the most constrained seats first so a neighboring pile cannot take
  // the only free space beside a narrow/mobile seat.
  placements.sort((a, b) => a.candidates.length - b.candidates.length);
  const positions = placements.map(item => {
    const candidate = item.candidates.find(position => occupied.every(other => !overlaps(position.box, other)));
    if (!candidate) {
      console.warn('No clear space for a street wager. Keeping its seat-relative position.');
      return null;
    }
    occupied.push(candidate.box);
    return { item, point: candidate.point };
  });
  for (const position of positions) {
    if (!position) continue;
    const { item, point } = position;
    item.wager.style.left = `${(point.x - item.size.left) / item.scaleX}px`;
    item.wager.style.top = `${(point.y - item.size.top) / item.scaleY}px`;
  }
}
