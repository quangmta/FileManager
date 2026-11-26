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

