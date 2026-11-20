import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { collection, doc, getDoc, getDocs, setDoc, updateDoc, query, where, limit, serverTimestamp, deleteField, Timestamp } from 'firebase/firestore';
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
