import type { RoomView, Street } from '../shared/model';

export interface Premove {
  action: 'check' | 'check_fold';
  roomId: string;
  handId: string;
  street: Street;
  youId: string;
}

export function canPremove(room: RoomView): boolean {
  const hero = room.players.find(player => player.id === room.youId);
  return room.status === 'open' && !room.paused && !!room.hand && room.hand.street !== 'complete' &&
    room.hand.actorId !== null && !room.hand.runoutVote && !!hero?.hand && !hero.hand.folded &&
    hero.stack > 0 && hero.seat !== null;
}

export function resolvePremove(premove: Premove, room: RoomView, connected: boolean): 'cancel' | 'wait' | 'check' | 'fold' {
  if (!connected || !canPremove(room) || premove.roomId !== room.id || premove.youId !== room.youId ||
      premove.handId !== room.hand?.id || premove.street !== room.hand.street ||
      (premove.action === 'check' && room.legal.toCall > 0)) return 'cancel';
  if (!room.legal.canAct) return 'wait';
  if (room.legal.canCheck) return 'check';
  return premove.action === 'check_fold' ? 'fold' : 'cancel';
}
