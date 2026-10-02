import type { Command, Identity, RoomView } from '../shared/model';

export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}
let csrf = '';
export function useIdentity(user: Identity | null) { csrf = user?.csrf ?? ''; }
export async function api<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', signal,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result: unknown = await response.json();
  if (!response.ok) throw new ApiError(
    typeof result === 'object' && result && 'error' in result && typeof result.error === 'string'
      ? result.error : `Request failed (${response.status}).`, response.status);
  return result as T;
}
export const getRoom = (id: string) => api<{ room: RoomView }>(`/rooms/${encodeURIComponent(id)}`);
export async function repeatable<T>(path: string, body: object): Promise<T> {
  try { return await api<T>(path, body); }
  catch (error) {
    if (error instanceof ApiError) throw error;
    // Only a transport failure is retried; the same command key makes a lost response harmless.
    await new Promise(resolve => setTimeout(resolve, 700));
    return api<T>(path, body);
  }
}
export function submit(room: RoomView, command: Command) {
  return repeatable<{ room: RoomView; duplicate: boolean }>(
    `/rooms/${encodeURIComponent(room.id)}/commands`,
    { commandId: crypto.randomUUID(), expectedVersion: room.version, command });
}
