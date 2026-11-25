import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { doc, collection, getDoc, getDocs, setDoc, updateDoc, query, limit, serverTimestamp, Timestamp } from 'firebase/firestore';
import * as api from '../src/data.js';

let env, owner, peer, visitor, id;
const a = { uid: 'owner', name: '글쓴이' }, b = { uid: 'peer', name: '보태는 사람' };
const plan = { title: '부모와 아이의 작은 실험', audience: '함께 배워보고 싶은 가족', firstStep: '이번 주에 한 번 해보고 경험을 나누기' };
before(async () => {
  env = await initializeTestEnvironment({ projectId: 'demo-saenggak-exchange', firestore: { host: '127.0.0.1', port: 8080, rules: await readFile(new URL('../firestore.rules', import.meta.url), 'utf8') } });
});
after(async () => env?.cleanup());
beforeEach(async () => {
  await env.clearFirestore();
  owner = { db: env.authenticatedContext(a.uid).firestore() }; peer = { db: env.authenticatedContext(b.uid).firestore() }; visitor = { db: env.unauthenticatedContext().firestore() };
  for (const [store, person] of [[owner, a], [peer, b]]) await setDoc(doc(store.db, 'profiles', person.uid), { displayName: person.name, createdAt: serverTimestamp() });
  id = await api.createIdea(owner, a, { title: '아이와 어떻게 미래를 준비할까요?', body: '경험을 나눠요.', topic: '아이의 내일' });
});

test('새 글은 공개로 이어지며 비공개 방이나 참여 신청을 만들지 않는다', async () => {
  assert.equal((await getDoc(doc(owner.db, 'rooms', id))).exists(), false);
  await assertFails(api.requestToJoin(peer, b, id));
  await assertFails(setDoc(doc(owner.db, 'rooms', id), { ownerId: a.uid, title: '새 방', memberIds: [a.uid], createdAt: serverTimestamp(), lastAddedId: '' }));
  const original = api.row(await getDoc(doc(owner.db, 'ideas', id)));
  await api.updateIdea(owner, a.uid, original, { title: '공개로 이어가는 생각', body: original.body, topic: original.topic });
  assert.equal((await getDoc(doc(visitor.db, 'ideas', id))).data().title, '공개로 이어가는 생각');
});

test('다른 사람의 보탬에서 구체화하고 누구나 읽고 답글로 이어갈 수 있다', async () => {
  await api.addContribution(peer, b, id, { kind: '제안', text: '작은 실험을 해보면 어떨까요?' });
  const source = (await getDoc(doc(visitor.db, 'ideas', id))).data().lastContributionId;
  const rid = await assertSucceeds(api.addRefinement(owner, a, id, { ...plan, sourceContributionId: source }));
  const publicPlan = (await getDoc(doc(visitor.db, 'ideas', id, 'refinements', rid))).data();
  assert.equal(publicPlan.sourceContributionId, source); assert.equal(publicPlan.authorName, a.name);
  assert.equal((await api.getContribution(visitor, id, source)).authorName, b.name);
  await api.addContribution(peer, b, id, { kind: '질문', text: '어떤 주제로 시작할까요?', refinementId: rid });
  const question = (await getDoc(doc(visitor.db, 'ideas', id))).data().lastContributionId;
  await api.addContribution(owner, a, id, { kind: '제안', text: '이번 주 과학 시간 주제로 해봐요.', refinementId: rid, replyTo: question });
  await api.addContribution(peer, b, id, { kind: '경험', text: '원래 생각에도 계속 보태요.' });
  const ideas = (await getDoc(doc(visitor.db, 'ideas', id))).data();
  assert.equal(ideas.contributionCount, 4); assert.equal(ideas.refinementCount, 1);
  const comments = await getDocs(query(collection(visitor.db, 'ideas', id, 'contributions'), limit(50)));
  assert.equal(comments.size, 4);
  assert.equal(comments.docs.find(item => item.data().replyTo === question).data().refinementId, rid);
  assert.ok((await api.loadActivity(visitor, id)).some(event => event.type === 'refinement'));
  await api.addRefinement(peer, b, id, { ...plan, title: '다른 방향의 구체화안' });
  assert.equal((await getDocs(query(collection(visitor.db, 'ideas', id, 'refinements'), limit(20)))).size, 2);
});

test('공지와 상단 고정은 독립적이고 공지도 공개 의견을 받을 수 있다', async () => {
  await assertFails(api.setNotice(owner, id, true));
  await env.withSecurityRulesDisabled(ctx => setDoc(doc(ctx.firestore(), 'moderators', a.uid), { canPin: true }));
  await api.pinIdea(owner, id);
  await api.addRefinement(peer, b, id, plan); // A pinned ordinary thought is still open.
  await api.setNotice(owner, id, true);
  await assertFails(api.addRefinement(peer, b, id, plan));
  await assertFails(api.requestToJoin(peer, b, id));
  await assertSucceeds(api.addContribution(peer, b, id, { kind: '질문', text: '공지에 궁금한 점이 있어요.' }));
  await api.pinIdea(owner, '');
  assert.equal((await getDoc(doc(visitor.db, 'ideas', id))).data().postType, 'notice');
  await assertFails(api.setNotice(peer, id, false));
  await assertFails(updateDoc(doc(owner.db, 'ideas', id), { postType: 'idea', authorId: b.uid }));
  await api.setNotice(owner, id, false); await api.addRefinement(peer, b, id, plan);
});

test('구체화안·출처·답글 관계와 통계를 위조할 수 없다', async () => {
  await assertFails(api.addRefinement(visitor, b, id, plan));
  await assertFails(api.addRefinement(peer, a, id, plan));
  for (const invalid of [{ title: '' }, { audience: '' }, { firstStep: 'x'.repeat(801) }, { sourceContributionId: 'missing' }]) await assertFails(api.addRefinement(peer, b, id, { ...plan, ...invalid }));
  const rid = await api.addRefinement(peer, b, id, plan);
  await assertFails(updateDoc(doc(owner.db, 'ideas', id), { refinementCount: 999 }));
  await assertFails(updateDoc(doc(peer.db, 'ideas', id, 'refinements', rid), { authorName: '사칭' }));
  await assertFails(api.addContribution(peer, b, id, { kind: '제안', text: '잘못된 연결', refinementId: 'missing' }));
  await assertFails(api.addContribution(peer, b, id, { kind: '제안', text: '잘못된 답글', replyTo: 'missing' }));
  await api.addContribution(owner, a, id, { kind: '경험', text: '원래 생각에 보탬' });
  const cid = (await getDoc(doc(visitor.db, 'ideas', id))).data().lastContributionId;
  await assertFails(api.addContribution(peer, b, id, { kind: '제안', text: '다른 맥락에 연결', refinementId: rid, replyTo: cid }));
  await assertFails(getDocs(collection(visitor.db, 'ideas', id, 'refinements')));
});

test('공개 구체화 후에도 기존 비공개 내용과 참여자는 그대로 보호된다', async () => {
  await env.withSecurityRulesDisabled(async ctx => {
    await setDoc(doc(ctx.firestore(), 'rooms', id), { ownerId: a.uid, title: '기존 대화', memberIds: [a.uid], createdAt: Timestamp.now(), lastAddedId: '' });
    await setDoc(doc(ctx.firestore(), 'rooms', id, 'messages', 'old'), { authorId: a.uid, authorName: a.name, text: '공개하지 않은 기존 이야기', createdAt: Timestamp.now() });
  });
  await api.addRefinement(peer, b, id, plan);
  await assertFails(getDoc(doc(peer.db, 'rooms', id, 'messages', 'old')));
  await assertFails(getDoc(doc(visitor.db, 'rooms', id, 'messages', 'old')));
  await assertSucceeds(api.sendMessage(owner, a, id, '계속 비공개로 남긴 이야기'));
  assert.deepEqual((await getDoc(doc(owner.db, 'rooms', id))).data().memberIds, [a.uid]);
  const visible = JSON.stringify((await getDocs(query(collection(visitor.db, 'ideas', id, 'refinements'), limit(20)))).docs.map(item => item.data()));
  assert.ok(!visible.includes('비공개')); assert.ok(!visible.includes('공개하지 않은'));
  assert.equal((await getDocs(query(collection(owner.db, 'rooms', id, 'messages'), limit(50)))).size, 2);
});
