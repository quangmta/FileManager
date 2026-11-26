#!/usr/bin/env python3
"""Root-confined Linux web file manager."""
import argparse, csv, hashlib, io, json, os, re, secrets, shutil, sqlite3, stat, tempfile, time, zipfile, zlib, platform, signal, sys
from datetime import datetime, timezone
from functools import wraps
from pathlib import Path, PurePosixPath
from flask import Flask, abort, jsonify, request, send_file, session
from werkzeug.security import check_password_hash, generate_password_hash
from werkzeug.exceptions import HTTPException
from geodata import GeoDataError, dted_elevation, dted_elevations, dted_header, dted_integrity, dted_preview, parse_log

if __name__ == "__main__":
    sys.modules.setdefault("app", sys.modules[__name__])

BASE=Path(__file__).resolve().parent
DB=Path(os.environ.get('FILEMANAGER_DB',BASE/'.filescope/filemanager.sqlite3'))
ROOT=Path(os.environ.get('FILEMANAGER_ROOT',BASE)).expanduser().resolve()
_geo_root_setting=Path(os.environ.get('FILEMANAGER_GEO_ROOT',str(ROOT))).expanduser()
GEO_ROOT=(_geo_root_setting if _geo_root_setting.is_absolute() else ROOT/_geo_root_setting).resolve()
try:GEO_ROOT.relative_to(ROOT)
except ValueError:raise RuntimeError('FILEMANAGER_GEO_ROOT phải nằm bên trong FILEMANAGER_ROOT')
MAX_UPLOAD=int(os.environ.get('FILEMANAGER_MAX_UPLOAD',str(1024**3)))
MAX_EXTRACTED=int(os.environ.get('FILEMANAGER_MAX_EXTRACTED',str(2*1024**3)))
MAX_ARCHIVE_ENTRIES=int(os.environ.get('FILEMANAGER_MAX_ARCHIVE_ENTRIES','10000'))
MAX_SEARCH_SCAN=int(os.environ.get('FILEMANAGER_MAX_SEARCH_SCAN','100000'))
MAX_SESSION_IDLE=int(os.environ.get('FILEMANAGER_SESSION_IDLE','1800'))
MAX_BACKUP=int(os.environ.get('FILEMANAGER_MAX_BACKUP',str(32*1024**2)))
MAX_EDIT_BYTES=int(os.environ.get('FILEMANAGER_MAX_EDIT_BYTES',str(4*1024**2)))
MIN_FREE_SPACE=int(os.environ.get('FILEMANAGER_MIN_FREE_SPACE',str(64*1024**2)))
MAX_GEO_FILE_BYTES=int(os.environ.get('FILEMANAGER_MAX_GEO_FILE',str(32*1024**2)))
TEMP_DIR=os.environ.get('FILEMANAGER_TMP') or None
if TEMP_DIR:
    TEMP_DIR=str(Path(TEMP_DIR).expanduser().resolve())
    Path(TEMP_DIR).mkdir(parents=True,exist_ok=True)
    tempfile.tempdir=TEMP_DIR
app=Flask(__name__,static_folder='static',static_url_path='/static')
app.secret_key=os.environ.get('FILEMANAGER_SECRET','')
app.config.update(MAX_CONTENT_LENGTH=MAX_UPLOAD+1024*1024,SESSION_COOKIE_HTTPONLY=True,SESSION_COOKIE_SAMESITE='Lax',SESSION_COOKIE_SECURE=os.environ.get('FILEMANAGER_HTTPS')=='1')
ROLES={'read':1,'write':2,'admin':3}
PREVIEW_TYPES={
    '.txt':'text/plain','.log':'text/plain','.md':'text/plain','.csv':'text/csv','.json':'application/json',
    '.xml':'text/plain','.yaml':'text/plain','.yml':'text/plain','.toml':'text/plain','.ini':'text/plain',
    '.conf':'text/plain','.py':'text/plain','.js':'text/plain','.css':'text/plain','.sh':'text/plain',
    '.sql':'text/plain','.html':'text/plain','.htm':'text/plain','.rtf':'text/plain',
    '.pdf':'application/pdf','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg',
    '.gif':'image/gif','.webp':'image/webp','.bmp':'image/bmp','.avif':'image/avif'
}
EDITABLE_TEXT_EXTENSIONS={'.txt','.log','.md','.csv','.json','.xml','.yaml','.yml','.toml','.ini','.conf','.py','.js','.css','.sh','.sql','.html','.htm','.rtf'}

def dbconn():
    DB.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    if DB == BASE/'.filescope/filemanager.sqlite3':os.chmod(DB.parent,0o700)
    db=sqlite3.connect(DB,timeout=15); db.row_factory=sqlite3.Row
    if DB.exists():os.chmod(DB,0o600)
    return db
def initdb():
    with dbconn() as d:
        d.executescript('''CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY,username TEXT UNIQUE NOT NULL,password_hash TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('read','write','admin')),created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY,at TEXT NOT NULL,username TEXT NOT NULL,action TEXT NOT NULL,path TEXT NOT NULL,detail TEXT NOT NULL,ip TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS sessions(session_key TEXT PRIMARY KEY,username TEXT NOT NULL,created_at REAL NOT NULL,last_activity REAL NOT NULL,ip TEXT NOT NULL,user_agent TEXT NOT NULL);''')

# Ensure schema creation and lightweight migrations also run under WSGI servers.
initdb()

def audit(action,path='',detail=''):
    with dbconn() as d: d.execute('INSERT INTO audit(at,username,action,path,detail,ip) VALUES(?,?,?,?,?,?)',(datetime.now(timezone.utc).isoformat(timespec='seconds'),session.get('username','system'),action,path,str(detail)[:500],request.remote_addr or ''))

@app.before_request
def validate_session_idle():
    if not request.path.startswith('/api/') or request.path == '/api/login' or not session.get('username'):
        return None
    session_key=session.get('session_key')
    if not session_key:
        session.clear();return None
    now=time.time()
    with dbconn() as d:
        active=d.execute('SELECT last_activity FROM sessions WHERE session_key=? AND username=?',(session_key,session['username'])).fetchone()
        if not active or now-float(active['last_activity'])>MAX_SESSION_IDLE:
            d.execute('DELETE FROM sessions WHERE session_key=?',(session_key,))
            session.clear();return None
        d.execute('UPDATE sessions SET last_activity=? WHERE session_key=?',(now,session_key))
    return None
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

# Register route modules after the shared app, security helpers and storage config are ready.
from routes import auth, files, geo, system, transfers, admin  # noqa: E402,F401

def main():
    parser=argparse.ArgumentParser();sub=parser.add_subparsers(dest='cmd',required=True)
    cr=sub.add_parser('create-admin');cr.add_argument('username');cr.add_argument('--password')
    sv=sub.add_parser('serve');sv.add_argument('--host',default='127.0.0.1');sv.add_argument('--port',type=int,default=8080);sv.add_argument('--cert');sv.add_argument('--key')
    a=parser.parse_args();initdb()
    if a.cmd=='create-admin':
        pw=a.password or __import__('getpass').getpass('Mật khẩu (tối thiểu 3 ký tự): ')
        if len(pw)<3:raise SystemExit('Mật khẩu cần ít nhất 3 ký tự')
        with dbconn() as d:d.execute('INSERT INTO users(username,password_hash,role,created_at) VALUES(?,?,?,?)',(a.username,generate_password_hash(pw),'admin',datetime.now(timezone.utc).isoformat(timespec='seconds')))
        print('Đã tạo quản trị viên '+a.username)
    else:
        if not app.secret_key:raise SystemExit('Cần đặt FILEMANAGER_SECRET bằng chuỗi ngẫu nhiên dài trước khi chạy.')
        if bool(a.cert)!=bool(a.key):raise SystemExit('Cần cung cấp cả --cert và --key')
        app.run(host=a.host,port=a.port,ssl_context=(a.cert,a.key) if a.cert else None)
if __name__=='__main__':main()
