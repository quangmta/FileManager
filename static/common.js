const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
let me = null, csrf = '', current = '';
let folderHistory = [], historyIndex = -1;
let clipboardItem = null;
let listedFiles = [];
let sortKey = 'name', sortDirection = 1;
const activeFilters = { name: 'all', size: 'all', mode: 'all', modified: 'all', from: '', to: '' };
let searchMode = false, searchTruncated = false;
let activeTransfer = null, idleTimeout = 1800, maxUploadClient = 1024**3, idleTimer = null, lastHeartbeat = 0;
let geoMaps = [], geoLogFiles = [], geoMap = null, geoLogRows = [], geoFilteredRows = [], geoAnomalies=[],geoIntegrity=null, geoPlaybackIndex = 0, geoSelectedRecord = null, geoManualPoint = null, geoPlayTimer = null, geoActiveLogPath = '', geoOverlays = [], geoTerrainResults = [], geoTerrainAnalysisDone = false;
let geoMapLoadToken=0,geoLogLoadToken=0,geoTerrainToken=0,geoAutoMapTargetPath='',geoAutoMapPromise=null;
let geoChartZoom=1,geoChartRange=null,geoHeightYRange=null,geoSpeedYRange=null,geoChartMode='zoom',geoChartDrag=null,geoChartDragFrame=0;
const geoChartScales={};
let monitorTab='processes',monitorPollTimer=null,monitorPollInterval=2000,monitorUnsupported=false,processSamples=new Map(),processRows=[],processHistorySamples=[],selectedProcessHistoryPid='',resourceSample=null,processSort={key:'cpu_percent',direction:-1};
const resourceHistory={cores:{},memory:[],swap:[],networkDown:[],networkUp:[]};
const GEO_LOG_TABLE_LIMIT=1000;
const geoTrackColors=['#3768b1','#8a55a2','#168a7a','#d68124'];
const geoChartSeriesVisible={altitude:true,terrain:true,agl:true,speed:true};
const previewExtensions = new Set(['txt','log','md','csv','json','xml','yaml','yml','toml','ini','conf','py','js','css','sh','sql','html','htm','rtf','pdf','png','jpg','jpeg','gif','webp','bmp','avif']);
const editableTextExtensions = new Set(['txt','log','md','csv','json','xml','yaml','yml','toml','ini','conf','py','js','css','sh','sql','html','htm','rtf']);
const expandedNodes = new Set();

async function api(url, opts = {}) {
  const method = opts.method || 'GET';
  opts.headers = {
    ...(opts.headers || {}),
    ...(opts.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
    ...(method !== 'GET' ? { 'X-CSRF-Token': csrf } : {})
  };
  const response = await fetch(url, opts);
  let data = {};
  if ((response.headers.get('content-type') || '').includes('json')) data = await response.json();
  if (!response.ok) throw Error(data.error || `Lỗi ${response.status}`);
  return data;
}

const esc = value => String(value).replace(/[&<>"']/g, ch => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[ch]));
const size = bytes => bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : bytes < 1073741824 ? `${(bytes / 1048576).toFixed(1)} MB` : `${(bytes / 1073741824).toFixed(2)} GB`;
// System Monitor displays memory using decimal GB/MB, while procfs reports bytes.
const systemBytes = bytes => bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : bytes >= 1e3 ? `${(bytes / 1e3).toFixed(1)} KB` : `${Math.round(bytes)} B`;
const roleName = role => ({ admin: 'Quản trị viên', write: 'Đọc & ghi', read: 'Chỉ đọc' })[role] || role;
const canPreview = name => previewExtensions.has(name.split('.').pop().toLowerCase());
const canEditText = name => editableTextExtensions.has(name.split('.').pop().toLowerCase());

const editorLanguages = {
  py: ['Python', 'python'], js: ['JavaScript', 'javascript'], json: ['JSON', 'json'],
  html: ['HTML', 'html'], htm: ['HTML', 'html'], css: ['CSS', 'css'],
  sh: ['Shell', 'shell'], sql: ['SQL', 'sql'], yaml: ['YAML', 'yaml'], yml: ['YAML', 'yaml'],
  md: ['Markdown', 'markdown'], txt: ['Văn bản', 'plain'], log: ['Log', 'plain'],
  csv: ['CSV', 'plain'], xml: ['XML', 'html'], toml: ['TOML', 'python'], ini: ['INI', 'python'],
  conf: ['Config', 'python'], rtf: ['RTF', 'plain']
};
const editorKeywords = {
  python: new Set('and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield self False None True'.split(' ')),
  javascript: new Set('async await break case catch class const continue debugger default delete do else export extends finally for from function if import in instanceof let new return static super switch this throw try typeof var void while with yield true false null undefined'.split(' ')),
  json: new Set(['true','false','null']),
  shell: new Set('if then else elif fi for while in do done case esac function select until time coproc return exit export local readonly declare typeset unset shift break continue'.split(' ')),
  sql: new Set('select from where and or not null is as insert into values update set delete create alter drop table index join left right inner outer on group by order having limit offset distinct union all case when then else end count sum avg min max primary key foreign references'.split(' ')),
  css: new Set('important inherit initial unset revert auto none block flex grid inline inline-block absolute relative fixed sticky solid dashed hidden visible'.split(' '))
};
function highlightCode(source, language) {
  if (language === 'plain') return esc(source);
  if (language === 'markdown') {
    return source.split('\n').map(line => {
      if (/^\s{0,3}#{1,6}\s/.test(line)) return `<span class="tok-heading">${esc(line)}</span>`;
      return esc(line).replace(/(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g, '<span class="tok-markup">$1</span>');
    }).join('\n');
  }
  const comments = language === 'python' || language === 'shell' || language === 'yaml' ? '(#[^\\n]*)' :
    language === 'sql' ? '(--[^\\n]*|/\\*[\\s\\S]*?\\*/)' :
    language === 'html' ? '(<!--[\\s\\S]*?-->)' :
    language === 'css' ? '(/\\*[\\s\\S]*?\\*/)' :
    language === 'json' ? '($^)' : '(//[^\\n]*|/\\*[\\s\\S]*?\\*/)';
  const stringPattern = language === 'python'
    ? "(\"\"\"[\\s\\S]*?\"\"\"|'''[\\s\\S]*?'''|`(?:\\\\.|[^`\\\\])*`|\"(?:\\\\.|[^\"\\\\])*\"|'(?:\\\\.|[^'\\\\])*')"
    : "(`(?:\\\\.|[^`\\\\])*`|\"(?:\\\\.|[^\"\\\\])*\"|'(?:\\\\.|[^'\\\\])*')";
  const tagPattern = language === 'html' ? '(<\\/?[A-Za-z][^>]*>)' : '($^)';
  const regex = new RegExp(`${comments}|${stringPattern}|${tagPattern}|(\\b(?:0[xX][\\da-fA-F]+|\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)\\b)|([A-Za-z_$][\\w$]*)`, 'g');
  const keywords = editorKeywords[language] || editorKeywords.python;
  let output = '', cursor = 0, match;
  while ((match = regex.exec(source))) {
    output += esc(source.slice(cursor, match.index));
    const token = match[0];
    let type = match[1] ? 'comment' : match[2] ? 'string' : match[3] ? 'markup' : match[4] ? 'number' : '';
    if (!type && match[5]) {
      const word = token.toLowerCase();
      type = keywords.has(word) ? 'keyword' : /^(true|false|null|none|undefined)$/.test(word) ? 'literal' : /^\s*\(/.test(source.slice(regex.lastIndex)) ? 'function' : '';
    }
    output += type ? `<span class="tok-${type}">${esc(token)}</span>` : esc(token);
    cursor = regex.lastIndex;
  }
  output += esc(source.slice(cursor));
  return output;
}

function setupCodeEditor(editor, source, extension) {
  const code = $('.code-highlight', editor), gutter = $('.line-numbers', editor);
  const language = editorLanguages[extension] || ['Văn bản','plain'];
  const languageBadge = $('.editor-language', editor.parentElement);
  const undoButton = $('.editor-undo', editor.parentElement), redoButton = $('.editor-redo', editor.parentElement);
  if (languageBadge) languageBadge.textContent = language[0];
  const HISTORY_LIMIT = 8 * 1024 * 1024, OPERATION_LIMIT = 500;
  const undoStack = [], redoStack = [];
  let historySize = 0, pendingBefore = null, composing = false;
  const pointOffset = (node, offset) => {
    if (!code.contains(node)) return code.textContent.length;
    const range = document.createRange();range.selectNodeContents(code);range.setEnd(node, offset);
    return range.toString().length;
  };
  const selectionState = () => {
    const selection = window.getSelection();
    if (!selection?.rangeCount) return {start:0,end:0};
    const anchor = pointOffset(selection.anchorNode, selection.anchorOffset);
    const focus = pointOffset(selection.focusNode, selection.focusOffset);
    return {start:Math.min(anchor,focus),end:Math.max(anchor,focus)};
  };
  const pointAt = offset => {
    const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
    let node, remaining = offset, last = null;
    while ((node = walker.nextNode())) {
      last = node;
      if (remaining <= node.length) return [node,remaining];
      remaining -= node.length;
    }
    return last ? [last,last.length] : [code,0];
  };
  const restoreSelection = state => {
    const [startNode,startOffset] = pointAt(state.start), [endNode,endOffset] = pointAt(state.end);
    const range = document.createRange();range.setStart(startNode,startOffset);range.setEnd(endNode,endOffset);
    const selection = window.getSelection();selection.removeAllRanges();selection.addRange(range);
  };
  const ensureCaretVisible = () => {
    const selection = window.getSelection();
    if (!selection?.rangeCount || !code.contains(selection.anchorNode)) return;
    const offset=selectionState().end, line=(code.textContent.slice(0,offset).match(/\n/g)||[]).length;
    const style=getComputedStyle(code), lineHeight=parseFloat(style.lineHeight)||20, paddingTop=parseFloat(style.paddingTop)||0, margin=22;
    const caretTop=paddingTop+line*lineHeight, caretBottom=caretTop+lineHeight;
    if (caretBottom > code.scrollTop+code.clientHeight-margin) code.scrollTop=caretBottom-code.clientHeight+margin;
    else if (caretTop < code.scrollTop+margin) code.scrollTop=Math.max(0,caretTop-margin);
    const rect = selection.getRangeAt(0).getBoundingClientRect(), view = code.getBoundingClientRect();
    if (rect.right > view.right-margin) code.scrollLeft += rect.right-(view.right-margin);
    else if (rect.left < view.left+margin) code.scrollLeft -= view.left+margin-rect.left;
    syncScroll();
  };
  const syncScroll = () => { gutter.style.transform = `translateY(${-code.scrollTop}px)`; };
  const paint = (content, state) => {
    const oldTop=code.scrollTop, oldLeft=code.scrollLeft;
    code.innerHTML = highlightCode(content, language[1]);
    code.scrollTop=oldTop;code.scrollLeft=oldLeft;
    gutter.textContent = Array.from({length: content.split('\n').length}, (_, index) => index + 1).join('\n');
    restoreSelection(state);syncScroll();ensureCaretVisible();
  };
  const refreshHistoryButtons = () => {
    if (undoButton) undoButton.disabled = undoStack.length === 0;
    if (redoButton) redoButton.disabled = redoStack.length === 0;
  };
  const diffEdit = (before, after) => {
    let start=0;
    while (start<before.length && start<after.length && before[start]===after[start]) start++;
    let suffix=0;
    while (suffix<before.length-start && suffix<after.length-start && before[before.length-1-suffix]===after[after.length-1-suffix]) suffix++;
    const removed=before.slice(start,before.length-suffix), inserted=after.slice(start,after.length-suffix);
    return {start,removed,inserted,cost:removed.length+inserted.length};
  };
  const clearRedo = () => { for (const edit of redoStack) historySize-=edit.cost;redoStack.length=0; };
  const finishInput = () => {
    const after=code.textContent, afterSelection=selectionState();
    if (pendingBefore && pendingBefore.text!==after) {
      clearRedo();
      const edit={...diffEdit(pendingBefore.text,after),beforeSelection:pendingBefore.selection,afterSelection};
      if (edit.cost<=HISTORY_LIMIT) {
        undoStack.push(edit);historySize+=edit.cost;
        while (historySize>HISTORY_LIMIT || undoStack.length>OPERATION_LIMIT) historySize-=undoStack.shift().cost;
      } else {undoStack.length=0;historySize=0;}
    }
    pendingBefore=null;paint(after,afterSelection);refreshHistoryButtons();
  };
  const applyHistory = undoing => {
    const from=undoing?undoStack:redoStack, to=undoing?redoStack:undoStack, edit=from.pop();
    if (!edit) return;
    const current=code.textContent, remove=undoing?edit.inserted:edit.removed, insert=undoing?edit.removed:edit.inserted;
    const content=current.slice(0,edit.start)+insert+current.slice(edit.start+remove.length);
    to.push(edit);paint(content,undoing?edit.beforeSelection:edit.afterSelection);refreshHistoryButtons();
  };
  const undo = () => applyHistory(true), redo = () => applyHistory(false);
  const insertText = value => {
    const selection = window.getSelection();
    if (!selection?.rangeCount || !code.contains(selection.anchorNode)) return;
    pendingBefore={text:code.textContent,selection:selectionState()};
    const range = selection.getRangeAt(0);range.deleteContents();
    const textNode = document.createTextNode(value);
    range.insertNode(textNode);range.setStartAfter(textNode);range.collapse(true);
    selection.removeAllRanges();selection.addRange(range);finishInput();
  };
  code.textContent = source;
  paint(source,{start:0,end:0});
  code.addEventListener('beforeinput', event => {
    if (event.inputType==='historyUndo' || event.inputType==='historyRedo') {
      event.preventDefault();event.inputType==='historyUndo'?undo():redo();return;
    }
    if (!composing) pendingBefore={text:code.textContent,selection:selectionState()};
  });
  code.addEventListener('input', event => { if (!composing && !event.isComposing) finishInput(); });
  code.addEventListener('compositionstart', () => { composing=true;pendingBefore={text:code.textContent,selection:selectionState()}; });
  code.addEventListener('compositionend', () => { composing=false;finishInput(); });
  code.addEventListener('scroll', syncScroll, { passive: true });
  code.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase()==='z') {
      event.preventDefault();event.shiftKey?redo():undo();
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase()==='y') {
      event.preventDefault();redo();
    } else if (event.key === 'Enter' && !(event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      insertText('\n');
    } else if (event.key === 'Tab') {
      event.preventDefault();
      insertText('    ');
    }
  });
  code.addEventListener('paste', event => {
    event.preventDefault();insertText(event.clipboardData.getData('text/plain').replace(/\r\n?/g,'\n'));
  });
  undoButton?.addEventListener('click',()=>{code.focus();undo();});
  redoButton?.addEventListener('click',()=>{code.focus();redo();});
  refreshHistoryButtons();code.focus();restoreSelection({start:source.length,end:source.length});ensureCaretVisible();
}

function toast(message, error = false) {
  const element = $('#toast');
  element.textContent = message;
  element.className = `toast show ${error ? 'bad' : ''}`;
  setTimeout(() => element.className = 'toast', 3000);
}

async function boot() {
  try {
    const state = await api('/api/session');
    if (!state.authenticated) return showLogin();
    me = state;
    csrf = state.csrf;
    idleTimeout = state.idle_timeout || 1800;
    maxUploadClient = state.max_upload || maxUploadClient;
    armIdleTimer();
    document.body.dataset.role = me.role;
    $('#login-screen').classList.add('hidden');
    $('#app').classList.remove('hidden');
    $('#username').textContent = me.username;
    $('#avatar').textContent = me.username[0].toUpperCase();
    $('#role-label').textContent = roleName(me.role);
    $('#root-label').textContent = me.root;
    $('#admin-nav')?.remove();
    if (me.role === 'admin') {
      const button = document.createElement('button');
      button.id = 'admin-nav';
      button.className = 'nav';
      button.innerHTML = '<span>⚙</span> Quản trị';
      button.onclick = adminView;
      $('#monitor-nav').after(button);
    }
    await loadTree();
    await loadFiles('');
  } catch (error) {
    toast(error.message, true);
    showLogin();
  }
}

function showLogin() {
  $('#app').classList.add('hidden');
  $('#login-screen').classList.remove('hidden');
}

$('#login-form').onsubmit = async event => {
  event.preventDefault();
  const form = new FormData(event.target);
  try {
    await api('/api/login', { method: 'POST', body: JSON.stringify({ username: form.get('username'), password: form.get('password') }) });
    $('#login-error').textContent = '';
    await boot();
  } catch (error) {
    $('#login-error').textContent = error.message;
  }
};

$('#logout').onclick = async () => {
  clearTimeout(idleTimer);
  try { await api('/api/logout', { method: 'POST', body: '{}' }); }
  finally { me = null; csrf = ''; document.body.removeAttribute('data-role'); showLogin(); }
};

function expireLocalSession() {
  clearTimeout(idleTimer);
  me=null;csrf='';document.body.removeAttribute('data-role');showLogin();toast('Phiên đăng nhập đã hết hạn do không hoạt động.',true);
}
function armIdleTimer() {
  clearTimeout(idleTimer);
  if(!me)return;
  idleTimer=setTimeout(expireLocalSession,idleTimeout*1000);
}
let lastActivitySync=0;
function recordUserActivity() {
  armIdleTimer();
  if(!me||Date.now()-lastActivitySync<Math.min(60000,idleTimeout*1000/3))return;
  lastActivitySync=Date.now();
  fetch('/api/session',{cache:'no-store'}).then(response=>response.json()).then(state=>{if(!state.authenticated)expireLocalSession();}).catch(()=>{});
}
['pointerdown','keydown','touchstart','wheel'].forEach(type=>document.addEventListener(type,recordUserActivity,{passive:true}));

function treeNode(node, depth) {
  const hasChildren = node.children.length > 0;
  const expanded = expandedNodes.has(node.path);
  return `<div class="tree-node" data-node="${esc(node.path)}">
    <div class="tree-row" style="--depth:${depth}">
      <button class="tree-toggle" ${hasChildren ? '' : 'disabled'} aria-expanded="${expanded}" aria-label="${expanded ? 'Thu gọn' : 'Mở rộng'} ${esc(node.name)}">${hasChildren ? (expanded ? '▾' : '▸') : '·'}</button>
      <button class="tree-label ${current === node.path ? 'selected' : ''}" data-path="${esc(node.path)}">${esc(node.name)}</button>
    </div>
    <div class="tree-children" ${expanded ? '' : 'hidden'}>${node.children.map(child => treeNode(child, depth + 1)).join('')}</div>
  </div>`;
}

async function loadTree() {
  const data = await api('/api/tree');
  // Expand the currently selected path's ancestors while leaving other branches collapsed.
  if (current) expandedNodes.add('');
  let ancestor = '';
  for (const part of current.split('/').filter(Boolean).slice(0, -1)) {
    ancestor = ancestor ? `${ancestor}/${part}` : part;
    expandedNodes.add(ancestor);
  }
  const rootName = data.root.split('/').filter(Boolean).pop() || '/';
  const rootExpanded = expandedNodes.has('');
  const tree = $('#tree');
  tree.innerHTML = `<div class="tree-node root-node">
    <div class="tree-row">
      <button class="tree-toggle" aria-expanded="${rootExpanded}" aria-label="${rootExpanded ? 'Thu gọn' : 'Mở rộng'} thư mục gốc">${rootExpanded ? '▾' : '▸'}</button>
      <button class="tree-label ${current === '' ? 'selected' : ''}" data-path="">⌂ ${esc(rootName)}</button>
    </div>
    <div class="tree-children" ${rootExpanded ? '' : 'hidden'}>${data.children.map(node => treeNode(node, 0)).join('')}</div>
  </div>`;

  $$('.tree-toggle', tree).forEach(toggle => {
    toggle.onclick = () => {
      const node = toggle.closest('.tree-node');
      const path = node.classList.contains('root-node') ? '' : node.dataset.node;
      const children = $('.tree-children', node);
      const open = children.hidden;
      children.hidden = !open;
      toggle.setAttribute('aria-expanded', String(open));
      toggle.setAttribute('aria-label', `${open ? 'Thu gọn' : 'Mở rộng'} thư mục`);
      toggle.textContent = open ? '▾' : '▸';
      if (open) expandedNodes.add(path); else expandedNodes.delete(path);
    };
  });
  $$('.tree-label', tree).forEach(button => button.onclick = () => loadFiles(button.dataset.path));
}

$('#refresh-tree').onclick = loadTree;
$('#home-nav').onclick = () => { showSection('files-view'); loadFiles(''); };
$('#monitor-nav').onclick = () => showSection('monitor-view');
$('#geo-nav').onclick = () => { showSection('geo-view'); loadGeoCatalog(); };
$('#back-nav').onclick = () => moveHistory(-1);
$('#forward-nav').onclick = () => moveHistory(1);

function updateHistoryButtons() {
  $('#back-nav').disabled = historyIndex <= 0;
  $('#forward-nav').disabled = historyIndex < 0 || historyIndex >= folderHistory.length - 1;
}

function rememberFolder(path) {
  if (historyIndex >= 0 && folderHistory[historyIndex] === path) {
    updateHistoryButtons();
    return;
  }
  folderHistory = folderHistory.slice(0, historyIndex + 1);
  folderHistory.push(path);
  historyIndex = folderHistory.length - 1;
  updateHistoryButtons();
}

async function moveHistory(delta) {
  const targetIndex = historyIndex + delta;
  if (targetIndex < 0 || targetIndex >= folderHistory.length) return;
  const previousIndex = historyIndex;
  historyIndex = targetIndex;
  updateHistoryButtons();
  const loaded = await loadFiles(folderHistory[targetIndex], { recordHistory: false });
  if (!loaded) {
    historyIndex = previousIndex;
    updateHistoryButtons();
  }
}

function showSection(id) {
  ['files-view','monitor-view','admin-view','geo-view'].forEach(section => $(`#${section}`).classList.toggle('hidden', section !== id));
  $$('.nav').forEach(button => button.classList.remove('active'));
  const navId = { 'files-view': 'home-nav','monitor-view':'monitor-nav','admin-view': 'admin-nav','geo-view':'geo-nav' }[id];
  if (navId) $(`#${navId}`)?.classList.add('active');
  if(id==='monitor-view')startMonitorPolling();else stopMonitorPolling();
}

