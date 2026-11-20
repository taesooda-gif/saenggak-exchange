import { initializeApp } from 'firebase/app';
import { getAuth, onAuthStateChanged, signInAnonymously, connectAuthEmulator } from 'firebase/auth';
import {
  getFirestore, connectFirestoreEmulator, collection, doc, getDoc, getDocs,
  setDoc, addDoc, query, where, orderBy, limit, startAfter, onSnapshot,
  serverTimestamp, writeBatch, runTransaction, increment, arrayUnion, documentId,
} from 'firebase/firestore';

export async function connectStore() {
  const emulated = import.meta.env.DEV && import.meta.env.VITE_FIREBASE_EMULATORS === 'true';
  const config = emulated
    ? { apiKey: 'demo-key', projectId: 'demo-saenggak-exchange', authDomain: 'localhost', appId: 'demo-app' }
    : await fetch(`${import.meta.env.BASE_URL}firebase-config.json`, { cache: 'no-store' }).then(r => r.json());
  if (!['apiKey', 'projectId', 'appId', 'authDomain'].every(key => typeof config[key] === 'string' && config[key].trim())) return null;
  const app = initializeApp(config);
  const auth = getAuth(app);
  const db = getFirestore(app);
  if (emulated) {
    connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
    connectFirestoreEmulator(db, '127.0.0.1', 8080);
  }
  return { db, auth, projectId: config.projectId };
}

export const row = snapshot => ({ id: snapshot.id, ...snapshot.data() });
export const watchUser = (store, callback) => onAuthStateChanged(store.auth, callback);
export async function getProfile(store, uid) {
  const snapshot = await getDoc(doc(store.db, 'profiles', uid));
  return snapshot.exists() ? row(snapshot) : null;
}
export async function joinAsGuest(store, displayName) {
  const user = store.auth.currentUser || (await signInAnonymously(store.auth)).user;
  const ref = doc(store.db, 'profiles', user.uid);
  const profile = await getDoc(ref);
  if (!profile.exists()) await setDoc(ref, { displayName, createdAt: serverTimestamp() });
  return { user, profile: profile.exists() ? row(profile) : { id: user.uid, displayName } };
}
export function watchFeed(store, callback, failure) {
  return onSnapshot(query(collection(store.db, 'ideas'), orderBy('createdAt', 'desc'), limit(20)), snapshot => {
    callback(snapshot.docs.map(row), snapshot.docs.at(-1), snapshot.docs.length === 20);
  }, failure);
}
export async function nextIdeas(store, cursor) {
  const snapshot = await getDocs(query(collection(store.db, 'ideas'), orderBy('createdAt', 'desc'), startAfter(cursor), limit(20)));
  return { rows: snapshot.docs.map(row), cursor: snapshot.docs.at(-1), more: snapshot.docs.length === 20 };
}
export const watchIdea = (store, id, callback, failure) => onSnapshot(doc(store.db, 'ideas', id), snap => callback(snap.exists() ? row(snap) : null), failure);
export const watchContributions = (store, id, callback, failure) => onSnapshot(
  query(collection(store.db, 'ideas', id, 'contributions'), orderBy('createdAt', 'desc'), limit(50)),
  snap => callback(snap.docs.map(row).reverse(), snap.docs.length === 50), failure,
);
export async function earlierContributions(store, id, before) {
  const snapshot = await getDocs(query(collection(store.db, 'ideas', id, 'contributions'), orderBy('createdAt', 'desc'), orderBy(documentId(), 'desc'), startAfter(before.createdAt, before.id), limit(50)));
  return snapshot.docs.map(row).reverse();
}
export async function loadActivity(store, id) {
  const snapshot = await getDocs(query(collection(store.db, 'ideas', id, 'activities'), orderBy('createdAt', 'desc'), limit(30)));
  return snapshot.docs.map(row);
}
export async function createIdea(store, person, { title, body, topic }) {
  const ref = doc(collection(store.db, 'ideas'));
  const batch = writeBatch(store.db);
  batch.set(ref, {
    title, body, topic, authorId: person.uid, authorName: person.name,
    createdAt: serverTimestamp(), lastActivityAt: serverTimestamp(),
    interestCount: 0, contributionCount: 0, lastContributionId: '',
  });
  batch.set(doc(store.db, 'rooms', ref.id), {
    ownerId: person.uid, title, memberIds: [person.uid], createdAt: serverTimestamp(), lastAddedId: '',
  });
  await batch.commit();
  return ref.id;
}
export async function addContribution(store, person, id, { kind, text }) {
  const parent = doc(store.db, 'ideas', id);
  const ref = doc(collection(parent, 'contributions'));
  const batch = writeBatch(store.db);
  batch.set(ref, { kind, text, authorId: person.uid, authorName: person.name, createdAt: serverTimestamp() });
  batch.set(doc(parent, 'activities', `c_${ref.id}`), { type: 'contribution', refId: ref.id, actorId: person.uid, createdAt: serverTimestamp() });
  batch.update(parent, { contributionCount: increment(1), lastContributionId: ref.id, lastActivityAt: serverTimestamp() });
  await batch.commit();
}
export async function readInterest(store, uid, id) {
  return (await getDoc(doc(store.db, 'ideas', id, 'interests', uid))).exists();
}
export async function toggleInterest(store, uid, id) {
  const parent = doc(store.db, 'ideas', id);
  const interest = doc(parent, 'interests', uid);
  const event = doc(parent, 'activities', `i_${uid}`);
  return runTransaction(store.db, async transaction => {
    const [idea, current, history] = await Promise.all([transaction.get(parent), transaction.get(interest), transaction.get(event)]);
    if (!idea.exists()) throw new Error('생각을 찾을 수 없어요.');
    if (current.exists()) {
      transaction.delete(interest);
      transaction.update(parent, { interestCount: increment(-1) });
      return false;
    }
    transaction.set(interest, { createdAt: serverTimestamp() });
    const patch = { interestCount: increment(1) };
    if (!history.exists()) {
      transaction.set(event, { actorId: uid, type: 'interest', refId: uid, createdAt: serverTimestamp() });
      patch.lastActivityAt = serverTimestamp();
    }
    transaction.update(parent, patch);
    return true;
  });
}
export const watchRooms = (store, uid, callback, failure) => onSnapshot(
  query(collection(store.db, 'rooms'), where('memberIds', 'array-contains', uid), limit(20)),
  snapshot => callback(snapshot.docs.map(row)), failure,
);
export const watchRequests = (store, id, callback, failure) => onSnapshot(
  query(collection(store.db, 'ideas', id, 'requests'), where('status', '==', 'pending'), limit(20)),
  snapshot => callback(snapshot.docs.map(row)), failure,
);
export const getRequest = async (store, id, uid) => {
  const snapshot = await getDoc(doc(store.db, 'ideas', id, 'requests', uid));
  return snapshot.exists() ? row(snapshot) : null;
};
export async function requestToJoin(store, person, id) {
  await setDoc(doc(store.db, 'ideas', id, 'requests', person.uid), {
    authorId: person.uid, authorName: person.name, status: 'pending', createdAt: serverTimestamp(), decidedAt: null,
  });
}
export async function decideRequest(store, id, uid, accept) {
  const room = doc(store.db, 'rooms', id);
  const request = doc(store.db, 'ideas', id, 'requests', uid);
  await runTransaction(store.db, async transaction => {
    const [current, pending] = await Promise.all([transaction.get(room), transaction.get(request)]);
    if (!current.exists() || !pending.exists() || pending.data().status !== 'pending') throw new Error('이미 처리된 신청이에요.');
    if (accept) {
      if (current.data().memberIds.length >= 20) throw new Error('대화방은 20명까지 함께할 수 있어요.');
      transaction.update(room, { memberIds: arrayUnion(uid), lastAddedId: uid });
    }
    transaction.update(request, { status: accept ? 'accepted' : 'declined', decidedAt: serverTimestamp() });
  });
}
export const watchMessages = (store, id, callback, failure) => onSnapshot(
  query(collection(store.db, 'rooms', id, 'messages'), orderBy('createdAt', 'desc'), limit(50)),
  snapshot => callback(snapshot.docs.map(row).reverse(), snapshot.docs.length === 50), failure,
);
export async function olderMessages(store, id, before) {
  const snapshot = await getDocs(query(collection(store.db, 'rooms', id, 'messages'), orderBy('createdAt', 'desc'), orderBy(documentId(), 'desc'), startAfter(before.createdAt, before.id), limit(50)));
  return snapshot.docs.map(row).reverse();
}
export async function sendMessage(store, person, id, text) {
  await addDoc(collection(store.db, 'rooms', id, 'messages'), { authorId: person.uid, authorName: person.name, text, createdAt: serverTimestamp() });
}
