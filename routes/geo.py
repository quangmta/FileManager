"""Geo API routes."""
import app as core
from app import *
from functools import lru_cache

@lru_cache(maxsize=8)
def _cached_dted_preview(path, modified_ns, file_size, max_bytes):
    return dted_preview(path,max_bytes)

def geo_file(relpath, extensions):
    path=resolve(relpath)
    try:path.relative_to(core.GEO_ROOT)
    except ValueError:abort(400,'Đường dẫn bản đồ/log nằm ngoài FILEMANAGER_GEO_ROOT')
    if not path.is_file() or path.suffix.casefold() not in extensions:abort(400,'Loại tệp bản đồ/log không được hỗ trợ')
    if path.stat().st_size>MAX_GEO_FILE_BYTES:abort(413,f'Tệp vượt giới hạn đọc {MAX_GEO_FILE_BYTES} byte')
    return path

def geo_candidates(extensions, limit):
    found=[];scanned=0;db_dir=core.DB.parent.resolve()
    def onerror(_):return None
    for current_dir,dirs,files in os.walk(core.GEO_ROOT,topdown=True,followlinks=False,onerror=onerror):
        here=Path(current_dir)
        dirs[:]=sorted(name for name in dirs if name not in ('.git','.venv','__pycache__','.filescope') and not (here/name).is_symlink() and (here/name).resolve()!=db_dir)
        for name in sorted(files,key=str.casefold):
            scanned+=1
            if scanned>100000:return found,True
            path=here/name
            if path.is_symlink() or path.suffix.casefold() not in extensions:continue
            try:path.resolve().relative_to(core.GEO_ROOT)
            except ValueError:continue
            found.append(path)
            if len(found)>=limit:return found,True
    return found,False

@app.get('/api/geo/maps')
@require()
def geo_maps():
    paths,truncated=geo_candidates({'.dt2'},500)
    maps=[]
    for path in paths:
        entry={'path':rel(path),'name':path.name,'size':path.stat().st_size,'modified':path.stat().st_mtime}
        try:
            header=dted_header(path,MAX_GEO_FILE_BYTES)
            entry.update(format='DTED',columns=header['columns'],rows=header['rows'],min_latitude=header['min_latitude'],max_latitude=header['max_latitude'],min_longitude=header['min_longitude'],max_longitude=header['max_longitude'],latitude_interval_seconds=header['latitude_interval_seconds'],longitude_interval_seconds=header['longitude_interval_seconds'])
        except (GeoDataError,OSError) as error:entry['error']=str(error)
        maps.append(entry)
    maps.sort(key=lambda entry:entry['path'].casefold())
    return jsonify(maps=maps,truncated=truncated)

@app.get('/api/geo/map-preview')
@require()
def geo_map_preview():
    path=geo_file(request.args.get('path',''),{'.dt2'})
    try:
        metadata=path.stat()
        data=_cached_dted_preview(str(path),metadata.st_mtime_ns,metadata.st_size,MAX_GEO_FILE_BYTES)
    except GeoDataError as error:abort(415,str(error))
    except OSError as error:abort(400,f'Không đọc được tile DTED: {error.strerror or error}')
    audit('geo_map_view',rel(path))
    return jsonify(map=data)

@app.get('/api/geo/elevation')
@require()
def geo_elevation():
    path=geo_file(request.args.get('path',''),{'.dt2'})
    try:latitude=float(request.args.get('latitude',''));longitude=float(request.args.get('longitude',''))
    except ValueError:abort(400,'Latitude/longitude không hợp lệ')
    try:result=dted_elevation(path,latitude,longitude,MAX_GEO_FILE_BYTES)
    except GeoDataError as error:abort(400,str(error))
    except OSError as error:abort(400,f'Không đọc được độ cao: {error.strerror or error}')
    return jsonify(result)

@app.post('/api/geo/elevations')
@require()
@csrf
def geo_elevations():
    data=request.get_json(silent=True) or {}
    points=data.get('points')
    if not isinstance(points,list) or len(points)>5000:abort(400,'Danh sách tọa độ phải là mảng tối đa 5.000 điểm')
    path=geo_file(data.get('path',''),{'.dt2'})
    try:results=dted_elevations(path,points,MAX_GEO_FILE_BYTES)
    except GeoDataError as error:abort(400,str(error))
    except OSError as error:abort(400,f'Không đọc được độ cao: {error.strerror or error}')
    audit('geo_elevation_batch',rel(path),f'points={len(points)}')
    return jsonify(results=results)

GEO_LOG_EXTENSIONS={'.csv','.json','.jsonl','.log','.txt'}
@app.get('/api/geo/log-files')
@require()
def geo_log_files():
    paths,truncated=geo_candidates(GEO_LOG_EXTENSIONS,1000)
    files=[{'path':rel(path),'name':path.name,'size':path.stat().st_size,'modified':path.stat().st_mtime} for path in paths]
    files.sort(key=lambda entry:entry['path'].casefold())
    return jsonify(files=files,truncated=truncated)

@app.get('/api/geo/logs')
@require()
def geo_logs():
    path=geo_file(request.args.get('path',''),GEO_LOG_EXTENSIONS)
    try:result=parse_log(path,MAX_GEO_FILE_BYTES)
    except GeoDataError as error:abort(413,str(error))
    except (OSError,csv.Error) as error:abort(400,f'Không đọc được log: {error}')
    audit('geo_log_view',rel(path),f"records={result['total_records']}")
    return jsonify(path=rel(path),name=path.name,**result)

