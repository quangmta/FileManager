#!/usr/bin/env python3
"""Root-confined Linux web file manager."""
import argparse, hashlib, io, json, os, re, secrets, shutil, sqlite3, stat, tempfile, time, zipfile, zlib, platform
from datetime import datetime, timezone
from functools import wraps
from pathlib import Path, PurePosixPath
from flask import Flask, abort, jsonify, request, send_file, session
from werkzeug.security import check_password_hash, generate_password_hash
from werkzeug.exceptions import HTTPException

BASE=Path(__file__).resolve().parent
DB=Path(os.environ.get('FILEMANAGER_DB',BASE/'.filescope/filemanager.sqlite3'))
ROOT=Path(os.environ.get('FILEMANAGER_ROOT',BASE)).expanduser().resolve()
MAX_UPLOAD=int(os.environ.get('FILEMANAGER_MAX_UPLOAD',str(1024**3)))
MAX_EXTRACTED=int(os.environ.get('FILEMANAGER_MAX_EXTRACTED',str(2*1024**3)))
MAX_ARCHIVE_ENTRIES=int(os.environ.get('FILEMANAGER_MAX_ARCHIVE_ENTRIES','10000'))
MAX_SEARCH_SCAN=int(os.environ.get('FILEMANAGER_MAX_SEARCH_SCAN','100000'))
MAX_SESSION_IDLE=int(os.environ.get('FILEMANAGER_SESSION_IDLE','1800'))
MAX_BACKUP=int(os.environ.get('FILEMANAGER_MAX_BACKUP',str(32*1024**2)))
MAX_EDIT_BYTES=int(os.environ.get('FILEMANAGER_MAX_EDIT_BYTES',str(4*1024**2)))
MIN_FREE_SPACE=int(os.environ.get('FILEMANAGER_MIN_FREE_SPACE',str(64*1024**2)))
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
@app.get('/')
def index():return app.send_static_file('index.html')
@app.get('/api/session')
def session_info():
    if not session.get('username'):return jsonify(authenticated=False)
    with dbconn() as d:u=d.execute('SELECT username,role FROM users WHERE username=?',(session['username'],)).fetchone()
    if not u:session.clear();return jsonify(authenticated=False)
    return jsonify(authenticated=True,username=u['username'],role=u['role'],csrf=session['csrf'],root=str(ROOT),idle_timeout=MAX_SESSION_IDLE,max_upload=MAX_UPLOAD)
@app.post('/api/login')
def login():
    x=request.get_json(silent=True) or {}
    with dbconn() as d:u=d.execute('SELECT * FROM users WHERE username=?',(str(x.get('username','')),)).fetchone()
    if not u or not check_password_hash(u['password_hash'],str(x.get('password',''))):
        time.sleep(.25);audit('login_failed',detail='Sai thông tin đăng nhập');return jsonify(error='Tên đăng nhập hoặc mật khẩu không đúng.'),401
    now=time.time();session_key=secrets.token_urlsafe(32)
    with dbconn() as d:
        d.execute('DELETE FROM sessions WHERE last_activity<?',(now-MAX_SESSION_IDLE,))
        d.execute('INSERT INTO sessions(session_key,username,created_at,last_activity,ip,user_agent) VALUES(?,?,?,?,?,?)',(session_key,u['username'],now,now,request.remote_addr or '',request.user_agent.string[:300]))
    session.clear();session['username']=u['username'];session['csrf']=secrets.token_urlsafe(32);session['session_key']=session_key;audit('login',detail='Đăng nhập thành công')
    return jsonify(authenticated=True,username=u['username'],role=u['role'],csrf=session['csrf'],root=str(ROOT))
@app.post('/api/logout')
@require()
@csrf
def logout():
    audit('logout')
    with dbconn() as d:d.execute('DELETE FROM sessions WHERE session_key=?',(session.get('session_key'),))
    session.clear();return jsonify(ok=True)
@app.get('/api/list')
@require()
def listing():
    path=request.args.get('path','');p=resolve(path)
    if not p.is_dir():abort(400,'Đường dẫn không phải thư mục')
    data=[item(x) for x in p.iterdir() if not x.is_symlink() and not x.resolve().is_relative_to(DB.parent.resolve())];data.sort(key=lambda x:(x['type']!='directory',x['name'].casefold()));return jsonify(path=path,items=data)

@app.get('/api/search')
@require()
def search_files():
    base=resolve(request.args.get('path',''))
    if not base.is_dir():abort(400,'Phạm vi tìm kiếm không phải thư mục')
    query=request.args.get('q','').strip().casefold()
    if len(query)>200:abort(400,'Từ khóa tìm kiếm quá dài')
    kind=request.args.get('type','all')
    if kind not in ('all','file','directory','image','pdf','text','archive'):abort(400,'Loại tệp lọc không hợp lệ')
    try:
        min_size=int(request.args['min_size']) if request.args.get('min_size') else None
        max_size=int(request.args['max_size']) if request.args.get('max_size') else None
        after=request.args.get('after') or None;before=request.args.get('before') or None
        if min_size is not None and min_size<0 or max_size is not None and max_size<0:raise ValueError
        if min_size is not None and max_size is not None and min_size>max_size:raise ValueError
        if after:datetime.fromisoformat(after)
        if before:datetime.fromisoformat(before)
    except ValueError:abort(400,'Điều kiện kích thước hoặc ngày không hợp lệ')
    image_ext={'.png','.jpg','.jpeg','.gif','.webp','.bmp','.avif','.svg'}
    text_ext={'.txt','.log','.md','.csv','.json','.xml','.yaml','.yml','.toml','.ini','.conf','.py','.js','.css','.sh','.sql','.html','.htm','.rtf'}
    archive_ext={'.zip','.tar','.gz','.tgz','.bz2','.xz','.7z'}
    found=[];truncated=False;scanned=0;db_dir=DB.parent.resolve()
    def walk_error(_error):return None
    for current_dir,dirs,files in os.walk(base,topdown=True,followlinks=False,onerror=walk_error):
        here=Path(current_dir);dirs[:]=sorted(d for d in dirs if not (here/d).is_symlink() and (here/d).resolve()!=db_dir)
        for name in sorted(dirs+files,key=str.casefold):
            scanned+=1
            if scanned>MAX_SEARCH_SCAN:truncated=True;break
            path=here/name
            if path.is_symlink() or path.resolve()==db_dir:continue
            try:
                record=item(path);suffix=path.suffix.casefold();entry_type=record['type']
                if query and query not in name.casefold():continue
                if kind=='file' and entry_type!='file' or kind=='directory' and entry_type!='directory':continue
                if kind=='image' and suffix not in image_ext or kind=='pdf' and suffix!='.pdf' or kind=='text' and suffix not in text_ext or kind=='archive' and suffix not in archive_ext:continue
                if min_size is not None and record['size']<min_size or max_size is not None and record['size']>max_size:continue
                modified_date=datetime.fromtimestamp(path.stat().st_mtime).date()
                if after and modified_date<datetime.fromisoformat(after).date() or before and modified_date>datetime.fromisoformat(before).date():continue
                found.append(record)
                if len(found)>=1000:truncated=True;break
            except OSError:continue
        if truncated:break
    found.sort(key=lambda entry:entry['path'].casefold())
    return jsonify(items=found,truncated=truncated,limit=1000,scanned=min(scanned,MAX_SEARCH_SCAN))

@app.get('/api/capacity')
@require()
def capacity():
    folder=resolve(request.args.get('path',''))
    if not folder.is_dir():abort(400,'Đường dẫn không phải thư mục')
    usage=shutil.disk_usage(folder)
    return jsonify(total=usage.total,used=usage.used,free=usage.free,reserve=MIN_FREE_SPACE,max_upload=MAX_UPLOAD)
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
    data=[];seen=set();configured=os.environ.get('FILEMANAGER_MOUNTS')
    if configured:
        mounts=[part for part in configured.split(os.pathsep) if part]
    elif platform.system()=='Linux':
        mounts=[]
        try:
            with open('/proc/mounts',encoding='utf8') as mounts_file:
                for line in mounts_file:
                    fields=line.split()
                    if len(fields)>=2:
                        mounts.append(re.sub(r'\\([0-7]{3})',lambda match:chr(int(match.group(1),8)),fields[1]))
        except OSError:pass
    else:
        # Non-Linux targets (including QNX) should provide mount points explicitly.
        mounts=[]
    if str(ROOT) not in mounts:mounts.append(str(ROOT))
    for m in mounts:
        try:
            u=shutil.disk_usage(m);key=(os.stat(m).st_dev,u.total)
            if key in seen:continue
            seen.add(key);data.append({'mount':m,'total':u.total,'used':u.used,'free':u.free,'percent':round(u.used/u.total*100,1) if u.total else 0})
        except OSError:pass
    return jsonify(partitions=data,reserve=MIN_FREE_SPACE)
@app.get('/api/download')
@require()
def download():
    p=resolve(request.args.get('path',''))
    if p.is_dir():
        archive=tempfile.TemporaryFile(mode='w+b',dir=TEMP_DIR)
        try:
            count=0;plain_bytes=0
            with zipfile.ZipFile(archive,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=1,allowZip64=True) as bundle:
                root_name=p.name or 'root'
                bundle.writestr(root_name+'/', '')
                def walk_error(error):raise error
                for current,dirs,files in os.walk(p,topdown=True,followlinks=False,onerror=walk_error):
                    current_path=Path(current)
                    kept_dirs=[]
                    for name in sorted(dirs):
                        candidate=current_path/name
                        if candidate.resolve()==DB.parent.resolve():continue
                        mode=candidate.lstat().st_mode
                        if stat.S_ISLNK(mode):abort(400,'Không thể tải thư mục có symbolic link')
                        if not stat.S_ISDIR(mode):abort(400,'Thư mục chứa mục không hợp lệ')
                        kept_dirs.append(name)
                        arcname=(Path(root_name)/candidate.relative_to(p)).as_posix().rstrip('/')+'/'
                        bundle.writestr(arcname,'')
                    dirs[:]=kept_dirs
                    for name in sorted(files):
                        candidate=current_path/name
                        mode=candidate.lstat().st_mode
                        if stat.S_ISLNK(mode):abort(400,'Không thể tải thư mục có symbolic link')
                        if not stat.S_ISREG(mode):abort(400,'Chỉ hỗ trợ tệp thường trong bản ZIP')
                        count+=1;plain_bytes+=candidate.stat().st_size
                        if count>MAX_ARCHIVE_ENTRIES:abort(413,f'Thư mục vượt quá {MAX_ARCHIVE_ENTRIES} tệp')
                        if plain_bytes>MAX_EXTRACTED:abort(413,f'Thư mục vượt giới hạn đóng gói {MAX_EXTRACTED} byte')
                        bundle.write(candidate,arcname=(Path(root_name)/candidate.relative_to(p)).as_posix(),compress_type=zipfile.ZIP_DEFLATED,compresslevel=1)
            archive.seek(0,os.SEEK_END);archive_size=archive.tell();archive.seek(0)
        except OSError as error:
            archive.close()
            abort(403 if isinstance(error,PermissionError) else 400,f'Không thể đóng gói thư mục: {error.strerror or error}')
        except BaseException:
            archive.close()
            raise
        audit('download_directory',rel(p),f'files={count}; bytes={archive_size}')
        response=send_file(archive, mimetype='application/zip', as_attachment=True, download_name=p.name+'.zip', conditional=False)
        response.call_on_close(archive.close)
        return response
    if not p.is_file():abort(400,'Chỉ tải xuống tệp thường')
    audit('download',rel(p))
    return send_file(p,as_attachment=True,download_name=p.name,conditional=True)

def archive_member_parts(info):
    raw=info.filename
    if not raw or '\0' in raw or '\\' in raw or raw.startswith('/') or re.match(r'^[A-Za-z]:',raw):abort(400,'ZIP chứa đường dẫn không hợp lệ')
    trimmed=raw[:-1] if info.is_dir() and raw.endswith('/') else raw
    parts=trimmed.split('/')
    if not trimmed or any(part in ('','.','..') for part in parts):abort(400,'ZIP chứa đường dẫn không an toàn')
    mode=(info.external_attr>>16)&0xffff;kind=stat.S_IFMT(mode)
    if kind not in (0,stat.S_IFDIR if info.is_dir() else stat.S_IFREG):abort(400,'ZIP chứa symbolic link hoặc mục đặc biệt')
    return parts

def extract_zip_safely(uploaded, destination):
    try:
        stream=uploaded.stream;stream.seek(0)
        if not hasattr(stream,'seekable'):stream.seekable=lambda:True
        bundle=zipfile.ZipFile(stream)
    except (zipfile.BadZipFile, OSError, RuntimeError):abort(400,'Tệp tải lên không phải ZIP hợp lệ')
    with bundle:
        infos=bundle.infolist()
        if len(infos)>MAX_ARCHIVE_ENTRIES:abort(413,f'ZIP vượt quá {MAX_ARCHIVE_ENTRIES} mục')
        total=sum(info.file_size for info in infos if not info.is_dir())
        if total>MAX_EXTRACTED:abort(413,f'ZIP giải nén vượt giới hạn {MAX_EXTRACTED} byte')
        if shutil.disk_usage(destination).free < total+MIN_FREE_SPACE:abort(507,'Không đủ dung lượng trống để giải nén ZIP')
        validated=[];seen=set()
        for info in infos:
            parts=archive_member_parts(info);key='/'.join(parts)
            if key in seen:abort(400,'ZIP chứa đường dẫn trùng lặp')
            seen.add(key)
            if not info.is_dir() and info.file_size and info.compress_size==0:abort(400,'ZIP có tỷ lệ nén không hợp lệ')
            if not info.is_dir() and info.compress_size and info.file_size/info.compress_size>1000:abort(400,'ZIP có tỷ lệ nén vượt giới hạn an toàn')
            validated.append((info,parts))
        moved=[]
        try:
            with tempfile.TemporaryDirectory(prefix='.filescope-extract-',dir=destination) as temp_name:
                staging=Path(temp_name);written=0
                for info,parts in validated:
                    target=staging.joinpath(*parts)
                    target.resolve(strict=False).relative_to(staging.resolve())
                    if info.is_dir():target.mkdir(parents=True,exist_ok=True);continue
                    target.parent.mkdir(parents=True,exist_ok=True)
                    actual=0
                    with bundle.open(info,'r') as source, target.open('xb') as output:
                        while True:
                            chunk=source.read(1024*1024)
                            if not chunk:break
                            actual+=len(chunk);written+=len(chunk)
                            if actual>info.file_size or written>MAX_EXTRACTED:abort(413,'Nội dung giải nén vượt giới hạn')
                            output.write(chunk)
                    if actual!=info.file_size:abort(400,'Kích thước mục ZIP không khớp')
                roots=sorted(staging.iterdir(),key=lambda entry:entry.name.casefold())
                for entry in roots:
                    if (destination/entry.name).exists():abort(409,f'Đã tồn tại mục {entry.name}; không có gì được giải nén')
                try:
                    for entry in roots:
                        os.replace(entry,destination/entry.name);moved.append(destination/entry.name)
                except OSError:
                    for entry in reversed(moved):
                        shutil.rmtree(entry) if entry.is_dir() else entry.unlink(missing_ok=True)
                    raise
                return [entry.name for entry in roots],written
        except (zipfile.BadZipFile,EOFError,RuntimeError,NotImplementedError,zlib.error):abort(400,'ZIP bị hỏng, mã hóa hoặc không được hỗ trợ')
        except OSError as error:
            abort(403 if isinstance(error,PermissionError) else 507,f'Không thể giải nén ZIP: {error.strerror or error}')

def upload_capacity_error(folder):
    needed=request.content_length or 0
    try:free=shutil.disk_usage(folder).free
    except OSError:return jsonify(error='Không xác định được dung lượng trống của nơi lưu.'),507
    if free-needed<MIN_FREE_SPACE:return jsonify(error=f'Không đủ dung lượng trống. Còn {free} byte, cần khoảng {needed+MIN_FREE_SPACE} byte.'),507
    return None

@app.post('/api/upload-archive')
@require('write')
@csrf
def upload_archive():
    if request.content_length and request.content_length>MAX_UPLOAD+1024*1024:abort(413)
    path=request.args.get('path','');folder=resolve(path)
    if not folder.is_dir():abort(400,'Thư mục đích không hợp lệ')
    capacity_error=upload_capacity_error(folder)
    if capacity_error:return capacity_error
    uploaded=request.files.get('archive')
    if not uploaded or not uploaded.filename:abort(400,'Chưa chọn tệp ZIP')
    if Path(uploaded.filename).suffix.casefold()!='.zip':abort(400,'Chỉ chấp nhận tệp .zip')
    names,total=extract_zip_safely(uploaded,folder)
    audit('extract_archive',path,f'entries={len(names)}; bytes={total}')
    return jsonify(ok=True,items=names,bytes=total)
@app.get('/api/preview')
@require()
def preview():
    p=resolve(request.args.get('path',''))
    if not p.is_file():abort(400,'Chỉ xem trước tệp thường')
    mimetype=PREVIEW_TYPES.get(p.suffix.lower())
    if not mimetype:abort(415,'Định dạng này chưa hỗ trợ xem trước; hãy tải tệp xuống')
    audit('preview',rel(p))
    response=send_file(p,mimetype=mimetype,as_attachment=False,download_name=p.name,conditional=True)
    if mimetype.startswith('text/') or mimetype=='application/json':response.headers['Content-Type']=mimetype+'; charset=utf-8'
    return response

@app.get('/api/edit')
@require()
def read_text_for_editing():
    p=resolve(request.args.get('path',''))
    if not p.is_file() or p.suffix.casefold() not in EDITABLE_TEXT_EXTENSIONS:abort(415,'Chỉ hỗ trợ sửa các định dạng văn bản được cho phép')
    try:
        with p.open('rb') as source:raw=source.read(MAX_EDIT_BYTES+1)
    except OSError as error:abort(403 if isinstance(error,PermissionError) else 400,f'Không đọc được tệp: {error.strerror or error}')
    if len(raw)>MAX_EDIT_BYTES:abort(413,f'Tệp vượt giới hạn sửa trực tiếp {MAX_EDIT_BYTES} byte')
    if b'\0' in raw:abort(415,'Tệp có dữ liệu nhị phân, không thể sửa như văn bản')
    try:content=raw.decode('utf-8')
    except UnicodeDecodeError:abort(415,'Tệp không dùng mã hóa UTF-8; hãy tải xuống để sửa bằng ứng dụng phù hợp')
    audit('edit_open',rel(p),f'bytes={len(raw)}')
    return jsonify(path=rel(p),name=p.name,content=content,revision=hashlib.sha256(raw).hexdigest(),max_bytes=MAX_EDIT_BYTES)

@app.post('/api/edit')
@require('write')
@csrf
def save_text_edit():
    if request.content_length and request.content_length>MAX_EDIT_BYTES*6+8192:abort(413,'Yêu cầu sửa tệp vượt giới hạn')
    path,data=bodypath();p=resolve(path)
    if not p.is_file() or p.suffix.casefold() not in EDITABLE_TEXT_EXTENSIONS:abort(415,'Chỉ hỗ trợ sửa các định dạng văn bản được cho phép')
    content=data.get('content');revision=data.get('revision')
    if not isinstance(content,str) or not isinstance(revision,str):abort(400,'Nội dung hoặc phiên bản tệp không hợp lệ')
    if '\0' in content:abort(400,'Nội dung không được chứa ký tự NUL')
    raw=content.encode('utf-8')
    if len(raw)>MAX_EDIT_BYTES:abort(413,f'Nội dung vượt giới hạn sửa trực tiếp {MAX_EDIT_BYTES} byte')
    try:
        with p.open('r+b') as target:
            existing=target.read(MAX_EDIT_BYTES+1)
            if len(existing)>MAX_EDIT_BYTES:abort(413,f'Tệp vượt giới hạn sửa trực tiếp {MAX_EDIT_BYTES} byte')
            if hashlib.sha256(existing).hexdigest()!=revision:abort(409,'Tệp đã thay đổi từ nơi khác; hãy tải lại nội dung trước khi lưu')
            target.seek(0);target.write(raw);target.truncate();target.flush()
    except OSError as error:abort(403 if isinstance(error,PermissionError) else 400,f'Không lưu được tệp: {error.strerror or error}')
    new_revision=hashlib.sha256(raw).hexdigest()
    audit('edit_save',rel(p),f'bytes={len(raw)}')
    return jsonify(ok=True,revision=new_revision,bytes=len(raw))

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
    if request.content_length and request.content_length>MAX_UPLOAD+1024*1024:abort(413)
    p=request.args.get('path')
    if p is None:p=request.form.get('path','')
    folder=resolve(p)
    if not folder.is_dir():abort(400,'Thư mục tải lên không hợp lệ')
    capacity_error=upload_capacity_error(folder)
    if capacity_error:return capacity_error
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
        'settings':{'root':str(ROOT),'max_upload':MAX_UPLOAD,'max_extracted':MAX_EXTRACTED},
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
