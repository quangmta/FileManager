"""Transfers API routes."""
import app as core
from app import *

@app.get('/api/download')
@require()
def download():
    p=resolve(request.args.get('path',''))
    if p.is_dir():
        archive=tempfile.TemporaryFile(mode='w+b',dir=core.TEMP_DIR)
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
                        if candidate.resolve()==core.DB.parent.resolve():continue
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
    try:core.DB.parent.resolve().relative_to(source.resolve())
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
