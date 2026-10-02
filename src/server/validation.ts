import { z } from 'zod';
import { DEFAULT_SETTINGS } from '../shared/model.js';
import { isPlayerEmoji } from '../shared/emoji.js';

export const displayName = z.string().trim().min(2).max(24).regex(/^[^\u0000-\u001f\u007f]+$/, 'Use printable characters.');
const amount = z.number().int().min(1).max(10_000_000);
export const handRulesSchema = z.object({
  game: z.enum(['holdem', 'omaha', 'omaha_bomb', 'indian']),
  bombAnte: amount,
  indianAnte: amount,
  omahaAnte: amount,
  sevenDeuceBounty: z.number().int().min(0).max(10_000_000),
  maxRunouts: z.union([z.literal(1), z.literal(2), z.literal(3)]),
});
export const settingsSchema = z.object({
  smallBlind: amount.default(DEFAULT_SETTINGS.smallBlind),
  bigBlind: amount.default(DEFAULT_SETTINGS.bigBlind),
  ante: z.number().int().min(0).max(10_000_000).default(0),
  minBuyIn: amount.default(DEFAULT_SETTINGS.minBuyIn),
  maxBuyIn: amount.default(DEFAULT_SETTINGS.maxBuyIn),
  chipValueCents: z.number().int().min(1).max(10000).default(1),
  currency: z.enum(['USD', 'EUR', 'GBP', 'CAD']).default('USD'),
  maxSeats: z.number().int().min(2).max(9).default(9),
  turnSeconds: z.number().int().min(15).max(120).default(45),
  autoDeal: z.boolean().default(true),
  allowRebuys: z.boolean().default(true),
});
export const commandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('deal') }),
  z.object({ type: z.literal('act'), action: z.enum(['fold', 'check', 'call', 'raise']), amount: z.number().int().min(1).max(1_000_000_000).optional() }),
  z.object({ type: z.literal('fund'), amount }),
  z.object({ type: z.literal('approve'), requestId: z.string().uuid(), approve: z.boolean() }),
  z.object({ type: z.literal('cash_out') }),
  z.object({ type: z.literal('sit_out'), value: z.boolean() }),
  z.object({ type: z.literal('pause'), value: z.boolean() }),
  z.object({ type: z.literal('settings'), smallBlind: amount, bigBlind: amount, ante: z.number().int().min(0).max(10_000_000), autoDeal: z.boolean(), turnSeconds: z.number().int().min(15).max(120), allowRebuys: z.boolean(), minBuyIn: amount.optional() }),
  z.object({ type: z.literal('next_hand'), rules: handRulesSchema }),
  z.object({ type: z.literal('runouts'), handId: z.string().uuid(), count: z.union([z.literal(1), z.literal(2), z.literal(3)]) }),
  z.object({ type: z.literal('add_bot'), name: displayName.optional() }),
  z.object({ type: z.literal('fund_bot'), playerId: z.string().min(1).max(80), amount }),
  z.object({ type: z.literal('remove_bot'), playerId: z.string().max(80) }),
  z.object({ type: z.literal('transfer_host'), playerId: z.string().uuid() }),
  z.object({ type: z.literal('close') }),
  z.object({ type: z.literal('emoji'), emoji: z.string().max(16).refine(isPlayerEmoji, 'Choose an emoji from the picker.').nullable() }),
  z.object({ type: z.literal('chat'), message: z.string().trim().min(1).max(240).regex(/^[^\u0000-\u001f\u007f]+$/) }),
]);
export const commandEnvelope = z.object({
  commandId: z.string().uuid(),
  expectedVersion: z.number().int().nonnegative(),
  command: commandSchema,
});
export const createSchema = z.object({
  name: z.string().trim().min(2).max(60),
  buyIn: amount,
  settings: settingsSchema,
  commandId: z.string().uuid(),
  hostKey: z.string().max(256).optional(),
});
