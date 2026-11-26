"""Files API routes."""
import app as core
from app import *

@app.get('/api/list')
@require()
def listing():
    path=request.args.get('path','');p=resolve(path)
    if not p.is_dir():abort(400,'Đường dẫn không phải thư mục')
    data=[item(x) for x in p.iterdir() if not x.is_symlink() and not x.resolve().is_relative_to(core.DB.parent.resolve())];data.sort(key=lambda x:(x['type']!='directory',x['name'].casefold()));return jsonify(path=path,items=data)

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
    found=[];truncated=False;scanned=0;db_dir=core.DB.parent.resolve()
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
        try:children=sorted((x for x in p.iterdir() if x.is_dir() and not x.is_symlink() and not x.resolve().is_relative_to(core.DB.parent.resolve())),key=lambda x:x.name.casefold())
        except OSError:return []
        return [{'name':x.name,'path':rel(x),'children':walk(x,n+1)} for x in children[:500]]
    return jsonify(root=str(core.ROOT),children=walk(core.ROOT))
