const DAY = 86400000;
export function milliseconds(value) {
  if (!value) return 0;
  return typeof value.toMillis === 'function' ? value.toMillis() : Number(value);
}
// Korean calendar days avoid date changes at the visitor's local midnight.
export const dayNumber = value => Math.floor((milliseconds(value) + 9 * 3600000) / DAY);
export function activitySeries(events, now = Date.now()) {
  const today = dayNumber(now);
  const valid = events.filter(event => milliseconds(event.createdAt) > 0).sort((a, b) => milliseconds(a.createdAt) - milliseconds(b.createdAt));
  let score = 0;
  let last = null;
  const points = [];
  for (let day = today - 13; day <= today; day++) {
    // Every point is recomputed from recorded events, never synthetic price data.
    score = 0;
    last = null;
    for (const event of valid) {
      const eventDay = dayNumber(event.createdAt);
      if (eventDay > day) continue;
      score += event.type === 'contribution' ? 5 : 1;
      last = last === null ? eventDay : Math.max(last, eventDay);
    }
    const quietDays = last === null ? 0 : Math.max(0, day - last - 7);
    points.push({ day, value: Math.min(100, score) * 0.94 ** quietDays });
  }
  return points;
}
export function activityLabel(idea, now = Date.now()) {
  if (!idea.interestCount && !idea.contributionCount) return '첫 보탬을 기다려요';
  return dayNumber(now) - dayNumber(idea.lastActivityAt) > 7 ? '잠시 조용해요' : '함께 자라는 중';
}
