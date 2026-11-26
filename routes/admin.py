"""Admin API routes."""
import app as core
from app import *

@app.get('/api/audit')
@require('admin')
def audit_list():
    with dbconn() as d:rows=d.execute('SELECT at,username,action,path,detail,ip FROM audit ORDER BY id DESC LIMIT 500').fetchall()
    return jsonify(events=[dict(x) for x in rows])

@app.get('/api/admin/sessions')
@require('admin')
def active_sessions():
    with dbconn() as d:
        d.execute('DELETE FROM sessions WHERE last_activity<?',(time.time()-MAX_SESSION_IDLE,))
        rows=d.execute('SELECT session_key,username,created_at,last_activity,ip,user_agent FROM sessions ORDER BY last_activity DESC').fetchall()
    return jsonify(sessions=[{**dict(row),'current':row['session_key']==session.get('session_key')} for row in rows])

@app.post('/api/admin/sessions/revoke')
@require('admin')
@csrf
def revoke_session():
    data=request.get_json(silent=True) or {};key=data.get('session_key')
    if not isinstance(key,str) or not key:abort(400,'Phiên đăng nhập không hợp lệ')
    with dbconn() as d:
        row=d.execute('SELECT username FROM sessions WHERE session_key=?',(key,)).fetchone()
        if not row:abort(404,'Không tìm thấy phiên đăng nhập')
        d.execute('DELETE FROM sessions WHERE session_key=?',(key,))
    audit('session_revoke',row['username'])
    if key==session.get('session_key'):session.clear()
    return jsonify(ok=True)

@app.get('/api/admin/backup')
@require('admin')
def backup_configuration():
    with dbconn() as d:
        user_rows=d.execute('SELECT username,password_hash,role,created_at FROM users ORDER BY username').fetchall()
        audit_count=d.execute('SELECT COUNT(*) FROM audit').fetchone()[0]
        audit_rows=d.execute('SELECT at,username,action,path,detail,ip FROM audit ORDER BY id DESC LIMIT 100000').fetchall()
    payload={'format':'filescope-backup-v1','created_at':datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'settings':{'root':str(core.ROOT),'max_upload':MAX_UPLOAD,'max_extracted':MAX_EXTRACTED},
        'audit_truncated':audit_count>len(audit_rows),'users':[dict(row) for row in user_rows],
        'audit':[dict(row) for row in reversed(audit_rows)]}
    content=json.dumps(payload,ensure_ascii=False,separators=(',',':')).encode('utf-8')
    if len(content)>MAX_BACKUP:abort(413,f'Bản sao lưu vượt giới hạn {MAX_BACKUP} byte')
    audit('backup_export',detail=f'users={len(user_rows)}; events={len(audit_rows)}')
    return send_file(io.BytesIO(content),mimetype='application/json',as_attachment=True,download_name=f'filescope-backup-{datetime.now().strftime("%Y%m%d-%H%M%S")}.json')

@app.post('/api/admin/restore')
@require('admin')
@csrf
def restore_configuration():
    if request.content_length and request.content_length>MAX_BACKUP+1024*1024:abort(413,'Tệp sao lưu quá lớn')
    uploaded=request.files.get('backup')
    if not uploaded:abort(400,'Chưa chọn tệp sao lưu')
    raw=uploaded.stream.read(MAX_BACKUP+1)
    if len(raw)>MAX_BACKUP:abort(413,'Tệp sao lưu vượt giới hạn')
    try:payload=json.loads(raw.decode('utf-8'))
    except (UnicodeDecodeError,json.JSONDecodeError):abort(400,'Tệp sao lưu JSON không hợp lệ')
    if not isinstance(payload,dict) or payload.get('format')!='filescope-backup-v1':abort(400,'Không đúng định dạng bản sao lưu FileScope')
    users=payload.get('users');events=payload.get('audit')
    if not isinstance(users,list) or not isinstance(events,list) or len(users)>10000 or len(events)>100000:abort(400,'Dữ liệu sao lưu vượt giới hạn')
    clean_users=[];seen=set()
    for user in users:
        if not isinstance(user,dict):abort(400,'Danh sách người dùng trong bản sao lưu không hợp lệ')
        name=user.get('username');password_hash=user.get('password_hash');role=user.get('role');created=user.get('created_at')
        if not isinstance(name,str) or len(name)<3 or len(name)>64 or not name.replace('_','').replace('-','').isalnum() or name in seen:abort(400,'Tên người dùng trong bản sao lưu không hợp lệ')
        if not isinstance(password_hash,str) or not password_hash or len(password_hash)>1000 or role not in ROLES or not isinstance(created,str):abort(400,'Thông tin tài khoản trong bản sao lưu không hợp lệ')
        seen.add(name);clean_users.append((name,password_hash,role,created))
    actor=session.get('username')
    if not any(role=='admin' for _,_,role,_ in clean_users) or not any(name==actor and role=='admin' for name,_,role,_ in clean_users):abort(400,'Bản sao lưu phải có quản trị viên hiện tại để tiếp tục khôi phục')
    clean_events=[]
    for event in events:
        if not isinstance(event,dict) or any(not isinstance(event.get(key),str) for key in ('at','username','action','path','detail','ip')):abort(400,'Nhật ký trong bản sao lưu không hợp lệ')
        clean_events.append(tuple(event[key][:limit] for key,limit in (('at',64),('username',64),('action',100),('path',2048),('detail',500),('ip',128))))
    try:
        with dbconn() as d:
            d.execute('DELETE FROM audit');d.execute('DELETE FROM users')
            d.executemany('INSERT INTO users(username,password_hash,role,created_at) VALUES(?,?,?,?)',clean_users)
            d.executemany('INSERT INTO audit(at,username,action,path,detail,ip) VALUES(?,?,?,?,?,?)',clean_events)
            d.execute('DELETE FROM sessions WHERE session_key<>?',(session.get('session_key'),))
    except sqlite3.Error:abort(400,'Không thể khôi phục dữ liệu; database hiện tại không đổi')
    audit('backup_restore',detail=f'users={len(clean_users)}; events={len(clean_events)}')
    return jsonify(ok=True,users=len(clean_users),events=len(clean_events))
@app.get('/api/users')
@require('admin')
def users():
    with dbconn() as d:rows=d.execute('SELECT username,role,created_at FROM users ORDER BY username').fetchall()
    return jsonify(users=[dict(x) for x in rows])
@app.post('/api/users')
@require('admin')
@csrf
def add_user():
    d=request.get_json(silent=True) or {};name=str(d.get('username','')).strip();pw=str(d.get('password',''));role=d.get('role')
    if len(name)<3 or len(name)>64 or not name.replace('_','').replace('-','').isalnum():abort(400,'Tên đăng nhập cần 3–64 ký tự chữ, số, _ hoặc -')
    if len(pw)<3:abort(400,'Mật khẩu cần ít nhất 3 ký tự')
    if role not in ROLES:abort(400,'Vai trò không hợp lệ')
    try:
        with dbconn() as c:c.execute('INSERT INTO users(username,password_hash,role,created_at) VALUES(?,?,?,?)',(name,generate_password_hash(pw),role,datetime.now(timezone.utc).isoformat(timespec='seconds')))
    except sqlite3.IntegrityError:abort(409,'Tên đăng nhập đã tồn tại')
    audit('user_create',name,f'role={role}');return jsonify(ok=True),201
@app.delete('/api/users/<username>')
@require('admin')
@csrf
def remove_user(username):
    if username==session.get('username'):abort(400,'Không thể xóa tài khoản đang đăng nhập')
    with dbconn() as d:
        cur=d.execute('DELETE FROM users WHERE username=?',(username,))
        if cur.rowcount==0:abort(404,'Không tìm thấy người dùng')
        if d.execute("SELECT COUNT(*) FROM users WHERE role='admin'").fetchone()[0]==0:abort(400,'Hệ thống phải còn ít nhất một quản trị viên')
    audit('user_delete',username);return jsonify(ok=True)
