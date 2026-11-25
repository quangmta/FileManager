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
  ['files-view', 'disk-view', 'admin-view'].forEach(section => $(`#${section}`).classList.toggle('hidden', section !== id));
  $$('.nav').forEach(button => button.classList.remove('active'));
  const navId = { 'files-view': 'home-nav', 'disk-view': 'disk-nav', 'admin-view': 'admin-nav' }[id];
  if (navId) $(`#${navId}`)?.classList.add('active');
}

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
    openModal(`Sửa: ${documentData.name}`, `<div class="editor-toolbar"><p class="muted editor-note"><span class="editor-language"></span> · UTF-8 · tối đa ${formatBytes(documentData.max_bytes)} · Ctrl+Z/Y hoàn tác/làm lại</p><div><button type="button" class="secondary editor-undo" disabled title="Hoàn tác (Ctrl+Z)">↶ Hoàn tác</button><button type="button" class="secondary editor-redo" disabled title="Làm lại (Ctrl+Y)">↷ Làm lại</button></div></div><div class="code-editor"><div class="line-number-clip" aria-hidden="true"><pre class="line-numbers"></pre></div><div class="code-pane"><pre class="text-editor code-highlight" contenteditable="true" role="textbox" aria-multiline="true" aria-label="Nội dung tệp" spellcheck="false" autocapitalize="off" tabindex="0"></pre></div></div>`, async () => {
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
