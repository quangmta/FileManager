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
let geoMaps = [], geoLogFiles = [], geoMap = null, geoLogRows = [], geoFilteredRows = [], geoPlaybackIndex = 0, geoSelectedRecord = null, geoManualPoint = null, geoPlayTimer = null, geoActiveLogPath = '', geoOverlays = [], geoTerrainResults = [], geoTerrainAnalysisDone = false;
let geoMapLoadToken=0,geoLogLoadToken=0,geoTerrainToken=0,geoAutoMapTargetPath='',geoAutoMapPromise=null;
let geoChartZoom=1,geoChartRange=null,geoHeightYRange=null,geoSpeedYRange=null,geoChartMode='zoom',geoChartDrag=null,geoChartDragFrame=0;
const geoChartScales={};
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
      $('#disk-nav').after(button);
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
$('#disk-nav').onclick = () => { showSection('disk-view'); loadDisk(); };
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
  ['files-view', 'disk-view', 'admin-view','geo-view'].forEach(section => $(`#${section}`).classList.toggle('hidden', section !== id));
  $$('.nav').forEach(button => button.classList.remove('active'));
  const navId = { 'files-view': 'home-nav', 'disk-view': 'disk-nav', 'admin-view': 'admin-nav','geo-view':'geo-nav' }[id];
  if (navId) $(`#${navId}`)?.classList.add('active');
}

async function loadGeoCatalog() {
  showSection('geo-view');
  const oldMap=$('#geo-map-select').value, oldLog=$('#geo-log-select').value,oldOverlay=$('#geo-overlay-select').value;
  try {
    const [mapData,logData]=await Promise.all([api('/api/geo/maps'),api('/api/geo/log-files')]);
    geoMaps=mapData.maps;geoLogFiles=logData.files;
    $('#geo-map-select').innerHTML='<option value="">Chọn tile bản đồ…</option>'+geoMaps.map(item=>`<option value="${esc(item.path)}">${esc(item.name)}${item.error?' · không đọc được':''}</option>`).join('');
    $('#geo-log-select').innerHTML='<option value="">Chọn tệp log…</option>'+geoLogFiles.map(item=>`<option value="${esc(item.path)}">${esc(item.name)} (${formatBytes(item.size)})</option>`).join('');
    $('#geo-overlay-select').innerHTML='<option value="">Chọn log khác…</option>'+geoLogFiles.map(item=>`<option value="${esc(item.path)}">${esc(item.name)} (${formatBytes(item.size)})</option>`).join('');
    const selectedMap=geoMaps.some(item=>item.path===oldMap)?oldMap:(geoMaps.find(item=>!item.error)?.path||'');
    const selectedLog=geoLogFiles.some(item=>item.path===oldLog)?oldLog:(geoLogFiles[0]?.path||'');
    $('#geo-map-select').value=selectedMap;$('#geo-log-select').value=selectedLog;
    const selectedOverlay=geoLogFiles.some(item=>item.path===oldOverlay)?oldOverlay:(geoLogFiles.find(item=>item.path!==selectedLog)?.path||'');$('#geo-overlay-select').value=selectedOverlay;
    renderGeoCatalog(mapData.truncated,logData.truncated);
    await Promise.all([selectedMap?loadGeoMap(selectedMap):clearGeoMap('Chưa tìm thấy file .dt2 trong FILEMANAGER_GEO_ROOT.'),selectedLog?loadGeoLog(selectedLog):clearGeoLog('Chưa tìm thấy log .csv, .json, .jsonl, .log hoặc .txt.')]);
  } catch(error) { toast(error.message,true); }
}

function renderGeoCatalog(mapsTruncated=false,logsTruncated=false) {
  const note=mapsTruncated||logsTruncated?'<p class="muted geo-truncated-note">Danh mục bị giới hạn; có thể chưa hiển thị mọi tệp.</p>':'';
  $('#geo-map-catalog').innerHTML=note+(geoMaps.map((item,index)=>`<button type="button" class="geo-map-item ${geoMap?.path===item.path?'active':''}" data-geo-map-index="${index}"><b>${esc(item.name)}</b>${item.error?`<small class="error">${esc(item.error)}</small>`:`<small>Lat ${item.min_latitude.toFixed(4)}…${item.max_latitude.toFixed(4)}</small><small>Lon ${item.min_longitude.toFixed(4)}…${item.max_longitude.toFixed(4)}</small>`}<small>${formatBytes(item.size)}</small></button>`).join('')||'<p class="muted">Chưa có tile .dt2.</p>');
  $$('[data-geo-map-index]').forEach(button=>button.onclick=()=>{const item=geoMaps[Number(button.dataset.geoMapIndex)];$('#geo-map-select').value=item.path;loadGeoMap(item.path);});
  renderTileHealth();
}

function renderTileHealth() {
  const maps=geoMaps.filter(item=>!item.error);
  if(!maps.length){$('#geo-catalog-health').textContent='Chưa có tile DTED hợp lệ để kiểm tra vùng phủ.';return;}
  let overlaps=0;
  for(let i=0;i<maps.length;i++)for(let j=i+1;j<maps.length;j++){
    const width=Math.min(maps[i].max_longitude,maps[j].max_longitude)-Math.max(maps[i].min_longitude,maps[j].min_longitude);
    const height=Math.min(maps[i].max_latitude,maps[j].max_latitude)-Math.max(maps[i].min_latitude,maps[j].min_latitude);
    if(width>1e-8&&height>1e-8)overlaps++;
  }
  const minLat=Math.min(...maps.map(item=>item.min_latitude)),maxLat=Math.max(...maps.map(item=>item.max_latitude));
  const minLon=Math.min(...maps.map(item=>item.min_longitude)),maxLon=Math.max(...maps.map(item=>item.max_longitude));
  const latEdges=[...new Set(maps.flatMap(item=>[item.min_latitude,item.max_latitude]))].sort((a,b)=>a-b);
  let gapBands=0,gapArea=0;
  for(let i=0;i<latEdges.length-1;i++){
    const south=latEdges[i],north=latEdges[i+1],mid=(south+north)/2;
    if(north-south<1e-10)continue;
    const intervals=maps.filter(item=>item.min_latitude<=mid&&item.max_latitude>=mid).map(item=>[item.min_longitude,item.max_longitude]).sort((a,b)=>a[0]-b[0]);
    let cursor=minLon,bandGaps=0;
    for(const [west,east] of intervals){if(west>cursor+1e-8){gapArea+=(west-cursor)*(north-south);bandGaps++;}cursor=Math.max(cursor,east);}
    if(cursor<maxLon-1e-8){gapArea+=(maxLon-cursor)*(north-south);bandGaps++;}
    gapBands+=bandGaps;
  }
  $('#geo-catalog-health').textContent=`${maps.length} tile hợp lệ · ${overlaps} cặp chồng diện tích · ${gapBands} dải trống trong khung bao (${gapArea.toFixed(5)}°²)`;
}

function locateGeoTile() {
  const rawLatitude=$('#geo-find-lat').value.trim(),rawLongitude=$('#geo-find-lon').value.trim(),latitude=Number(rawLatitude),longitude=Number(rawLongitude);
  if(!rawLatitude||!rawLongitude||!Number.isFinite(latitude)||!Number.isFinite(longitude)||latitude < -90||latitude>90||longitude < -180||longitude>180){toast('Nhập latitude và longitude hợp lệ.',true);return;}
  const matches=geoMaps.filter(item=>!item.error&&latitude>=item.min_latitude&&latitude<=item.max_latitude&&longitude>=item.min_longitude&&longitude<=item.max_longitude);
  const results=$('#geo-find-results');
  if(!matches.length){results.textContent='Không có tile nào chứa tọa độ này.';return;}
  results.innerHTML=`${matches.length} tile chứa điểm:<br>`+matches.map((item,index)=>`<button type="button" class="geo-find-result" data-find-tile="${index}">${esc(item.name)} · ${item.rows}×${item.columns}</button>`).join('');
  $$('[data-find-tile]',results).forEach(button=>button.onclick=()=>{const item=matches[Number(button.dataset.findTile)];$('#geo-map-select').value=item.path;loadGeoMap(item.path);});
}

async function ensureGeoMapForPoint(point) {
  const toggle=$('#geo-auto-map');
  if(!toggle?.checked||point?.latitude===null||point?.latitude===undefined||point?.longitude===null||point?.longitude===undefined)return;
  const latitude=Number(point.latitude),longitude=Number(point.longitude),status=$('#geo-auto-map-status');
  if(!Number.isFinite(latitude)||!Number.isFinite(longitude))return;
  const match=geoMaps.find(item=>!item.error&&latitude>=item.min_latitude&&latitude<=item.max_latitude&&longitude>=item.min_longitude&&longitude<=item.max_longitude);
  if(!match){status.textContent='Không có tile chứa điểm này; đang giữ tile hiện tại.';return;}
  $('#geo-map-select').value=match.path;
  if(geoMap?.path===match.path){status.textContent=`Đang hiển thị: ${match.name}`;return;}
  if(geoAutoMapTargetPath===match.path&&geoAutoMapPromise){await geoAutoMapPromise;return;}
  status.textContent=`Đang tải tile: ${match.name}…`;
  geoAutoMapTargetPath=match.path;
  const path=match.path,promise=loadGeoMap(path);
  geoAutoMapPromise=promise;
  try {await promise;}
  finally {
    if(geoAutoMapTargetPath===path){geoAutoMapTargetPath='';geoAutoMapPromise=null;}
    if(toggle.checked&&$('#geo-map-select').value===path)status.textContent=geoMap?.path===path?`Đang hiển thị: ${match.name}`:`Không tải được tile: ${match.name}`;
  }
}

async function loadGeoMap(path) {
  const token=++geoMapLoadToken;
  const entry=geoMaps.find(item=>item.path===path);
  if(entry?.error) {clearGeoMap(entry.error);renderGeoCatalog();return;}
  try {
    const response=await api(`/api/geo/map-preview?path=${encodeURIComponent(path)}`);
    if(token!==geoMapLoadToken)return;
    geoMap={path,...response.map};geoManualPoint=null;
    $('#geo-map-empty').classList.add('hidden');$('#geo-map-title').textContent=entry?.name||path;
    $('#geo-map-summary').textContent=`Lat ${geoMap.min_latitude.toFixed(5)}° to ${geoMap.max_latitude.toFixed(5)}° · Lon ${geoMap.min_longitude.toFixed(5)}° to ${geoMap.max_longitude.toFixed(5)}° · ${geoMap.columns} × ${geoMap.rows} ô`;
    const sampleStats=geoMap.sampled_min_elevation_m===null?'Không có điểm độ cao hợp lệ':`Mẫu xem trước: ${geoMap.sampled_min_elevation_m}–${geoMap.sampled_max_elevation_m} m`;
    $('#geo-map-stats').textContent=`${sampleStats}${geoMap.checksum_warning_columns?` · ${geoMap.checksum_warning_columns}/${geoMap.checksum_checked_columns} cột mẫu lỗi checksum`:''}`;
    $('#geo-map-legend').innerHTML=`Cao độ (m) <span class="geo-height-gradient"></span><small>${geoMap.sampled_min_elevation_m??'—'} → ${geoMap.sampled_max_elevation_m??'—'}</small>`;
    $('#geo-map-format').textContent=`DTED · ${geoMap.preview_columns}×${geoMap.preview_rows}`;
    renderGeoCatalog();updateGeoCoverage();updateGeoActionState();renderGeoStats();renderGeoLogs();drawGeoMap();
  } catch(error) {if(token===geoMapLoadToken){clearGeoMap(error.message);renderGeoCatalog();}}
}

function clearGeoMap(message) {
  geoMapLoadToken++;geoMap=null;geoManualPoint=null;$('#geo-map-title').textContent='Chưa có bản đồ đọc được';$('#geo-map-summary').textContent=message;$('#geo-map-empty').textContent=message;$('#geo-map-empty').classList.remove('hidden');$('#geo-map-stats').textContent='—';$('#geo-map-format').textContent='DTED';$('#geo-map-legend').textContent='Cao độ (m)';$('#geo-point-info').textContent='Chọn điểm trên bản đồ hoặc một dòng log để xem chi tiết.';$('#geo-analysis-info').textContent='Chọn dòng log có latitude/longitude.';updateGeoActionState();renderGeoStats();renderGeoLogs();drawGeoMap();
}

function terrainColor(value,min,max) {
  if(value===null)return [243,248,245,255];
  const t=max===min?0.5:Math.max(0,Math.min(1,(value-min)/(max-min)));
  const colors=[[31,89,158],[41,157,156],[112,174,105],[223,205,112],[157,102,66],[240,237,218]];
  const position=t*(colors.length-1),i=Math.min(colors.length-2,Math.floor(position)),f=position-i;
  return [0,1,2].map(channel=>Math.round(colors[i][channel]*(1-f)+colors[i+1][channel]*f)).concat(255);
}

function geoPixel(point,width,height) {
  if(!geoMap||point.latitude<geoMap.min_latitude||point.latitude>geoMap.max_latitude||point.longitude<geoMap.min_longitude||point.longitude>geoMap.max_longitude)return null;
  return {x:(point.longitude-geoMap.min_longitude)/(geoMap.max_longitude-geoMap.min_longitude)*width,y:(geoMap.max_latitude-point.latitude)/(geoMap.max_latitude-geoMap.min_latitude)*height};
}

function drawGeoMap() {
  const canvas=$('#geo-map-canvas');if(!canvas)return;
  const bounds=canvas.getBoundingClientRect(),dpr=window.devicePixelRatio||1;
  if(bounds.width<2||bounds.height<2)return;
  canvas.width=Math.round(bounds.width*dpr);canvas.height=Math.round(bounds.height*dpr);
  const ctx=canvas.getContext('2d');ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,bounds.width,bounds.height);
  if(!geoMap)return;
  const grid=geoMap.grid,h=grid.length,w=grid[0]?.length||0;if(!w||!h)return;
  const raster=document.createElement('canvas');raster.width=w;raster.height=h;
  const rasterCtx=raster.getContext('2d'),image=rasterCtx.createImageData(w,h),min=geoMap.sampled_min_elevation_m,max=geoMap.sampled_max_elevation_m;
  for(let y=0;y<h;y++)for(let x=0;x<w;x++)image.data.set(terrainColor(grid[y][x],min,max),(y*w+x)*4);
  rasterCtx.putImageData(image,0,0);ctx.imageSmoothingEnabled=true;ctx.drawImage(raster,0,0,bounds.width,bounds.height);
  ctx.save();ctx.strokeStyle='rgba(255,255,255,.52)';ctx.fillStyle='rgba(23,39,32,.82)';ctx.lineWidth=1;ctx.font='10px sans-serif';ctx.setLineDash([3,4]);
  for(let i=1;i<4;i++){const x=bounds.width*i/4,y=bounds.height*i/4;ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,bounds.height);ctx.moveTo(0,y);ctx.lineTo(bounds.width,y);ctx.stroke();}
  ctx.setLineDash([]);ctx.textBaseline='bottom';ctx.textAlign='left';ctx.fillText(`${geoMap.min_longitude.toFixed(4)}°`,5,bounds.height-4);ctx.textAlign='right';ctx.fillText(`${geoMap.max_longitude.toFixed(4)}°`,bounds.width-5,bounds.height-4);ctx.textAlign='left';ctx.textBaseline='top';ctx.fillText(`${geoMap.max_latitude.toFixed(4)}°`,5,4);ctx.textBaseline='bottom';ctx.fillText(`${geoMap.min_latitude.toFixed(4)}°`,5,bounds.height-18);ctx.restore();
  const drawTrack=(rows,color,width,limit=rows.length)=>{
    const points=rows.slice(0,limit).filter(row=>row.latitude!==null&&row.longitude!==null);
    ctx.strokeStyle=color;ctx.lineWidth=width;ctx.lineCap='round';ctx.lineJoin='round';ctx.beginPath();let pen=false;
    points.forEach(point=>{const xy=geoPixel(point,bounds.width,bounds.height);if(!xy){pen=false;return;}if(pen)ctx.lineTo(xy.x,xy.y);else{ctx.moveTo(xy.x,xy.y);pen=true;}});ctx.stroke();
    for(let i=points.length-1;i>=0;i--){const xy=geoPixel(points[i],bounds.width,bounds.height);if(xy){ctx.beginPath();ctx.fillStyle='#fff';ctx.strokeStyle=color;ctx.lineWidth=2;ctx.arc(xy.x,xy.y,width>2?5:3,0,Math.PI*2);ctx.fill();ctx.stroke();break;}}
  };
  geoOverlays.forEach((layer,index)=>{if(layer.path!==geoActiveLogPath)drawTrack(layer.rows,geoTrackColors[index%geoTrackColors.length],2);});
  drawTrack(geoFilteredRows,'#e25b36',2.5,geoPlaybackIndex+1);
  geoFilteredRows.slice(0,geoPlaybackIndex+1).filter(isLowAgl).forEach(point=>{const xy=geoPixel(point,bounds.width,bounds.height);if(xy){ctx.beginPath();ctx.fillStyle='#bd2929';ctx.strokeStyle='#fff';ctx.lineWidth=1;ctx.arc(xy.x,xy.y,3.5,0,Math.PI*2);ctx.fill();ctx.stroke();}});
  if(geoManualPoint){const xy=geoPixel(geoManualPoint,bounds.width,bounds.height);if(xy){ctx.beginPath();ctx.fillStyle='#fff';ctx.strokeStyle='#176b55';ctx.lineWidth=3;ctx.arc(xy.x,xy.y,7,0,Math.PI*2);ctx.fill();ctx.stroke();}}
}

async function inspectGeoPoint(point,record=null) {
  geoSelectedRecord=record;geoManualPoint=record?null:point;drawGeoMap();
  const el=$('#geo-analysis-info');
  if(!point||point.latitude===null||point.longitude===null){el.textContent='Dòng log này không có cặp latitude/longitude.';$('#geo-point-info').textContent='Không có tọa độ để đối chiếu.';return;}
  await ensureGeoMapForPoint(point);
  const logged=record?.altitude_m;
  el.textContent=`Log: lat ${point.latitude}, lon ${point.longitude}${logged===null||logged===undefined?'':`, cao độ ${logged} m`}. Đang tra tile…`;
  $('#geo-point-info').textContent=`Tọa độ đã chọn: ${point.latitude.toFixed(6)}, ${point.longitude.toFixed(6)}`;
  if($('#geo-auto-map').checked&&(!geoMap||point.latitude<geoMap.min_latitude||point.latitude>geoMap.max_latitude||point.longitude<geoMap.min_longitude||point.longitude>geoMap.max_longitude)){el.textContent=`Log: ${point.latitude.toFixed(6)}, ${point.longitude.toFixed(6)}. Không có tile bản đồ phù hợp.`;return;}
  if(!geoMap){el.textContent=`Log: lat ${point.latitude}, lon ${point.longitude}. Chưa có tile để đối chiếu.`;return;}
  try {
    const result=await api(`/api/geo/elevation?path=${encodeURIComponent(geoMap.path)}&latitude=${encodeURIComponent(point.latitude)}&longitude=${encodeURIComponent(point.longitude)}`);
    const elevation=result.elevation_m;
    el.textContent=`Log: ${logged===null||logged===undefined?'không có cao độ':`${logged} m`} · Bản đồ: ${elevation===null?'NoData':`${elevation} m`}${logged!==null&&logged!==undefined&&elevation!==null?` · Chênh lệch: ${(logged-elevation).toFixed(1)} m`:''}`;
    $('#geo-point-info').textContent=`Điểm lưới gần nhất: ${result.latitude.toFixed(6)}, ${result.longitude.toFixed(6)} · ô (${result.row}, ${result.column}) · checksum ${result.checksum_valid?'OK':'không khớp'}`;
  } catch(error) {el.textContent=`Log: ${logged===null||logged===undefined?'không có cao độ':`${logged} m`} · ${error.message}`;$('#geo-point-info').textContent=`Tọa độ: ${point.latitude.toFixed(6)}, ${point.longitude.toFixed(6)}`;}
}

async function loadGeoLog(path) {
  const token=++geoLogLoadToken;geoTerrainToken++;resetGeoChartView();$('#geo-analyze-terrain').textContent='Phân tích toàn bộ hành trình';
  stopGeoPlayback();geoPlaybackIndex=0;
  try {
    const result=await api(`/api/geo/logs?path=${encodeURIComponent(path)}`);
    if(token!==geoLogLoadToken)return;
    geoLogRows=result.records;geoActiveLogPath=path;geoTerrainResults=[];geoTerrainAnalysisDone=false;geoSelectedRecord=null;geoPlaybackIndex=0;
    $('#geo-log-summary').textContent=`${result.name}: ${result.total_records} bản ghi · ${result.coordinate_records} bản ghi có tọa độ${result.truncated?' · đã giới hạn 5.000':''}`;
    $('#geo-export').disabled=!geoLogRows.length;renderGeoLogs();updateGeoCoverage();updateGeoActionState();renderGeoStats();
  } catch(error) {if(token===geoLogLoadToken)clearGeoLog(error.message);}
}

function clearGeoLog(message) {
  geoLogLoadToken++;geoTerrainToken++;resetGeoChartView();stopGeoPlayback();geoLogRows=[];geoFilteredRows=[];geoActiveLogPath='';geoTerrainResults=[];geoTerrainAnalysisDone=false;geoSelectedRecord=null;geoPlaybackIndex=0;$('#geo-log-summary').textContent=message;$('#geo-log-body').innerHTML=`<tr><td colspan="8" class="muted">${esc(message)}</td></tr>`;$('#geo-export').disabled=true;$('#geo-report').disabled=true;$('#geo-timeline').disabled=true;$('#geo-play').disabled=true;$('#geo-timeline').max=0;$('#geo-timeline').value=0;$('#geo-time-label').textContent='—';$('#geo-analysis-info').textContent='Chọn dòng log có latitude/longitude.';$('#geo-log-stats').innerHTML='';$('#geo-terrain-summary').textContent='Chọn log và chạy phân tích toàn bộ hành trình qua các tile DTED.';updateGeoCoverage();updateGeoActionState();drawGeoMap();renderGeoChart();
}

function stopGeoPlayback() {
  if(geoPlayTimer){clearTimeout(geoPlayTimer);geoPlayTimer=null;}
  const button=$('#geo-play');if(button)button.textContent='▶ Phát lại';
}

function updateGeoCoverage() {
  if(!geoMap)return;
  const coordinates=geoLogRows.filter(row=>row.latitude!==null&&row.longitude!==null),inside=coordinates.filter(row=>row.latitude>=geoMap.min_latitude&&row.latitude<=geoMap.max_latitude&&row.longitude>=geoMap.min_longitude&&row.longitude<=geoMap.max_longitude).length;
  $('#geo-map-summary').textContent=`Lat ${geoMap.min_latitude.toFixed(5)}°…${geoMap.max_latitude.toFixed(5)}° · Lon ${geoMap.min_longitude.toFixed(5)}°…${geoMap.max_longitude.toFixed(5)}° · ${geoMap.columns}×${geoMap.rows} ô · bước ${geoMap.latitude_interval_seconds}″/${geoMap.longitude_interval_seconds}″ · ${inside}/${coordinates.length} điểm log nằm trong tile`;
}

function updateGeoActionState() {
  const hasCoordinates=geoLogRows.some(row=>row.latitude!==null&&row.longitude!==null);
  $('#geo-analyze-terrain').disabled=!(geoMaps.some(item=>!item.error)&&hasCoordinates);
  $('#geo-report').disabled=!geoLogRows.length;
  const overlayPath=$('#geo-overlay-select').value;
  $('#geo-add-overlay').disabled=!overlayPath||overlayPath===geoActiveLogPath||geoOverlays.some(layer=>layer.path===overlayPath)||geoOverlays.length>=4;
  $('#geo-clear-overlays').disabled=!geoOverlays.length;
}

function renderGeoOverlays() {
  $('#geo-overlay-list').innerHTML=geoOverlays.map((layer,index)=>`<span class="geo-overlay-chip" style="--series-color:${geoTrackColors[index%geoTrackColors.length]}"><i></i>${esc(layer.name)}<button type="button" data-remove-overlay="${index}" aria-label="Gỡ lớp phủ ${esc(layer.name)}">×</button></span>`).join('');
  $$('[data-remove-overlay]').forEach(button=>button.onclick=()=>{geoOverlays.splice(Number(button.dataset.removeOverlay),1);renderGeoOverlays();updateGeoActionState();drawGeoMap();});
  updateGeoActionState();drawGeoMap();
}

async function addGeoOverlay() {
  const path=$('#geo-overlay-select').value;
  if(!path)return;
  if(path===geoActiveLogPath||geoOverlays.some(layer=>layer.path===path)){toast('Log này đã nằm trên bản đồ.',true);return;}
  if(geoOverlays.length>=4){toast('Tối đa 4 quỹ đạo phủ cùng lúc.',true);return;}
  try {
    const result=await api(`/api/geo/logs?path=${encodeURIComponent(path)}`);
    const layer={path,name:result.name,rows:result.records};geoOverlays.push(layer);renderGeoOverlays();
    const firstPoint=layer.rows.find(row=>row.latitude!==null&&row.longitude!==null);
    if(firstPoint&&$('#geo-auto-map').checked)await ensureGeoMapForPoint(firstPoint);
    toast(`Đã thêm quỹ đạo phủ “${layer.name}” · ${layer.rows.length} bản ghi. Quỹ đạo nằm trên khung bản đồ.`);
  } catch(error){toast(error.message,true);}
}

function isLowAgl(row) {
  const threshold=Number($('#geo-agl-threshold').value);
  return Number.isFinite(row.agl_m)&&Number.isFinite(threshold)&&row.agl_m<threshold;
}

function calculateGeoStats() {
  const coordinates=geoLogRows.filter(row=>row.latitude!==null&&row.longitude!==null);
  let distance=0;const derivedSpeeds=[];
  for(let i=1;i<coordinates.length;i++){
    const a=coordinates[i-1],b=coordinates[i],rad=Math.PI/180,dLat=(b.latitude-a.latitude)*rad,dLon=(b.longitude-a.longitude)*rad;
    const h=Math.sin(dLat/2)**2+Math.cos(a.latitude*rad)*Math.cos(b.latitude*rad)*Math.sin(dLon/2)**2;
    const segment=2*6371008.8*Math.asin(Math.sqrt(h));distance+=segment;
    const elapsed=(Date.parse(b.timestamp)-Date.parse(a.timestamp))/1000;if(Number.isFinite(elapsed)&&elapsed>0)derivedSpeeds.push(segment/elapsed);
  }
  const times=geoLogRows.map(row=>Date.parse(row.timestamp)).filter(Number.isFinite),duration=times.length>1?(Math.max(...times)-Math.min(...times))/1000:0;
  const reportedSpeeds=geoLogRows.map(row=>row.speed_mps).filter(value=>Number.isFinite(value)&&value>=0),speeds=reportedSpeeds.length?reportedSpeeds:derivedSpeeds;
  const altitudes=geoLogRows.map(row=>row.altitude_m).filter(value=>Number.isFinite(value));
  const outside=geoTerrainResults.length?Math.max(0,coordinates.length-geoTerrainResults.length):geoMap?coordinates.filter(row=>row.latitude<geoMap.min_latitude||row.latitude>geoMap.max_latitude||row.longitude<geoMap.min_longitude||row.longitude>geoMap.max_longitude).length:null;
  const aglRows=geoLogRows.filter(row=>Number.isFinite(row.agl_m)),low=aglRows.filter(isLowAgl).length;
  return {points:geoLogRows.length,coordinatePoints:coordinates.length,distance,duration,avgSpeed:speeds.length?speeds.reduce((a,b)=>a+b,0)/speeds.length:(duration?distance/duration:null),maxSpeed:speeds.length?Math.max(...speeds):null,minAltitude:altitudes.length?Math.min(...altitudes):null,maxAltitude:altitudes.length?Math.max(...altitudes):null,outside,low,analyzed:aglRows.length};
}

function formatDuration(seconds) {
  if(!Number.isFinite(seconds)||seconds<=0)return '—';
  const total=Math.round(seconds),hours=Math.floor(total/3600),minutes=Math.floor((total%3600)/60),remaining=total%60;
  return hours?`${hours} giờ ${minutes} phút`:`${minutes} phút ${remaining} giây`;
}

function renderGeoStats() {
  const root=$('#geo-log-stats');
  if(!geoLogRows.length){root.innerHTML='';return;}
  const stats=calculateGeoStats(),speed=stats.avgSpeed===null?'—':`${stats.avgSpeed.toFixed(1)} m/s`,maxSpeed=stats.maxSpeed===null?'—':`${stats.maxSpeed.toFixed(1)} m/s`,altitude=stats.minAltitude===null?'—':`${stats.minAltitude.toFixed(0)}–${stats.maxAltitude.toFixed(0)} m`,outside=stats.outside===null?'Chọn tile':`${stats.outside}`;
  root.innerHTML=[['Điểm',stats.points.toLocaleString()],['Quãng đường',`${(stats.distance/1000).toFixed(2)} km`],['Thời lượng',formatDuration(stats.duration)],['Tốc độ TB / max',`${speed} / ${maxSpeed}`],['Cao độ log',altitude],['Ngoài tile',outside],['Dưới ngưỡng AGL',stats.analyzed?`${stats.low}/${stats.analyzed}`:'Chưa phân tích']].map(([label,value])=>`<div class="geo-stat-card ${label==='Dưới ngưỡng AGL'&&stats.low?'alert':''}"><small>${label}</small><b>${value}</b></div>`).join('');
  const covered=geoTerrainResults.length,terrainTiles=new Set(geoTerrainResults.map(item=>item.path)).size;
  $('#geo-terrain-summary').textContent=geoTerrainAnalysisDone?`${stats.analyzed} điểm có cao độ từ ${terrainTiles} tile DTED · ${stats.low} điểm dưới ngưỡng ${Number($('#geo-agl-threshold').value)} m · ${Math.max(0,stats.coordinatePoints-covered)} điểm không có mẫu DTED`:!geoMaps.some(item=>!item.error)?'Chưa có tile DTED hợp lệ để phân tích.':!stats.coordinatePoints?'Log này không có tọa độ để tra địa hình.':'Nhấn “Phân tích toàn bộ hành trình” để tra AGL qua các tile.';
}

async function analyzeGeoTerrain() {
  if(!geoLogRows.length||!geoMaps.some(item=>!item.error))return;
  const token=++geoTerrainToken,logPath=geoActiveLogPath,sourceRows=geoLogRows;
  const button=$('#geo-analyze-terrain'),maps=geoMaps.filter(item=>!item.error),groups=new Map();let uncovered=0;
  geoTerrainAnalysisDone=false;
  button.disabled=true;button.textContent='Đang phân tích…';$('#geo-terrain-summary').textContent='Đang tìm tile DTED phù hợp cho toàn bộ hành trình…';
  try {
    geoLogRows.forEach(row=>{row.terrain_elevation_m=null;row.agl_m=null;delete row.terrain_checksum_valid;});
    for(let index=0;index<geoLogRows.length;index++){
      const row=geoLogRows[index];if(row.latitude===null||row.longitude===null)continue;
      const matches=maps.filter(map=>row.latitude>=map.min_latitude&&row.latitude<=map.max_latitude&&row.longitude>=map.min_longitude&&row.longitude<=map.max_longitude);
      const map=matches.find(candidate=>candidate.path===geoMap?.path)||matches[0];
      if(!map){uncovered++;continue;}
      if(!groups.has(map.path))groups.set(map.path,{map,points:[],rowIndexes:[]});
      const group=groups.get(map.path);group.points.push({latitude:row.latitude,longitude:row.longitude});group.rowIndexes.push(index);
    }
    let completed=0;geoTerrainResults=[];
    for(const group of groups.values()){
      if(token!==geoTerrainToken||geoActiveLogPath!==logPath||geoLogRows!==sourceRows)return;
      $('#geo-terrain-summary').textContent=`Đang tra tile ${++completed}/${groups.size}: ${group.map.name}…`;
      const response=await api('/api/geo/elevations',{method:'POST',body:JSON.stringify({path:group.map.path,points:group.points})});
      if(token!==geoTerrainToken||geoActiveLogPath!==logPath||geoLogRows!==sourceRows)return;
      response.results.forEach(item=>{
        const rowIndex=group.rowIndexes[item.index],row=geoLogRows[rowIndex];if(!row)return;
        row.terrain_elevation_m=item.elevation_m;row.agl_m=item.elevation_m===null||row.altitude_m===null?null:row.altitude_m-item.elevation_m;row.terrain_checksum_valid=item.checksum_valid;
        geoTerrainResults.push({index:rowIndex,path:group.map.path,...item});
      });
    }
    const analyzed=geoLogRows.filter(row=>Number.isFinite(row.terrain_elevation_m)).length;
    geoTerrainAnalysisDone=true;
    $('#geo-terrain-summary').textContent=`Đã phân tích ${analyzed}/${geoLogRows.filter(row=>row.latitude!==null&&row.longitude!==null).length} điểm qua ${groups.size} tile DTED${uncovered?` · ${uncovered} điểm không có tile phủ`:''}.`;
    renderGeoStats();renderGeoLogs();drawGeoMap();
  } catch(error){if(token===geoTerrainToken){$('#geo-terrain-summary').textContent=error.message;toast(error.message,true);}}
  finally {if(token===geoTerrainToken){button.textContent='Phân tích toàn bộ hành trình';updateGeoActionState();}}
}

function geoChartWindow() {
  const count=geoFilteredRows.length;if(!count)return [0,-1];
  if(geoChartRange){const start=Math.max(0,Math.min(count-1,geoChartRange[0])),end=Math.max(start,Math.min(count-1,geoChartRange[1]));return [start,end];}
  return [0,count-1];
}

function geoIndexAtRatio(ratio,range) {
  const [first,last]=range,visible=geoFilteredRows.slice(first,last+1),times=visible.map(row=>Date.parse(row.timestamp));
  const timed=times.length>1&&times.every(Number.isFinite)&&Math.max(...times)>Math.min(...times);
  if(timed){const target=Math.min(...times)+ratio*(Math.max(...times)-Math.min(...times));return first+times.reduce((best,value,index)=>Math.abs(value-target)<Math.abs(times[best]-target)?index:best,0);}
  return first+Math.round(ratio*Math.max(0,last-first));
}

function resetGeoChartView() {
  geoChartZoom=1;geoChartRange=null;geoHeightYRange=null;geoSpeedYRange=null;
}

function applyGeoChartZoom(factor) {
  const count=geoFilteredRows.length;if(count<3)return;
  const [start,end]=geoChartWindow(),oldSpan=end-start+1,newSpan=Math.max(2,Math.min(count,Math.round(oldSpan/factor)));
  if(newSpan>=count){geoChartRange=null;geoChartZoom=1;}else{
    const anchor=geoPlaybackIndex>=start&&geoPlaybackIndex<=end?geoPlaybackIndex:Math.round((start+end)/2);
    const nextStart=Math.max(0,Math.min(count-newSpan,Math.round(anchor-(anchor-start)/oldSpan*newSpan)));
    geoChartRange=[nextStart,nextStart+newSpan-1];geoChartZoom=count/newSpan;
  }
  if(factor>1){geoHeightYRange=scaleGeoYRange(geoHeightYRange,factor);geoSpeedYRange=scaleGeoYRange(geoSpeedYRange,factor);}
  else if(factor<1){geoHeightYRange=scaleGeoYRange(geoHeightYRange,factor);geoSpeedYRange=scaleGeoYRange(geoSpeedYRange,factor);}
  renderGeoChart();
}

function scaleGeoYRange(range,factor) {
  if(!range)return null;
  const center=(range[0]+range[1])/2,half=(range[1]-range[0])/(2*factor);
  return [center-half,center+half];
}

function setGeoChartMode(mode) {
  geoChartMode=mode;
  $('#geo-chart-mode-zoom').classList.toggle('active',mode==='zoom');$('#geo-chart-mode-zoom').setAttribute('aria-pressed',String(mode==='zoom'));
  $('#geo-chart-mode-pan').classList.toggle('active',mode==='pan');$('#geo-chart-mode-pan').setAttribute('aria-pressed',String(mode==='pan'));
  ['geo-log-chart','geo-speed-chart'].forEach(id=>$('#'+id).dataset.chartMode=mode);
}

function drawGeoChartCanvas(canvasId,emptyId,series,fillBetween=false) {
  const canvas=$('#'+canvasId),rows=geoFilteredRows,[start,end]=geoChartWindow();if(!canvas)return;
  const visible=end>=start?rows.slice(start,end+1):[],hasValues=visible.some(row=>series.some(item=>Number.isFinite(row[item.key])));
  $('#'+emptyId).classList.toggle('hidden',hasValues);
  const rect=canvas.getBoundingClientRect(),dpr=window.devicePixelRatio||1;if(rect.width<2||rect.height<2)return;
  canvas.width=Math.round(rect.width*dpr);canvas.height=Math.round(rect.height*dpr);
  const ctx=canvas.getContext('2d');ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,rect.width,rect.height);if(!hasValues){delete geoChartScales[canvasId];return;}
  const left=48,right=12,top=12,bottom=25,width=rect.width-left-right,height=rect.height-top-bottom;
  const times=visible.map(row=>Date.parse(row.timestamp)),timed=times.length>1&&times.every(Number.isFinite)&&Math.max(...times)>Math.min(...times),timeStart=timed?Math.min(...times):0,timeSpan=timed?Math.max(...times)-timeStart:0;
  const xForLocal=index=>left+(timed?(times[index]-timeStart)/timeSpan:(visible.length<2?0:index/(visible.length-1)))*width;
  const allValues=visible.flatMap(row=>series.map(item=>row[item.key])).filter(Number.isFinite),fixedRange=canvasId==='geo-log-chart'?geoHeightYRange:geoSpeedYRange;let min=fixedRange?.[0]??Math.min(...allValues),max=fixedRange?.[1]??Math.max(...allValues);if(min===max){min-=1;max+=1;}if(!fixedRange){const pad=(max-min)*0.04;min-=pad;max+=pad;}
  geoChartScales[canvasId]={left,right,top,bottom,width,height,min,max,start,end};
  const yFor=value=>top+height-(value-min)/(max-min)*height;
  ctx.font='9px sans-serif';ctx.strokeStyle='#e8edeb';ctx.fillStyle='#87948e';ctx.lineWidth=1;
  for(let i=0;i<=4;i++){const y=top+height*i/4;ctx.beginPath();ctx.moveTo(left,y);ctx.lineTo(left+width,y);ctx.stroke();ctx.textAlign='right';ctx.textBaseline='middle';ctx.fillText((max-(max-min)*i/4).toFixed(0),left-5,y);}
  const altitudeTerrain=fillBetween&&series.some(item=>item.key==='altitude_m')&&series.some(item=>item.key==='terrain_elevation_m');
  if(altitudeTerrain){ctx.fillStyle='rgba(147,184,92,.18)';for(let i=0;i<visible.length-1;i++){const a=visible[i],b=visible[i+1];if(!Number.isFinite(a.altitude_m)||!Number.isFinite(a.terrain_elevation_m)||!Number.isFinite(b.altitude_m)||!Number.isFinite(b.terrain_elevation_m))continue;ctx.beginPath();ctx.moveTo(xForLocal(i),yFor(a.altitude_m));ctx.lineTo(xForLocal(i+1),yFor(b.altitude_m));ctx.lineTo(xForLocal(i+1),yFor(b.terrain_elevation_m));ctx.lineTo(xForLocal(i),yFor(a.terrain_elevation_m));ctx.closePath();ctx.fill();}}
  series.forEach(item=>{ctx.strokeStyle=item.color;ctx.lineWidth=item.key==='altitude_m'?2.2:1.9;ctx.beginPath();let pen=false;visible.forEach((row,index)=>{const value=row[item.key];if(!Number.isFinite(value)){pen=false;return;}const x=xForLocal(index),y=yFor(value);if(pen)ctx.lineTo(x,y);else{ctx.moveTo(x,y);pen=true;}});ctx.stroke();});
  const first=visible[0],last=visible[visible.length-1];ctx.fillStyle='#87948e';ctx.textBaseline='bottom';ctx.textAlign='left';ctx.fillText(first?.timestamp||`Bản ghi ${start+1}`,left,rect.height-4);ctx.textAlign='right';ctx.fillText(last?.timestamp||`Bản ghi ${end+1}`,left+width,rect.height-4);
}

function updateGeoChartPlayhead(canvasId) {
  const canvas=$('#'+canvasId),scale=geoChartScales[canvasId];if(!canvas)return;
  const wrap=canvas.parentElement;let playhead=wrap.querySelector('.geo-chart-playhead');
  if(!playhead){playhead=document.createElement('div');playhead.className='geo-chart-playhead';playhead.innerHTML='<i></i>';wrap.append(playhead);}
  const [start,end]=geoChartWindow();
  if(!scale||geoPlaybackIndex<start||geoPlaybackIndex>end||!geoFilteredRows.length){playhead.hidden=true;return;}
  const visible=geoFilteredRows.slice(start,end+1),index=geoPlaybackIndex-start,row=geoFilteredRows[geoPlaybackIndex];
  const times=visible.map(item=>Date.parse(item.timestamp)),timed=times.length>1&&times.every(Number.isFinite)&&Math.max(...times)>Math.min(...times);
  const ratio=timed?(times[index]-Math.min(...times))/(Math.max(...times)-Math.min(...times)):(visible.length<2?0:index/(visible.length-1));
  playhead.hidden=false;playhead.style.left=`${scale.left+ratio*scale.width}px`;playhead.style.top=`${scale.top}px`;playhead.style.height=`${scale.height}px`;
  playhead.title=`${row?.timestamp||`Bản ghi ${geoPlaybackIndex+1}`} · cao độ ${row?.altitude_m??'—'} m · AGL ${row?.agl_m??'—'} m`;
}

function renderGeoChart() {
  const heightSeries=[];
  if(geoChartSeriesVisible.altitude)heightSeries.push({key:'altitude_m',color:'#176b55'});
  if(geoChartSeriesVisible.terrain)heightSeries.push({key:'terrain_elevation_m',color:'#3768b1'});
  if(geoChartSeriesVisible.agl)heightSeries.push({key:'agl_m',color:'#93b85c'});
  drawGeoChartCanvas('geo-log-chart','geo-chart-empty',heightSeries,geoChartSeriesVisible.agl);
  drawGeoChartCanvas('geo-speed-chart','geo-speed-chart-empty',geoChartSeriesVisible.speed?[{key:'speed_mps',color:'#ed9b57'}]:[]);
  updateGeoChartPlayhead('geo-log-chart');updateGeoChartPlayhead('geo-speed-chart');
  const [start,end]=geoChartWindow(),count=geoFilteredRows.length,span=Math.max(0,end-start+1);geoChartZoom=count&&span?count/span:1;
  $('#geo-chart-zoom-label').textContent=`${geoChartZoom.toFixed(geoChartZoom%1?1:0)}×`;
  $('#geo-chart-zoom-in').disabled=span<3;
  $('#geo-chart-zoom-out').disabled=!geoChartRange;
  $('#geo-chart-reset').disabled=!geoChartRange&&!geoHeightYRange&&!geoSpeedYRange;
}

function updateGeoChartVisibility() {
  $$('[data-geo-series]').forEach(input=>{geoChartSeriesVisible[input.dataset.geoSeries]=input.checked;});
  const anyHeight=geoChartSeriesVisible.altitude||geoChartSeriesVisible.terrain||geoChartSeriesVisible.agl;
  $('#geo-chart-empty').textContent=anyHeight?'Phân tích toàn bộ hành trình để hiển thị dữ liệu địa hình.':'Bật ít nhất một chuỗi cao độ để hiển thị.';
  $('#geo-speed-heading').classList.toggle('hidden',!geoChartSeriesVisible.speed);
  $('#geo-speed-chart-wrap').classList.toggle('hidden',!geoChartSeriesVisible.speed);
  renderGeoChart();
}

function geoChartLocalPoint(canvas,event) {
  const rect=canvas.getBoundingClientRect(),scale=geoChartScales[canvas.id]||{left:48,right:12,top:12,bottom:25};
  return {x:event.clientX-rect.left,y:event.clientY-rect.top,rect,plotX:Math.max(0,Math.min(1,(event.clientX-rect.left-scale.left)/(rect.width-scale.left-scale.right))),plotY:Math.max(0,Math.min(1,(event.clientY-rect.top-scale.top)/(rect.height-scale.top-scale.bottom)))};
}

function showGeoDragSelection() {
  const drag=geoChartDrag;if(!drag||geoChartMode!=='zoom')return;
  const canvas=drag.canvas,wrap=canvas.parentElement,rect=canvas.getBoundingClientRect(),left=Math.min(drag.start.x,drag.current.x),top=Math.min(drag.start.y,drag.current.y),width=Math.abs(drag.current.x-drag.start.x),height=Math.abs(drag.current.y-drag.start.y);
  let box=wrap.querySelector('.geo-drag-selection');
  if(!box){box=document.createElement('div');box.className='geo-drag-selection';wrap.append(box);}
  box.style.display='block';box.style.left=`${left}px`;box.style.top=`${top}px`;box.style.width=`${width}px`;box.style.height=`${height}px`;
  // The overlay is positioned in the wrapper's coordinate system.
  const wrapRect=wrap.getBoundingClientRect();box.style.left=`${left+rect.left-wrapRect.left}px`;box.style.top=`${top+rect.top-wrapRect.top}px`;
}

function removeGeoDragSelection() {
  document.querySelectorAll('.geo-drag-selection').forEach(node=>node.remove());
}

function geoChartPointerDown(event) {
  if(event.button!==0||!geoFilteredRows.length)return;
  const canvas=event.currentTarget,point=geoChartLocalPoint(canvas,event),scale=geoChartScales[canvas.id];
  if(!scale||point.x<scale.left||point.x>point.rect.width-scale.right||point.y<scale.top||point.y>point.rect.height-scale.bottom)return;
  if(geoPlayTimer)stopGeoPlayback();
  geoChartDrag={canvas,id:canvas.id,start:point,current:point,scale,range:geoChartWindow(),initialPlayback:geoPlaybackIndex,initialYRange:canvas.id==='geo-speed-chart'?(geoSpeedYRange||[scale.min,scale.max]):(geoHeightYRange||[scale.min,scale.max]),moved:false};
  canvas.setPointerCapture(event.pointerId);canvas.classList.add(geoChartMode==='pan'?'geo-panning':'geo-zooming');event.preventDefault();
}

function geoChartPointerMove(event) {
  const drag=geoChartDrag;if(!drag||drag.canvas!==event.currentTarget)return;
  drag.current=geoChartLocalPoint(drag.canvas,event);
  const dx=drag.current.x-drag.start.x,dy=drag.current.y-drag.start.y;
  if(Math.abs(dx)+Math.abs(dy)>3)drag.moved=true;
  if(!drag.moved)return;
  if(geoChartMode==='zoom')showGeoDragSelection();
  else {
    const count=geoFilteredRows.length,[start,end]=drag.range,span=end-start+1,plotWidth=drag.start.rect.width-drag.scale.left-drag.scale.right,plotHeight=drag.start.rect.height-drag.scale.top-drag.scale.bottom;
    const shift=Math.round(-dx/plotWidth*span),nextStart=Math.max(0,Math.min(count-span,start+shift));
    if(span<count){geoChartRange=[nextStart,nextStart+span-1];geoPlaybackIndex=Math.max(nextStart,Math.min(nextStart+span-1,drag.initialPlayback+nextStart-start));}
    const [min,max]=drag.initialYRange,valueShift=dy/plotHeight*(max-min),nextY=[min+valueShift,max+valueShift];
    if(drag.id==='geo-speed-chart')geoSpeedYRange=nextY;else geoHeightYRange=nextY;
    if(!geoChartDragFrame)geoChartDragFrame=requestAnimationFrame(()=>{geoChartDragFrame=0;renderGeoChart();});
  }
  event.preventDefault();
}

function geoChartPointerUp(event) {
  const drag=geoChartDrag;if(!drag||drag.canvas!==event.currentTarget)return;
  drag.current=geoChartLocalPoint(drag.canvas,event);drag.canvas.classList.remove('geo-panning','geo-zooming');
  try{drag.canvas.releasePointerCapture(event.pointerId);}catch{}
  geoChartDrag=null;removeGeoDragSelection();
  if(drag.moved&&geoChartMode==='zoom'){
    const {scale,range,start,current,id}=drag,plotW=start.rect.width-scale.left-scale.right,plotH=start.rect.height-scale.top-scale.bottom;
    const x1=Math.max(0,Math.min(start.plotX,current.plotX)),x2=Math.max(0,Math.max(start.plotX,current.plotX));
    if(Math.abs(current.x-start.x)>8){const first=geoIndexAtRatio(x1,range),last=geoIndexAtRatio(x2,range);if(last-first>=1){geoChartRange=[first,last];geoPlaybackIndex=Math.max(first,Math.min(last,geoPlaybackIndex));$('#geo-timeline').value=geoPlaybackIndex;updateGeoTimeLabel();showPlaybackRecord(geoFilteredRows[geoPlaybackIndex]);}}
    if(Math.abs(current.y-start.y)>8){const y1=Math.max(0,Math.min(start.plotY,current.plotY)),y2=Math.max(0,Math.max(start.plotY,current.plotY)),min=scale.min+(1-y2)*(scale.max-scale.min),max=scale.min+(1-y1)*(scale.max-scale.min);if(id==='geo-speed-chart')geoSpeedYRange=[min,max];else geoHeightYRange=[min,max];}
  } else if(!drag.moved) {
    const [first,last]=geoChartWindow();geoPlaybackIndex=geoIndexAtRatio(drag.current.plotX,[first,last]);
    $('#geo-timeline').value=geoPlaybackIndex;updateGeoTimeLabel();
    const row=geoFilteredRows[geoPlaybackIndex];showPlaybackRecord(row);if(row?.latitude!==null&&row?.latitude!==undefined)inspectGeoPoint(row,row);renderGeoLogSelection();
  }
  renderGeoChart();
}

function bindGeoChart(canvasId) {
  const canvas=$('#'+canvasId);canvas.addEventListener('pointerdown',geoChartPointerDown);canvas.addEventListener('pointermove',geoChartPointerMove);canvas.addEventListener('pointerup',geoChartPointerUp);canvas.addEventListener('pointercancel',geoChartPointerUp);
}

function renderGeoLogs() {
  if(geoPlayTimer)stopGeoPlayback();
  const query=$('#geo-log-query').value.trim().toLocaleLowerCase(),from=$('#geo-log-from').value,to=$('#geo-log-to').value;
  geoFilteredRows=geoLogRows.filter(row=>{const day=row.timestamp.slice(0,10);return (!query||`${row.message} ${row.raw} ${row.latitude??''} ${row.longitude??''}`.toLocaleLowerCase().includes(query))&&(!from||(day&&day>=from))&&(!to||(day&&day<=to));});
  geoPlaybackIndex=Math.min(geoPlaybackIndex,Math.max(0,geoFilteredRows.length-1));
  const body=$('#geo-log-body');let tableStart=Number(body.dataset.windowStart)||0;
  if(geoFilteredRows.length<=GEO_LOG_TABLE_LIMIT)tableStart=0;
  else if(geoPlaybackIndex<tableStart||geoPlaybackIndex>=tableStart+GEO_LOG_TABLE_LIMIT)tableStart=Math.max(0,Math.min(geoFilteredRows.length-GEO_LOG_TABLE_LIMIT,geoPlaybackIndex-Math.floor(GEO_LOG_TABLE_LIMIT/2)));
  body.dataset.windowStart=String(tableStart);
  if(!geoFilteredRows.length){$('#geo-log-body').innerHTML='<tr><td colspan="8" class="muted">Không có bản ghi khớp bộ lọc.</td></tr>';}
  else $('#geo-log-body').innerHTML=geoFilteredRows.slice(tableStart,tableStart+GEO_LOG_TABLE_LIMIT).map((row,offset)=>{const index=tableStart+offset;return `<tr tabindex="0" data-geo-log-index="${index}" class="${row===geoSelectedRecord?'selected':''} ${index===geoPlaybackIndex?'playback-current':''} ${isLowAgl(row)?'low-agl':''}"><td>${row.index+1}</td><td>${esc(row.timestamp||'—')}</td><td>${row.latitude===null?'—':row.latitude.toFixed(6)}</td><td>${row.longitude===null?'—':row.longitude.toFixed(6)}</td><td>${row.altitude_m===null?'—':`${row.altitude_m} m`}</td><td>${row.speed_mps===null?'—':`${row.speed_mps} m/s`}</td><td>${row.agl_m===null||row.agl_m===undefined?'—':`${row.agl_m} m`}</td><td title="${esc(row.raw)}">${esc(row.message||row.raw||'—')}</td></tr>`;}).join('');
  $$('#geo-log-body [data-geo-log-index]').forEach(row=>row.onclick=()=>{if(geoPlayTimer)stopGeoPlayback();const index=Number(row.dataset.geoLogIndex);geoPlaybackIndex=index;$('#geo-timeline').value=index;updateGeoTimeLabel();showPlaybackRecord(geoFilteredRows[index]);inspectGeoPoint(geoFilteredRows[index],geoFilteredRows[index]);renderGeoLogSelection();drawGeoMap();});
  $('#geo-timeline').max=Math.max(0,geoFilteredRows.length-1);geoPlaybackIndex=Math.min(geoPlaybackIndex,Math.max(0,geoFilteredRows.length-1));$('#geo-timeline').value=geoPlaybackIndex;$('#geo-timeline').disabled=geoFilteredRows.length<2;$('#geo-play').disabled=geoFilteredRows.length<2;
  $('#geo-log-summary').textContent=`${$('#geo-log-select').selectedOptions[0]?.textContent||'Log'} · ${geoFilteredRows.length} / ${geoLogRows.length} bản ghi đang hiển thị`;
  updateGeoTimeLabel();drawGeoMap();renderGeoChart();renderGeoStats();renderGeoLogSelection();$('#geo-export').disabled=!geoFilteredRows.length;$('#geo-report').disabled=!geoLogRows.length;
  const current=geoFilteredRows[geoPlaybackIndex];if(current)ensureGeoMapForPoint(current);
}

function renderGeoLogSelection() {
  const body=$('#geo-log-body');if(!geoFilteredRows.length)return;
  const start=Number(body.dataset.windowStart)||0;
  if(geoPlaybackIndex<start||geoPlaybackIndex>=Math.min(start+GEO_LOG_TABLE_LIMIT,geoFilteredRows.length))renderGeoLogs();
  $$('[data-geo-log-index]',body).forEach(row=>{const index=Number(row.dataset.geoLogIndex);row.classList.toggle('selected',geoFilteredRows[index]===geoSelectedRecord);row.classList.toggle('playback-current',index===geoPlaybackIndex);});
  const currentRow=$(`[data-geo-log-index="${geoPlaybackIndex}"]`,body),wrap=body.closest('.geo-table-wrap');
  if(currentRow&&wrap){
    const rowRect=currentRow.getBoundingClientRect(),wrapRect=wrap.getBoundingClientRect(),headHeight=$('.geo-log-table thead',wrap)?.getBoundingClientRect().height||0;
    const visibleCenter=wrapRect.top+headHeight+(wrap.clientHeight-headHeight)/2,rowCenter=rowRect.top+rowRect.height/2,delta=rowCenter-visibleCenter;
    if(Math.abs(delta)>2)wrap.scrollTo({top:wrap.scrollTop+delta,behavior:'smooth'});
  }
}

function updateGeoTimeLabel() {
  const row=geoFilteredRows[geoPlaybackIndex];$('#geo-time-label').textContent=row?.timestamp||`Bản ghi ${geoFilteredRows.length?geoPlaybackIndex+1:0}/${geoFilteredRows.length}`;
}

function showPlaybackRecord(row) {
  geoSelectedRecord=row||null;
  if(row?.latitude!==null&&row?.latitude!==undefined&&row?.longitude!==null&&row?.longitude!==undefined)ensureGeoMapForPoint(row);
  if(geoChartRange&&geoFilteredRows.length){
    const [start,end]=geoChartRange,span=end-start+1;
    if(geoPlaybackIndex<start||geoPlaybackIndex>end){
      const nextStart=Math.max(0,Math.min(geoFilteredRows.length-span,geoPlaybackIndex>=end?geoPlaybackIndex-span+1:geoPlaybackIndex));
      geoChartRange=[nextStart,nextStart+span-1];
    }
  }
  if(row?.latitude!==null&&row?.latitude!==undefined&&row?.longitude!==null&&row?.longitude!==undefined){
    geoManualPoint=null;
    $('#geo-analysis-info').textContent=`Đang phát: ${row.timestamp||`bản ghi ${row.index+1}`} · ${row.latitude.toFixed(6)}, ${row.longitude.toFixed(6)}${row.altitude_m===null?'':` · cao độ log ${row.altitude_m} m`}. Chọn dòng để đối chiếu với tile.`;
    $('#geo-point-info').textContent=`Tọa độ đang phát: ${row.latitude.toFixed(6)}, ${row.longitude.toFixed(6)}`;
  }
  drawGeoMap();renderGeoLogSelection();renderGeoChart();
}

function geoPlaybackDelay() {
  const current=Date.parse(geoFilteredRows[geoPlaybackIndex]?.timestamp||''),next=Date.parse(geoFilteredRows[geoPlaybackIndex+1]?.timestamp||'');
  const recordedGap=Number.isFinite(current)&&Number.isFinite(next)&&next>current?next-current:5000;
  return Math.max(50,recordedGap/Number($('#geo-play-speed').value||10));
}

function scheduleGeoPlaybackStep() {
  if(geoPlaybackIndex>=geoFilteredRows.length-1){stopGeoPlayback();return;}
  geoPlayTimer=setTimeout(()=>{
    geoPlayTimer=null;
    if(geoPlaybackIndex>=geoFilteredRows.length-1){stopGeoPlayback();return;}
    geoPlaybackIndex++;$('#geo-timeline').value=geoPlaybackIndex;updateGeoTimeLabel();showPlaybackRecord(geoFilteredRows[geoPlaybackIndex]);
    scheduleGeoPlaybackStep();
  },geoPlaybackDelay());
}

function exportGeoLogs() {
  const rows=[['index','timestamp','latitude','longitude','altitude_m','speed_mps','terrain_elevation_m','agl_m','below_agl_threshold','message','raw'],...geoFilteredRows.map(row=>[row.index,row.timestamp,row.latitude??'',row.longitude??'',row.altitude_m??'',row.speed_mps??'',row.terrain_elevation_m??'',row.agl_m??'',Number.isFinite(row.agl_m)?isLowAgl(row):'',row.message,row.raw])];
  const csv=rows.map(row=>row.map(value=>{const text=String(value),safe=typeof value==='string'&&/^[\s]*[=+\-@]/.test(text)?`'${text}`:text;return `"${safe.replace(/"/g,'""')}"`;}).join(',')).join('\r\n');
  const blob=new Blob(['\ufeff',csv],{type:'text/csv;charset=utf-8'}),url=URL.createObjectURL(blob),link=document.createElement('a');
  link.href=url;link.download='filescope-log-export.csv';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}

function exportGeoReport() {
  if(!geoLogRows.length)return;
  const stats=calculateGeoStats(),name=$('#geo-log-select').selectedOptions[0]?.textContent||geoActiveLogPath||'Log';
  const mapImage=geoMap?$('#geo-map-canvas').toDataURL('image/png'):'';
  const chartImage=geoFilteredRows.length?$('#geo-log-chart').toDataURL('image/png'):'';
  const speedChartImage=geoFilteredRows.some(row=>Number.isFinite(row.speed_mps))?$('#geo-speed-chart').toDataURL('image/png'):'';
  const lowRows=geoLogRows.filter(isLowAgl).slice(0,100);
  const cards=[['Bản ghi',stats.points],['Tọa độ',stats.coordinatePoints],['Quãng đường',`${(stats.distance/1000).toFixed(2)} km`],['Thời lượng',formatDuration(stats.duration)],['Tốc độ trung bình',stats.avgSpeed===null?'—':`${stats.avgSpeed.toFixed(1)} m/s`],['Tốc độ lớn nhất',stats.maxSpeed===null?'—':`${stats.maxSpeed.toFixed(1)} m/s`],['Cao độ',stats.minAltitude===null?'—':`${stats.minAltitude}–${stats.maxAltitude} m`],['Ngoài tile',stats.outside??'Chưa chọn tile'],['Dưới ngưỡng AGL',stats.analyzed?`${stats.low}/${stats.analyzed} (ngưỡng ${Number($('#geo-agl-threshold').value)} m)`:'Chưa phân tích']];
  const table=lowRows.length?`<h2>Các điểm dưới ngưỡng AGL (${lowRows.length}${stats.low>100?' trong '+stats.low:''})</h2><table><thead><tr><th>#</th><th>Thời gian</th><th>Lat</th><th>Lon</th><th>Cao độ</th><th>Địa hình</th><th>AGL</th></tr></thead><tbody>${lowRows.map(row=>`<tr><td>${row.index+1}</td><td>${esc(row.timestamp||'—')}</td><td>${row.latitude?.toFixed(6)??'—'}</td><td>${row.longitude?.toFixed(6)??'—'}</td><td>${row.altitude_m??'—'}</td><td>${row.terrain_elevation_m??'—'}</td><td>${row.agl_m?.toFixed(1)??'—'}</td></tr>`).join('')}</tbody></table>`:'<p>Không có điểm dưới ngưỡng hoặc chưa chạy phân tích AGL.</p>';
  const overlays=geoOverlays.map(layer=>`<li>${esc(layer.name)} — ${layer.rows.length} bản ghi</li>`).join('')||'<li>Không có quỹ đạo phủ thêm.</li>';
  const html=`<!doctype html><html lang="vi"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Báo cáo ${esc(name)}</title><style>body{font:14px system-ui,sans-serif;max-width:1100px;margin:30px auto;padding:0 18px;color:#24312b}h1{font-size:24px}.muted{color:#68776f}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:9px}.card{border:1px solid #dfe7e2;border-radius:7px;padding:11px}.card small{display:block;color:#68776f}.card b{display:block;margin-top:5px}img{display:block;max-width:100%;margin:14px 0;border:1px solid #dfe7e2}table{border-collapse:collapse;width:100%;font-size:12px}th,td{text-align:left;padding:7px;border-bottom:1px solid #e5ebe7}th{background:#f4f7f5}section{margin-top:26px}@media print{body{margin:0 auto}.cards{break-inside:avoid}}</style><h1>Báo cáo log: ${esc(name)}</h1><p class="muted">Tạo lúc ${esc(new Date().toISOString())}${geoMap?` · Tile ${esc(geoMap.path)}`:''}</p><div class="cards">${cards.map(([label,value])=>`<div class="card"><small>${esc(label)}</small><b>${esc(value)}</b></div>`).join('')}</div>${mapImage?`<section><h2>Bản đồ và quỹ đạo</h2><img alt="Bản đồ địa hình với quỹ đạo" src="${mapImage}"></section>`:''}${chartImage?`<section><h2>Độ cao bay so với địa hình</h2><img alt="Biểu đồ cao độ bay và địa hình" src="${chartImage}"></section>`:''}${speedChartImage?`<section><h2>Tốc độ theo thời gian</h2><img alt="Biểu đồ tốc độ" src="${speedChartImage}"></section>`:''}<section><h2>Quỹ đạo phủ</h2><ul>${overlays}</ul></section><section>${table}</section><p class="muted">AGL là chênh lệch giữa cao độ log và địa hình; chỉ diễn giải khi các nguồn dùng cùng đơn vị và mốc cao độ.</p></html>`;
  const blob=new Blob([html],{type:'text/html;charset=utf-8'}),url=URL.createObjectURL(blob),link=document.createElement('a');
  link.href=url;link.download='filescope-flight-report.html';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}

$('#geo-refresh').onclick=loadGeoCatalog;
$('#geo-map-select').onchange=event=>event.target.value?loadGeoMap(event.target.value):clearGeoMap('Chưa chọn tile bản đồ.');
$('#geo-log-select').onchange=event=>event.target.value?loadGeoLog(event.target.value):clearGeoLog('Chưa chọn tệp log.');
$('#geo-auto-map').onchange=event=>{const status=$('#geo-auto-map-status');if(!event.target.checked){if(geoAutoMapTargetPath){geoMapLoadToken++;geoAutoMapTargetPath='';geoAutoMapPromise=null;$('#geo-map-select').value=geoMap?.path||'';}status.textContent='Tự động chọn bản đồ đã tắt.';return;}status.textContent='Đang dò tile theo điểm bay hiện tại…';const row=geoFilteredRows[geoPlaybackIndex];if(row)ensureGeoMapForPoint(row);};
$('#geo-load-log').onclick=()=>$('#geo-log-select').value&&loadGeoLog($('#geo-log-select').value);
$('#geo-overlay-select').onchange=updateGeoActionState;
$$('[data-geo-series]').forEach(input=>input.onchange=updateGeoChartVisibility);
['geo-log-query','geo-log-from','geo-log-to'].forEach(id=>$('#'+id).addEventListener(id==='geo-log-query'?'input':'change',renderGeoLogs));
$('#geo-timeline').oninput=()=>{if(geoPlayTimer)stopGeoPlayback();geoPlaybackIndex=Number($('#geo-timeline').value);updateGeoTimeLabel();showPlaybackRecord(geoFilteredRows[geoPlaybackIndex]);};
$('#geo-timeline').onchange=()=>{const row=geoFilteredRows[geoPlaybackIndex];if(row?.latitude!==null&&row?.latitude!==undefined)inspectGeoPoint(row,row);};
$('#geo-play-speed').onchange=()=>{if(geoPlayTimer){clearTimeout(geoPlayTimer);geoPlayTimer=null;scheduleGeoPlaybackStep();}};
$('#geo-play').onclick=()=>{if(geoPlayTimer){stopGeoPlayback();return;}if(!geoFilteredRows.length)return;if(geoPlaybackIndex>=geoFilteredRows.length-1){geoPlaybackIndex=0;$('#geo-timeline').value=0;showPlaybackRecord(geoFilteredRows[0]);}$('#geo-play').textContent='Ⅱ Tạm dừng';scheduleGeoPlaybackStep();};
$('#geo-export').onclick=exportGeoLogs;
$('#geo-report').onclick=exportGeoReport;
$('#geo-find-tile').onclick=locateGeoTile;
['geo-find-lat','geo-find-lon'].forEach(id=>$('#'+id).onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();locateGeoTile();}});
$('#geo-add-overlay').onclick=addGeoOverlay;
$('#geo-clear-overlays').onclick=()=>{geoOverlays=[];renderGeoOverlays();};
$('#geo-analyze-terrain').onclick=analyzeGeoTerrain;
$('#geo-agl-threshold').oninput=()=>{renderGeoStats();renderGeoLogs();drawGeoMap();};
bindGeoChart('geo-log-chart');bindGeoChart('geo-speed-chart');setGeoChartMode('zoom');
$('#geo-chart-mode-zoom').onclick=()=>setGeoChartMode('zoom');
$('#geo-chart-mode-pan').onclick=()=>setGeoChartMode('pan');
$('#geo-chart-zoom-in').onclick=()=>applyGeoChartZoom(2);
$('#geo-chart-zoom-out').onclick=()=>applyGeoChartZoom(.5);
$('#geo-chart-reset').onclick=()=>{resetGeoChartView();renderGeoChart();};
$('#geo-map-canvas').addEventListener('click',async event=>{if(!geoMap)return;const rect=event.currentTarget.getBoundingClientRect(),x=(event.clientX-rect.left)/rect.width,y=(event.clientY-rect.top)/rect.height;const point={latitude:geoMap.max_latitude-y*(geoMap.max_latitude-geoMap.min_latitude),longitude:geoMap.min_longitude+x*(geoMap.max_longitude-geoMap.min_longitude)};await inspectGeoPoint(point);});
window.addEventListener('resize',()=>{drawGeoMap();renderGeoChart();});

async function loadFiles(path, { recordHistory = true } = {}) {
  showSection('files-view');
  try {
    const data = await api(`/api/list?path=${encodeURIComponent(path)}`);
    current = path;
    searchMode = false;searchTruncated = false;
    if (recordHistory) rememberFolder(path);
    $('#folder-title').textContent = path.split('/').pop() || 'Tất cả tệp';
    $('#breadcrumb').innerHTML = '<button data-path="">Home</button>' + path.split('/').filter(Boolean).map((part, index, parts) =>
      `<span>/</span><button data-path="${esc(parts.slice(0, index + 1).join('/'))}">${esc(part)}</button>`).join('');
    $$('[data-path]', $('#breadcrumb')).forEach(button => button.onclick = () => loadFiles(button.dataset.path));
    listedFiles = data.items;
    renderFileRows();
    if (!columnResizingReady) initColumnResizing();
    wireOpenButtons();
    if (me.role !== 'read') wireActions();
    updateClipboardUI();
    await loadTree();
    return true;
  } catch (error) {
    toast(error.message, true);
    return false;
  }
}

function renderFileRows() {
  const filtered = listedFiles.filter(file => matchesFilters(file));
  filtered.sort((a, b) => compareFiles(a, b) * sortDirection);
  $('#item-count').textContent = `${filtered.length}${searchTruncated ? '+' : ''}${filtered.length !== listedFiles.length ? ` / ${listedFiles.length}` : ''} mục`;
  $('#file-list').innerHTML = filtered.map(file => `<tr>
      <td><button class="file-name" data-open="${esc(file.path)}"><span class="file-icon ${file.type}">${file.type === 'directory' ? '▰' : '▤'}</span><span>${esc(file.name)}</span></button>${searchMode ? `<small class="search-path">${esc(file.path.includes('/') ? file.path.slice(0,file.path.lastIndexOf('/')) : 'Thư mục gốc')}</small>` : ''}</td>
      <td>${file.type === 'directory' ? '—' : size(file.size)}</td><td><code>${esc(file.mode)}</code></td>
      <td>${new Date(file.modified).toLocaleString('vi-VN', { dateStyle: 'medium', timeStyle: 'short' })}</td>
      <td><div class="row-actions"><button title="Sao chép" aria-label="Sao chép ${esc(file.name)}" data-copy="${esc(file.path)}" data-name="${esc(file.name)}">⧉</button><button title="Cắt" aria-label="Cắt ${esc(file.name)}" data-cut="${esc(file.path)}" data-name="${esc(file.name)}">✂</button><button title="Đổi tên" data-rename="${esc(file.path)}" data-name="${esc(file.name)}">✎</button>${me.role!=='read'&&file.type==='file'&&canEditText(file.name)?`<button title="Sửa nội dung" aria-label="Sửa nội dung ${esc(file.name)}" data-edit="${esc(file.path)}">▤</button>`:''}<button title="Đổi quyền" data-chmod="${esc(file.path)}" data-mode="${esc(file.mode_octal)}">⌘</button>${canPreview(file.name) ? `<a class="preview-link" title="Mở xem trước" target="_blank" rel="noopener noreferrer" href="/api/preview?path=${encodeURIComponent(file.path)}">◉</a>` : ''}<a class="download-link" title="Tải xuống" href="/api/download?path=${encodeURIComponent(file.path)}">↓</a><button title="Xóa" data-delete="${esc(file.path)}">×</button></div></td>
    </tr>`).join('');
  $('#empty').classList.toggle('hidden', filtered.length > 0);
  $('#empty b').textContent = searchMode ? 'Không tìm thấy kết quả' : 'Thư mục này chưa có tệp';
  $('#empty p').textContent = searchMode ? 'Thử thay đổi từ khóa hoặc điều kiện lọc.' : 'Tải tệp lên hoặc tạo một tệp mới để bắt đầu.';
  if (me?.role !== 'read') wireActions();
  wireOpenButtons();
  updateClipboardUI();
  updateHeaderState();
}

function wireOpenButtons() {
  $$('[data-open]', $('#file-list')).forEach(button => button.onclick = () => {
    const file = listedFiles.find(item => item.path === button.dataset.open);
    if (file?.type === 'directory') loadFiles(file.path);
    else if (file && canPreview(file.name)) window.open(`/api/preview?path=${encodeURIComponent(file.path)}`, '_blank', 'noopener,noreferrer');
    else if (file) toast('Định dạng này chưa hỗ trợ xem trước; hãy tải tệp xuống.');
  });
}

function compareFiles(a, b) {
  let result = 0;
  if (sortKey === 'size') result = Number(a.size || 0) - Number(b.size || 0);
  else if (sortKey === 'mode') result = String(a.mode_octal || a.mode).localeCompare(String(b.mode_octal || b.mode), 'en', { numeric: true });
  else if (sortKey === 'modified') result = new Date(a.modified).getTime() - new Date(b.modified).getTime();
  else result = a.name.localeCompare(b.name, 'vi', { numeric: true, sensitivity: 'base' });
  if (!result && sortKey !== 'name') result = a.name.localeCompare(b.name, 'vi', { numeric: true, sensitivity: 'base' });
  return result;
}

function normalizedInitial(name) {
  return name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').charAt(0).toUpperCase();
}

function matchesFilters(file) {
  const letter = normalizedInitial(file.name);
  if (activeFilters.name === 'ah' && !(letter >= 'A' && letter <= 'H')) return false;
  if (activeFilters.name === 'ip' && !(letter >= 'I' && letter <= 'P')) return false;
  if (activeFilters.name === 'qz' && !(letter >= 'Q' && letter <= 'Z')) return false;
  if (activeFilters.name === 'other' && letter >= 'A' && letter <= 'Z') return false;
  const bytes = Number(file.size || 0);
  if (activeFilters.size === 'empty' && bytes !== 0) return false;
  if (activeFilters.size === 'lt1k' && !(bytes > 0 && bytes < 1024)) return false;
  if (activeFilters.size === '1k100k' && !(bytes >= 1024 && bytes < 102400)) return false;
  if (activeFilters.size === '100k1m' && !(bytes >= 102400 && bytes < 1048576)) return false;
  if (activeFilters.size === '1m100m' && !(bytes >= 1048576 && bytes < 104857600)) return false;
  if (activeFilters.size === 'gt100m' && bytes < 104857600) return false;
  if (activeFilters.mode !== 'all' && String(file.mode) !== activeFilters.mode) return false;
  const modified = new Date(file.modified);
  const now = new Date();
  const days = (now.getTime() - modified.getTime()) / 86400000;
  if (activeFilters.modified === 'today' && modified.toDateString() !== now.toDateString()) return false;
  if (activeFilters.modified === 'week' && !(days >= 0 && days <= 7)) return false;
  if (activeFilters.modified === 'month' && !(days >= 0 && days <= 30)) return false;
  if (activeFilters.modified === 'calendarMonth' && (modified.getFullYear() !== now.getFullYear() || modified.getMonth() !== now.getMonth())) return false;
  if (activeFilters.modified === 'calendarYear' && modified.getFullYear() !== now.getFullYear()) return false;
  if (activeFilters.modified === 'older' && !(days > 30)) return false;
  if (activeFilters.from && modified < new Date(`${activeFilters.from}T00:00:00`)) return false;
  if (activeFilters.to && modified > new Date(`${activeFilters.to}T23:59:59.999`)) return false;
  return true;
}

function updateHeaderState() {
  $$('.sort-button').forEach(button => {
    const active = button.dataset.sort === sortKey;
    button.querySelector('.sort-indicator').textContent = active ? (sortDirection === 1 ? ' ↑' : ' ↓') : '';
    button.closest('th').setAttribute('aria-sort', active ? (sortDirection === 1 ? 'ascending' : 'descending') : 'none');
  });
  $$('.filter-trigger').forEach(button => button.classList.toggle('active', activeFilters[button.dataset.filter] !== 'all' || (button.dataset.filter === 'modified' && (activeFilters.from || activeFilters.to))));
}

function initTableControls() {
  $$('.sort-button').forEach(button => button.onclick = () => {
    if (sortKey === button.dataset.sort) sortDirection *= -1;
    else { sortKey = button.dataset.sort; sortDirection = 1; }
    renderFileRows();
  });
  $$('.filter-trigger').forEach(button => button.onclick = event => {
    event.stopPropagation();
    openFilterMenu(button.dataset.filter, button);
  });
  document.addEventListener('click', event => {
    const menu = $('#filter-menu');
    if (!menu.contains(event.target) && !event.target.closest('.filter-trigger')) menu.classList.add('hidden');
  });
}

function openFilterMenu(key, trigger) {
  const menu = $('#filter-menu');
  const options = {
    name: [['all','Tất cả tên'],['ah','A – H'],['ip','I – P'],['qz','Q – Z'],['other','Ký tự khác']],
    size: [['all','Mọi kích thước'],['empty','0 B / thư mục'],['lt1k','Dưới 1 KB'],['1k100k','1 – 100 KB'],['100k1m','100 KB – 1 MB'],['1m100m','1 – 100 MB'],['gt100m','Từ 100 MB']],
    modified: [['all','Mọi thời điểm'],['today','Hôm nay'],['week','7 ngày gần đây'],['month','30 ngày gần đây'],['calendarMonth','Tháng này'],['calendarYear','Năm nay'],['older','Cũ hơn 30 ngày']]
  };
  if (key === 'mode') {
    const modes = [...new Set(listedFiles.map(file => String(file.mode)))].sort();
    options.mode = [['all','Mọi quyền'], ...modes.map(mode => [mode, mode])];
  }
  const entries = options[key] || [];
  menu.innerHTML = `<div class="filter-title">Lọc ${({name:'tên',size:'kích thước',mode:'quyền',modified:'ngày sửa đổi'})[key]}</div>${entries.map(([value,label]) => `<button type="button" class="filter-option ${activeFilters[key] === value ? 'selected' : ''}" data-value="${esc(value)}">${esc(label)}</button>`).join('')}${key === 'modified' ? `<div class="filter-dates"><label>Từ<input type="date" id="filter-from" value="${esc(activeFilters.from)}"></label><label>Đến<input type="date" id="filter-to" value="${esc(activeFilters.to)}"></label><button class="primary filter-apply" type="button">Áp dụng</button></div>` : ''}<button type="button" class="filter-reset">Xóa bộ lọc</button>`;
  const rect = trigger.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - 245))}px`;
  menu.style.top = `${rect.bottom + 5}px`;
  menu.classList.remove('hidden');
  $$('.filter-option', menu).forEach(button => button.onclick = () => {
    activeFilters[key] = button.dataset.value;
    if (key === 'modified') activeFilters.from = activeFilters.to = '';
    menu.classList.add('hidden'); renderFileRows();
  });
  $('.filter-apply', menu)?.addEventListener('click', () => {
    activeFilters.modified = 'all'; activeFilters.from = $('#filter-from').value; activeFilters.to = $('#filter-to').value;
    menu.classList.add('hidden'); renderFileRows();
  });
  $('.filter-reset', menu).onclick = () => {
    activeFilters[key] = 'all';
    if (key === 'modified') activeFilters.from = activeFilters.to = '';
    menu.classList.add('hidden'); renderFileRows();
  };
}

$('#search-form').onsubmit = async event => {
  event.preventDefault();
  $('#search-dates').open=false;
  updateSearchDateSummary();
  const params=new URLSearchParams({path:current,q:$('#search-query').value.trim(),type:$('#search-type').value});
  const min=$('#search-min-size').value,max=$('#search-max-size').value;
  if(min)params.set('min_size',String(Math.floor(Number(min)*1024)));
  if(max)params.set('max_size',String(Math.floor(Number(max)*1024)));
  if($('#search-after').value)params.set('after',$('#search-after').value);
  if($('#search-before').value)params.set('before',$('#search-before').value);
  try {
    const result=await api(`/api/search?${params}`);
    listedFiles=result.items;searchMode=true;searchTruncated=result.truncated;renderFileRows();
    toast(result.truncated?'Đã giới hạn kết quả ở 1.000 mục.':'Đã cập nhật kết quả tìm kiếm.');
  } catch(error) { toast(error.message,true); }
};
$('#clear-search').onclick = () => {
  $('#search-form').reset();
  $('#search-dates').open=false;
  updateSearchDateSummary();
  loadFiles(current);
};

function updateSearchDateSummary() {
  const shortDate=value=>value?value.slice(8,10)+'/'+value.slice(5,7):'';
  const from=shortDate($('#search-after').value),to=shortDate($('#search-before').value);
  const text=from&&to?`${from}–${to}`:from?`Từ ${from}`:to?`Đến ${to}`:'Ngày sửa đổi';
  $('#search-date-summary').textContent=`${text} ▾`;
}
['search-after','search-before'].forEach(id=>$('#'+id).addEventListener('change',updateSearchDateSummary));
document.addEventListener('click',event=>{
  const details=$('#search-dates');
  if(details.open&&!details.contains(event.target))details.open=false;
});

function formatBytes(value) {
  return value<1024?`${value} B`:value<1048576?`${(value/1024).toFixed(1)} KB`:value<1073741824?`${(value/1048576).toFixed(1)} MB`:`${(value/1073741824).toFixed(2)} GB`;
}

async function checkUploadCapacity(files) {
  const total=files.reduce((sum,file)=>sum+file.size,0);
  if(total>maxUploadClient)throw Error(`Tổng dữ liệu vượt giới hạn tải lên ${formatBytes(maxUploadClient)}.`);
  const data=await api(`/api/capacity?path=${encodeURIComponent(current)}`);
  if(total+data.reserve>data.free)throw Error(`Không đủ dung lượng. Còn ${formatBytes(data.free)}; cần ít nhất ${formatBytes(total+data.reserve)}.`);
}

function sendUpload(url, form, label) {
  return new Promise((resolve,reject)=>{
    const xhr=new XMLHttpRequest();activeTransfer=xhr;
    const started=performance.now();
    const progress=$('#transfer-progress');progress.classList.remove('hidden');
    $('#transfer-label').textContent=label;$('#transfer-bar').value=0;$('#transfer-percent').textContent='0%';$('#transfer-detail').textContent='Đang chuẩn bị';
    xhr.open('POST',url);xhr.setRequestHeader('X-CSRF-Token',csrf);
    xhr.upload.onprogress=event=>{
      if(!event.lengthComputable)return;
      armIdleTimer();
      const percent=Math.round(event.loaded/event.total*100);
      $('#transfer-bar').value=percent;$('#transfer-percent').textContent=`${percent}%`;
      $('#transfer-detail').textContent=`${formatBytes(event.loaded)} / ${formatBytes(event.total)}`;
      $('#transfer-speed').textContent=`${formatBytes(Math.round(event.loaded/Math.max((performance.now()-started)/1000,0.1)))} /s`;
    };
    xhr.onload=()=>{
      let data={};try{data=JSON.parse(xhr.responseText||'{}');}catch(_){}
      if(xhr.status>=200&&xhr.status<300)resolve(data);else reject(Error(data.error||`Lỗi tải lên ${xhr.status}`));
    };
    xhr.onerror=()=>reject(Error('Lỗi kết nối trong khi tải lên.'));
    xhr.onabort=()=>reject(Error('Đã hủy tải lên.'));
    xhr.onloadend=()=>{if(activeTransfer===xhr)activeTransfer=null;progress.classList.add('hidden');};
    xhr.send(form);
  });
}

async function uploadSelection(files, archive=false) {
  if(!files.length)return;
  try {
    await checkUploadCapacity(files);
    const form=new FormData();
    if(archive)form.append('archive',files[0]);
    else files.forEach(file=>form.append('files',file));
    const url=archive?`/api/upload-archive?path=${encodeURIComponent(current)}`:`/api/upload?path=${encodeURIComponent(current)}`;
    await sendUpload(url,form,archive?'Tải ZIP và giải nén':'Đang tải tệp lên');
    toast(archive?'Đã tải lên và giải nén ZIP':'Tải tệp lên thành công');await loadFiles(current);
  } catch(error) { toast(error.message,true); }
}

$('#upload').onchange=async event=>{await uploadSelection([...event.target.files]);event.target.value='';};
$('#archive-upload').onchange=async event=>{await uploadSelection([...event.target.files].slice(0,1),true);event.target.value='';};
$('#cancel-transfer').onclick=()=>activeTransfer?.abort();

function wireActions() {
  $('#new-folder').onclick = () => nameModal('Tạo thư mục', 'Tên thư mục mới', async name => {
    await api('/api/create', { method: 'POST', body: JSON.stringify({ path: current, name, type: 'directory' }) });
    toast('Đã tạo thư mục'); await loadFiles(current);
  });
  $('#new-file').onclick = () => nameModal('Tạo tệp', 'Tên tệp mới', async name => {
    await api('/api/create', { method: 'POST', body: JSON.stringify({ path: current, name, type: 'file' }) });
    toast('Đã tạo tệp'); await loadFiles(current);
  });
  $$('[data-copy]', $('#file-list')).forEach(button => button.onclick = () => setClipboard(button.dataset.copy, button.dataset.name, 'copy'));
  $$('[data-cut]', $('#file-list')).forEach(button => button.onclick = () => setClipboard(button.dataset.cut, button.dataset.name, 'cut'));
  $$('[data-rename]', $('#file-list')).forEach(button => button.onclick = () => nameModal('Đổi tên', 'Tên mới', async name => {
    await api('/api/rename', { method: 'POST', body: JSON.stringify({ path: button.dataset.rename, name }) });
    toast('Đã đổi tên'); await loadFiles(current);
  }, button.dataset.name));
  $$('[data-edit]', $('#file-list')).forEach(button => button.onclick = () => openTextEditor(button.dataset.edit));
  $$('[data-chmod]', $('#file-list')).forEach(button => button.onclick = () => {
    const row = button.closest('tr');
    const name = $('.file-name span:last-child', row).textContent;
    const mode = button.dataset.mode;
    permissionModal(`Tên: ${name}`, mode, async value => {
      await api('/api/chmod', { method: 'POST', body: JSON.stringify({ path: button.dataset.chmod, mode: value }) });
      toast('Đã cập nhật quyền'); await loadFiles(current);
    });
  });
  $$('[data-delete]', $('#file-list')).forEach(button => button.onclick = () => confirmModal('Xóa mục này?', 'Thao tác này sẽ xóa tệp hoặc toàn bộ nội dung thư mục.', async () => {
    await api('/api/delete', { method: 'POST', body: JSON.stringify({ path: button.dataset.delete }) });
    toast('Đã xóa'); await loadFiles(current);
  }));
}

function setClipboard(path, name, operation) {
  clipboardItem = { path, name, operation };
  updateClipboardUI();
  toast(operation === 'copy' ? `Đã sao chép: ${name}` : `Đã cắt: ${name}`);
}

function updateClipboardUI() {
  const status = $('#clipboard-status');
  const paste = $('#paste-here');
  const clear = $('#clear-clipboard');
  if (!status || !paste || !clear) return;
  const available = Boolean(clipboardItem && me?.role !== 'read');
  status.textContent = clipboardItem ? `${clipboardItem.operation === 'copy' ? 'Copy' : 'Cut'}: ${clipboardItem.name}` : 'Clipboard trống';
  paste.disabled = !available;
  clear.disabled = !clipboardItem;
  $$('.is-cut', $('#file-list')).forEach(row => row.classList.remove('is-cut'));
  if (clipboardItem?.operation === 'cut') {
    const row = $$('[data-open]', $('#file-list')).find(button => button.dataset.open === clipboardItem.path)?.closest('tr');
    row?.classList.add('is-cut');
  }
}

$('#paste-here').onclick = async () => {
  if (!clipboardItem) return;
  try {
    const result = await api('/api/transfer', { method: 'POST', body: JSON.stringify({ path: clipboardItem.path, destination: current, operation: clipboardItem.operation }) });
    toast(clipboardItem.operation === 'copy' ? 'Đã sao chép vào thư mục này' : 'Đã di chuyển vào thư mục này');
    if (clipboardItem.operation === 'cut') clipboardItem = null;
    await loadFiles(current);
  } catch (error) { toast(error.message, true); }
};
$('#clear-clipboard').onclick = () => { clipboardItem = null; updateClipboardUI(); };

function openModal(title, html, handler) {
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = html;
  $('#modal').showModal();
  const firstField = $('#modal-body input, #modal-body select, #modal-body textarea, #modal-body [contenteditable="true"]');
  (firstField || $('#modal-submit')).focus();
  $('#modal').onkeydown = event => {
    if (event.defaultPrevented) return;
    if (event.key !== 'Enter' || event.isComposing) return;
    if (event.target.closest('[contenteditable="true"]') && !(event.ctrlKey || event.metaKey)) return;
    if (event.target.matches('textarea') && !(event.ctrlKey || event.metaKey)) return;
    const button = event.target.closest('button');
    if (button && !button.matches('#modal-submit')) return;
    event.preventDefault();
    $('#modal-form').requestSubmit($('#modal-submit'));
  };
  $('#modal-form').onsubmit = async event => {
    event.preventDefault();
    if (event.submitter?.value === 'cancel') { $('#modal').close(); return; }
    try { await handler(new FormData(event.target)); $('#modal').close(); }
    catch (error) { toast(error.message, true); }
  };
}
async function openTextEditor(path) {
  try {
    const documentData = await api(`/api/edit?path=${encodeURIComponent(path)}`);
    const extension = documentData.name.split('.').pop().toLowerCase();
    let editorInput;
    openModal(`Sửa: ${documentData.name}`, `<div class="editor-toolbar"><p class="muted editor-note"><span class="editor-language"></span> · UTF-8 · tối đa ${formatBytes(documentData.max_bytes)} · Ctrl+Z/Y hoàn tác/làm lại <span class="editor-resize-hint">↘ Kéo góc dưới phải để đổi kích thước</span></p><div><button type="button" class="secondary editor-undo" disabled title="Hoàn tác (Ctrl+Z)">↶ Hoàn tác</button><button type="button" class="secondary editor-redo" disabled title="Làm lại (Ctrl+Y)">↷ Làm lại</button></div></div><div class="code-editor"><div class="line-number-clip" aria-hidden="true"><pre class="line-numbers"></pre></div><div class="code-pane"><pre class="text-editor code-highlight" contenteditable="true" role="textbox" aria-multiline="true" aria-label="Nội dung tệp" spellcheck="false" autocapitalize="off" tabindex="0"></pre></div></div>`, async () => {
      const result = await api('/api/edit', { method: 'POST', body: JSON.stringify({ path: documentData.path, content: editorInput.textContent, revision: documentData.revision }) });
      documentData.revision = result.revision;
      toast('Đã lưu nội dung tệp');
      await loadFiles(current);
    });
    editorInput = $('#modal-body .text-editor');
    setupCodeEditor($('#modal-body .code-editor'), documentData.content, extension);
  } catch (error) { toast(error.message, true); }
}
function nameModal(title, label, handler, initialValue = '') {
  openModal(title, `<label>${label}<input name="value" value="${esc(initialValue)}" required maxlength="240" autofocus></label>`, form => handler(form.get('value')));
  if (initialValue) $('#modal-body input')?.select();
}
function permissionModal(subject, initialMode, handler) {
  const choices=[['0','Không có quyền'],['4','Chỉ đọc'],['2','Chỉ ghi'],['1','Chỉ thực thi'],['6','Đọc + ghi'],['5','Đọc + thực thi'],['3','Ghi + thực thi'],['7','Đọc + ghi + thực thi']];
  const digits=String(initialMode).padStart(3,'0').slice(-3);
  const select=(label,name,value)=>`<label>${label}<select name="${name}" class="permission-select">${choices.map(([mode,text])=>`<option value="${mode}" ${mode===value?'selected':''}>${text}</option>`).join('')}</select></label>`;
  openModal('Đổi quyền truy cập', `<p class="muted">${esc(subject)}</p><div class="permission-grid">${select('Chủ sở hữu','owner',digits[0])}${select('Nhóm','group',digits[1])}${select('Người khác','other',digits[2])}</div><label class="octal-mode-label">Quyền số (bát phân)<input name="mode" value="${esc(digits)}" inputmode="numeric" pattern="[0-7]{3}" maxlength="3" required aria-describedby="chmod-help"></label><p id="chmod-help" class="muted chmod-help">Đọc = 4 · Ghi = 2 · Thực thi = 1. Ví dụ 640: chủ sở hữu đọc/ghi, nhóm chỉ đọc, người khác không có quyền.</p>`, async form=>handler(form.get('mode')));
  const body=$('#modal-body'), modeInput=$('[name="mode"]',body), selects=$$('.permission-select',body);
  const syncMode=()=>{modeInput.value=selects.map(item=>item.value).join('');};
  const syncSelects=()=>{if(/^[0-7]{3}$/.test(modeInput.value))selects.forEach((item,index)=>item.value=modeInput.value[index]);};
  selects.forEach(item=>item.addEventListener('change',syncMode));
  modeInput.addEventListener('input',syncSelects);
}
function confirmModal(title, description, handler) {
  openModal(title, `<p class="muted">${esc(description)}</p>`, () => handler());
}

async function loadDisk() {
  try {
    const data = await api('/api/disk');
    $('#disk-grid').innerHTML = data.partitions.map(partition => `<article class="disk-card"><div class="disk-head"><span class="disk-icon">◉</span><span><b>${esc(partition.mount)}</b><small>Phân vùng</small></span><b class="percent">${partition.percent}%</b></div><div class="progress"><i style="width:${Math.min(partition.percent, 100)}%"></i></div><div class="disk-stats"><span><b>${size(partition.used)}</b><small>Đã sử dụng</small></span><span><b>${size(partition.free)}</b><small>Còn trống</small></span><span><b>${size(partition.total)}</b><small>Tổng dung lượng</small></span></div>${partition.free<data.reserve?`<p class="capacity-warning">Dung lượng trống thấp hơn mức dự phòng ${size(data.reserve)}.</p>`:''}</article>`).join('') || '<p>Không đọc được thông tin phân vùng.</p>';
  } catch (error) { toast(error.message, true); }
}
$('#refresh-disk').onclick = loadDisk;

async function adminView() {
  showSection('admin-view');
  try {
    const [userData, auditData, sessionData] = await Promise.all([api('/api/users'), api('/api/audit'), api('/api/admin/sessions')]);
    $('#users-list').innerHTML = userData.users.map(user => `<div class="user-row"><span class="avatar small">${esc(user.username[0].toUpperCase())}</span><span><b>${esc(user.username)}</b><small>${roleName(user.role)}</small></span><button data-remove="${esc(user.username)}" title="Xóa người dùng">×</button></div>`).join('');
    $$('[data-remove]', $('#users-list')).forEach(button => button.onclick = () => confirmModal('Xóa người dùng?', `Tài khoản ${button.dataset.remove} sẽ bị thu hồi.`, async () => {
      await api(`/api/users/${encodeURIComponent(button.dataset.remove)}`, { method: 'DELETE' });
      toast('Đã xóa người dùng'); await adminView();
    }));
    $('#audit-list').innerHTML = auditData.events.map(event => `<div class="audit-row"><span class="audit-dot"></span><div><b>${esc(event.action)}</b><small>${esc(event.username)} · ${esc(event.path || '—')}</small><small>${new Date(event.at).toLocaleString('vi-VN')} · ${esc(event.ip)}</small></div></div>`).join('') || '<p class="muted">Chưa có sự kiện.</p>';
    $('#session-note').textContent=`Tự đăng xuất sau ${Math.round(idleTimeout/60)} phút không hoạt động.`;
    $('#sessions-list').innerHTML=sessionData.sessions.map(item=>`<div class="session-row"><div><b>${esc(item.username)}${item.current?' · Phiên này':''}</b><small>${esc(item.ip||'IP không rõ')} · hoạt động ${new Date(item.last_activity*1000).toLocaleString('vi-VN')}</small><small class="session-agent">${esc(item.user_agent||'Trình duyệt không rõ')}</small></div><button data-revoke-session="${esc(item.session_key)}" title="Thu hồi phiên" ${item.current?'disabled':''}>×</button></div>`).join('')||'<p class="muted">Không có phiên nào.</p>';
    $$('[data-revoke-session]').forEach(button=>button.onclick=()=>confirmModal('Thu hồi phiên đăng nhập?','Thiết bị này sẽ phải đăng nhập lại.',async()=>{
      await api('/api/admin/sessions/revoke',{method:'POST',body:JSON.stringify({session_key:button.dataset.revokeSession})});toast('Đã thu hồi phiên');await adminView();
    }));
  } catch (error) { toast(error.message, true); }
}

$('#restore-backup').onchange=event=>{
  const file=event.target.files[0];if(!file)return;
  confirmModal('Khôi phục tài khoản và nhật ký?',`Dữ liệu hiện tại sẽ được thay thế bằng bản sao lưu ${file.name}. Tệp quản lý và cấu hình môi trường không bị thay đổi.`,async()=>{
    const form=new FormData();form.append('backup',file);
    await api('/api/admin/restore',{method:'POST',body:form});toast('Đã khôi phục tài khoản và nhật ký');await adminView();
  });
  event.target.value='';
};

$('#add-user').onclick = () => openModal('Thêm người dùng', '<label>Tên đăng nhập<input name="username" minlength="3" required></label><label>Mật khẩu<input name="password" type="password" minlength="12" required></label><label>Vai trò<select name="role"><option value="read">Chỉ đọc</option><option value="write">Đọc & ghi</option><option value="admin">Quản trị</option></select></label>', async form => {
  await api('/api/users', { method: 'POST', body: JSON.stringify({ username: form.get('username'), password: form.get('password'), role: form.get('role') }) });
  toast('Đã tạo người dùng'); await adminView();
});

let columnResizingReady = false;
function initColumnResizing() {
  const table = $('#file-table');
  if (!table || columnResizingReady) return;
  const columns = $$('col', table);
  if (columns.length < 2) return;
  const wrapper = $('.table-wrap');
  const minimums = [150, 100, 90, 150, 160];
  const storageKey = 'filescope-file-table-columns-v3';
  const defaults = [46, 10, 10, 19, 15];
  let widths = [];
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || 'null');
    if (Array.isArray(saved) && saved.length === columns.length && saved.every((width, index) => Number.isFinite(width) && width >= minimums[index])) widths = saved;
  } catch (_) { /* Ignore invalid or unavailable local storage. */ }
  const initialWidth = Math.max(650, wrapper.clientWidth || 900);
  if (!widths.length) {
    const mins = minimums.reduce((sum, width) => sum + width, 0);
    const extra = Math.max(0, initialWidth - mins);
    const weights = defaults.map((percent, index) => Math.max(0, initialWidth * percent / 100 - minimums[index]));
    const weightTotal = weights.reduce((sum, width) => sum + width, 0) || 1;
    widths = minimums.map((min, index) => min + extra * weights[index] / weightTotal);
  }
  const save = () => {
    try { localStorage.setItem(storageKey, JSON.stringify(widths)); }
    catch (_) { /* Column resizing still works if preferences cannot be saved. */ }
  };
  const applyWidths = () => {
    widths.forEach((width, index) => columns[index].style.width = `${Math.round(width)}px`);
    const sum = widths.reduce((total, width) => total + width, 0);
    table.style.width = `${Math.max(wrapper.clientWidth, sum)}px`;
  };
  const resizeBy = (index, delta) => {
    widths[index] = Math.max(minimums[index], widths[index] + delta);
    applyWidths();
    save();
  };
  applyWidths();
  $$('.column-resizer', table).forEach((handle, index) => {
    handle.onpointerdown = event => {
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = widths[index];
      document.body.classList.add('resizing-columns');
      try { handle.setPointerCapture(event.pointerId); } catch (_) { /* Document listeners also support browsers without pointer capture. */ }
      const move = moveEvent => {
        widths[index] = Math.max(minimums[index], startWidth + moveEvent.clientX - startX);
        applyWidths();
      };
      const finish = () => {
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', finish);
        document.removeEventListener('pointercancel', finish);
        document.body.classList.remove('resizing-columns');
        save();
      };
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', finish, { once: true });
      document.addEventListener('pointercancel', finish, { once: true });
    };
    handle.onkeydown = event => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      resizeBy(index, (event.key === 'ArrowRight' ? 1 : -1) * Math.max(8, table.clientWidth * 0.01));
    };
  });
  window.addEventListener('resize', applyWidths);
  columnResizingReady = true;
}

initTableControls();
boot();
