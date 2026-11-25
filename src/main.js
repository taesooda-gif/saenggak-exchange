import './style.css';
import * as api from './data.js';
import { activitySeries, activityLabel, milliseconds } from './activity.js';

const $ = selector => document.querySelector(selector);
const root = $('#sg-community');
let store, user, profile, currentIdea, selectedRoom;
let view = 'home', selectedId = '', kind = '경험', feedRows = [], extraRows = [], rooms = [];
let cursor, hasMore = false, recentComments = [], previousComments = [], recentMessages = [], previousMessages = [];
let stopFeed, stopRooms, stopIdea, stopComments, stopMessages, stopInbox;
let identityReady = Promise.resolve(), guestResolve, guestPromise;
let identityVersion = 0, activeUid = '', authBusy = false;
let editingIdea = null, editBusy = false;
const interestState = new Map(), activityCache = new Map();
const syncedDiscussions = new Map();
let requestVersion = 0, requestGroups = [];
const decidingRequests = new Set();
let canPin = false, pinnedId = '', pinnedIdea = null, stopPinnedIdea, stopModerator;

function refreshPinViews() { renderFeed(); if (view === 'detail') renderDetail(); }
function watchPinnedIdea(id) {
  if (id === pinnedId) return;
  stopPinnedIdea?.(); stopPinnedIdea = undefined;
  pinnedId = id; pinnedIdea = null; refreshPinViews();
  if (id) stopPinnedIdea = api.watchIdea(store, id, idea => {
    if (pinnedId !== id) return;
    pinnedIdea = idea; refreshPinViews();
  }, error => showStatus(errorText(error), true));
}

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
  [stopIdea, stopComments].forEach(stop => stop?.());
  stopIdea = stopComments = undefined;
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
  renderRequests();
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
    renderAccount();
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
$('#nickname-dialog').addEventListener('cancel', event => { event.preventDefault(); if (!authBusy) resolveGuest(null); });
$('#nickname-cancel').addEventListener('click', () => { if (!authBusy) resolveGuest(null); });
$('#nickname-form').addEventListener('submit', event => {
  event.preventDefault();
  if (authBusy) return;
  run(event.submitter, async () => {
    const name = $('#nickname').value.trim();
    if (name.length < 2) { $('#nickname-error').textContent = '닉네임을 2자 이상 적어주세요.'; return; }
    try {
      const joined = await api.joinAsGuest(store, name);
      await setIdentity(joined.user);
      if (user && profile) resolveGuest({ uid: user.uid, name: profile.displayName });
    } catch (error) { $('#nickname-error').textContent = errorText(error); }
  });
});
function renderAccount() {
  const linked = user && !user.isAnonymous;
  $('#nickname-google-option').hidden = Boolean(linked);
  $('#nickname-intro').textContent = linked ? '로그인했어요. 다른 사람에게 보여줄 닉네임을 정해주세요.' : '닉네임만 정해도 참여할 수 있어요. Google 연결은 원할 때 선택하세요.';
  $('#nickname-hint').textContent = linked ? 'Google 실명과 이메일 대신 이 닉네임이 공개돼요.' : 'Google 연결 전에는 이 브라우저에서만 이어 쓸 수 있어요. 나중에 연결해도 지금 남긴 기록은 그대로 이어져요.';
  $('#nickname-submit').textContent = linked ? '이 닉네임으로 참여' : '닉네임으로 시작';
  $('#account-title').textContent = profile ? `${profile.displayName}님의 참여 계정` : '내 참여 계정';
  $('#account-description').textContent = linked ? 'Google 계정이 연결되어 있어요. 다른 기기에서도 같은 Google 계정으로 로그인하면 이어 쓸 수 있어요.' : '지금은 이 브라우저에서 닉네임으로 참여하고 있어요. 원할 때 Google 계정을 연결하면 글과 대화방을 다른 기기에서도 이어 쓸 수 있어요.';
  $('#account-email').textContent = linked ? `연결한 계정: ${user.email || 'Google'}` : '연결은 선택이에요. 연결하지 않아도 계속 참여할 수 있어요.';
  $('#account-google').hidden = Boolean(linked);
  $('#account-logout').hidden = !linked;
  $('#account-permission').hidden = !canPin;
}
$('#profile-button').addEventListener('click', () => run($('#profile-button'), async () => {
  await identityReady;
  if (profile) {
    renderAccount(); $('#account-error').textContent = ''; $('#account-switch').hidden = true;
    $('#account-dialog').showModal();
  } else await person();
}));
$('#account-close').addEventListener('click', () => { if (!authBusy) $('#account-dialog').close(); });
$('#account-dialog').addEventListener('cancel', event => { if (authBusy) event.preventDefault(); });
function googleError(error) {
  if (error.code === 'auth/popup-closed-by-user' || error.code === 'auth/cancelled-popup-request') return '로그인을 취소했어요. 지금처럼 계속 이용하셔도 돼요.';
  if (error.code === 'auth/popup-blocked') return '로그인 창이 차단됐어요. 팝업을 허용하고 다시 눌러주세요. 앱 안에서 열었다면 Safari나 Chrome에서 접속해주세요.';
  if (error.code === 'auth/unauthorized-domain') return '이 주소의 Google 로그인을 준비 중이에요. 닉네임으로는 계속 참여할 수 있어요.';
  if (error.code === 'auth/credential-already-in-use' || error.code === 'auth/email-already-in-use') return '이 Google 계정은 이미 다른 참여 계정에 연결되어 있어요. 현재 계정과 기록은 그대로 두었어요.';
  return errorText(error);
}
async function googleLogin(switchAccount = false) {
  if (authBusy || !store) return;
  authBusy = true;
  const controls = ['#nickname-google', '#nickname-submit', '#nickname-cancel', '#account-google', '#account-switch-button', '#account-close', '#account-logout'];
  controls.forEach(id => $(id).disabled = true);
  $('#nickname-error').textContent = $('#account-error').textContent = '';
  $('#account-switch').hidden = true;
  try {
    // Start the popup directly in the click handler, before any async work.
    const result = await api.continueWithGoogle(store, switchAccount);
    await setIdentity(result.user);
    if (profile) {
      if (guestPromise) resolveGuest({ uid: user.uid, name: profile.displayName });
      renderAccount();
      showStatus('Google 계정으로 이어졌어요. 다른 기기에서도 같은 계정으로 로그인해주세요.');
    } else {
      $('#account-dialog').close();
      if (!guestPromise) void person();
      renderAccount();
    }
  } catch (error) {
    const message = googleError(error);
    $('#nickname-error').textContent = $('#account-error').textContent = message;
    if (['auth/credential-already-in-use', 'auth/email-already-in-use'].includes(error.code) && profile && !canPin) $('#account-switch').hidden = false;
  } finally { authBusy = false; controls.forEach(id => $(id).disabled = false); }
}
$('#nickname-google').addEventListener('click', () => googleLogin());
$('#account-google').addEventListener('click', () => googleLogin());
$('#account-switch-button').addEventListener('click', () => {
  if (window.confirm('현재 닉네임으로 남긴 기록은 합쳐지지 않으며, 이 계정으로 돌아오지 못할 수 있어요. 기존 Google 계정으로 전환할까요?')) void googleLogin(true);
});
$('#account-logout').addEventListener('click', () => run($('#account-logout'), async () => {
  if (authBusy) return;
  await api.leaveAccount(store); await setIdentity(null); $('#account-dialog').close();
  showStatus('로그아웃했어요. 같은 Google 계정으로 다시 이어올 수 있어요.');
}));

async function setIdentity(next) {
  const version = ++identityVersion;
  user = next; profile = null;
  if (activeUid !== (next?.uid || '')) {
    closeIdeaEditor(true);
    activeUid = next?.uid || '';
    stopRooms?.(); stopRooms = undefined; stopModerator?.(); stopModerator = undefined;
    stopInbox?.(); stopInbox = undefined; requestVersion++; requestGroups = []; decidingRequests.clear();
    $('#request-error').hidden = true; $('#request-result').textContent = ''; renderRequests();
    stopChat(); rooms = []; selectedRoom = null; recentMessages = []; previousMessages = [];
    interestState.clear(); syncedDiscussions.clear(); canPin = false;
    $('#messages').replaceChildren(); $('#room-list').replaceChildren(); $('#home-rooms').replaceChildren();
    $('#room-title').textContent = $('#room-members').textContent = $('#room-context').textContent = '';
    $('#message-input').value = ''; $('#request-list').replaceChildren(); $('#join-requests').hidden = true;
    $('#chat-content').hidden = true;
    renderRooms(); refreshPinViews();
  }
  const nextProfile = next ? await api.getProfile(store, next.uid) : null;
  if (version !== identityVersion) return;
  profile = nextProfile; identityChanged(); renderAccount();
}

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
    const pinned = compact ? null : pinnedIdea || ideas.find(idea => idea.id === pinnedId);
    if (pinned) list.append(ideaCard(pinned, false));
    if (!ideas.length && !pinned) list.append(empty('첫 생각을 기다리고 있어요.', '아직 글이 없어요. 떠오른 생각을 한 줄 남겨주세요.', true));
    ideas.filter(idea => idea.id !== pinned?.id).forEach(idea => list.append(ideaCard(idea, compact)));
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
  const pending = requestGroups.find(group => group.id === idea.id)?.requests.length || 0;
  if (user?.uid === idea.authorId && pending) actions.append(button(`참여 신청 ${pending}건`, () => navigate('chat'), 'sg-button sg-request-link'));
  if (profile && user?.uid === idea.authorId) actions.append(button('수정하기', () => openIdeaEditor(idea)));
  if (canPin) actions.append(button(idea.id === pinnedId ? '고정 해제' : '상단 고정', async () => {
    const clear = idea.id === pinnedId;
    await api.pinIdea(store, clear ? '' : idea.id);
    showStatus(clear ? '상단 고정을 해제했어요.' : '둘러보기 맨 위에 고정했어요. 고정 글은 하나만 표시돼요.');
  }, 'sg-button sg-pin-action'));
  return actions;
}
function discussionCard(idea) {
  const group = el('section', 'sg-discussion');
  group.setAttribute('aria-label', '이 생각의 함께하기');
  const copy = el('div');
  const mine = rooms.find(room => room.id === idea.id);
  const count = idea.participantCount || mine?.memberIds.length;
  const started = Boolean(milliseconds(idea.lastChatAt));
  copy.append(el('strong', '', started ? '이 생각에서 대화가 시작됐어요' : '이 생각을 더 깊이 나눠볼까요?'));
  copy.append(el('p', 'sg-caption', started
    ? `작성자 포함 ${count || 1}명이 함께해요 · 최근 대화 ${when(idea.lastChatAt)}`
    : '관심이 맞는 사람끼리 주제를 좁히고, 함께 해볼 일을 찾아요.'));
  copy.append(el('p', 'sg-discussion-privacy', '대화 내용은 참여자에게만 보여요.'));
  group.append(copy, button(mine ? '함께하는 대화' : '대화에 함께하기', () => joinIdea(idea), 'sg-button sg-discussion-button'));
  return group;
}
function ideaCard(idea, compact) {
  const card = el('article', `sg-card${idea.id === pinnedId ? ' sg-pinned' : ''}`);
  const meta = el('div', 'sg-meta'); meta.append(el('span', 'sg-tag', idea.topic), el('span', '', idea.authorName), el('span', '', when(idea.createdAt)));
  if (idea.updatedAt) meta.append(el('span', '', `수정됨 · ${when(idea.updatedAt)}`));
  if (idea.id === pinnedId) meta.prepend(el('span', 'sg-pin-label', '상단 고정'));
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
  if (!compact) card.append(discussionCard(idea));
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
  $('#detail-body').textContent = ''; $('#detail-meta').replaceChildren(); $('#detail-actions').replaceChildren(); $('#detail-together').replaceChildren();
  $('#join-requests').hidden = true; $('#comment-count').textContent = ''; $('#comment-input').value = ''; kind = '경험'; updateKind();
  displayView('detail');
  if (updateHash) history.replaceState(null, '', `#idea/${encodeURIComponent(id)}`);
  stopIdea = api.watchIdea(store, id, idea => {
    currentIdea = idea;
    $('#connection-status').hidden = true;
    if (!idea) { $('#detail-title').textContent = '생각을 찾을 수 없어요.'; $('#comment-form').hidden = true; return; }
    $('#comment-form').hidden = false; renderDetail();
    if (user && !interestState.has(id)) {
      const uid = user.uid;
      api.readInterest(store, uid, id).then(active => { if (user?.uid !== uid) return; interestState.set(id, active); if (currentIdea?.id === id) renderDetail(); }).catch(error => { if (user?.uid === uid) showStatus(errorText(error), true); });
    }
    renderRequests();
  }, error => showStatus(errorText(error), true));
  stopComments = api.watchContributions(store, id, (rows, more) => { recentComments = rows; $('#older-comments').hidden = !more || Boolean(previousComments.length && previousComments.length % 50); renderComments(); }, error => showStatus(errorText(error), true));
}
function renderDetail() {
  if (!currentIdea) return;
  const idea = currentIdea;
  $('#detail-title').textContent = idea.title; $('#detail-body').textContent = idea.body;
  $('#detail-meta').replaceChildren(el('span', 'sg-tag', idea.topic), el('span', '', `${idea.authorName} · ${when(idea.createdAt)}`));
  if (idea.updatedAt) $('#detail-meta').append(el('span', '', `수정됨 · ${when(idea.updatedAt)}`));
  if (idea.id === pinnedId) $('#detail-meta').prepend(el('span', 'sg-pin-label', '상단 고정'));
  $('#detail-actions').replaceChildren(...actionsFor(idea).children);
  $('#detail-together').replaceChildren(discussionCard(idea));
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
function openIdeaEditor(idea) {
  if (editBusy || !profile || user?.uid !== idea.authorId) return;
  editingIdea = { ...idea };
  $('#edit-idea-title').value = idea.title;
  $('#edit-idea-body').value = idea.body;
  $('#edit-idea-topic').replaceChildren(...Array.from($('#idea-topic').options, option => option.cloneNode(true)));
  $('#edit-idea-topic').value = idea.topic;
  $('#edit-idea-error').textContent = '';
  $('#edit-idea-dialog').showModal(); $('#edit-idea-title').focus();
}
function closeIdeaEditor(force = false) {
  if (editBusy && !force) return;
  $('#edit-idea-dialog').close(); editingIdea = null;
  $('#edit-idea-form').reset(); $('#edit-idea-error').textContent = '';
}
$('#edit-idea-cancel').addEventListener('click', () => closeIdeaEditor());
$('#edit-idea-dialog').addEventListener('cancel', event => { event.preventDefault(); closeIdeaEditor(); });
$('#edit-idea-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (editBusy || !editingIdea) return;
  const original = editingIdea, uid = user?.uid;
  const title = $('#edit-idea-title').value.trim(), body = $('#edit-idea-body').value.trim(), topic = $('#edit-idea-topic').value;
  if (!title) { $('#edit-idea-error').textContent = '생각 한 줄을 적어주세요.'; $('#edit-idea-title').focus(); return; }
  if (!profile || uid !== original.authorId) { closeIdeaEditor(); showStatus('글을 올린 계정으로 다시 접속해주세요.', true); return; }
  const controls = Array.from($('#edit-idea-form').querySelectorAll('input, textarea, select, button'));
  editBusy = true; controls.forEach(control => control.disabled = true); $('#edit-idea-error').textContent = '';
  try {
    const updated = await api.updateIdea(store, uid, original, { title, body, topic });
    if (user?.uid !== uid || editingIdea !== original) return;
    feedRows = feedRows.map(idea => idea.id === updated.id ? updated : idea);
    extraRows = extraRows.map(idea => idea.id === updated.id ? updated : idea);
    if (pinnedId === updated.id) pinnedIdea = updated;
    if (currentIdea?.id === updated.id) currentIdea = updated;
    closeIdeaEditor(true); refreshPinViews(); showStatus('생각을 수정했어요. 보탬과 함께하는 대화는 그대로예요.');
  } catch (error) {
    if (user?.uid === uid && editingIdea === original) $('#edit-idea-error').textContent = errorText(error);
  } finally { editBusy = false; controls.forEach(control => control.disabled = false); }
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

function renderRequests() {
  const groups = user && profile ? requestGroups : [];
  const count = groups.reduce((sum, group) => sum + group.requests.length, 0);
  $('#request-badge').hidden = !count;
  $('#request-badge').textContent = String(count);
  $('#chat-nav').setAttribute('aria-label', count ? `함께하기 · 참여 신청 ${count}건` : '함께하기');
  $('#request-notice').hidden = !count || view === 'chat';
  $('#request-notice-title').textContent = `내 생각에 함께하고 싶은 신청이 ${count}건 있어요`;
  $('#request-inbox').hidden = !count;
  const inbox = $('#inbox-list'); inbox.replaceChildren();
  for (const group of groups) {
    const section = el('section', 'sg-request-group');
    const heading = el('h3'); heading.append(button(group.title, () => openIdea(group.id), 'sg-title-link'));
    section.append(heading);
    group.requests.forEach(request => section.append(requestRow(group.id, request)));
    inbox.append(section);
  }
  const requests = view === 'detail' && currentIdea?.authorId === user?.uid
    ? groups.find(group => group.id === currentIdea.id)?.requests || [] : [];
  $('#join-requests').hidden = !requests.length;
  $('#request-list').replaceChildren(...requests.map(request => requestRow(currentIdea.id, request)));
}
function requestRow(id, request) {
  const item = el('div', 'sg-request'), copy = el('div', 'sg-request-copy');
  copy.append(el('strong', '', `${request.authorName}님이 함께하고 싶어 해요.`), el('p', 'sg-caption', `참여 신청 · ${when(request.createdAt)}`));
  const actions = el('div', 'sg-actions');
  const accept = button('참여 수락', () => decideJoin(id, request, true), 'sg-button sg-primary');
  const decline = button('이번에는 어려워요', () => decideJoin(id, request, false));
  accept.disabled = decline.disabled = decidingRequests.has(`${id}:${request.id}`);
  actions.append(accept, decline); item.append(copy, actions); return item;
}
async function decideJoin(id, request, accept) {
  const key = `${id}:${request.id}`, uid = user?.uid, version = requestVersion;
  if (!uid || decidingRequests.has(key)) return;
  decidingRequests.add(key); renderRequests(); $('#request-error').hidden = true;
  try {
    await api.decideRequest(store, id, request.id, accept);
    if (user?.uid !== uid || requestVersion !== version) return;
    const message = accept ? `${request.authorName}님의 참여를 수락했어요. 이제 같은 대화방에서 이야기할 수 있어요.` : `${request.authorName}님의 신청을 정리했어요.`;
    $('#request-result').textContent = message; showStatus(view === 'chat' ? '' : message);
  } catch (error) {
    if (user?.uid !== uid || requestVersion !== version) return;
    $('#request-error').textContent = errorText(error); $('#request-error').hidden = false;
  } finally {
    if (requestVersion === version) { decidingRequests.delete(key); renderRequests(); }
  }
}
function watchOwnerRequests() {
  stopInbox?.(); stopInbox = undefined;
  const uid = user?.uid, version = ++requestVersion;
  requestGroups = []; decidingRequests.clear(); renderRequests();
  $('#request-error').hidden = true;
  if (!uid || !profile) return;
  stopInbox = api.watchRequestInbox(store, uid, groups => {
    if (user?.uid !== uid || requestVersion !== version) return;
    requestGroups = groups; renderRequests(); renderFeed();
    if (view === 'detail') renderDetail();
  }, error => {
    if (user?.uid !== uid || requestVersion !== version) return;
    $('#request-error').textContent = `참여 신청을 불러오지 못했어요. ${errorText(error)}`;
    $('#request-error').hidden = false;
  });
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
    else { selectedRoom = selected; $('#room-title').textContent = selected.title; $('#room-members').textContent = `${selected.memberIds.length}명 · 초대받은 사람끼리 나누는 대화`; renderRoomContext(selected); }
  }
}
function selectRoom(id) {
  const room = rooms.find(item => item.id === id); if (!room) return;
  stopChat(); selectedRoom = room; recentMessages = []; previousMessages = [];
  $('#chat-empty').hidden = true; $('#chat-content').hidden = false; $('#messages').replaceChildren();
  $('#room-title').textContent = room.title; $('#room-members').textContent = `${room.memberIds.length}명 · 초대받은 사람끼리 나누는 대화`;
  renderRoomContext(room);
  $('#message-input').value = '';
  const uid = user?.uid;
  stopMessages = api.watchMessages(store, id, (rows, more) => { if (user?.uid !== uid || selectedRoom?.id !== id) return; recentMessages = rows; $('#older-messages').hidden = !more; renderMessages(); }, error => showStatus(errorText(error), true));
}
function renderRoomContext(room) {
  const context = $('#room-context'); context.replaceChildren();
  context.append(el('strong', '', room.memberIds.length === 1 ? '지금은 작성자 혼자 있어요. 함께할 사람을 기다려요.' : '생각을 조금 더 구체적으로, 함께 이어가요.'));
  context.append(el('p', '', '대화를 남기면 둘러보기에 참여 인원과 최근 대화 시간이 표시돼요. 대화 내용은 이 모임 안에서만 보여요.'));
  context.append(el('p', '', '함께 고민할 질문 하나, 작게 해볼 일 하나부터 정해보세요.'));
  context.append(button('원래 생각과 보탬 보기', () => openIdea(room.id), 'sg-button sg-action-link'));
}
function renderMessages() {
  const list = $('#messages'); list.replaceChildren();
  const messages = merged(previousMessages, recentMessages);
  if (!messages.length) list.append(el('p', 'sg-empty', '첫 인사를 남겨주세요. 함께 해볼 작은 일부터 이야기해봐요.'));
  messages.forEach(message => { const item = el('div', `sg-message ${message.authorId === user?.uid ? 'sg-mine' : ''}`); item.append(el('span', '', `${message.authorName} · ${when(message.createdAt)}`), el('div', 'sg-bubble', message.text)); list.append(item); });
}
$('#older-messages').addEventListener('click', () => run($('#older-messages'), async () => {
  const oldest = merged(previousMessages, recentMessages)[0]; if (!oldest || !selectedRoom) return;
  const uid = user?.uid, roomId = selectedRoom.id;
  const rows = await api.olderMessages(store, roomId, oldest); if (user?.uid !== uid || selectedRoom?.id !== roomId) return; previousMessages = [...rows, ...previousMessages]; $('#older-messages').hidden = rows.length < 50; renderMessages();
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
  $('#profile-button').textContent = profile ? `${profile.displayName}님` : '시작하기 · 로그인';
  stopModerator?.(); stopModerator = undefined; canPin = false;
  if (user && profile) {
    const uid = user.uid;
    stopModerator = api.watchModerator(store, uid, allowed => {
      if (user?.uid !== uid) return;
      canPin = allowed; refreshPinViews(); renderAccount();
    }, error => { canPin = false; refreshPinViews(); console.error(error); });
  }
  refreshPinViews();
  stopRooms?.(); stopRooms = undefined; rooms = [];
  const uid = user?.uid;
  if (user && profile) stopRooms = api.watchRooms(store, uid, rows => {
    if (user?.uid !== uid) return;
    if (view === 'chat') $('#connection-status').hidden = true;
    rooms = rows; renderRooms(); renderFeed(); if (view === 'detail') renderDetail();
    rows.forEach(room => {
      const key = `${uid}:${room.id}`;
      if (syncedDiscussions.get(key) === room.memberIds.length) return;
      syncedDiscussions.set(key, room.memberIds.length);
      api.refreshDiscussion(store, room.id).catch(error => { syncedDiscussions.delete(key); console.error(error); showStatus('대화는 사용할 수 있지만, 둘러보기의 참여 표시를 갱신하지 못했어요. 잠시 후 새로고침해주세요.', true); });
    });
  }, error => showStatus(errorText(error), true));
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
    api.watchCommunity(store, watchPinnedIdea, error => showStatus('고정 글을 불러오지 못했어요. 잠시 후 새로고침해주세요.', true));
    let ready;
    identityReady = new Promise(resolve => { ready = resolve; });
    api.watchUser(store, next => {
      identityReady = setIdentity(next).catch(error => showStatus(errorText(error), true));
      identityReady.finally(ready);
    });
    route();
  }
} catch (error) { $('#connection-status').textContent = errorText(error); }
