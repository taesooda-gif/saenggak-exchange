import './style.css';
import * as api from './data.js';
import { activitySeries, activityLabel, milliseconds } from './activity.js';

const $ = selector => document.querySelector(selector);
const root = $('#sg-community');
let store, user, profile, currentIdea, selectedRoom;
let view = 'home', selectedId = '', kind = '경험', feedRows = [], extraRows = [], rooms = [];
let cursor, hasMore = false, recentComments = [], previousComments = [], recentMessages = [], previousMessages = [];
let stopFeed, stopRooms, stopIdea, stopComments, stopMessages, stopRequests;
let identityReady = Promise.resolve(), guestResolve, guestPromise;
const interestState = new Map(), activityCache = new Map();
let requestVersion = 0;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function button(text, action, className = 'sg-button') {
  const node = el('button', className, text); node.type = 'button'; node.addEventListener('click', () => run(node, action)); return node;
}
function showStatus(message, error = false) {
  $('#status').textContent = message;
  $('#status').classList.toggle('sg-error', error);
}
function errorText(error) {
  const code = String(error?.code || '');
  if (code.includes('permission-denied')) return '접근할 수 없어요. 저장소 연결과 참여 권한을 확인해주세요.';
  if (code.includes('resource-exhausted') || code.includes('quota-exceeded')) return '오늘 사용할 수 있는 양을 모두 사용했어요. 잠시 후 다시 찾아주세요. 기존 글은 삭제되지 않아요.';
  if (code.includes('operation-not-allowed')) return '참여 기능을 준비하고 있어요. 잠시 후 다시 시도해주세요.';
  if (code.includes('unavailable') || code.includes('network')) return '연결이 잠시 끊겼어요. 인터넷 연결을 확인하고 다시 시도해주세요.';
  return error?.message?.startsWith('Firebase') ? '저장하지 못했어요. 잠시 후 다시 시도해주세요.' : (error?.message || '요청을 처리하지 못했어요.');
}
async function run(control, action) {
  if (control?.disabled) return;
  if (control) control.disabled = true;
  try { await action(); } catch (error) { console.error(error); showStatus(errorText(error), true); }
  finally { if (control) control.disabled = false; }
}
function when(value) {
  const time = milliseconds(value);
  if (!time) return '방금';
  return new Intl.DateTimeFormat('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Seoul' }).format(time);
}
function empty(title, description, action) {
  const box = el('div', 'sg-empty'); box.append(el('h3', '', title), el('p', '', description));
  if (action) box.append(button('첫 생각 올리기', () => navigate('write'), 'sg-button sg-primary'));
  return box;
}
function stopDetail() {
  [stopIdea, stopComments, stopRequests].forEach(stop => stop?.());
  stopIdea = stopComments = stopRequests = undefined;
  requestVersion++;
}
function stopChat() { stopMessages?.(); stopMessages = undefined; }
function displayView(name) {
  view = name;
  document.querySelectorAll('[data-panel]').forEach(panel => panel.hidden = panel.dataset.panel !== name);
  document.querySelectorAll('.sg-nav [data-view]').forEach(nav => nav.setAttribute('aria-pressed', String(nav.dataset.view === (name === 'detail' ? 'contribute' : name))));
  showStatus('');
  if (!['home', 'contribute'].includes(name)) { stopFeed?.(); stopFeed = undefined; }
  else startFeed();
  if (name !== 'detail') stopDetail();
  if (name !== 'chat') stopChat();
  if (name === 'chat') renderRooms();
  window.scrollTo({ top: 0, behavior: 'instant' });
}
function navigate(name, updateHash = true) {
  if (!['home', 'write', 'contribute', 'chat'].includes(name)) name = 'home';
  displayView(name);
  if (updateHash) history.replaceState(null, '', `#${name}`);
}
async function person() {
  if (!store) throw new Error('저장소 연결을 준비하고 있어요.');
  await identityReady;
  if (user && profile) return { uid: user.uid, name: profile.displayName };
  if (!guestPromise) {
    guestPromise = new Promise(resolve => { guestResolve = resolve; });
    $('#nickname-error').textContent = '';
    $('#nickname-dialog').showModal();
    $('#nickname').focus();
  }
  return guestPromise;
}
function resolveGuest(value) {
  const resolve = guestResolve;
  guestResolve = undefined; guestPromise = undefined;
  $('#nickname-dialog').close(); resolve?.(value);
}
$('#nickname-dialog').addEventListener('cancel', event => { event.preventDefault(); resolveGuest(null); });
$('#nickname-cancel').addEventListener('click', () => resolveGuest(null));
$('#nickname-form').addEventListener('submit', event => {
  event.preventDefault();
  run(event.submitter, async () => {
    const name = $('#nickname').value.trim();
    if (name.length < 2) { $('#nickname-error').textContent = '닉네임을 2자 이상 적어주세요.'; return; }
    try {
      const joined = await api.joinAsGuest(store, name);
      user = joined.user; profile = joined.profile; identityChanged();
      resolveGuest({ uid: user.uid, name: profile.displayName });
    } catch (error) { $('#nickname-error').textContent = errorText(error); }
  });
});
$('#profile-button').addEventListener('click', () => run($('#profile-button'), async () => {
  if (profile) showStatus(`${profile.displayName}님으로 참여하고 있어요. 참여 기록은 이 브라우저에 연결돼요.`);
  else await person();
}));

function startFeed() {
  if (!store || stopFeed || document.hidden) return;
  stopFeed = api.watchFeed(store, (rows, last, more) => {
    feedRows = rows; if (!extraRows.length) { cursor = last; hasMore = more; }
    $('#connection-status').hidden = true;
    renderFeed();
  }, error => { $('#connection-status').hidden = false; $('#connection-status').textContent = errorText(error); });
}
function feedIdeas() { return [...new Map([...feedRows, ...extraRows].map(idea => [idea.id, idea])).values()]; }
function renderFeed() {
  const ideas = feedIdeas();
  for (const [selector, compact] of [['#feed', false], ['#contribute-list', true]]) {
    const list = $(selector); list.replaceChildren();
    if (!ideas.length) list.append(empty('첫 생각을 기다리고 있어요.', '아직 글이 없어요. 떠오른 생각을 한 줄 남겨주세요.', true));
    ideas.forEach(idea => list.append(ideaCard(idea, compact)));
  }
  $('#more-ideas').hidden = $('#more-contribute').hidden = !hasMore;
}
async function loadMoreIdeas() {
  if (!cursor || !store) return;
  const result = await api.nextIdeas(store, cursor);
  extraRows.push(...result.rows); cursor = result.cursor; hasMore = result.more; renderFeed();
}
$('#more-ideas').addEventListener('click', () => run($('#more-ideas'), loadMoreIdeas));
$('#more-contribute').addEventListener('click', () => run($('#more-contribute'), loadMoreIdeas));

function actionsFor(idea, compact = false) {
  const actions = el('div', 'sg-actions');
  if (!compact) {
    const interested = interestState.get(idea.id) === true;
    const interest = button(`${interested ? '♥' : '♡'} 관심 ${idea.interestCount}`, async () => {
      const who = await person(); if (!who) return;
      const active = await api.toggleInterest(store, who.uid, idea.id);
      interestState.set(idea.id, active); activityCache.delete(idea.id);
      showStatus(active ? '관심 있는 생각에 담았어요.' : '관심 표시를 해제했어요.');
      renderFeed(); if (currentIdea?.id === idea.id) renderDetail();
    });
    interest.setAttribute('aria-pressed', String(interested)); actions.append(interest);
  }
  actions.append(button(`보태기 ${idea.contributionCount}`, () => openIdea(idea.id)));
  if (!compact) actions.append(button(rooms.some(room => room.id === idea.id) ? '함께하는 대화' : '함께하고 싶어요', () => joinIdea(idea), 'sg-button sg-action-link'));
  return actions;
}
function ideaCard(idea, compact) {
  const card = el('article', 'sg-card');
  const meta = el('div', 'sg-meta'); meta.append(el('span', 'sg-tag', idea.topic), el('span', '', idea.authorName), el('span', '', when(idea.createdAt)));
  const body = el('div', compact ? '' : 'sg-card-body'); const copy = el('div'); const heading = el('h2');
  heading.append(button(idea.title, () => openIdea(idea.id), 'sg-title-link'));
  copy.append(heading, el('p', 'sg-copy', idea.body)); body.append(copy);
  if (!compact) {
    const trend = el('section', 'sg-trend'); trend.setAttribute('aria-label', `${idea.title}의 최근 활동`);
    const head = el('div', 'sg-trend-head'); const label = activityLabel(idea);
    head.append(el('span', '', '활동 흐름 · 14일'), el('span', label === '잠시 조용해요' ? 'sg-down' : 'sg-up', label));
    trend.append(head, el('div', 'sg-chart-placeholder', '흐름을 불러오고 있어요.')); body.append(trend);
    requestAnimationFrame(() => observeTrend(trend, idea));
  }
  card.append(meta, body, actionsFor(idea, compact));
  return card;
}
const observer = new IntersectionObserver(entries => entries.forEach(entry => {
  if (!entry.isIntersecting) return;
  observer.unobserve(entry.target);
  const item = entry.target._idea;
  paintTrend(entry.target, item).catch(() => { if (entry.target.isConnected) entry.target.querySelector('.sg-chart-placeholder')?.replaceChildren(document.createTextNode('흐름을 잠시 불러오지 못했어요.')); });
}), { rootMargin: '120px' });
function observeTrend(node, idea) { if (!node.isConnected) return; node._idea = idea; observer.observe(node); }
async function paintTrend(container, idea) {
  const key = `${idea.contributionCount}:${milliseconds(idea.lastActivityAt)}`;
  let cache = activityCache.get(idea.id);
  if (!cache || cache.key !== key) {
    cache = { key, promise: api.loadActivity(store, idea.id) }; activityCache.set(idea.id, cache);
  }
  const events = await cache.promise;
  if (!container.isConnected) return;
  const holder = container.querySelector('.sg-chart-placeholder'); if (!holder) return;
  if (!events.length) { holder.textContent = '첫 활동부터 차곡차곡 쌓여요.'; return; }
  const series = activitySeries(events);
  const make = name => document.createElementNS('http://www.w3.org/2000/svg', name);
  const svg = make('svg'); svg.classList.add('sg-market-chart', activityLabel(idea) === '잠시 조용해요' ? 'sg-down' : 'sg-up');
  svg.setAttribute('viewBox', '0 0 164 80'); svg.setAttribute('preserveAspectRatio', 'none'); svg.setAttribute('role', 'img');
  const title = make('title'); title.textContent = '최근 기록된 최대 30개 활동으로 본 14일 흐름. 7일 동안 유지하고 8일째부터 서서히 낮아집니다.';
  const max = Math.max(10, ...series.map(point => point.value));
  const points = series.map((point, i) => `${i ? 'L' : 'M'}${4 + i * 12},${72 - point.value / max * 58}`).join(' ');
  const fill = make('path'); fill.setAttribute('d', `${points} L160,72 L4,72 Z`); fill.setAttribute('fill', 'currentColor'); fill.setAttribute('opacity', '.07');
  const line = make('path'); line.setAttribute('d', points); line.setAttribute('class', 'sg-chart-line'); svg.append(title, fill, line);
  const note = el('span', 'sg-caption', '최근 최대 30개 활동 기준'); holder.replaceWith(svg, note);
}

async function openIdea(id, updateHash = true) {
  if (!store) return;
  stopDetail(); stopChat(); selectedId = id; currentIdea = null; previousComments = []; recentComments = [];
  $('#comments').replaceChildren(); $('#detail-title').textContent = '생각을 불러오고 있어요.';
  $('#detail-body').textContent = ''; $('#detail-meta').replaceChildren(); $('#detail-actions').replaceChildren();
  $('#join-requests').hidden = true; $('#comment-count').textContent = ''; $('#comment-input').value = ''; kind = '경험'; updateKind();
  displayView('detail');
  if (updateHash) history.replaceState(null, '', `#idea/${encodeURIComponent(id)}`);
  stopIdea = api.watchIdea(store, id, idea => {
    currentIdea = idea;
    if (!idea) { $('#detail-title').textContent = '생각을 찾을 수 없어요.'; $('#comment-form').hidden = true; return; }
    $('#comment-form').hidden = false; renderDetail();
    if (user && !interestState.has(id)) api.readInterest(store, user.uid, id).then(active => { interestState.set(id, active); if (currentIdea?.id === id) renderDetail(); }).catch(error => showStatus(errorText(error), true));
    watchOwnerRequests();
  }, error => showStatus(errorText(error), true));
  stopComments = api.watchContributions(store, id, (rows, more) => { recentComments = rows; $('#older-comments').hidden = !more || Boolean(previousComments.length && previousComments.length % 50); renderComments(); }, error => showStatus(errorText(error), true));
}
function renderDetail() {
  if (!currentIdea) return;
  const idea = currentIdea;
  $('#detail-title').textContent = idea.title; $('#detail-body').textContent = idea.body;
  $('#detail-meta').replaceChildren(el('span', 'sg-tag', idea.topic), el('span', '', `${idea.authorName} · ${when(idea.createdAt)}`));
  $('#detail-actions').replaceChildren(...actionsFor(idea).children);
  $('#comment-count').textContent = `${idea.contributionCount}개`;
}
function merged(oldRows, newRows) { return [...new Map([...oldRows, ...newRows].map(item => [item.id, item])).values()].sort((a, b) => milliseconds(a.createdAt) - milliseconds(b.createdAt)); }
function renderComments() {
  const list = $('#comments'); list.replaceChildren();
  const rows = merged(previousComments, recentComments);
  if (!rows.length) list.append(el('p', 'sg-empty', '아직 보탬이 없어요. 첫 경험이나 질문을 남겨주세요.'));
  rows.forEach(comment => { const item = el('div', 'sg-comment'); item.append(el('span', 'sg-caption', `${comment.authorName} · ${comment.kind} · ${when(comment.createdAt)}`), el('p', '', comment.text)); list.append(item); });
}
$('#older-comments').addEventListener('click', () => run($('#older-comments'), async () => {
  const oldest = merged(previousComments, recentComments)[0]; if (!oldest) return;
  const rows = await api.earlierContributions(store, selectedId, oldest); previousComments = [...rows, ...previousComments]; $('#older-comments').hidden = rows.length < 50; renderComments();
}));
function updateKind() { document.querySelectorAll('[data-kind]').forEach(control => control.setAttribute('aria-pressed', String(control.dataset.kind === kind))); }
root.addEventListener('click', event => {
  const nav = event.target.closest('[data-view]'); if (nav) navigate(nav.dataset.view);
  const type = event.target.closest('[data-kind]'); if (type) { kind = type.dataset.kind; updateKind(); }
});
$('#idea-form').addEventListener('submit', event => {
  event.preventDefault();
  run(event.submitter, async () => {
    const title = $('#idea-title').value.trim(), body = $('#idea-body').value.trim(), topic = $('#idea-topic').value;
    if (!title) return;
    const who = await person(); if (!who) return;
    const id = await api.createIdea(store, who, { title, body, topic }); $('#idea-form').reset(); await openIdea(id); showStatus('새 생각을 올렸어요. 다른 방문자도 이 글을 볼 수 있어요.');
  });
});
$('#comment-form').addEventListener('submit', event => {
  event.preventDefault();
  run(event.submitter, async () => {
    const text = $('#comment-input').value.trim(), id = selectedId, selectedKind = kind; if (!text || !id) return;
    const who = await person(); if (!who) return;
    await api.addContribution(store, who, id, { text, kind: selectedKind });
    if (selectedId === id) $('#comment-input').value = '';
    activityCache.delete(id); showStatus('이 생각에 보탰어요.');
  });
});

function watchOwnerRequests() {
  if (stopRequests || !currentIdea || user?.uid !== currentIdea.authorId) return;
  stopRequests = api.watchRequests(store, currentIdea.id, requests => {
    $('#join-requests').hidden = requests.length === 0; const list = $('#request-list'); list.replaceChildren();
    requests.forEach(request => {
      const item = el('div', 'sg-request'); item.append(el('span', '', `${request.authorName}님이 함께하고 싶어 해요.`));
      const actions = el('div', 'sg-actions');
      const id = currentIdea.id;
      actions.append(button('함께하기', () => api.decideRequest(store, id, request.id, true), 'sg-button sg-primary'), button('이번에는 어려워요', () => api.decideRequest(store, id, request.id, false)));
      item.append(actions); list.append(item);
    });
  }, error => showStatus(errorText(error), true));
}
async function joinIdea(idea) {
  const who = await person(); if (!who) return;
  const mine = rooms.find(room => room.id === idea.id);
  if (mine) { navigate('chat'); selectRoom(mine.id); return; }
  const request = await api.getRequest(store, idea.id, who.uid);
  if (request) { showStatus(request.status === 'pending' ? '이미 함께하기를 신청했어요. 글쓴이가 확인하면 대화방이 열려요.' : request.status === 'accepted' ? '참여가 승인됐어요. 함께하기 메뉴에서 대화방을 확인해주세요.' : '이번 함께하기 신청은 수락되지 않았어요. 다른 생각에도 보태보세요.'); return; }
  if (idea.authorId === who.uid) { showStatus('내 대화방을 불러오고 있어요. 잠시 후 함께하기를 눌러주세요.'); return; }
  await api.requestToJoin(store, who, idea.id); showStatus('함께하기를 신청했어요. 글쓴이가 수락하면 대화방이 열려요.');
}
function renderRooms() {
  const home = $('#home-rooms'), list = $('#room-list'); home.replaceChildren(); list.replaceChildren();
  if (!user || !profile) {
    home.append(el('p', 'sg-caption', '닉네임으로 시작하면 함께하는 대화를 볼 수 있어요.'), button('닉네임으로 시작', person));
    $('#chat-empty').textContent = '닉네임으로 시작하고, 관심 있는 생각에 함께하기를 신청해보세요.';
    $('#chat-empty').hidden = false; $('#chat-content').hidden = true;
    list.append(button('닉네임으로 시작', person, 'sg-button sg-primary')); return;
  }
  if (!rooms.length) {
    home.append(el('p', 'sg-caption', '아직 함께하는 대화가 없어요. 관심 있는 생각에 참여해보세요.'));
    $('#chat-empty').textContent = '생각을 올리면 내 대화방이 생겨요. 다른 생각에는 함께하기를 신청하고 초대를 기다려주세요.';
    $('#chat-empty').hidden = false; $('#chat-content').hidden = true; return;
  }
  rooms.forEach((room, index) => {
    const make = () => { const control = button('', () => { navigate('chat'); selectRoom(room.id); }, 'sg-room-link'); control.append(el('span', '', room.title), el('span', '', `${room.memberIds.length}명이 함께해요`)); control.setAttribute('aria-pressed', String(selectedRoom?.id === room.id)); return control; };
    list.append(make()); if (index < 3) home.append(make());
  });
  if (view === 'chat') {
    const selected = rooms.find(room => room.id === selectedRoom?.id) || rooms[0];
    if (!stopMessages || selectedRoom?.id !== selected.id) selectRoom(selected.id);
    else { selectedRoom = selected; $('#room-members').textContent = `${selected.memberIds.length}명 · 초대받은 사람끼리 나누는 대화`; }
  }
}
function selectRoom(id) {
  const room = rooms.find(item => item.id === id); if (!room) return;
  stopChat(); selectedRoom = room; recentMessages = []; previousMessages = [];
  $('#chat-empty').hidden = true; $('#chat-content').hidden = false; $('#messages').replaceChildren();
  $('#room-title').textContent = room.title; $('#room-members').textContent = `${room.memberIds.length}명 · 초대받은 사람끼리 나누는 대화`;
  $('#message-input').value = '';
  stopMessages = api.watchMessages(store, id, (rows, more) => { recentMessages = rows; $('#older-messages').hidden = !more; renderMessages(); }, error => showStatus(errorText(error), true));
}
function renderMessages() {
  const list = $('#messages'); list.replaceChildren();
  const messages = merged(previousMessages, recentMessages);
  if (!messages.length) list.append(el('p', 'sg-empty', '첫 인사를 남겨주세요. 함께 해볼 작은 일부터 이야기해봐요.'));
  messages.forEach(message => { const item = el('div', `sg-message ${message.authorId === user?.uid ? 'sg-mine' : ''}`); item.append(el('span', '', `${message.authorName} · ${when(message.createdAt)}`), el('div', 'sg-bubble', message.text)); list.append(item); });
}
$('#older-messages').addEventListener('click', () => run($('#older-messages'), async () => {
  const oldest = merged(previousMessages, recentMessages)[0]; if (!oldest || !selectedRoom) return;
  const rows = await api.olderMessages(store, selectedRoom.id, oldest); previousMessages = [...rows, ...previousMessages]; $('#older-messages').hidden = rows.length < 50; renderMessages();
}));
$('#chat-form').addEventListener('submit', event => {
  event.preventDefault();
  run(event.submitter, async () => {
    const text = $('#message-input').value.trim(), id = selectedRoom?.id; if (!text || !id) return;
    const who = await person(); if (!who) return;
    await api.sendMessage(store, who, id, text); if (selectedRoom?.id === id) $('#message-input').value = '';
  });
});
function identityChanged() {
  $('#profile-button').textContent = profile ? `${profile.displayName}님` : '닉네임으로 시작';
  stopRooms?.(); stopRooms = undefined; rooms = [];
  if (user && profile) stopRooms = api.watchRooms(store, user.uid, rows => { rooms = rows; renderRooms(); if (view === 'detail') renderDetail(); }, error => showStatus(errorText(error), true));
  renderRooms(); watchOwnerRequests();
}
function route() {
  const hash = decodeURIComponent(location.hash.slice(1));
  if (hash.startsWith('idea/')) openIdea(hash.slice(5), false);
  else navigate(hash, false);
}
window.addEventListener('hashchange', route);
document.addEventListener('visibilitychange', () => { if (document.hidden) { stopFeed?.(); stopFeed = undefined; } else if (['home', 'contribute'].includes(view)) startFeed(); });
window.addEventListener('offline', () => showStatus('인터넷 연결이 끊겼어요. 연결 후 다시 시도해주세요.', true));

try {
  store = await api.connectStore();
  if (!store) {
    $('#connection-status').textContent = '저장소 연결을 준비하고 있어요. 잠시 후 다시 찾아주세요.';
    renderFeed(); renderRooms();
  } else {
    let ready;
    identityReady = new Promise(resolve => { ready = resolve; });
    api.watchUser(store, async next => {
      user = next;
      try { profile = next ? await api.getProfile(store, next.uid) : null; identityChanged(); }
      catch (error) { showStatus(errorText(error), true); }
      finally { ready(); }
    });
    route();
  }
} catch (error) { $('#connection-status').textContent = errorText(error); }
