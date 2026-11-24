const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
let me = null, csrf = '', current = '';
let folderHistory = [], historyIndex = -1;
let clipboardItem = null;
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
  try { await api('/api/logout', { method: 'POST', body: '{}' }); }
  finally { me = null; csrf = ''; document.body.removeAttribute('data-role'); showLogin(); }
};

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
    if (recordHistory) rememberFolder(path);
    $('#folder-title').textContent = path.split('/').pop() || 'Tất cả tệp';
    $('#breadcrumb').innerHTML = '<button data-path="">Home</button>' + path.split('/').filter(Boolean).map((part, index, parts) =>
      `<span>/</span><button data-path="${esc(parts.slice(0, index + 1).join('/'))}">${esc(part)}</button>`).join('');
    $$('[data-path]', $('#breadcrumb')).forEach(button => button.onclick = () => loadFiles(button.dataset.path));
    $('#item-count').textContent = `${data.items.length} mục`;
    $('#file-list').innerHTML = data.items.map(file => `<tr>
      <td><button class="file-name" data-open="${esc(file.path)}"><span class="file-icon ${file.type}">${file.type === 'directory' ? '▰' : '▤'}</span><span>${esc(file.name)}</span></button></td>
      <td>${file.type === 'directory' ? '—' : size(file.size)}</td><td><code>${esc(file.mode)}</code></td>
      <td>${new Date(file.modified).toLocaleString('vi-VN', { dateStyle: 'medium', timeStyle: 'short' })}</td>
      <td><div class="row-actions"><button title="Sao chép" aria-label="Sao chép ${esc(file.name)}" data-copy="${esc(file.path)}" data-name="${esc(file.name)}">⧉</button><button title="Cắt" aria-label="Cắt ${esc(file.name)}" data-cut="${esc(file.path)}" data-name="${esc(file.name)}">✂</button><button title="Đổi tên" data-rename="${esc(file.path)}" data-name="${esc(file.name)}">✎</button><button title="Đổi quyền" data-chmod="${esc(file.path)}" data-mode="${esc(file.mode_octal)}">⌘</button><a title="Tải xuống" href="/api/download?path=${encodeURIComponent(file.path)}">↓</a><button title="Xóa" data-delete="${esc(file.path)}">×</button></div></td>
    </tr>`).join('');
    $('#empty').classList.toggle('hidden', data.items.length > 0);
    $$('[data-open]', $('#file-list')).forEach(button => button.onclick = () => {
      const file = data.items.find(item => item.path === button.dataset.open);
      if (file?.type === 'directory') loadFiles(file.path);
    });
    if (me.role !== 'read') wireActions();
    updateClipboardUI();
    await loadTree();
    return true;
  } catch (error) {
    toast(error.message, true);
    return false;
  }
}

function wireActions() {
  $('#new-folder').onclick = () => nameModal('Tạo thư mục', 'Tên thư mục mới', async name => {
    await api('/api/create', { method: 'POST', body: JSON.stringify({ path: current, name, type: 'directory' }) });
    toast('Đã tạo thư mục'); await loadFiles(current);
  });
  $('#new-file').onclick = () => nameModal('Tạo tệp', 'Tên tệp mới', async name => {
    await api('/api/create', { method: 'POST', body: JSON.stringify({ path: current, name, type: 'file' }) });
    toast('Đã tạo tệp'); await loadFiles(current);
  });
  $('#upload').onchange = async event => {
    if (!event.target.files.length) return;
    const form = new FormData();
    form.append('path', current);
    [...event.target.files].forEach(file => form.append('files', file));
    try { await api('/api/upload', { method: 'POST', body: form }); toast('Tải tệp lên thành công'); await loadFiles(current); }
    catch (error) { toast(error.message, true); }
    event.target.value = '';
  };
  $$('[data-copy]', $('#file-list')).forEach(button => button.onclick = () => setClipboard(button.dataset.copy, button.dataset.name, 'copy'));
  $$('[data-cut]', $('#file-list')).forEach(button => button.onclick = () => setClipboard(button.dataset.cut, button.dataset.name, 'cut'));
  $$('[data-rename]', $('#file-list')).forEach(button => button.onclick = () => nameModal('Đổi tên', 'Tên mới', async name => {
    await api('/api/rename', { method: 'POST', body: JSON.stringify({ path: button.dataset.rename, name }) });
    toast('Đã đổi tên'); await loadFiles(current);
  }, button.dataset.name));
  $$('[data-chmod]', $('#file-list')).forEach(button => button.onclick = () => {
    const row = button.closest('tr');
    const name = $('.file-name span:last-child', row).textContent;
    const mode = button.dataset.mode;
    inputModal('Đổi quyền truy cập', `Tên: ${name}`, mode, 'Nhập ba chữ số bát phân, ví dụ 640', async value => {
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
  $('#modal').onkeydown = event => {
    if (event.key !== 'Enter' || event.isComposing || event.target.closest('button')) return;
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
function nameModal(title, label, handler, initialValue = '') {
  openModal(title, `<label>${label}<input name="value" value="${esc(initialValue)}" required maxlength="240" autofocus></label>`, form => handler(form.get('value')));
  if (initialValue) $('#modal-body input')?.select();
}
function inputModal(title, subject, value, hint, handler) {
  openModal(title, `<p class="muted">${esc(subject)} · ${esc(hint)}</p><label>Quyền mới<input name="value" value="${esc(value)}" pattern="[0-7]{3}" required autofocus></label>`, form => handler(form.get('value')));
  $('#modal-body input')?.select();
}
function confirmModal(title, description, handler) {
  openModal(title, `<p class="muted">${esc(description)}</p>`, () => handler());
}

async function loadDisk() {
  try {
    const data = await api('/api/disk');
    $('#disk-grid').innerHTML = data.partitions.map(partition => `<article class="disk-card"><div class="disk-head"><span class="disk-icon">◉</span><span><b>${esc(partition.mount)}</b><small>Phân vùng</small></span><b class="percent">${partition.percent}%</b></div><div class="progress"><i style="width:${Math.min(partition.percent, 100)}%"></i></div><div class="disk-stats"><span><b>${size(partition.used)}</b><small>Đã sử dụng</small></span><span><b>${size(partition.free)}</b><small>Còn trống</small></span><span><b>${size(partition.total)}</b><small>Tổng dung lượng</small></span></div></article>`).join('') || '<p>Không đọc được thông tin phân vùng.</p>';
  } catch (error) { toast(error.message, true); }
}
$('#refresh-disk').onclick = loadDisk;

async function adminView() {
  showSection('admin-view');
  try {
    const [userData, auditData] = await Promise.all([api('/api/users'), api('/api/audit')]);
    $('#users-list').innerHTML = userData.users.map(user => `<div class="user-row"><span class="avatar small">${esc(user.username[0].toUpperCase())}</span><span><b>${esc(user.username)}</b><small>${roleName(user.role)}</small></span><button data-remove="${esc(user.username)}" title="Xóa người dùng">×</button></div>`).join('');
    $$('[data-remove]', $('#users-list')).forEach(button => button.onclick = () => confirmModal('Xóa người dùng?', `Tài khoản ${button.dataset.remove} sẽ bị thu hồi.`, async () => {
      await api(`/api/users/${encodeURIComponent(button.dataset.remove)}`, { method: 'DELETE' });
      toast('Đã xóa người dùng'); await adminView();
    }));
    $('#audit-list').innerHTML = auditData.events.map(event => `<div class="audit-row"><span class="audit-dot"></span><div><b>${esc(event.action)}</b><small>${esc(event.username)} · ${esc(event.path || '—')}</small><small>${new Date(event.at).toLocaleString('vi-VN')} · ${esc(event.ip)}</small></div></div>`).join('') || '<p class="muted">Chưa có sự kiện.</p>';
  } catch (error) { toast(error.message, true); }
}

$('#add-user').onclick = () => openModal('Thêm người dùng', '<label>Tên đăng nhập<input name="username" minlength="3" required></label><label>Mật khẩu<input name="password" type="password" minlength="12" required></label><label>Vai trò<select name="role"><option value="read">Chỉ đọc</option><option value="write">Đọc & ghi</option><option value="admin">Quản trị</option></select></label>', async form => {
  await api('/api/users', { method: 'POST', body: JSON.stringify({ username: form.get('username'), password: form.get('password'), role: form.get('role') }) });
  toast('Đã tạo người dùng'); await adminView();
});

boot();
