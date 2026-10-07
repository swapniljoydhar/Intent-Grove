import { renderGardenTree } from './tree-renderer.js';
import { logError, wrapWithErrorBoundary, ERROR_CATEGORIES } from '../shared/error-tracing.js';
import { getNodeDuration, rewardHistoryView, STORAGE_KEY } from '../shared/state.js';
import { applyStoredTheme, mountThemeToggle, clearStoredTheme } from '../shared/theme.js';
import { applyPerfMode, nextPerfMode, sampleMemoryPressure, sampleSystemMemory } from '../shared/ram-guard.js';

let lastSettings = null;

async function message(type, payload = {}) { return chrome.runtime.sendMessage({ type, ...payload }); }
const svg = document.querySelector('#tree');
const sessionSelect = document.querySelector('#session-select');
const detail = document.querySelector('#branch-detail');
const careDialog = document.querySelector('#care-dialog');
const careTitle = document.querySelector('#care-dialog-title');
const careCopy = document.querySelector('#care-dialog-copy');
const careCancel = document.querySelector('#care-cancel');
const careConfirm = document.querySelector('#care-confirm');
let selectedSessionId = null; let selectedNodeId = null; let careAction = null; let careReturnFocus = null;

// Marker classes follow the rhythm the user chose, so the garden never calls a
// branch "deep" before their own choice threshold (or "long" before their gentle
// one). Defaults mirror DEFAULT_SETTINGS, so an unconfigured garden is unchanged.
let thresholds = { DESATURATE: 4, INTERRUPT: 5 };
function branchClass(node) { return node.state === 'pruned' ? 'pruned' : node.state === 'composted' ? 'saved' : node.depth >= thresholds.INTERRUPT ? 'deep' : node.depth >= thresholds.DESATURATE ? 'long' : node.depth === 0 ? 'root' : 'healthy'; }
function nodeClasses(node) { return `${branchClass(node)}${node.closedAt ? ' closed' : ''}`; }
function confidenceLabel(node) { return node.relationshipConfidence === 'direct' ? 'direct link' : node.relationshipConfidence === 'tab-inferred' ? 'new tab from a tracked page' : 'unlinked path'; }
function pathReason(node) {
  if (node.depth === 0) return 'You planted this as the root of the mission.';
  if (node.navigationKind === 'search') return 'This branch grew from a search step.';
  if (node.navigationKind === 'new-tab-link') return 'This branch opened in a new tab from another tracked page.';
  if (node.navigationKind === 'spa') return 'This branch followed an in-page route change.';
  if (node.navigationKind === 'manual' || node.relationshipConfidence === 'external') return 'This was an unlinked path you chose to explore.';
  return 'This branch followed a link from the page before it.';
}
function nodeDescription(node) { const state = node.state === 'pruned' ? 'pruned and kept in the trail' : node.state === 'composted' ? 'resting in compost' : node.depth === 0 ? 'mission root' : `${branchClass(node)} branch`; return `${(node.title || node.url || 'Untitled path').slice(0, 80)}, ${state}, ${confidenceLabel(node)}, depth ${node.depth}`; }
function shortLabel(node) { const value = (node.title || node.url || 'Untitled path').replace(/^https?:\/\//, ''); return value.length > 20 ? `${value.slice(0, 19)}…` : value; }
let lastTree = null;
let lastTreeMode = null;
let stageShiftTimer = 0;
function renderTree(session) {
  const tree = renderGardenTree(svg, session, {
    selectedNodeId, describeNode: nodeDescription, classForNode: nodeClasses, shortLabel
  });
  lastTree = tree;
  delete svg.dataset.preview; // the DOM was rebuilt; no stale hover preview
  // A stage change (seed -> sapling -> canopy -> deep) is a milestone: give
  // the whole scene one gentle crossfade. One-shot timer, no loops.
  if (lastTreeMode && lastTreeMode !== tree.mode) {
    svg.classList.remove('stage-shift');
    void svg.getBoundingClientRect(); // restart the one-shot animation
    svg.classList.add('stage-shift');
    window.clearTimeout(stageShiftTimer);
    stageShiftTimer = window.setTimeout(() => svg.classList.remove('stage-shift'), 900);
  }
  lastTreeMode = tree.mode;
  const stages = { empty: 'Every grove starts somewhere.', seed: 'A little beginning.', sapling: 'Putting down roots.', canopy: 'Room for your curiosity.', deep: 'A whole world of little discoveries.' };
  document.querySelector('#tree-stage').textContent = stages[tree.mode];
  document.querySelector('#tree-hint').textContent = !tree.root
    ? 'Plant an intention, and give your curiosity a place to grow.'
    : tree.nodes.length === 1
      ? 'Your intention is planted. Follow a link to grow your first leaf.'
      : 'Golden threads show how discoveries grew. Pick a leaf to trace its path home.';
  const picker = document.querySelector('#tree-page-select');
  picker.replaceChildren(makeTextElement('option', 'Choose a leaf…'));
  picker.firstChild.value = '';
  tree.nodes.forEach(node => {
    const option = makeTextElement('option', `${node.id === tree.root.id ? 'Root · ' : ''}${node.title || node.url || 'Untitled page'}`);
    option.value = node.id;
    picker.append(option);
  });
  picker.value = selectedNodeId || '';
  picker.parentElement.hidden = !tree.root;
  renderDetail(tree.nodes.find(node => node.id === selectedNodeId), session);
}
function makeTextElement(tag, text, className = '') {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = text;
  return element;
}
function makeBranchButton(action, label, quiet = false) {
  const button = makeTextElement('button', label, `detail-button${quiet ? ' quiet' : ''}`);
  button.type = 'button';
  button.dataset.branchAction = action;
  return button;
}
function renderDetail(node, session) {
  detail.replaceChildren();
  if (!node) { detail.hidden = true; return; }
  detail.hidden = false;
  const isRoot = node.depth === 0;
  const isPruned = node.state === 'pruned' || node.state === 'composted';
  const parent = session.nodes.find((candidate) => candidate.id === node.parentId);
  const parentLabel = parent
    ? `From "${shortLabel(parent)}"`
    : isRoot
      ? 'This is the mission root.'
      : 'Arrived as an unlinked path.';
  const stateLabel = node.state === 'pruned'
    ? 'pruned'
    : node.state === 'composted'
      ? 'resting in compost'
      : 'growing';
  const duration = getNodeDuration(node);
  let durationLabel = '';
  if (duration > 0) {
    const mins = Math.floor(duration / 60);
    const secs = duration % 60;
    durationLabel = `Spent ${mins}m ${secs}s here`;
  }
  const copy = document.createElement('div');
  copy.className = 'detail-copy';
  copy.append(
    makeTextElement('p', 'SELECTED PATH', 'eyebrow'),
    makeTextElement('h3', (node.title || node.url || 'Untitled path').slice(0, 72)),
    makeTextElement('p', `Depth ${node.depth} · ${confidenceLabel(node)} · ${stateLabel}`, 'detail-meta'),
    makeTextElement('p', parentLabel, 'detail-parent'),
    makeTextElement('p', pathReason(node), 'detail-reason')
  );
  if (durationLabel) copy.append(makeTextElement('p', durationLabel, 'detail-duration'));
  // Where this path lives: the bare address as text, plus a safe visit link
  // for real pages (property-assigned href, noopener — same discipline as the
  // compost links).
  const urlText = String(node.url || '').replace(/^https?:\/\//, '');
  if (urlText) copy.append(makeTextElement('p', urlText.length > 64 ? `${urlText.slice(0, 63)}…` : urlText, 'detail-url'));
  if (/^https?:\/\//i.test(node.url || '')) {
    const visit = makeTextElement('a', 'Visit this page ↗', 'detail-visit');
    visit.href = node.url;
    visit.target = '_blank';
    visit.rel = 'noopener noreferrer';
    copy.append(visit);
  }
  const actions = document.createElement('div');
  actions.className = 'detail-actions';
  if (isRoot) {
    actions.append(makeTextElement('span', 'The root stays with this mission.', 'detail-note'));
  } else if (isPruned) {
    actions.append(makeTextElement('span', 'This path remains in the trail for reflection.', 'detail-note'));
  } else {
    actions.append(makeBranchButton('prune', 'Prune this path'), makeBranchButton('compost', 'Return to compost'));
  }
  actions.append(makeBranchButton('close', 'Leave it growing', true));
  detail.append(copy, actions);
}
function formatDuration(seconds) {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remainingMins = mins % 60;
  return `${hours}h ${remainingMins}m`;
}
function formatDate(timestamp) {
  const date = new Date(timestamp);
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function readableEvent(e) {
  if (e.type === 'mission_started') return `Planted \u201c${e.mission || 'a mission'}\u201d.`;
  if (e.type === 'origin_planted') return 'Found the root page for this mission.';
  if (e.type === 'navigation') return `Followed a branch to \u201c${(e.url || '').replace(/^https?:\/\//, '').slice(0, 48)}\u201d.`;
  if (e.type === 'external_path') return `Arrived at an unlinked path: \u201c${(e.url || '').replace(/^https?:\/\//, '').slice(0, 48)}\u201d.`;
  if (e.type === 'tab_joined_path') return 'A duplicate tab joined a known path.';
  if (e.type === 'return_to_path') return 'Returned to a path already growing in this garden.';
  if (e.type === 'composted') return 'Saved an interesting branch for later.';
  if (e.type === 'pruned') return 'Pruned a branch while keeping its trail note.';
  if (e.type === 'mission_changed') return 'Let this garden rest and chose a new direction.';
  if (e.type === 'mission_ended' && e.reason === 'browse_without_mission') return 'Set this mission down and continued without one.';
  if (e.type === 'mission_ended') return 'Closed this garden for the day.';
  if (e.type === 'link_opened') return 'Opened a new path from this page.';
  if (e.type === 'garden_at_capacity') return 'This garden reached its page limit, so a new path was not added.';
  if (e.type === 'back_forward') return 'Stepped back to a page already in this trail.';
  if (e.type === 'reload') return 'Reloaded the page you were already on.';
  if (e.type === 'search_refinement') return 'Refined a search instead of following a new branch.';
  // Unknown types are still humanised rather than leaking a raw identifier.
  const fallback = String(e.type || '').replaceAll('_', ' ').trim();
  return fallback ? `${fallback[0].toUpperCase()}${fallback.slice(1)}.` : 'A small step along this path.';
}
function relTime(at) {
  const diff = Date.now() - Number(at);
  if (!Number.isFinite(diff) || diff < 0) return '';
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days < 30 ? `${days}d ago` : '';
}
function renderEvents(session) {
  const box = document.querySelector('#events');
  box.replaceChildren();
  const events = (session?.events || []).slice().reverse();
  if (!events.length) {
    box.append(makeTextElement('p', 'Your trail notes will appear here.', 'muted'));
    return;
  }
  events.forEach((event) => {
    const item = document.createElement('div');
    item.className = 'event';
    item.append(makeTextElement('span', '', 'event-dot'));
    const copy = document.createElement('div');
    copy.append(makeTextElement('strong', readableEvent(event)));
    const ago = relTime(event.at);
    copy.append(makeTextElement('small', `${new Date(event.at).toLocaleTimeString([], { hour:'numeric', minute:'2-digit' })}${event.depth != null ? ` · branch ${event.depth}` : ''}${ago ? ` · ${ago}` : ''}`));
    item.append(copy);
    box.append(item);
  });
}
function renderCompost(items) {
  const box = document.querySelector('#compost');
  box.replaceChildren();
  if (!items?.length) {
    box.append(makeTextElement('p', 'Your saved curiosities will rest here.', 'muted'));
    return;
  }
  items.forEach((item) => {
    const row = document.createElement('div');
    row.className = 'compost-item';
    const copy = document.createElement('div');
    const link = makeTextElement('a', item.title);
    link.href = item.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    copy.append(link, makeTextElement('small', `${new Date(item.savedAt).toLocaleDateString()} · from “${item.mission}”`));
    const remove = makeTextElement('button', 'Remove');
    remove.type = 'button';
    remove.dataset.id = item.id;
    row.append(copy, remove);
    box.append(row);
  });
}
function renderFinds(history) {
  const panel = document.querySelector('#finds-panel');
  const box = document.querySelector('#finds');
  const finds = rewardHistoryView(history);
  // Rewards are opt-in, so the panel stays out of the way until there is something to show.
  panel.hidden = finds.length === 0;
  box.replaceChildren();
  if (!finds.length) return;
  finds.forEach((find) => {
    const row = document.createElement('div');
    row.className = 'find-item';
    const copy = document.createElement('div');
    copy.append(makeTextElement('strong', find.text));
    copy.append(makeTextElement('small', `${new Date(find.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · ${find.tier}`));
    row.append(makeTextElement('span', find.icon || '✦', 'find-icon'), copy);
    box.append(row);
  });
}
function renderSessions(sessions, activeId, currentId) {
  sessionSelect.replaceChildren();
  if (!sessions.length) {
    sessionSelect.append(makeTextElement('option', 'No gardens yet'));
  } else {
    sessions.slice().sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt)).forEach((session) => {
      const option = makeTextElement('option', `${session.mission}${session.id === activeId ? ' · active' : ''}`);
      option.value = session.id;
      sessionSelect.append(option);
    });
  }
  sessionSelect.value = currentId || activeId || sessions[0]?.id || '';
}
const safeRender = wrapWithErrorBoundary(render, { category: ERROR_CATEGORIES.UI_RENDER, function: 'render' });
async function render() {
  // GET_SNAPSHOT legally answers null (rate limit, worker restarting), and
  // messaging rejects while the worker is down. A null snap used to throw on
  // snap.settings and flip the whole garden into the error state over a
  // transient condition; normalize it to an empty-but-valid shape instead.
  const snap = (await message('GET_SNAPSHOT', { sessionId: selectedSessionId, includeHistory: true })) || { state: {}, settings: {}, session: null, thresholds: null, activeSessionId: null };
  document.body.dataset.motion = snap.settings?.ambientMotion === false ? 'off' : 'on';
  lastSettings = snap.settings || null;
  applyPerfMode(nextPerfMode(document.body.dataset.perf, snap.settings, { ...sampleMemoryPressure(), ...(await sampleSystemMemory()) }, window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true));
  thresholds = snap.thresholds || { DESATURATE: Number(snap.settings?.gentleDepth) || 4, INTERRUPT: Number(snap.settings?.choiceDepth) || 5 };
  selectedSessionId = snap.session?.id || null;
  renderSessions(snap.state.sessions || [], snap.activeSessionId, selectedSessionId);
  const session = snap.session;
  const nodes = session?.nodes || [];
  if (!nodes.some((node) => node.id === selectedNodeId)) selectedNodeId = null;
  document.querySelector('#mission').textContent = session ? `Mission: ${session.mission}` : 'A visual record of where your browsing path went today.';
  document.querySelector('#mission-note').textContent = session?.note ? `Why it matters: ${session.note}` : 'No extra reason was recorded for this mission.';
  const deepest = Math.max(0, ...nodes.map((node) => node.depth));
  const composted = nodes.filter((node) => node.state === 'composted').length;
  const pruned = nodes.filter((node) => node.state === 'pruned').length;
  const changed = session?.endReason === 'mission_changed';
  const storyline = !session
    ? 'A clearing is ready whenever you are.'
    : changed
      ? 'You noticed a new direction and gave this garden a graceful ending.'
      : pruned
        ? `You grew ${nodes.length} pages and pruned ${pruned} path${pruned === 1 ? '' : 's'} without losing the trail.`
        : composted
          ? `You grew ${nodes.length} pages and returned ${composted} curiosit${composted === 1 ? 'y' : 'ies'} to the compost pile.`
          : deepest >= thresholds.DESATURATE
            ? `You grew ${nodes.length} pages. The longest traced path is ${deepest} navigation steps from its root; only you know whether it served your intention.`
            : `You grew ${nodes.length} pages from a single clear intention.`;
  document.querySelector('#storyline').textContent = storyline;
  const weatherCue = document.querySelector('#weather-cue');
  weatherCue.textContent = session?.status === 'completed' ? 'Resting garden' : deepest >= thresholds.DESATURATE ? 'A little dusk' : nodes.length > 4 ? 'Fern light' : 'Soft light';
  weatherCue.dataset.cue = session?.status === 'completed' ? 'resting' : deepest >= thresholds.DESATURATE ? 'dusk' : nodes.length > 4 ? 'fern' : 'soft';
  document.body.dataset.gardenState = session?.status === 'completed' ? 'resting' : 'growing';
  renderTree(session);
  renderEvents(session);
  renderCompost(snap.state.compostItems);
  renderFinds(snap.state.rewardHistory);
}
async function renderSafely() { 
  try { 
    await safeRender(); 
  } catch (error) { 
    logError(error, { category: ERROR_CATEGORIES.UI_RENDER, function: 'renderSafely' });
    document.querySelector('#mission').textContent = 'The garden could not be read right now.'; 
    document.querySelector('#storyline').textContent = 'Your local data is still on this device. Try opening the garden again.'; 
    sessionSelect.replaceChildren(makeTextElement('option', 'Garden unavailable'));
    renderTree(null);
    renderEvents(null);
    renderCompost([]);
    detail.replaceChildren();
    detail.hidden = true;
    document.body.dataset.gardenState = 'error';
  } 
}
function closeCareDialog() { careDialog.hidden = true; const returnFocus = careReturnFocus; careAction = null; careReturnFocus = null; if (returnFocus && document.contains(returnFocus)) returnFocus.focus(); }
function openCareDialog(action, trigger) { careAction = action; careReturnFocus = trigger; const deletingAll = action === 'clear'; careTitle.textContent = deletingAll ? 'Clear every garden?' : 'Forget this garden?'; careCopy.textContent = deletingAll ? 'This removes all local gardens, trail notes, and saved curiosities from this device. Nothing is sent anywhere.' : 'This removes the selected garden from this device. Its saved curiosities remain in the compost pile unless you remove them separately.'; careConfirm.textContent = deletingAll ? 'Clear local data' : 'Forget garden'; careDialog.hidden = false; careConfirm.focus(); }
const safeConfirmCareAction = wrapWithErrorBoundary(confirmCareAction, { category: ERROR_CATEGORIES.MESSAGING, function: 'confirmCareAction', swallow: true });
async function confirmCareAction() { const action = careAction; const sessionId = selectedSessionId; closeCareDialog(); if (action === 'forget' && sessionId) { await message('DELETE_SESSION', { sessionId }); selectedSessionId = null; selectedNodeId = null; await renderSafely(); } else if (action === 'clear') { const cleared = await message('CLEAR_DATA'); if (!cleared?.error) clearStoredTheme(); selectedSessionId = null; selectedNodeId = null; await renderSafely(); } }
careCancel.addEventListener('click', wrapWithErrorBoundary(closeCareDialog, { category: ERROR_CATEGORIES.UI_RENDER, function: 'careCancel.click', swallow: true }));
careConfirm.addEventListener('click', safeConfirmCareAction);
careDialog.addEventListener('click', wrapWithErrorBoundary(event => { if (event.target === careDialog) closeCareDialog(); }, { category: ERROR_CATEGORIES.UI_RENDER, function: 'careDialog.click', swallow: true }));
document.addEventListener('keydown', wrapWithErrorBoundary(event => { if (careDialog.hidden) return; if (event.key === 'Escape') { event.preventDefault(); closeCareDialog(); } if (event.key === 'Tab') { const focusables = [careCancel, careConfirm]; const index = focusables.indexOf(document.activeElement); if (event.shiftKey && index <= 0) { event.preventDefault(); focusables[focusables.length - 1].focus(); } else if (!event.shiftKey && (index === focusables.length - 1 || index < 0)) { event.preventDefault(); focusables[0].focus(); } } }, { category: ERROR_CATEGORIES.UI_RENDER, function: 'document.keydown', swallow: true }));
const safeSelectNode = wrapWithErrorBoundary(selectNode, { category: ERROR_CATEGORIES.UI_RENDER, function: 'selectNode', swallow: true });
async function selectNode(nodeId, returnFocus = false) { selectedNodeId = nodeId; await renderSafely(); if (returnFocus && !detail.hidden) detail.focus({ preventScroll: true }); }
document.querySelector('#tree-page-select').addEventListener('change', wrapWithErrorBoundary(event => safeSelectNode(event.target.value || null, true), { category: ERROR_CATEGORIES.UI_RENDER, function: 'treePageSelect.change', swallow: true }));
sessionSelect.addEventListener('change', wrapWithErrorBoundary(() => { selectedSessionId = sessionSelect.value; selectedNodeId = null; renderSafely(); }, { category: ERROR_CATEGORIES.UI_RENDER, function: 'sessionSelect.change', swallow: true }));
svg.addEventListener('click', wrapWithErrorBoundary(event => { const node = event.target.closest?.('[data-node-id]'); if (node) safeSelectNode(node.dataset.nodeId); }, { category: ERROR_CATEGORIES.UI_RENDER, function: 'svg.click', swallow: true }));
svg.addEventListener('keydown', wrapWithErrorBoundary(event => {
  const node = event.target.closest?.('[data-node-id]');
  if (node && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); safeSelectNode(node.dataset.nodeId, true); return; }
  // Arrow keys walk the leaves in reading order (DOM order = arrival order),
  // so the whole garden is traversable without a pointer.
  if (['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(event.key)) {
    const leaves = [...svg.querySelectorAll('.node[data-node-id]')];
    if (!leaves.length) return;
    event.preventDefault();
    const current = event.target.closest?.('.node[data-node-id]');
    const index = current ? leaves.indexOf(current) : -1;
    const delta = (event.key === 'ArrowRight' || event.key === 'ArrowDown') ? 1 : -1;
    // With no leaf focused yet, ArrowRight/Down enters at the first leaf and
    // ArrowLeft/Up at the last — Math.max(index,0) used to skip leaves[0].
    const start = index === -1 ? (delta === 1 ? -1 : 0) : index;
    const next = leaves[((start + delta) % leaves.length + leaves.length) % leaves.length];
    next?.focus();
  }
}, { category: ERROR_CATEGORIES.UI_RENDER, function: 'svg.keydown', swallow: true }));
// Hover preview: softly light a leaf's ancestry before the user commits to
// selecting it. Pure class toggling on existing edges (data-edge-for), so it
// never interferes with the selection highlight layer.
function ancestorsOf(nodeId) {
  const ids = new Set();
  if (!lastTree || !nodeId) return ids;
  let id = nodeId;
  while (id && !ids.has(id)) { ids.add(id); id = lastTree.parentById.get(id); }
  return ids;
}
function clearTrailPreview() {
  svg.querySelectorAll('.branch-taper.trail-preview').forEach((edge) => edge.classList.remove('trail-preview'));
  delete svg.dataset.preview;
}
function applyTrailPreview(nodeId) {
  clearTrailPreview();
  if (!nodeId || nodeId === selectedNodeId) return; // selection already traces it
  const ids = ancestorsOf(nodeId);
  svg.querySelectorAll('.branch-layer .branch-taper[data-edge-for]').forEach((edge) => {
    if (ids.has(edge.dataset.edgeFor)) edge.classList.add('trail-preview');
  });
  svg.dataset.preview = 'on';
}
svg.addEventListener('mouseover', wrapWithErrorBoundary(event => { const node = event.target.closest?.('[data-node-id]'); if (node) { node.classList.add('hovered'); applyTrailPreview(node.dataset.nodeId); } }, { category: ERROR_CATEGORIES.UI_RENDER, function: 'svg.mouseover', swallow: true }));
svg.addEventListener('mouseout', wrapWithErrorBoundary(event => { const node = event.target.closest?.('[data-node-id]'); if (node) { node.classList.remove('hovered'); clearTrailPreview(); } }, { category: ERROR_CATEGORIES.UI_RENDER, function: 'svg.mouseout', swallow: true }));
detail.addEventListener('click', wrapWithErrorBoundary(async event => { const action = event.target.dataset.branchAction; if (!action) return; if (action === 'close') { selectedNodeId = null; await renderSafely(); return; } if (!selectedSessionId || !selectedNodeId) return; await message('PRUNE_NODE', { sessionId: selectedSessionId, nodeId: selectedNodeId, toCompost: action === 'compost' }); await renderSafely(); }, { category: ERROR_CATEGORIES.MESSAGING, function: 'detail.click', swallow: true }));
document.querySelector('#compost').addEventListener('click', wrapWithErrorBoundary(async event => { const id = event.target.dataset.id; if (id) { await message('DELETE_COMPOST', { id }); await renderSafely(); } }, { category: ERROR_CATEGORIES.MESSAGING, function: 'compost.click', swallow: true }));
document.querySelector('#forget').addEventListener('click', wrapWithErrorBoundary(event => { if (selectedSessionId) openCareDialog('forget', event.currentTarget); }, { category: ERROR_CATEGORIES.UI_RENDER, function: 'forget.click', swallow: true }));
document.querySelector('#forget-site').addEventListener('click', wrapWithErrorBoundary(async () => {
  // GET_SNAPSHOT can legitimately answer null (rate limit, worker restart);
  // dereferencing it directly threw and made the button look inert.
  const snapshot = selectedSessionId ? await message('GET_SNAPSHOT', { sessionId: selectedSessionId }) : null;
  const session = snapshot?.session || null;
  const node = session?.nodes?.find((item) => item.id === selectedNodeId) || session?.nodes?.at(-1);
  let hostname = '';
  try { hostname = new URL(node?.url || '').hostname; } catch {}
  if (!hostname) return;
  await message('FORGET_SITE', { hostname });
  selectedNodeId = null;
  await renderSafely();
}, { category: ERROR_CATEGORIES.UI_RENDER, function: 'forget-site.click', swallow: true }));
document.querySelector('#clear').addEventListener('click', wrapWithErrorBoundary(event => openCareDialog('clear', event.currentTarget), { category: ERROR_CATEGORIES.UI_RENDER, function: 'clear.click', swallow: true }));
document.querySelector('#settings').addEventListener('click', wrapWithErrorBoundary(() => chrome.runtime.openOptionsPage(), { category: ERROR_CATEGORIES.UI_RENDER, function: 'settings.click', swallow: true }));

// Tab switching
const tabButtons = document.querySelectorAll('.tab-btn');
const mapTab = document.querySelector('#map-tab');
const statsTab = document.querySelector('#stats-tab');
let activeTab = null;
function switchTab(tab) {
  if (tab !== 'map' && tab !== 'stats') return;
  const changed = activeTab !== tab;
  activeTab = tab;
  // Always reconcile visibility, even when the already-active button is clicked.
  tabButtons.forEach(btn => {
    const selected = btn.dataset.tab === tab;
    btn.classList.toggle('active', selected);
    btn.setAttribute('aria-pressed', String(selected));
  });
  if (mapTab) { mapTab.classList.toggle('active', tab === 'map'); mapTab.hidden = tab !== 'map'; }
  if (statsTab) { statsTab.classList.toggle('active', tab === 'stats'); statsTab.hidden = tab !== 'stats'; }
  if (tab === 'stats' && changed) loadStatsTab();
}
const safeSwitchTab = wrapWithErrorBoundary(switchTab, { category: ERROR_CATEGORIES.UI_RENDER, function: 'switchTab', swallow: true });
tabButtons.forEach(btn => btn.addEventListener('click', () => safeSwitchTab(btn.dataset.tab)));

// Stats rendering
function renderWeeklyChart(weeklyData) {
  const svg = document.getElementById('weeklyChart');
  if (!svg) return;
  svg.replaceChildren();
  if (!weeklyData || !weeklyData.length) {
    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('x', '200'); text.setAttribute('y', '125');
    text.setAttribute('text-anchor', 'middle'); text.setAttribute('fill', '#6b7280');
    text.setAttribute('font-size', '14'); text.textContent = 'No data yet.';
    svg.append(text);
    return;
  }
  const maxVal = Math.max(1, ...weeklyData.map(d => d.minutes));
  const barW = 36; const gap = 16; const chartH = 180; const chartY = 220;
  const totalW = weeklyData.length * (barW + gap) - gap;
  const startX = (400 - totalW) / 2;
  for (let i = 0; i <= 4; i++) {
    const y = chartY - (chartH * i / 4);
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', '30'); line.setAttribute('y1', String(y));
    line.setAttribute('x2', '370'); line.setAttribute('y2', String(y));
    line.setAttribute('stroke', '#e5e7eb'); line.setAttribute('stroke-width', '1');
    svg.append(line);
    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    label.setAttribute('x', '25'); label.setAttribute('y', String(y + 4));
    label.setAttribute('text-anchor', 'end'); label.setAttribute('fill', '#9ca3af');
    label.setAttribute('font-size', '10'); label.textContent = String(Math.round(maxVal * i / 4));
    svg.append(label);
  }
  weeklyData.forEach((d, i) => {
    const x = startX + i * (barW + gap);
    const barH = (d.minutes / maxVal) * chartH;
    const y = chartY - barH;
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', String(x)); rect.setAttribute('y', String(y));
    rect.setAttribute('width', String(barW)); rect.setAttribute('height', String(Math.max(barH, 0)));
    rect.setAttribute('rx', '4'); rect.setAttribute('fill', '#10b981');
    // Native SVG tooltip + a quiet marker on today's bar (the last bucket).
    rect.setAttribute('class', i === weeklyData.length - 1 ? 'week-bar today-bar' : 'week-bar');
    const tip = document.createElementNS('http://www.w3.org/2000/svg', 'title');
    tip.textContent = `${d.day} (${d.date}): ${d.minutes} minute${d.minutes === 1 ? '' : 's'}`;
    rect.append(tip);
    svg.append(rect);
    if (d.minutes > 0) {
      const val = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      val.setAttribute('x', String(x + barW / 2)); val.setAttribute('y', String(y - 6));
      val.setAttribute('text-anchor', 'middle'); val.setAttribute('fill', '#374151');
      val.setAttribute('font-size', '11'); val.setAttribute('font-weight', '600');
      val.textContent = String(d.minutes);
      svg.append(val);
    }
    const lbl = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    lbl.setAttribute('x', String(x + barW / 2)); lbl.setAttribute('y', String(chartY + 16));
    lbl.setAttribute('text-anchor', 'middle'); lbl.setAttribute('fill', '#6b7280');
    lbl.setAttribute('font-size', '11'); lbl.textContent = d.day;
    svg.append(lbl);
  });
}

function renderWeeklyTrendChart(svgId, weeklyTrendData, metric) {
  const svg = document.getElementById(svgId);
  if (!svg) return;
  svg.replaceChildren();
  const data = Array.isArray(weeklyTrendData) ? weeklyTrendData : [];
  const isIntentions = metric === 'intentionsStarted';
  const formatValue = (value) => isIntentions ? String(Math.round(value)) : Number(value).toFixed(1);
  const description = isIntentions
    ? 'Intentions started'
    : 'Average deepest path in navigation steps';
  if (!data.some((week) => week.intentionsStarted > 0)) {
    svg.setAttribute('aria-label', `${description} for the last eight Monday–Sunday UTC weeks. No intention sessions were recorded during this period.`);
    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('x', '200'); text.setAttribute('y', '125');
    text.setAttribute('text-anchor', 'middle'); text.setAttribute('class', 'trend-empty-state');
    text.textContent = 'No intentions started in these eight weeks.';
    svg.append(text);
    return;
  }

  const values = data.map((week) => Math.max(0, Number(week[metric]) || 0));
  const accessibleValues = data.map((week, index) => `${week.weekLabel}: ${formatValue(values[index])}`).join('; ');
  svg.setAttribute('aria-label', `${description} for the last eight Monday–Sunday UTC weeks: ${accessibleValues}.`);
  const maxValue = isIntentions ? Math.max(4, Math.ceil(Math.max(...values))) : Math.max(1, ...values);
  const chartTop = 32; const chartBottom = 216; const chartHeight = chartBottom - chartTop;
  for (let i = 0; i <= 4; i++) {
    const y = chartBottom - chartHeight * i / 4;
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', '42'); line.setAttribute('y1', String(y));
    line.setAttribute('x2', '376'); line.setAttribute('y2', String(y));
    line.setAttribute('class', 'trend-grid-line');
    svg.append(line);
    const tick = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    tick.setAttribute('x', '36'); tick.setAttribute('y', String(y + 4));
    tick.setAttribute('text-anchor', 'end'); tick.setAttribute('class', 'trend-axis-label');
    tick.textContent = formatValue(maxValue * i / 4);
    svg.append(tick);
  }

  const barWidth = 25; const gap = 16; const startX = 52;
  data.forEach((week, index) => {
    const value = values[index];
    const barHeight = value / maxValue * chartHeight;
    const x = startX + index * (barWidth + gap);
    const y = chartBottom - barHeight;
    const bar = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    bar.setAttribute('x', String(x)); bar.setAttribute('y', String(y));
    bar.setAttribute('width', String(barWidth)); bar.setAttribute('height', String(barHeight));
    bar.setAttribute('rx', '4'); bar.setAttribute('class', 'weekly-trend-bar');
    const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
    title.textContent = isIntentions
      ? `Week of ${week.weekStart}: ${formatValue(value)} intention${value === 1 ? '' : 's'} started`
      : `Week of ${week.weekStart}: ${formatValue(value)} average deepest navigation steps`;
    bar.append(title);
    svg.append(bar);

    if (value > 0) {
      const valueLabel = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      valueLabel.setAttribute('x', String(x + barWidth / 2));
      valueLabel.setAttribute('y', String(y - 6));
      valueLabel.setAttribute('text-anchor', 'middle');
      valueLabel.setAttribute('class', 'trend-value-label');
      valueLabel.textContent = formatValue(value);
      svg.append(valueLabel);
    }

    const weekLabel = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    weekLabel.setAttribute('x', String(x + barWidth / 2));
    weekLabel.setAttribute('y', String(chartBottom + 18));
    weekLabel.setAttribute('text-anchor', 'middle');
    weekLabel.setAttribute('class', 'trend-week-label');
    weekLabel.textContent = week.weekLabel;
    svg.append(weekLabel);
  });
}

function renderDomainChart(domainData) {
  const svg = document.getElementById('domainChart');
  if (!svg) return;
  svg.replaceChildren();
  if (!domainData || !domainData.length) {
    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('x', '200'); text.setAttribute('y', '125');
    text.setAttribute('text-anchor', 'middle'); text.setAttribute('fill', '#6b7280');
    text.setAttribute('font-size', '14'); text.textContent = 'No data yet.';
    svg.append(text);
    return;
  }
  const colors = ['#10b981', '#3b82f6', '#8b5cf6', '#f59e0b', '#ef4444'];
  const cx = 150; const cy = 125; const r = 90; const innerR = 50;
  const total = domainData.reduce((sum, d) => sum + d.count, 0);
  if (total <= 0) {
    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('x', '200'); text.setAttribute('y', '125');
    text.setAttribute('text-anchor', 'middle'); text.setAttribute('fill', '#6b7280');
    text.setAttribute('font-size', '14'); text.textContent = 'No data yet.';
    svg.append(text);
    return;
  }
  let angle = -Math.PI / 2;
  domainData.forEach((d, i) => {
    const sliceAngle = (d.count / total) * 2 * Math.PI;
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    if (sliceAngle >= Math.PI * 2 - 1e-6) {
      // A single 100% slice would make the arc's endpoints coincide, which
      // SVG renders as nothing — the ring would appear empty. Split the ring
      // into two half-arcs and carve the hole with fill-rule: evenodd.
      const top = { x: cx, y: cy - r }, topInner = { x: cx, y: cy - innerR };
      const bottom = { x: cx, y: cy + r }, bottomInner = { x: cx, y: cy + innerR };
      path.setAttribute('d',
        `M${top.x} ${top.y} A${r} ${r} 0 1 1 ${bottom.x} ${bottom.y} A${r} ${r} 0 1 1 ${top.x} ${top.y} Z ` +
        `M${topInner.x} ${topInner.y} A${innerR} ${innerR} 0 1 0 ${bottomInner.x} ${bottomInner.y} A${innerR} ${innerR} 0 1 0 ${topInner.x} ${topInner.y} Z`);
      path.setAttribute('fill-rule', 'evenodd');
    } else {
      const x1 = cx + r * Math.cos(angle); const y1 = cy + r * Math.sin(angle);
      const x2 = cx + r * Math.cos(angle + sliceAngle); const y2 = cy + r * Math.sin(angle + sliceAngle);
      const ix1 = cx + innerR * Math.cos(angle); const iy1 = cy + innerR * Math.sin(angle);
      const ix2 = cx + innerR * Math.cos(angle + sliceAngle); const iy2 = cy + innerR * Math.sin(angle + sliceAngle);
      const large = sliceAngle > Math.PI ? 1 : 0;
      path.setAttribute('d', `M${x1.toFixed(2)} ${y1.toFixed(2)} A${r} ${r} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} L${ix2.toFixed(2)} ${iy2.toFixed(2)} A${innerR} ${innerR} 0 ${large} 0 ${ix1.toFixed(2)} ${iy1.toFixed(2)} Z`);
    }
    path.setAttribute('fill', colors[i % colors.length]);
    const sliceTip = document.createElementNS('http://www.w3.org/2000/svg', 'title');
    sliceTip.textContent = `${d.domain}: ${d.count} page${d.count === 1 ? '' : 's'}`;
    path.append(sliceTip);
    svg.append(path);
    angle += sliceAngle;
  });
  domainData.forEach((d, i) => {
    const ly = 60 + i * 28;
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', '290'); rect.setAttribute('y', String(ly));
    rect.setAttribute('width', '14'); rect.setAttribute('height', '14');
    rect.setAttribute('rx', '3'); rect.setAttribute('fill', colors[i % colors.length]);
    svg.append(rect);
    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    label.setAttribute('x', '310'); label.setAttribute('y', String(ly + 11));
    label.setAttribute('fill', '#374151'); label.setAttribute('font-size', '12');
    label.textContent = d.domain.length > 18 ? d.domain.slice(0, 17) + '…' : d.domain;
    svg.append(label);
    const count = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    count.setAttribute('x', '390'); count.setAttribute('y', String(ly + 11));
    count.setAttribute('text-anchor', 'end'); count.setAttribute('fill', '#6b7280');
    count.setAttribute('font-size', '11'); count.textContent = String(d.count);
    svg.append(count);
  });
}

function renderHistoryTable(history) {
  const tbody = document.querySelector('#historyTable tbody');
  if (!tbody) return;
  if (!history || history.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 4;
    td.className = 'empty-state';
    td.textContent = 'No sessions recorded yet.';
    tr.appendChild(td);
    tbody.replaceChildren(tr);
    return;
  }
  tbody.replaceChildren();
  history.slice(0, 10).forEach(session => {
    const tr = document.createElement('tr');
    const tdDate = document.createElement('td');
    tdDate.textContent = formatDate(session.timestamp);
    tr.appendChild(tdDate);
    const tdDomain = document.createElement('td');
    tdDomain.textContent = session.domain || 'Unknown';
    tr.appendChild(tdDomain);
    const tdDuration = document.createElement('td');
    tdDuration.textContent = formatDuration(session.duration);
    tr.appendChild(tdDuration);
    const tdType = document.createElement('td');
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = session.type;
    tdType.appendChild(tag);
    tr.appendChild(tdType);
    tbody.appendChild(tr);
  });
}

function renderSavedItems(items, agedCount = 0) {
  const container = document.getElementById('savedList');
  if (!container) return;
  container.replaceChildren();
  if (agedCount > 0) {
    // Strict-mode compost honesty: age-based facts only — the extension never
    // claims to know whether a saved page was revisited.
    const note = document.createElement('p');
    note.className = 'saved-aged-note';
    note.textContent = `${agedCount} saved ${agedCount === 1 ? 'curiosity has' : 'curiosities have'} been resting for over a week.`;
    container.appendChild(note);
  }
  if (!items || items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No items saved yet.';
    container.appendChild(empty);
    return;
  }
  items.forEach(item => {
    const div = document.createElement('div');
    div.className = 'saved-item';
    const infoDiv = document.createElement('div');
    infoDiv.style.overflow = 'hidden';
    infoDiv.style.textOverflow = 'ellipsis';
    infoDiv.style.whiteSpace = 'nowrap';
    infoDiv.style.maxWidth = '70%';
    const titleDiv = document.createElement('div');
    titleDiv.style.fontWeight = '600';
    titleDiv.style.fontSize = '0.9rem';
    titleDiv.textContent = item.title || '';
    infoDiv.appendChild(titleDiv);
    const urlDiv = document.createElement('div');
    urlDiv.style.fontSize = '0.8rem';
    urlDiv.style.opacity = '0.7';
    urlDiv.textContent = item.url || '';
    infoDiv.appendChild(urlDiv);
    div.appendChild(infoDiv);
    const btn = document.createElement('button');
    btn.className = 'btn btn-secondary delete-saved';
    btn.setAttribute('data-id', item.id);
    btn.setAttribute('aria-label', 'Remove item');
    btn.textContent = '×';
    div.appendChild(btn);
    container.appendChild(div);
  });
  container.querySelectorAll('.delete-saved').forEach(btn => {
    btn.addEventListener('click', wrapWithErrorBoundary(async (e) => {
      const id = e.target.dataset.id;
      await message('REMOVE_SAVED_ITEM', { id });
      loadStatsTab();
    }, { category: ERROR_CATEGORIES.MESSAGING, function: 'deleteSavedItem.click', swallow: true }));
  });
}

async function loadStatsTab() {
  try {
    const response = await message('GET_DASHBOARD_STATS');
    if (!response || response.error) {
      console.warn('Could not load dashboard stats:', response?.error);
      return;
    }
    const { totalSessions, totalFocusTime, totalActiveTabTime, intentionalBranches, unlinkedPaths, interruptionsDismissed, averageBranchDepth, currentStreak, weeklyData, weeklyTrendData, domainData, history, savedItems } = response;
    const totalSessionsEl = document.getElementById('totalSessions');
    const totalFocusTimeEl = document.getElementById('totalFocusTime');
    const currentStreakEl = document.getElementById('currentStreak');
    const savedCountEl = document.getElementById('savedCount');
    const activeTabTimeEl = document.getElementById('totalActiveTabTime');
    const intentionalBranchesEl = document.getElementById('intentionalBranches');
    const unlinkedPathsEl = document.getElementById('unlinkedPaths');
    const promptsDeclinedEl = document.getElementById('promptsDeclined');
    const averageBranchDepthEl = document.getElementById('averageBranchDepth');
    if (totalSessionsEl) totalSessionsEl.textContent = totalSessions;
    if (totalFocusTimeEl) totalFocusTimeEl.textContent = formatDuration(totalFocusTime);
    if (currentStreakEl) currentStreakEl.textContent = currentStreak;
    const milestoneEl = document.getElementById('streakMilestone');
    // Milestone copy lives here, not in the worker; positive-only wording —
    // a broken streak shows nothing and is never framed as a loss.
    if (milestoneEl) milestoneEl.textContent = { roots: 'Three days — roots are holding.', week: 'A week of tending.', grove: 'The grove knows your rhythm.', season: 'A whole season of tending.' }[response.streakMilestone] || '';
    if (savedCountEl) savedCountEl.textContent = savedItems.length;
    if (activeTabTimeEl) activeTabTimeEl.textContent = formatDuration(totalActiveTabTime);
    if (intentionalBranchesEl) intentionalBranchesEl.textContent = intentionalBranches;
    if (unlinkedPathsEl) unlinkedPathsEl.textContent = unlinkedPaths;
    if (promptsDeclinedEl) promptsDeclinedEl.textContent = Number(interruptionsDismissed || 0);
    if (averageBranchDepthEl) averageBranchDepthEl.textContent = Number(averageBranchDepth || 0).toFixed(1);
    renderWeeklyChart(weeklyData);
    renderWeeklyTrendChart('weeklyIntentionsChart', weeklyTrendData, 'intentionsStarted');
    renderWeeklyTrendChart('weeklyPathChart', weeklyTrendData, 'averageDeepestPath');
    renderDomainChart(domainData);
    renderHistoryTable(history);
    renderSavedItems(savedItems, lastSettings?.strictMode === true ? Number(response.agedSavedCount) || 0 : 0);
  } catch (error) {
    logError(error, { category: ERROR_CATEGORIES.MESSAGING, function: 'loadStatsTab' });
  }
}

async function exportData() {
  try {
    const response = await message('EXPORT_DATA');
    if (!response || response.error) throw new Error(response.error);
    const dataStr = JSON.stringify(response.data, null, 2);
    const blob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `intent-grove-export-${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Revoking in the same task as a.click() can cancel a download that has
    // not finished reading the blob; give the browser a moment first.
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  } catch (error) {
    logError(error, { category: ERROR_CATEGORIES.MESSAGING, function: 'exportData' });
  }
}

// 15 MiB is far above any realistic export (12 sessions x 96 nodes plus 80
// compost items serializes to well under 1 MiB) and below the point where
// JSON.parse on a hostile multi-gigabyte file can freeze the tab.
const MAX_IMPORT_BYTES = 15 * 1024 * 1024;

const importStatus = document.getElementById('import-status');
function setImportStatus(text) { if (importStatus) importStatus.textContent = text || ''; }

async function importData() {
  const input = document.getElementById('importFile');
  if (!input || !input.files?.length) return;
  const file = input.files[0];
  try {
    if (file.size > MAX_IMPORT_BYTES) {
      logError(new Error(`Import file exceeds ${MAX_IMPORT_BYTES} bytes (${file.size})`), { category: ERROR_CATEGORIES.VALIDATION, function: 'importData' });
      // A rejected file is easy to miss without feedback: the picker closes
      // either way, so say why nothing happened.
      setImportStatus('That file is larger than 15 MiB — Intent Grove exports are far smaller. Check that you picked the right file.');
      return;
    }
    const text = await file.text();
    const payload = JSON.parse(text);
    const response = await message('IMPORT_DATA', { payload });
    if (!response || response.error) throw new Error(response.error);
    await renderSafely();
    await loadStatsTab();
    setImportStatus('Import complete.');
  } catch (error) {
    logError(error, { category: ERROR_CATEGORIES.MESSAGING, function: 'importData' });
    setImportStatus('Import could not be read. Choose a Intent Grove export file.');
  } finally {
    input.value = '';
  }
}

// Load saved theme preference on startup
applyStoredTheme();
mountThemeToggle();

const exportBtn = document.getElementById('exportData');
if (exportBtn) exportBtn.addEventListener('click', wrapWithErrorBoundary(exportData, { category: ERROR_CATEGORIES.MESSAGING, function: 'exportData.click', swallow: true }));

const importBtn = document.getElementById('importData');
const importInput = document.getElementById('importFile');
if (importBtn && importInput) {
  importBtn.addEventListener('click', wrapWithErrorBoundary(() => importInput.click(), { category: ERROR_CATEGORIES.UI_RENDER, function: 'importData.click', swallow: true }));
  importInput.addEventListener('change', wrapWithErrorBoundary(() => importData(), { category: ERROR_CATEGORIES.MESSAGING, function: 'importData.change', swallow: true }));
}

// Browsing continues in other tabs while the garden is open. Coalesce storage
// notifications instead of polling, and catch up when this page becomes visible.
let gardenRefreshTimer = 0;
function scheduleGardenRefresh() {
  window.clearTimeout(gardenRefreshTimer);
  if (document.hidden) return;
  gardenRefreshTimer = window.setTimeout(() => {
    renderSafely();
    if (activeTab === 'stats') loadStatsTab();
  }, 80);
}
function updatePageVisibility() {
  document.body.dataset.pageVisibility = document.hidden ? 'hidden' : 'visible';
}
chrome.storage?.onChanged?.addListener((changes, area) => {
  if (area === 'local' && changes[STORAGE_KEY]) scheduleGardenRefresh();
});
window.addEventListener('focus', scheduleGardenRefresh);
document.addEventListener('visibilitychange', () => { updatePageVisibility(); scheduleGardenRefresh(); });

updatePageVisibility();
switchTab('map');
renderSafely();
