import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { initializeTestEnvironment, assertFails } from '@firebase/rules-unit-testing';
import { doc, collection, getDoc, getDocs, setDoc, updateDoc, deleteDoc, query, limit, serverTimestamp, Timestamp, writeBatch, increment } from 'firebase/firestore';
import * as api from '../src/data.js';
let env, owner, peer, outsider, visitor, id;
const a = { uid: 'owner', name: '생각주인' }, b = { uid: 'peer', name: '보태는이' };
const plan = { title: '작은 실험 모임', audience: '함께 배울 부모', firstStep: '한 번 해보고 경험 나누기' };
const inbox = store => collection(store.db, 'profiles', a.uid, 'notifications');
before(async () => { env = await initializeTestEnvironment({ projectId: 'demo-saenggak-exchange', firestore: { host: '127.0.0.1', port: 8080, rules: await readFile(new URL('../firestore.rules', import.meta.url), 'utf8') } }); });
after(async () => env?.cleanup());
beforeEach(async () => {
  await env.clearFirestore();
  owner = { db: env.authenticatedContext(a.uid).firestore() }; peer = { db: env.authenticatedContext(b.uid).firestore() }; outsider = { db: env.authenticatedContext('outsider').firestore() }; visitor = { db: env.unauthenticatedContext().firestore() };
  for (const [store, person] of [[owner, a], [peer, b]]) await setDoc(doc(store.db, 'profiles', person.uid), { displayName: person.name, createdAt: serverTimestamp() });
  id = await api.createIdea(owner, a, { title: '아이와 함께 미래 준비하기', body: '', topic: '아이의 내일' });
});
function tracker(store, uid, unread = false) {
  let latest = [], cursor, more, error;
  const waiters = new Set();
  const stop = (unread ? api.watchUnreadNotifications : api.watchNotifications)(store, uid, (rows, last, hasMore) => { latest = rows; cursor = last; more = hasMore; waiters.forEach(fn => fn()); }, err => { error = err; waiters.forEach(fn => fn()); });
  return { stop, get cursor() { return cursor; }, get more() { return more; }, until(predicate) { return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiters.delete(check); reject(new Error('알림 대기 시간 초과')); }, 10000);
    function check() { if (!error && !predicate(latest)) return; clearTimeout(timer); waiters.delete(check); error ? reject(error) : resolve(latest); }
    waiters.add(check); check();
  }); } };
}
test('보탬·구체화·답글마다 글쓴이에게 정확히 하나의 알림이 오고 본인은 제외된다', async () => {
  const stream = tracker(owner, a.uid, true);
  try {
    const cid = await api.addContribution(peer, b, id, { kind: '경험', text: '함께 관찰해봤어요' });
    const rows = await stream.until(rows => rows.length === 1);
    assert.equal(rows[0].itemId, cid); assert.equal(rows[0].actorName, b.name); assert.equal(rows[0].text, '함께 관찰해봤어요');
    assert.equal(rows[0].ideaTitle, '아이와 함께 미래 준비하기'); assert.equal(rows[0].readAt, null);
    await api.addContribution(owner, a, id, { kind: '제안', text: '내가 이어 쓴 생각' });
    const rid = await api.addRefinement(peer, b, id, plan);
    await api.addContribution(peer, b, id, { kind: '질문', text: '구체화안에도 보태요', refinementId: rid });
    await api.addContribution(peer, b, id, { kind: '경험', text: '답글도 알려요', replyTo: cid });
    const all = await stream.until(rows => rows.length === 4);
    assert.equal(all.filter(row => row.type === 'refinement').length, 1);
    assert.equal(all.find(row => row.type === 'refinement').itemId, rid);
    assert.ok(all.every(row => row.actorId === b.uid));
  } finally { stream.stop(); }
});
test('접속하지 않을 때도 알림이 저장되고 다른 기기의 읽음 상태와 동기화된다', async () => {
  const cid = await api.addContribution(peer, b, id, { kind: '질문', text: '부재 중 도착' });
  const key = `${id}_contribution_${cid}`, otherDevice = { db: env.authenticatedContext(a.uid).firestore() };
  const unread = tracker(owner, a.uid, true);
  try {
    await unread.until(rows => rows.length === 1);
    await api.readNotification(otherDevice, a.uid, key);
    await unread.until(rows => rows.length === 0);
    assert.ok((await getDoc(doc(inbox(owner), key))).data().readAt.toMillis() > 0);
    await api.addContribution(peer, b, id, { kind: '경험', text: '읽은 뒤 새로 도착' });
    await unread.until(rows => rows.length === 1 && rows[0].itemId !== cid);
  } finally { unread.stop(); }
});
test('알림은 수신자만 읽고 읽음으로 바꿀 수 있고 내용을 위조하거나 삭제할 수 없다', async () => {
  const cid = await api.addContribution(peer, b, id, { kind: '제안', text: '진짜 내용' });
  const key = `${id}_contribution_${cid}`, data = (await getDoc(doc(inbox(owner), key))).data();
  for (const store of [peer, outsider, visitor]) {
    await assertFails(getDoc(doc(inbox(store), key))); await assertFails(getDocs(query(inbox(store), limit(20))));
    await assertFails(api.readNotification(store, a.uid, key));
  }
  await assertFails(getDocs(inbox(owner)));
  await assertFails(updateDoc(doc(inbox(owner), key), { text: '알림 변조' }));
  await assertFails(updateDoc(doc(inbox(owner), key), { readAt: Timestamp.fromMillis(0) }));
  await assertFails(deleteDoc(doc(inbox(owner), key)));
  await assertFails(setDoc(doc(peer.db, 'profiles', 'outsider', 'notifications', key), { ...data, createdAt: serverTimestamp() }));
  await assertFails(setDoc(doc(inbox(peer), 'fake'), { ...data, itemId: 'missing', createdAt: serverTimestamp() }));
  await assertFails(setDoc(doc(inbox(peer), key), { ...data, createdAt: serverTimestamp() }));
});
test('보탬 저장과 알림 전달은 함께 성공하며 허위·누락 알림은 거부된다', async () => {
  for (const tamper of ['missing', 'text', 'recipient']) {
    const batch = writeBatch(peer.db), cid = `invalid-${tamper}`;
    batch.set(doc(peer.db, 'ideas', id, 'contributions', cid), { kind: '제안', text: '실제 보탬', refinementId: '', replyTo: '', authorId: b.uid, authorName: b.name, createdAt: serverTimestamp() });
    batch.update(doc(peer.db, 'ideas', id), { contributionCount: increment(1), lastContributionId: cid, lastActivityAt: serverTimestamp() });
    if (tamper !== 'missing') batch.set(doc(peer.db, 'profiles', tamper === 'recipient' ? 'outsider' : a.uid, 'notifications', `${id}_contribution_${cid}`), { ideaId: id, itemId: cid, type: 'contribution', actorId: b.uid, actorName: b.name, ideaTitle: '아이와 함께 미래 준비하기', text: tamper === 'text' ? '가짜 내용' : '실제 보탬', createdAt: serverTimestamp(), readAt: null });
    await assertFails(batch.commit());
    assert.equal((await getDoc(doc(owner.db, 'ideas', id, 'contributions', cid))).exists(), false);
  }
});
test('오래된 알림은 페이지로 이어 읽고 안 읽은 알림 50개가 한꺼번에 사라지지 않는다', async () => {
  await env.withSecurityRulesDisabled(async ctx => {
    const batch = writeBatch(ctx.firestore());
    for (let n = 0; n < 57; n++) batch.set(doc(ctx.firestore(), 'profiles', a.uid, 'notifications', `n${String(n).padStart(2, '0')}`), { ideaId: id, itemId: `item${n}`, type: 'contribution', actorId: b.uid, actorName: b.name, ideaTitle: '페이지 시험', text: String(n), createdAt: Timestamp.fromMillis(1000 + n), readAt: n === 56 ? Timestamp.fromMillis(2000) : null });
    await batch.commit();
  });
  const recent = tracker(owner, a.uid), unread = tracker(owner, a.uid, true);
  try {
    const first = await recent.until(rows => rows.length === 20);
    assert.equal(first[0].text, '56'); assert.equal(recent.more, true);
    const second = await api.olderNotifications(owner, a.uid, recent.cursor);
    const third = await api.olderNotifications(owner, a.uid, second.cursor);
    assert.equal(new Set([...first, ...second.rows, ...third.rows].map(row => row.id)).size, 57);
    assert.equal(third.more, false);
    await unread.until(rows => rows.length === 50);
    for (let n = 0; n < 7; n++) await api.readNotification(owner, a.uid, `n${String(n).padStart(2, '0')}`);
    const remaining = await unread.until(rows => rows.length === 49);
    assert.ok(remaining.every(row => Number(row.text) >= 7));
  } finally { recent.stop(); unread.stop(); }
});
