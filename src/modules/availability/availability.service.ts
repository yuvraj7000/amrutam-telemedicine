import {
  ConflictError,
  ERROR_CODES,
  ForbiddenError,
  ValidationError,
} from '../../common/errors/index.js';
import type { AuthUser } from '../../common/middleware/auth.js';
import type { AvailabilityRepository, SlotRow } from './availability.repository.js';
import type { CreateSlotsInput } from './availability.schemas.js';

export class AvailabilityService {
  constructor(private readonly repository: AvailabilityRepository) {}
  async create(
    user: AuthUser,
    input: CreateSlotsInput,
    key?: string,
  ): Promise<{ created: number; skipped: { start: string; reason: string }[]; replay: boolean }> {
    if (user.role !== 'DOCTOR') throw new ForbiddenError();
    const slots =
      'slots' in input
        ? input.slots.map((item) => ({ start: new Date(item.start), end: new Date(item.end) }))
        : expandRecurrence(input.recurrence);
    if (slots.length > 200) throw new ValidationError('A request may create at most 200 slots.');
    const now = Date.now();
    if (slots.some((slot) => slot.end <= slot.start || slot.start.getTime() <= now)) {
      throw new ValidationError('Slots must have a positive duration and start in the future.');
    }
    if (slots.some((slot) => slot.end.getTime() - slot.start.getTime() > 4 * 60 * 60 * 1000)) {
      throw new ValidationError('A slot cannot be longer than 4 hours.');
    }
    return this.repository.createSlots(user.id, slots, key, input);
  }
  async listMine(
    user: AuthUser,
    from: string,
    to: string,
    status?: string,
  ): Promise<Record<string, unknown>> {
    if (user.role !== 'DOCTOR') throw new ForbiddenError();
    const rows = await this.repository.listDoctorSlots(user.id, from, to, status);
    return { data: rows.map(slotDto), meta: { limit: rows.length, nextCursor: null } };
  }
  async publicAvailability(
    doctorId: string,
    from: string,
    to: string,
  ): Promise<Record<string, unknown>> {
    const rows = await this.repository.publicAvailability(doctorId, from, to);
    return {
      doctorId,
      timezone: 'UTC',
      slots: rows.map((row) => ({ id: row.id, start: row.start_time, end: row.end_time })),
    };
  }
  async delete(user: AuthUser, slotId: string): Promise<void> {
    if (user.role !== 'DOCTOR') throw new ForbiddenError();
    const deleted = await this.repository.deleteAvailableSlot(user.id, slotId);
    if (deleted) return;
    throw new ConflictError(ERROR_CODES.SLOT_NOT_DELETABLE);
  }
}

function slotDto(row: SlotRow): Record<string, unknown> {
  return { id: row.id, start: row.start_time, end: row.end_time, status: row.status };
}

function expandRecurrence(
  value: Extract<CreateSlotsInput, { recurrence: unknown }>['recurrence'],
): { start: Date; end: Date }[] {
  const from = new Date(`${value.from}T00:00:00Z`);
  const to = new Date(`${value.to}T00:00:00Z`);
  const days = Math.floor((to.getTime() - from.getTime()) / 86_400_000);
  if (days < 0 || days > 30)
    throw new ValidationError('Recurrence must span at most 31 calendar days.');
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value.timezone });
  } catch {
    throw new ValidationError('Unknown recurrence timezone.');
  }
  const slots: { start: Date; end: Date }[] = [];
  for (let day = 0; day <= days; day += 1) {
    const date = new Date(from.getTime() + day * 86_400_000);
    if (!value.daysOfWeek.includes(date.getUTCDay())) continue;
    const dateText = date.toISOString().slice(0, 10);
    for (const window of value.dailyWindows) {
      const startMinute = timeToMinutes(window.start);
      const endMinute = timeToMinutes(window.end);
      if (endMinute <= startMinute)
        throw new ValidationError('Daily window end must be after its start.');
      for (
        let minute = startMinute;
        minute + value.slotMinutes <= endMinute;
        minute += value.slotMinutes
      ) {
        slots.push({
          start: zonedTimeToUtc(dateText, minute, value.timezone),
          end: zonedTimeToUtc(dateText, minute + value.slotMinutes, value.timezone),
        });
        if (slots.length > 200)
          throw new ValidationError('A request may create at most 200 slots.');
      }
    }
  }
  return slots;
}

function timeToMinutes(value: string): number {
  const [hours, minutes] = value.split(':').map(Number);
  if (hours! > 23 || minutes! > 59)
    throw new ValidationError('Daily windows must use valid 24-hour times.');
  return hours! * 60 + minutes!;
}

function zonedTimeToUtc(date: string, minutes: number, timeZone: string): Date {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  const desired = Date.UTC(
    Number(date.slice(0, 4)),
    Number(date.slice(5, 7)) - 1,
    Number(date.slice(8, 10)),
    hour,
    minute,
  );
  let guess = desired;
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = Object.fromEntries(
      formatter.formatToParts(new Date(guess)).map((part) => [part.type, part.value]),
    );
    const represented = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
    );
    const correction = desired - represented;
    guess += correction;
    if (correction === 0) break;
  }
  if (!Number.isFinite(guess)) throw new ValidationError('Invalid recurrence time.');
  return new Date(guess);
}
