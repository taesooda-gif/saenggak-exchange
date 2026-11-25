import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { initializeApp, deleteApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, GoogleAuthProvider, linkWithCredential, signInWithCredential } from 'firebase/auth';
import { getFirestore, connectFirestoreEmulator, doc, getDoc, setDoc, collection, getDocs, query, limit, terminate, Timestamp } from 'firebase/firestore';
import { initializeTestEnvironment, assertFails } from '@firebase/rules-unit-testing';
import * as api from '../src/data.js';

let env, linkedUID, ideaId;
const apps = [], stores = [];
const testEmail = `owner-${Date.now()}@example.test`;
const google = GoogleAuthProvider.credential(JSON.stringify({ sub: testEmail, email: testEmail, email_verified: true, name: '비공개 실명' }));
function device() {
  const app = initializeApp({ projectId: 'demo-saenggak-exchange', apiKey: 'demo-key' }, `device-${apps.length}-${Date.now()}`);
  const auth = getAuth(app), db = getFirestore(app);
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
  const store = { auth, db }; apps.push(app); stores.push(store); return store;
}
before(async () => {
  env = await initializeTestEnvironment({ projectId: 'demo-saenggak-exchange', firestore: { rules: await readFile(new URL('../firestore.rules', import.meta.url), 'utf8'), host: '127.0.0.1', port: 8080 } });
});
after(async () => { await Promise.all(stores.map(s => terminate(s.db))); await Promise.all(apps.map(deleteApp)); await env?.cleanup(); });

test('익명 계정에 Google을 연결하면 다른 기기에서도 닉네임·원문·대화·고정 권한을 유지한다', async () => {
  const first = device();
  const joined = await api.joinAsGuest(first, '시험 목성인');
  linkedUID = joined.user.uid;
  const person = { uid: linkedUID, name: joined.profile.displayName };
  ideaId = await api.createIdea(first, person, { title: '기기 간 연결 확인', body: '기존 글 유지', topic: '나의 다음 일' });
  await env.withSecurityRulesDisabled(ctx => setDoc(doc(ctx.firestore(), 'rooms', ideaId), { ownerId: linkedUID, title: '기기 간 연결 확인', memberIds: [linkedUID], createdAt: Timestamp.now(), lastAddedId: '' }));
  await api.sendMessage(first, person, ideaId, '기존 비공개 대화');
  await env.withSecurityRulesDisabled(ctx => setDoc(doc(ctx.firestore(), 'moderators', linkedUID), { canPin: true }));
  assert.throws(() => api.leaveAccount(first), /먼저 Google/);
  const linked = await linkWithCredential(joined.user, google);
  assert.equal(linked.user.uid, linkedUID);
  assert.equal(linked.user.isAnonymous, false);
  const second = device();
  const signed = await signInWithCredential(second.auth, google);
  assert.equal(signed.user.uid, linkedUID);
  assert.equal((await api.getProfile(second, linkedUID)).displayName, '시험 목성인');
  const idea = (await getDoc(doc(second.db, 'ideas', ideaId))).data();
  assert.equal(idea.authorId, linkedUID);
  assert.ok(!JSON.stringify(idea).includes(testEmail));
  assert.ok(!JSON.stringify(idea).includes('비공개 실명'));
  assert.equal((await getDocs(query(collection(second.db, 'rooms', ideaId, 'messages'), limit(50)))).size, 1);
  await api.pinIdea(second, ideaId);
  await api.leaveAccount(second);
  await assertFails(getDoc(doc(second.db, 'rooms', ideaId)));
  await signInWithCredential(second.auth, google);
  assert.equal(second.auth.currentUser.uid, linkedUID);
});

test('이미 연결된 Google을 골라도 기존 익명 계정을 자동으로 바꾸거나 합치지 않는다', async () => {
  const other = device();
  const joined = await api.joinAsGuest(other, '다른 참여자');
  const uid = joined.user.uid;
  await assert.rejects(linkWithCredential(joined.user, google), error => ['auth/credential-already-in-use', 'auth/email-already-in-use'].includes(error.code));
  assert.equal(other.auth.currentUser.uid, uid);
  assert.equal(other.auth.currentUser.isAnonymous, true);
  assert.equal((await api.getProfile(other, uid)).displayName, '다른 참여자');
  await assertFails(getDoc(doc(other.db, 'rooms', ideaId)));
  await assertFails(api.pinIdea(other, ideaId));
});
