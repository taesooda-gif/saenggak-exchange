import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, writeBatch, query, where, limit, serverTimestamp, deleteField, Timestamp } from 'firebase/firestore';
import * as api from '../src/data.js';

let env, alice, bob, eve, visitor, id;
const personA = { uid: 'alice', name: '도토리' }, personB = { uid: 'bob', name: '달팽이' };
before(async () => {
  env = await initializeTestEnvironment({ projectId: 'demo-saenggak-exchange', firestore: { rules: await readFile(new URL('../firestore.rules', import.meta.url), 'utf8'), host: '127.0.0.1', port: 8080 } });
});
after(async () => env?.cleanup());
beforeEach(async () => {
  await env.clearFirestore();
  alice = { db: env.authenticatedContext('alice').firestore() };
  bob = { db: env.authenticatedContext('bob').firestore() };
  eve = { db: env.authenticatedContext('eve').firestore() };
  visitor = { db: env.unauthenticatedContext().firestore() };
  await Promise.all([[alice, personA], [bob, personB], [eve, { uid: 'eve', name: '방문자' }]].map(([store, person]) => setDoc(doc(store.db, 'profiles', person.uid), { displayName: person.name, createdAt: serverTimestamp() })));
  id = await api.createIdea(alice, personA, { title: '어른들의 일을 소개해요', body: '각자의 경험을 모아볼까요?', topic: '아이의 내일' });
});
test('비로그인 방문자는 글을 읽을 수 있지만 글을 쓰거나 무제한 조회할 수 없다', async () => {
  const result = await assertSucceeds(getDocs(query(collection(visitor.db, 'ideas'), limit(20))));
  assert.equal(result.size, 1);
  await assertFails(getDocs(collection(visitor.db, 'ideas')));
  await assertFails(api.createIdea(visitor, personA, { title: '사칭', body: '', topic: '나의 다음 일' }));
  await assertFails(api.createIdea(bob, personA, { title: '사칭', body: '', topic: '나의 다음 일' }));
});
test('보탬은 해당 글에 원자적으로 기록되며 수치 조작과 원문 변경을 거부한다', async () => {
  await assertSucceeds(api.addContribution(bob, personB, id, { kind: '제안', text: '한 가지씩 적어봐요.' }));
  assert.equal((await getDoc(doc(alice.db, 'ideas', id))).data().contributionCount, 1);
  assert.equal((await api.loadActivity(visitor, id)).length, 1);
  await assertFails(updateDoc(doc(bob.db, 'ideas', id), { contributionCount: 500 }));
  await assertFails(updateDoc(doc(bob.db, 'ideas', id), { title: '다른 글로 변경' }));
  await assertFails(setDoc(doc(bob.db, 'ideas', id, 'contributions', 'unpaired'), { authorId: 'bob', authorName: '달팽이', kind: '경험', text: '통계 없이 직접 쓰기', createdAt: serverTimestamp() }));
});
test('동시에 보탬을 남겨도 개수가 유실되지 않는다', async () => {
  await Promise.all([api.addContribution(alice, personA, id, { kind: '경험', text: '내 경험' }), api.addContribution(bob, personB, id, { kind: '질문', text: '궁금해요' })]);
  assert.equal((await getDoc(doc(alice.db, 'ideas', id))).data().contributionCount, 2);
});
test('관심은 사용자당 하나이며 취소와 재등록으로 활동 기록을 부풀릴 수 없다', async () => {
  assert.equal(await api.toggleInterest(bob, 'bob', id), true);
  assert.equal((await getDoc(doc(alice.db, 'ideas', id))).data().interestCount, 1);
  assert.equal(await api.toggleInterest(bob, 'bob', id), false);
  assert.equal((await getDoc(doc(alice.db, 'ideas', id))).data().interestCount, 0);
  assert.equal(await api.toggleInterest(bob, 'bob', id), true);
  assert.equal((await api.loadActivity(visitor, id)).length, 1);
  await assertFails(api.toggleInterest(eve, 'bob', id));
});
test('대화는 초대 전에는 읽거나 쓸 수 없고, 글쓴이가 수락하면 가능하다', async () => {
  await assertFails(getDoc(doc(bob.db, 'rooms', id)));
  await assertFails(api.sendMessage(bob, personB, id, '초대 전 메시지'));
  await api.requestToJoin(bob, personB, id);
  await assertFails(api.decideRequest(eve, id, 'bob', true));
  await assertFails(updateDoc(doc(bob.db, 'rooms', id), { memberIds: ['alice', 'bob'], lastAddedId: 'bob' }));
  await assertSucceeds(api.decideRequest(alice, id, 'bob', true));
  await assertSucceeds(api.sendMessage(bob, personB, id, '함께해요'));
  const messages = await assertSucceeds(getDocs(query(collection(bob.db, 'rooms', id, 'messages'), limit(50))));
  assert.equal(messages.size, 1);
  await assertFails(getDocs(query(collection(eve.db, 'rooms', id, 'messages'), limit(50))));
  await assertFails(getDoc(doc(visitor.db, 'rooms', id)));
  const mine = await getDocs(query(collection(bob.db, 'rooms'), where('memberIds', 'array-contains', 'bob'), limit(20)));
  assert.equal(mine.size, 1);
});
test('프로필과 참여 신청은 본인과 필요한 담당자에게만 보인다', async () => {
  await assertFails(getDoc(doc(eve.db, 'profiles', 'alice')));
  await api.requestToJoin(bob, personB, id);
  await assertFails(api.getRequest(eve, id, 'bob'));
  await assertSucceeds(api.getRequest(alice, id, 'bob'));
  await assertFails(updateDoc(doc(alice.db, 'rooms', id), { memberIds: ['alice', 'eve'], lastAddedId: 'eve' }));
});

function inboxTracker(store, uid) {
  let groups = [], error, count = 0;
  const waiters = new Set();
  const notify = () => waiters.forEach(check => check());
  const stop = api.watchRequestInbox(store, uid, value => { groups = value; count++; notify(); }, value => { error = value; notify(); });
  return {
    stop,
    get count() { return count; },
    until(predicate) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { waiters.delete(check); reject(new Error('참여 신청 알림 대기 시간 초과')); }, 10000);
        function check() {
          if (!error && !predicate(groups)) return;
          clearTimeout(timer); waiters.delete(check);
          if (error) reject(error); else resolve(groups);
        }
        waiters.add(check); check();
      });
    },
  };
}

test('작성자 알림함은 글을 열지 않아도 신청과 수락·거절을 실시간 반영한다', async () => {
  const inbox = inboxTracker(alice, 'alice'), other = inboxTracker(bob, 'bob');
  try {
    await inbox.until(() => inbox.count > 0);
    await api.requestToJoin(bob, personB, id);
    const groups = await inbox.until(rows => rows[0]?.requests.length === 1);
    assert.equal(groups[0].title, '어른들의 일을 소개해요');
    assert.equal(groups[0].requests[0].authorName, '달팽이');
    await other.until(rows => other.count > 0 && rows.length === 0);
    await assertFails(getDocs(query(collection(bob.db, 'ideas', id, 'requests'), limit(20))));
    await api.decideRequest(alice, id, 'bob', true);
    await inbox.until(rows => rows.length === 0);
    assert.equal((await getDoc(doc(bob.db, 'rooms', id))).data().memberIds.length, 2);
    await api.requestToJoin(eve, { uid: 'eve', name: '방문자' }, id);
    await inbox.until(rows => rows[0]?.requests[0]?.authorId === 'eve');
    await api.decideRequest(alice, id, 'eve', false);
    await inbox.until(rows => rows.length === 0);
    await assertFails(getDoc(doc(eve.db, 'rooms', id)));
    inbox.stop(); const before = inbox.count;
    await api.updateIdea(alice, 'alice', { id, ...(await getDoc(doc(alice.db, 'ideas', id))).data() }, { title: '변경한 생각', body: '', topic: '아이의 내일' });
    assert.equal(inbox.count, before, '구독 종료 후 이전 계정의 알림을 전달하지 않는다');
  } finally { inbox.stop(); other.stop(); }
});

test('알림함은 20개를 넘는 내 글과 신청도 누락하거나 중복하지 않는다', async () => {
  await env.withSecurityRulesDisabled(async context => {
    const db = context.firestore();
    const batch = writeBatch(db);
    for (let i = 0; i < 23; i++) {
      const ideaId = `paged-${String(i).padStart(2, '0')}`;
      batch.set(doc(db, 'ideas', ideaId), { authorId: 'alice', title: ideaId });
      batch.set(doc(db, 'rooms', ideaId), { ownerId: 'alice', title: ideaId, memberIds: ['alice'] });
      for (let j = 0; j < (i === 22 ? 22 : 1); j++) {
        const uid = `guest-${String(j).padStart(2, '0')}`;
        batch.set(doc(db, 'ideas', ideaId, 'requests', uid), { authorId: uid, authorName: uid, status: 'pending', createdAt: Timestamp.now(), decidedAt: null });
      }
    }
    await batch.commit();
  });
  const inbox = inboxTracker(alice, 'alice');
  try {
    const groups = await inbox.until(rows => rows.length === 23 && rows.find(group => group.id === 'paged-22')?.requests.length === 22);
    assert.equal(new Set(groups.map(group => group.id)).size, 23);
    await api.decideRequest(alice, 'paged-22', 'guest-00', false);
    const shifted = await inbox.until(rows => rows.find(group => group.id === 'paged-22')?.requests.length === 21 && !rows.find(group => group.id === 'paged-22').requests.some(request => request.id === 'guest-00'));
    assert.equal(new Set(shifted.find(group => group.id === 'paged-22').requests.map(request => request.id)).size, 21);
    await env.withSecurityRulesDisabled(async context => {
      const db = context.firestore();
      await setDoc(doc(db, 'ideas', 'aaa-first'), { authorId: 'alice', title: '앞쪽에 새로 들어온 생각' });
      await setDoc(doc(db, 'ideas', 'aaa-first', 'requests', 'new-guest'), { authorId: 'new-guest', authorName: '새참여자', status: 'pending', createdAt: Timestamp.now(), decidedAt: null });
    });
    await inbox.until(rows => rows.length === 24 && rows.find(group => group.id === 'paged-22')?.requests.length === 21);
  } finally { inbox.stop(); }
});

test('알림을 보고 있는 중에 올린 새 글도 저장 완료 후 신청을 받는다', async () => {
  const inbox = inboxTracker(alice, 'alice');
  try {
    await inbox.until(() => inbox.count > 0);
    const newId = await api.createIdea(alice, personA, { title: '새로운 생각', body: '', topic: '생활 속 생각' });
    await api.requestToJoin(bob, personB, newId);
    const groups = await inbox.until(rows => rows.some(group => group.id === newId && group.requests.length === 1));
    assert.equal(groups.find(group => group.id === newId).requests[0].authorName, '달팽이');
  } finally { inbox.stop(); }
});

test('대화를 시작하면 공개 글에는 실제 참여 인원과 시간만 나타난다', async () => {
  await api.sendMessage(alice, personA, id, '참여자에게만 보이는 대화');
  const idea = (await getDoc(doc(visitor.db, 'ideas', id))).data();
  assert.equal(idea.participantCount, 1);
  assert.ok(idea.lastChatAt.toMillis() > 0);
  assert.ok(idea.lastChatMessageId);
  assert.ok(!JSON.stringify(idea).includes('참여자에게만 보이는 대화'));
  await assertFails(getDoc(doc(visitor.db, 'rooms', id, 'messages', idea.lastChatMessageId)));
  await api.requestToJoin(bob, personB, id);
  await api.decideRequest(alice, id, 'bob', true);
  assert.equal((await getDoc(doc(visitor.db, 'ideas', id))).data().participantCount, 2);
  await api.sendMessage(bob, personB, id, '같이 해볼 일을 정해요');
  assert.equal((await getDoc(doc(visitor.db, 'ideas', id))).data().participantCount, 2);
});

test('참여 인원이나 최근 대화 시간을 조작하거나 다른 모임에서 갱신할 수 없다', async () => {
  await api.sendMessage(alice, personA, id, '첫 대화');
  const idea = (await getDoc(doc(visitor.db, 'ideas', id))).data();
  await assertFails(updateDoc(doc(alice.db, 'ideas', id), { participantCount: 100 }));
  await assertFails(updateDoc(doc(alice.db, 'ideas', id), { lastChatAt: Timestamp.fromMillis(Date.now() + 86400000) }));
  await assertFails(updateDoc(doc(eve.db, 'ideas', id), { participantCount: 1 }));
  await assertFails(updateDoc(doc(eve.db, 'ideas', id), { lastChatAt: idea.lastChatAt, lastChatMessageId: idea.lastChatMessageId }));
  await assertFails(updateDoc(doc(alice.db, 'ideas', id), { lastChatAt: serverTimestamp(), lastChatMessageId: 'not-a-message' }));
  await api.sendMessage(alice, personA, id, '다음 대화');
  await assertFails(updateDoc(doc(alice.db, 'ideas', id), { lastChatAt: idea.lastChatAt, lastChatMessageId: idea.lastChatMessageId }));
});

test('기존 대화는 참여자가 접속하면 실제 기록에서 공개 활동 표시를 복구한다', async () => {
  await api.sendMessage(alice, personA, id, '이미 쓰여 있던 비공개 대화');
  const original = (await getDoc(doc(alice.db, 'ideas', id))).data();
  await env.withSecurityRulesDisabled(async context => updateDoc(doc(context.firestore(), 'ideas', id), {
    participantCount: deleteField(), lastChatAt: deleteField(), lastChatMessageId: deleteField(),
  }));
  await assertFails(api.refreshDiscussion(eve, id));
  await assertSucceeds(api.refreshDiscussion(alice, id));
  const repaired = (await getDoc(doc(visitor.db, 'ideas', id))).data();
  assert.equal(repaired.participantCount, 1);
  assert.equal(repaired.lastChatMessageId, original.lastChatMessageId);
  assert.equal(repaired.lastChatAt.toMillis(), original.lastChatAt.toMillis());
});

test('지정된 운영자만 글을 고정·교체·해제하며 닉네임 사칭이나 권한 자체 생성은 거부한다', async () => {
  await env.withSecurityRulesDisabled(context => setDoc(doc(context.firestore(), 'moderators', 'alice'), { canPin: true }));
  await updateDoc(doc(bob.db, 'profiles', 'bob'), { displayName: personA.name });
  await assertFails(api.pinIdea(visitor, id));
  await assertFails(api.pinIdea(bob, id));
  await assertFails(setDoc(doc(bob.db, 'moderators', 'bob'), { canPin: true }));
  await assertFails(setDoc(doc(alice.db, 'moderators', 'bob'), { canPin: true }));
  await assertFails(updateDoc(doc(alice.db, 'profiles', 'alice'), { canPin: true }));
  await assertSucceeds(api.pinIdea(alice, id));
  const setting = doc(visitor.db, 'settings', 'community');
  assert.equal((await getDoc(setting)).data().pinnedIdeaId, id);
  const second = await api.createIdea(eve, { uid: 'eve', name: '방문자' }, { title: '다음 공지', body: '', topic: '생활 속 생각' });
  await assertSucceeds(api.pinIdea(alice, second));
  assert.equal((await getDoc(setting)).data().pinnedIdeaId, second);
  // Pin authority grants no access to someone else's private chat or posts.
  await assertFails(getDoc(doc(alice.db, 'rooms', second)));
  await assertFails(updateDoc(doc(alice.db, 'ideas', second), { body: '변경' }));
  await assertFails(api.pinIdea(bob, ''));
  await assertSucceeds(api.pinIdea(alice, ''));
  assert.equal((await getDoc(setting)).data().pinnedIdeaId, '');
});

test('고정 설정은 존재하는 글만 허용하고 권한 정보와 다른 설정을 보호한다', async () => {
  await env.withSecurityRulesDisabled(context => setDoc(doc(context.firestore(), 'moderators', 'alice'), { canPin: true }));
  await assertSucceeds(getDoc(doc(alice.db, 'moderators', 'alice')));
  await assertFails(getDoc(doc(bob.db, 'moderators', 'alice')));
  await assertFails(getDocs(query(collection(alice.db, 'moderators'), limit(20))));
  await assertFails(api.pinIdea(alice, 'missing'));
  await assertFails(api.pinIdea(alice, 'rooms/private'));
  await assertFails(setDoc(doc(alice.db, 'settings', 'community'), { pinnedIdeaId: id, updatedAt: serverTimestamp(), admin: true }));
  await assertFails(setDoc(doc(alice.db, 'settings', 'community'), { pinnedIdeaId: id, updatedAt: Timestamp.fromMillis(0) }));
  await assertSucceeds(api.pinIdea(alice, id));
  await assertFails(deleteDoc(doc(alice.db, 'settings', 'community')));
  await assertFails(setDoc(doc(alice.db, 'settings', 'other'), { pinnedIdeaId: id }));
  await env.withSecurityRulesDisabled(context => updateDoc(doc(context.firestore(), 'moderators', 'alice'), { canPin: false }));
  await assertFails(api.pinIdea(alice, ''));
});

test('작성자는 글과 방 제목을 함께 수정하며 보탬·관심·참여자·대화·고정을 유지한다', async () => {
  await env.withSecurityRulesDisabled(context => setDoc(doc(context.firestore(), 'moderators', 'alice'), { canPin: true }));
  await api.pinIdea(alice, id);
  await api.addContribution(bob, personB, id, { kind: '제안', text: '함께 남긴 보탬' });
  await api.toggleInterest(bob, 'bob', id);
  await api.requestToJoin(bob, personB, id); await api.decideRequest(alice, id, 'bob', true);
  await api.sendMessage(bob, personB, id, '함께 남긴 대화');
  const ref = doc(alice.db, 'ideas', id), original = api.row(await getDoc(ref));
  const roomBefore = (await getDoc(doc(alice.db, 'rooms', id))).data();
  const activityBefore = await api.loadActivity(visitor, id);
  const updated = await assertSucceeds(api.updateIdea(alice, 'alice', original, { title: '수정한 생각', body: '추가한 설명', topic: '생활 속 생각' }));
  assert.equal(updated.title, '수정한 생각'); assert.equal(updated.body, '추가한 설명'); assert.equal(updated.topic, '생활 속 생각');
  assert.ok(updated.updatedAt.toMillis() > 0);
  for (const key of ['authorId', 'authorName', 'createdAt', 'lastActivityAt', 'interestCount', 'contributionCount', 'lastContributionId', 'participantCount', 'lastChatAt', 'lastChatMessageId']) assert.deepEqual(updated[key], original[key], key);
  const roomAfter = (await getDoc(doc(bob.db, 'rooms', id))).data();
  assert.deepEqual(roomAfter, { ...roomBefore, title: updated.title });
  assert.deepEqual(await api.loadActivity(visitor, id), activityBefore);
  assert.equal((await getDoc(doc(visitor.db, 'settings', 'community'))).data().pinnedIdeaId, id);
  assert.equal((await getDoc(doc(visitor.db, 'ideas', id, 'contributions', original.lastContributionId))).data().text, '함께 남긴 보탬');
  assert.equal((await getDoc(doc(bob.db, 'rooms', id, 'messages', original.lastChatMessageId))).data().text, '함께 남긴 대화');
  // Existing social actions continue to work after updatedAt is added.
  await assertSucceeds(api.addContribution(bob, personB, id, { kind: '경험', text: '수정된 생각에도 보태요' }));
  await assertSucceeds(api.sendMessage(bob, personB, id, '대화도 이어져요'));
  await assertSucceeds(api.toggleInterest(bob, 'bob', id));
});

test('같은 닉네임·참여자·운영자도 남의 글을 수정하거나 수정에 다른 권한 변경을 섞을 수 없다', async () => {
  const ref = doc(alice.db, 'ideas', id), original = api.row(await getDoc(ref));
  await updateDoc(doc(bob.db, 'profiles', 'bob'), { displayName: personA.name });
  await env.withSecurityRulesDisabled(context => setDoc(doc(context.firestore(), 'moderators', 'bob'), { canPin: true }));
  await api.requestToJoin(bob, { uid: 'bob', name: personA.name }, id); await api.decideRequest(alice, id, 'bob', true);
  for (const other of [bob, visitor]) {
    await assertFails(updateDoc(doc(other.db, 'ideas', id), { body: '사칭', updatedAt: serverTimestamp() }));
    await assertFails(api.updateIdea(other, 'alice', original, { title: original.title, body: '사칭', topic: original.topic }));
  }
  for (const extra of [{ authorId: 'bob' }, { authorName: '다른 사람' }, { createdAt: serverTimestamp() }, { lastActivityAt: serverTimestamp() }, { interestCount: 99 }, { participantCount: 99 }, { extra: true }]) {
    await assertFails(updateDoc(ref, { body: '수정', updatedAt: serverTimestamp(), ...extra }));
  }
  const batch = writeBatch(alice.db);
  batch.update(ref, { title: '새 제목', updatedAt: serverTimestamp() });
  batch.update(doc(alice.db, 'rooms', id), { title: '새 제목', memberIds: ['alice'] });
  await assertFails(batch.commit());
  await assertFails(updateDoc(doc(bob.db, 'rooms', id), { title: original.title }));
});

test('수정 값·시각·방 제목 동기화를 검증하고 오래된 편집으로 새 내용을 덮어쓰지 않는다', async () => {
  const ref = doc(alice.db, 'ideas', id), original = api.row(await getDoc(ref));
  for (const invalid of [{ title: '' }, { title: '가'.repeat(101) }, { body: '가'.repeat(2001) }, { body: 123 }, { topic: '없는 분류' }, { updatedAt: Timestamp.fromMillis(0) }]) {
    await assertFails(updateDoc(ref, { body: '수정', updatedAt: serverTimestamp(), ...invalid }));
  }
  await assertFails(updateDoc(ref, { body: '시각 없는 수정' }));
  await assertFails(updateDoc(ref, { title: '방과 다른 제목', updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(alice.db, 'rooms', id), { title: '원문과 다른 제목' }));
  const changes = { title: original.title, body: '먼저 저장한 내용', topic: original.topic };
  const first = await assertSucceeds(api.updateIdea(alice, 'alice', original, changes));
  await assert.rejects(api.updateIdea(alice, 'alice', original, { ...changes, body: '오래된 편집 내용' }), /먼저 수정된 글/);
  assert.equal((await getDoc(ref)).data().body, changes.body);
  const same = await api.updateIdea(alice, 'alice', first, changes);
  assert.equal(same.updatedAt.toMillis(), first.updatedAt.toMillis());
});
