import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activitySeries, dayNumber } from '../src/activity.js';

test('마지막 활동 후 7일 유지하고 8일째부터 낮아진다', () => {
  const now = Date.parse('2026-11-20T12:00:00+09:00');
  const points = activitySeries([{ type: 'contribution', createdAt: Date.parse('2026-11-12T12:00:00+09:00') }], now);
  const at = date => points.find(point => point.day === dayNumber(Date.parse(date))).value;
  assert.equal(at('2026-11-19T12:00:00+09:00'), 5);
  assert.ok(Math.abs(at('2026-11-20T12:00:00+09:00') - 4.7) < 1e-9);
});
test('활동이 없으면 그래프를 임의로 올리지 않고, 새 보탬은 실제 기록에 반영한다', () => {
  const now = Date.now();
  assert.ok(activitySeries([], now).every(point => point.value === 0));
  const values = activitySeries([{ type: 'interest', createdAt: now }, { type: 'contribution', createdAt: now }], now);
  assert.equal(values.at(-1).value, 6);
  assert.equal(values.at(-2).value, 0);
});
