import { initializeApp } from 'firebase/app';
import { getAuth, onAuthStateChanged, signInAnonymously, connectAuthEmulator, GoogleAuthProvider, linkWithPopup, signInWithPopup, signOut } from 'firebase/auth';
import {
  getFirestore, connectFirestoreEmulator, collection, doc, getDoc, getDocs,
  setDoc, updateDoc, query, where, orderBy, limit, startAfter, onSnapshot,
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
export function continueWithGoogle(store, switchAccount = false) {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  store.auth.languageCode = 'ko';
  // Linking preserves the anonymous UID, including all posts, room membership and pin rights.
  if (store.auth.currentUser?.isAnonymous && !switchAccount) return linkWithPopup(store.auth.currentUser, provider);
  return signInWithPopup(store.auth, provider);
}
export function leaveAccount(store) {
  if (store.auth.currentUser?.isAnonymous) throw new Error('현재 기록을 이어 쓰려면 먼저 Google 계정을 연결해주세요.');
  return signOut(store.auth);
}
export const watchModerator = (store, uid, callback, failure) => onSnapshot(
  doc(store.db, 'moderators', uid), snap => callback(snap.exists() && snap.data().canPin === true), failure,
);
export const watchCommunity = (store, callback, failure) => onSnapshot(
  doc(store.db, 'settings', 'community'), snap => callback(snap.data()?.pinnedIdeaId || ''), failure,
);
export const pinIdea = (store, id) => setDoc(doc(store.db, 'settings', 'community'), {
  pinnedIdeaId: id, updatedAt: serverTimestamp(),
});
export const setNotice = (store, id, notice) => updateDoc(doc(store.db, 'ideas', id), { postType: notice ? 'notice' : 'idea' });
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
    participantCount: 1, lastChatAt: null, lastChatMessageId: '',
    postType: 'idea', refinementCount: 0, lastRefinementId: '',
  });
  await batch.commit();
  return ref.id;
}
export async function updateIdea(store, uid, original, { title, body, topic }) {
  const ref = doc(store.db, 'ideas', original.id);
  await runTransaction(store.db, async transaction => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists()) throw new Error('생각을 찾을 수 없어요.');
    const current = snapshot.data();
    if (current.authorId !== uid) throw new Error('내가 올린 생각만 수정할 수 있어요.');
    if (['title', 'body', 'topic'].some(key => current[key] !== original[key])
      || (current.updatedAt?.toMillis() || 0) !== (original.updatedAt?.toMillis() || 0)) {
      throw new Error('다른 화면에서 먼저 수정된 글이에요. 입력한 내용을 복사한 뒤, 닫고 최신 글에서 다시 수정해주세요.');
    }
    if (current.title === title && current.body === body && current.topic === topic) return;
    const room = current.title !== title ? await transaction.get(doc(store.db, 'rooms', original.id)) : null;
    transaction.update(ref, { title, body, topic, updatedAt: serverTimestamp() });
    if (room?.exists()) transaction.update(doc(store.db, 'rooms', original.id), { title });
  });
  return row(await getDoc(ref));
}
export async function addContribution(store, person, id, { kind, text, refinementId = '', replyTo = '' }) {
  const parent = doc(store.db, 'ideas', id);
  const ref = doc(collection(parent, 'contributions'));
  const batch = writeBatch(store.db);
  batch.set(ref, { kind, text, refinementId, replyTo, authorId: person.uid, authorName: person.name, createdAt: serverTimestamp() });
  batch.set(doc(parent, 'activities', `c_${ref.id}`), { type: 'contribution', refId: ref.id, actorId: person.uid, createdAt: serverTimestamp() });
  batch.update(parent, { contributionCount: increment(1), lastContributionId: ref.id, lastActivityAt: serverTimestamp() });
  await batch.commit();
}
export const getContribution = async (store, id, cid) => {
  const snapshot = await getDoc(doc(store.db, 'ideas', id, 'contributions', cid));
  return snapshot.exists() ? row(snapshot) : null;
};
export function watchRefinements(store, id, callback, failure) {
  return watchPages(collection(store.db, 'ideas', id, 'refinements'), [], callback, failure);
}
export async function addRefinement(store, person, id, { title, audience, firstStep, sourceContributionId = '' }) {
  const parent = doc(store.db, 'ideas', id), ref = doc(collection(parent, 'refinements'));
  const batch = writeBatch(store.db);
  batch.set(ref, { title, audience, firstStep, sourceContributionId, authorId: person.uid, authorName: person.name, createdAt: serverTimestamp() });
  batch.set(doc(parent, 'activities', `r_${ref.id}`), { type: 'refinement', refId: ref.id, actorId: person.uid, createdAt: serverTimestamp() });
  batch.update(parent, { refinementCount: increment(1), lastRefinementId: ref.id, lastActivityAt: serverTimestamp() });
  await batch.commit();
  return ref.id;
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
  { includeMetadataChanges: true },
  snapshot => { if (!snapshot.metadata.hasPendingWrites) callback(snapshot.docs.map(row)); }, failure,
);
// Follow every bounded page so older thoughts and large queues stay discoverable.
// Document IDs provide stable boundaries without requiring a composite index.
function watchPages(ref, filters, callback, failure) {
  const pages = [];
  let active = true;
  const publish = () => callback([...new Map(pages.flatMap(page => page.docs).map(snap => [snap.id, row(snap)])).values()]);
  function subscribe(index, after) {
    const page = { docs: [], stop: undefined, boundary: undefined };
    pages[index] = page;
    page.stop = onSnapshot(query(ref, ...filters, orderBy(documentId()), ...(after ? [startAfter(after)] : []), limit(20)), { includeMetadataChanges: true }, snapshot => {
      // A newly created thought must reach the server before its requests can be authorized.
      if (!active || pages[index] !== page || snapshot.metadata.hasPendingWrites) return;
      page.docs = snapshot.docs;
      const boundary = snapshot.size === 20 ? snapshot.docs.at(-1).id : null;
      if (boundary !== page.boundary) {
        pages.splice(index + 1).forEach(next => next.stop?.());
        page.boundary = boundary;
        if (boundary) subscribe(index + 1, snapshot.docs.at(-1));
      }
      publish();
    }, error => { if (active && pages[index] === page) failure(error); });
  }
  subscribe(0);
  return () => { active = false; pages.forEach(page => page.stop?.()); };
}

export function watchRequestInbox(store, uid, callback, failure) {
  const groups = new Map();
  let active = true;
  const publish = () => {
    if (active) callback([...groups.values()].filter(group => group.requests.length).map(({ idea, requests }) => ({ ...idea, requests })));
  };
  const stopIdeas = watchPages(collection(store.db, 'ideas'), [where('authorId', '==', uid)], ideas => {
    const ids = new Set(ideas.map(idea => idea.id));
    for (const [id, group] of groups) if (!ids.has(id)) { group.stop(); groups.delete(id); }
    for (const idea of ideas) {
      if (groups.has(idea.id)) { groups.get(idea.id).idea = idea; continue; }
      const group = { idea, requests: [], stop: undefined };
      groups.set(idea.id, group);
      group.stop = watchPages(collection(store.db, 'ideas', idea.id, 'requests'), [where('status', '==', 'pending')], requests => {
        if (!active || groups.get(idea.id) !== group) return;
        group.requests = requests; publish();
      }, error => { if (active && groups.get(idea.id) === group) failure(error); });
    }
    publish();
  }, failure);
  return () => { active = false; stopIdeas(); groups.forEach(group => group.stop()); groups.clear(); };
}
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
      transaction.update(doc(store.db, 'ideas', id), { participantCount: current.data().memberIds.length + 1 });
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
  const message = doc(collection(store.db, 'rooms', id, 'messages'));
  await runTransaction(store.db, async transaction => {
    const room = await transaction.get(doc(store.db, 'rooms', id));
    if (!room.exists()) throw new Error('대화방을 찾을 수 없어요.');
    transaction.set(message, { authorId: person.uid, authorName: person.name, text, createdAt: serverTimestamp() });
    transaction.update(doc(store.db, 'ideas', id), {
      participantCount: room.data().memberIds.length,
      lastChatAt: serverTimestamp(), lastChatMessageId: message.id,
    });
  });
}

// Existing rooms also expose only their participant count and latest activity time.
// Message text and participant identities stay protected by the room's rules.
export async function refreshDiscussion(store, id) {
  const latest = await getDocs(query(collection(store.db, 'rooms', id, 'messages'), orderBy('createdAt', 'desc'), limit(1)));
  const message = latest.docs[0];
  await runTransaction(store.db, async transaction => {
    const parent = doc(store.db, 'ideas', id);
    const [room, idea] = await Promise.all([transaction.get(doc(store.db, 'rooms', id)), transaction.get(parent)]);
    if (!room.exists() || !idea.exists()) return;
    const patch = {};
    if (idea.data().participantCount !== room.data().memberIds.length) patch.participantCount = room.data().memberIds.length;
    const time = message?.data().createdAt;
    if (time && (!idea.data().lastChatAt || time.toMillis() > idea.data().lastChatAt.toMillis())) {
      patch.lastChatAt = time; patch.lastChatMessageId = message.id;
    }
    if (Object.keys(patch).length) transaction.update(parent, patch);
  });
}
