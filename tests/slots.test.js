import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateSlots, zonedToUtcMs, localParts, coveredSlots, todayIn } from '../lib/slots.js';

test('wall-clock times convert to UTC across timezones', () => {
  assert.equal(new Date(zonedToUtcMs('2026-10-13', 14 * 60, 'America/New_York')).toISOString(), '2026-10-13T18:00:00.000Z');
  assert.equal(new Date(zonedToUtcMs('2026-10-13', 14 * 60, 'Europe/London')).toISOString(), '2026-10-13T13:00:00.000Z');
  assert.equal(new Date(zonedToUtcMs('2026-10-13', 9 * 60, 'Asia/Kolkata')).toISOString(), '2026-10-13T03:30:00.000Z');
});

test('slots follow the local clock through a DST change', () => {
  // US clocks fall back on Nov 1 2026: 9am EDT is 13:00Z, 9am EST is 14:00Z.
  const slots = generateSlots({ startDate: '2026-10-31', days: 2, dayStartMin: 540, dayEndMin: 600, tz: 'America/New_York' });
  assert.deepEqual(slots, [
    '2026-10-31T13:00:00.000Z', '2026-10-31T13:30:00.000Z',
    '2026-11-01T14:00:00.000Z', '2026-11-01T14:30:00.000Z',
  ]);
});

test('generates day × time slots, sorted and unique', () => {
  const slots = generateSlots({ startDate: '2026-10-12', days: 7, dayStartMin: 480, dayEndMin: 1200, tz: 'UTC' });
  assert.equal(slots.length, 7 * 24);
  assert.deepEqual([...slots].sort(), slots);
  assert.equal(new Set(slots).size, slots.length);
});

test('localParts and coveredSlots', () => {
  assert.deepEqual(localParts('2026-10-13T18:00:00.000Z', 'America/New_York'), { date: '2026-10-13', minutes: 840, weekday: 'Tue' });
  assert.deepEqual(coveredSlots('2026-10-13T18:00:00.000Z', 90), ['2026-10-13T18:00:00.000Z', '2026-10-13T18:30:00.000Z', '2026-10-13T19:00:00.000Z']);
  assert.equal(todayIn('Pacific/Auckland', Date.parse('2026-10-11T12:00:00Z')), '2026-10-12');
});
