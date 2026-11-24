#!/usr/bin/env python3
"""Root-confined Linux web file manager."""
import argparse, os, secrets, shutil, sqlite3, stat, time
from datetime import datetime, timezone
from functools import wraps
from pathlib import Path
from flask import Flask, abort, jsonify, request, send_file, session
from werkzeug.security import check_password_hash, generate_password_hash
from werkzeug.exceptions import HTTPException

BASE=Path(__file__).resolve().parent
DB=Path(os.environ.get('FILEMANAGER_DB',BASE/'.filescope/filemanager.sqlite3'))
ROOT=Path(os.environ.get('FILEMANAGER_ROOT',BASE)).expanduser().resolve()
MAX_UPLOAD=int(os.environ.get('FILEMANAGER_MAX_UPLOAD',str(1024**3)))
app=Flask(__name__,static_folder='static',static_url_path='/static')
app.secret_key=os.environ.get('FILEMANAGER_SECRET','')
app.config.update(MAX_CONTENT_LENGTH=MAX_UPLOAD+1024*1024,SESSION_COOKIE_HTTPONLY=True,SESSION_COOKIE_SAMESITE='Lax',SESSION_COOKIE_SECURE=os.environ.get('FILEMANAGER_HTTPS')=='1')
ROLES={'read':1,'write':2,'admin':3}

def dbconn():
    DB.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    if DB == BASE/'.filescope/filemanager.sqlite3':os.chmod(DB.parent,0o700)
    db=sqlite3.connect(DB,timeout=15); db.row_factory=sqlite3.Row
    if DB.exists():os.chmod(DB,0o600)
    return db
def initdb():
    with dbconn() as d:
        d.executescript('''CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY,username TEXT UNIQUE NOT NULL,password_hash TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('read','write','admin')),created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY,at TEXT NOT NULL,username TEXT NOT NULL,action TEXT NOT NULL,path TEXT NOT NULL,detail TEXT NOT NULL,ip TEXT NOT NULL);''')
def audit(action,path='',detail=''):
    with dbconn() as d: d.execute('INSERT INTO audit(at,username,action,path,detail,ip) VALUES(?,?,?,?,?,?)',(datetime.now(timezone.utc).isoformat(timespec='seconds'),session.get('username','system'),action,path,str(detail)[:500],request.remote_addr or ''))
def require(level='read'):
    def deco(fn):
        @wraps(fn)
        def wrapped(*a,**kw):
            name=session.get('username')
            if not name:return jsonify(error='Vui lòng đăng nhập.'),401
            with dbconn() as d:user=d.execute('SELECT role FROM users WHERE username=?',(name,)).fetchone()
            if not user:session.clear();return jsonify(error='Phiên đăng nhập không hợp lệ.'),401
            if ROLES[user['role']]<ROLES[level]:return jsonify(error='Bạn không có quyền thực hiện thao tác này.'),403
            return fn(*a,**kw)
        return wrapped
    return deco
def csrf(fn):
    @wraps(fn)
    def wrapped(*a,**kw):
        if request.headers.get('X-CSRF-Token')!=session.get('csrf'):return jsonify(error='CSRF token không hợp lệ.'),403
        return fn(*a,**kw)
    return wrapped
def resolve(rel='',must_exist=True):
    if not isinstance(rel,str) or '\0' in rel or rel.startswith(('/','\\')):abort(400,'Đường dẫn không hợp lệ')
    parts=Path(rel).parts
    if any(x in ('..','') for x in parts):abort(400,'Đường dẫn không hợp lệ')
    p=ROOT.joinpath(*parts)
    try:
        q=p.resolve(strict=must_exist);q.relative_to(ROOT)
        try:q.relative_to(DB.parent.resolve())
        except ValueError:pass
        else:abort(400,'Đường dẫn hệ thống không được phép truy cập')
        cur=ROOT
        for part in parts:
            cur=cur/part
            if cur.is_symlink():abort(400,'Không hỗ trợ truy cập qua symbolic link')
        return q
    except (ValueError,FileNotFoundError,RuntimeError):abort(404 if must_exist else 400,'Đường dẫn không tồn tại hoặc ngoài thư mục quản lý')
def rel(p):return p.relative_to(ROOT).as_posix()
def item(p):
    s=p.lstat();return {'name':p.name,'path':rel(p),'type':'directory' if stat.S_ISDIR(s.st_mode) else 'file','size':s.st_size if stat.S_ISREG(s.st_mode) else 0,'mode':stat.filemode(s.st_mode),'mode_octal':format(stat.S_IMODE(s.st_mode),'03o'),'modified':datetime.fromtimestamp(s.st_mtime,timezone.utc).astimezone().isoformat(timespec='minutes')}
@app.after_request
def headers(r):
    r.headers['X-Content-Type-Options']='nosniff';r.headers['X-Frame-Options']='DENY';r.headers['Referrer-Policy']='same-origin';r.headers['Content-Security-Policy']="default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:";r.headers['Cache-Control']='no-store' if request.path.startswith('/api') else 'no-cache';return r
@app.errorhandler(413)
def too_big(_):return jsonify(error=f'Tệp vượt giới hạn {MAX_UPLOAD//(1024*1024)} MB.'),413
@app.errorhandler(HTTPException)
def api_http_error(error):
    if request.path.startswith('/api/'):return jsonify(error=error.description),error.code
    return error
@app.get('/')
def index():return app.send_static_file('index.html')
@app.get('/api/session')
def session_info():
    if not session.get('username'):return jsonify(authenticated=False)
    with dbconn() as d:u=d.execute('SELECT username,role FROM users WHERE username=?',(session['username'],)).fetchone()
    if not u:session.clear();return jsonify(authenticated=False)
    return jsonify(authenticated=True,username=u['username'],role=u['role'],csrf=session['csrf'],root=str(ROOT))
@app.post('/api/login')
def login():
    x=request.get_json(silent=True) or {}
    with dbconn() as d:u=d.execute('SELECT * FROM users WHERE username=?',(str(x.get('username','')),)).fetchone()
    if not u or not check_password_hash(u['password_hash'],str(x.get('password',''))):
        time.sleep(.25);audit('login_failed',detail='Sai thông tin đăng nhập');return jsonify(error='Tên đăng nhập hoặc mật khẩu không đúng.'),401
    session.clear();session['username']=u['username'];session['csrf']=secrets.token_urlsafe(32);audit('login',detail='Đăng nhập thành công')
    return jsonify(authenticated=True,username=u['username'],role=u['role'],csrf=session['csrf'],root=str(ROOT))
@app.post('/api/logout')
@require()
@csrf
def logout():audit('logout');session.clear();return jsonify(ok=True)
@app.get('/api/list')
@require()
def listing():
    path=request.args.get('path','');p=resolve(path)
    if not p.is_dir():abort(400,'Đường dẫn không phải thư mục')
    data=[item(x) for x in p.iterdir() if not x.is_symlink() and not x.resolve().is_relative_to(DB.parent.resolve())];data.sort(key=lambda x:(x['type']!='directory',x['name'].casefold()));return jsonify(path=path,items=data)
@app.get('/api/tree')
@require()
def tree():
    def walk(p,n=0):
        if n>=4:return []
        try:children=sorted((x for x in p.iterdir() if x.is_dir() and not x.is_symlink() and not x.resolve().is_relative_to(DB.parent.resolve())),key=lambda x:x.name.casefold())
        except OSError:return []
        return [{'name':x.name,'path':rel(x),'children':walk(x,n+1)} for x in children[:500]]
    return jsonify(root=str(ROOT),children=walk(ROOT))
@app.get('/api/disk')
@require()
def disk():
    data=[];seen=set()
    try:
        with open('/proc/mounts',encoding='utf8') as mounts_file:mounts=[line.split()[1] for line in mounts_file if len(line.split())>=2]
    except OSError:mounts=[]
    for m in mounts:
        try:
            u=shutil.disk_usage(m);key=(os.stat(m).st_dev,u.total)
            if key in seen:continue
            seen.add(key);data.append({'mount':m,'total':u.total,'used':u.used,'free':u.free,'percent':round(u.used/u.total*100,1) if u.total else 0})
        except OSError:pass
    return jsonify(partitions=data)
@app.get('/api/download')
@require()
def download():
    p=resolve(request.args.get('path',''))
    if not p.is_file():abort(400,'Chỉ tải xuống tệp thường')
    audit('download',rel(p))
    return send_file(p,as_attachment=True,download_name=p.name,conditional=True)
def bodypath():
    d=request.get_json(silent=True) or {};p=d.get('path','')
    if not isinstance(p,str):abort(400,'Đường dẫn không hợp lệ')
    return p,d
@app.post('/api/create')
@require('write')
@csrf
def create():
    p,d=bodypath();n=d.get('name','')
    if not isinstance(n,str) or n in ('','.','..') or '/' in n or '\\' in n or '\0' in n:abort(400,'Tên không hợp lệ')
    resolve(p);target=resolve((p+'/' if p else '')+n,False)
    if target.exists():abort(409,'Tệp hoặc thư mục đã tồn tại')
    if d.get('type')=='directory':target.mkdir()
    else:target.touch(exist_ok=False)
    audit('create_directory' if target.is_dir() else 'create_file',rel(target));return jsonify(item=item(target))
@app.post('/api/rename')
@require('write')
@csrf
def rename():
    p,d=bodypath();src=resolve(p);n=d.get('name','')
    if not isinstance(n,str) or n in ('','.','..') or '/' in n or '\\' in n:abort(400,'Tên không hợp lệ')
    parent=Path(p).parent.as_posix();dst=resolve((parent+'/' if parent!='.' else '')+n,False)
    if dst.exists():abort(409,'Tên đích đã tồn tại')
    src.rename(dst);audit('rename',rel(dst),f'from={p}');return jsonify(item=item(dst))
@app.post('/api/delete')
@require('write')
@csrf
def delete():
    p,_=bodypath()
    if not p:abort(400,'Không thể xóa thư mục gốc')
    target=resolve(p)
    if target.is_dir():shutil.rmtree(target)
    else:target.unlink()
    audit('delete',p);return jsonify(ok=True)
@app.post('/api/chmod')
@require('write')
@csrf
def chmod():
    p,d=bodypath();target=resolve(p);mode=d.get('mode','')
    if not isinstance(mode,str) or len(mode)!=3 or any(c not in '01234567' for c in mode):abort(400,'Quyền cần ba chữ số bát phân, ví dụ 644')
    os.chmod(target,int(mode,8));audit('chmod',p,mode);return jsonify(item=item(target))
@app.post('/api/transfer')
@require('write')
@csrf
def transfer():
    data=request.get_json(silent=True) or {}
    source_rel=data.get('path','');destination_rel=data.get('destination','');operation=data.get('operation')
    if operation not in ('copy','cut'):abort(400,'Thao tác cần là copy hoặc cut')
    if not isinstance(source_rel,str) or not source_rel:abort(400,'Không thể sao chép hoặc di chuyển thư mục gốc')
    if not isinstance(destination_rel,str):abort(400,'Thư mục đích không hợp lệ')
    source=resolve(source_rel);destination=resolve(destination_rel)
    if not destination.is_dir():abort(400,'Nơi dán phải là một thư mục')
    if not (source.is_file() or source.is_dir()):abort(400,'Chỉ hỗ trợ tệp thường và thư mục')
    if source.is_dir() and destination.is_relative_to(source):abort(400,'Không thể dán thư mục vào chính nó hoặc thư mục con')
    try:DB.parent.resolve().relative_to(source.resolve())
    except ValueError:pass
    else:abort(400,'Không thể sao chép hoặc di chuyển thư mục dữ liệu hệ thống')
    if source.is_dir():
        def reject_links_or_special(error):raise error
        for current_dir,dirs,files in os.walk(source,followlinks=False,onerror=reject_links_or_special):
            for name in dirs+files:
                candidate=Path(current_dir)/name
                mode=candidate.lstat().st_mode
                if stat.S_ISLNK(mode):abort(400,'Không thể sao chép thư mục có symbolic link')
                if name in dirs and not stat.S_ISDIR(mode):abort(400,'Thư mục nguồn chứa mục không hợp lệ')
                if name in files and not stat.S_ISREG(mode):abort(400,'Chỉ hỗ trợ tệp thường và thư mục')
    target_rel=(destination_rel+'/' if destination_rel else '')+source.name
    target=resolve(target_rel,must_exist=False)
    if target.exists():abort(409,'Nơi dán đã có mục cùng tên; hãy đổi tên hoặc chọn thư mục khác')
    if operation=='copy':
        if source.is_dir():shutil.copytree(source,target,copy_function=shutil.copy2)
        else:shutil.copy2(source,target)
        action='copy'
    else:
        shutil.move(str(source),str(target))
        action='cut'
    audit(action,source_rel,f'to={rel(target)}')
    return jsonify(item=item(target),destination=rel(target))
@app.post('/api/upload')
@require('write')
@csrf
def upload():
    p=request.form.get('path','');folder=resolve(p)
    if not folder.is_dir():abort(400,'Thư mục tải lên không hợp lệ')
    files=request.files.getlist('files')
    if not files:abort(400,'Chưa chọn tệp')
    out=[]
    for f in files:
        n=Path(f.filename or '').name
        if not n or n in ('.','..') or '\0' in n:abort(400,'Tên tệp không hợp lệ')
        target=resolve((p+'/' if p else '')+n,False)
        if target.exists():abort(409,f'Tệp {n} đã tồn tại')
        f.save(target);os.chmod(target,0o640);out.append(item(target));audit('upload',rel(target),f'bytes={target.stat().st_size}')
    return jsonify(items=out)
@app.get('/api/audit')
@require('admin')
def audit_list():
    with dbconn() as d:rows=d.execute('SELECT at,username,action,path,detail,ip FROM audit ORDER BY id DESC LIMIT 500').fetchall()
    return jsonify(events=[dict(x) for x in rows])
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
    if len(pw)<12:abort(400,'Mật khẩu cần ít nhất 12 ký tự')
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
def main():
    parser=argparse.ArgumentParser();sub=parser.add_subparsers(dest='cmd',required=True)
    cr=sub.add_parser('create-admin');cr.add_argument('username');cr.add_argument('--password')
    sv=sub.add_parser('serve');sv.add_argument('--host',default='127.0.0.1');sv.add_argument('--port',type=int,default=8080);sv.add_argument('--cert');sv.add_argument('--key')
    a=parser.parse_args();initdb()
    if a.cmd=='create-admin':
        pw=a.password or __import__('getpass').getpass('Mật khẩu (tối thiểu 12 ký tự): ')
        if len(pw)<12:raise SystemExit('Mật khẩu cần ít nhất 12 ký tự')
        with dbconn() as d:d.execute('INSERT INTO users(username,password_hash,role,created_at) VALUES(?,?,?,?)',(a.username,generate_password_hash(pw),'admin',datetime.now(timezone.utc).isoformat(timespec='seconds')))
        print('Đã tạo quản trị viên '+a.username)
    else:
        if not app.secret_key:raise SystemExit('Cần đặt FILEMANAGER_SECRET bằng chuỗi ngẫu nhiên dài trước khi chạy.')
        if bool(a.cert)!=bool(a.key):raise SystemExit('Cần cung cấp cả --cert và --key')
        app.run(host=a.host,port=a.port,ssl_context=(a.cert,a.key) if a.cert else None)
if __name__=='__main__':main()
