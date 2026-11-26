"""System API routes."""
import app as core
from app import *

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
    if str(core.ROOT) not in mounts:mounts.append(str(core.ROOT))
    for m in mounts:
        try:
            u=shutil.disk_usage(m);key=(os.stat(m).st_dev,u.total)
            if key in seen:continue
            seen.add(key);data.append({'mount':m,'total':u.total,'used':u.used,'free':u.free,'percent':round(u.used/u.total*100,1) if u.total else 0})
        except OSError:pass
    return jsonify(partitions=data,reserve=MIN_FREE_SPACE)

def linux_procfs_required():
    if platform.system()!='Linux' or not Path('/proc/stat').is_file():
        abort(501,'Giám sát tiến trình hiện cần Linux với procfs.')

def process_snapshot(pid):
    proc=Path('/proc')/str(pid)
    stat_text=(proc/'stat').read_text(encoding='utf8')
    sampled_at=time.monotonic()
    close=stat_text.rfind(')')
    if close<0:raise ValueError('Thông tin tiến trình không hợp lệ')
    fields=stat_text[close+2:].split()
    status={}
    for line in (proc/'status').read_text(encoding='utf8').splitlines():
        key,separator,value=line.partition(':')
        if separator:status[key]=value.strip()
    uid_fields=status.get('Uid','0 0').split();uid=int(uid_fields[1] if len(uid_fields)>1 else uid_fields[0])
    rss_kb=int(status.get('VmRSS','0 kB').split()[0])
    name=(proc/'comm').read_text(encoding='utf8').strip()
    try:
        import pwd
        username=pwd.getpwuid(uid).pw_name
    except (ImportError,KeyError):username=str(uid)
    return {'pid':pid,'name':name,'user':username,'uid':uid,'state':fields[0],
            'process_group':int(fields[2]),'cpu_ticks':int(fields[11])+int(fields[12]),
            'start_time':int(fields[19]),'memory_bytes':rss_kb*1024,'sampled_at':sampled_at}

@app.get('/api/system/processes')
@require()
def system_processes():
    linux_procfs_required()
    try:meminfo={line.split(':',1)[0]:int(line.split(':',1)[1].strip().split()[0])*1024 for line in Path('/proc/meminfo').read_text().splitlines() if ':' in line}
    except (OSError,ValueError):meminfo={}
    total_memory=meminfo.get('MemTotal',0)
    with dbconn() as db:user=db.execute('SELECT role FROM users WHERE username=?',(session.get('username',''),)).fetchone()
    is_admin=bool(user and user['role']=='admin')
    protected={name.strip().casefold() for name in os.environ.get('FILEMANAGER_PROTECTED_PROCESSES','core_r,core-r,corer').split(',') if name.strip()}
    service_group=os.getpgrp();rows=[]
    try:entries=os.scandir('/proc')
    except OSError:abort(503,'Không đọc được danh sách tiến trình.')
    with entries:
        for entry in entries:
            if not entry.name.isdigit():continue
            try:row=process_snapshot(int(entry.name))
            except (OSError,ValueError,IndexError):continue
            name_folded=row['name'].casefold()
            protected_name=any(pattern in name_folded for pattern in protected)
            is_service_group=row['process_group']==service_group
            row['memory_percent']=round(row['memory_bytes']/total_memory*100,2) if total_memory else 0
            row['can_control']=bool(is_admin and row['pid']>1 and row['uid']!=0 and not is_service_group and not protected_name)
            row['control_reason']='Tiến trình hệ thống được bảo vệ' if row['uid']==0 or row['pid']<=1 or is_service_group or protected_name else ''
            rows.append(row)
    return jsonify(processes=rows,total_memory=total_memory,clock_ticks=os.sysconf('SC_CLK_TCK'),
                   cpu_count=max(1,os.cpu_count() or 1),sampled_at=time.monotonic())

@app.get('/api/system/resources')
@require()
def system_resources():
    linux_procfs_required()
    cpus=[]
    try:
        for line in Path('/proc/stat').read_text().splitlines():
            fields=line.split()
            if not fields or not re.fullmatch(r'cpu\d+',fields[0]):continue
            cpus.append({'name':fields[0],'ticks':[int(value) for value in fields[1:]]})
        meminfo={line.split(':',1)[0]:int(line.split(':',1)[1].strip().split()[0])*1024 for line in Path('/proc/meminfo').read_text().splitlines() if ':' in line}
        interfaces=[]
        for line in Path('/proc/net/dev').read_text().splitlines()[2:]:
            name,values=line.split(':',1);values=values.split()
            if len(values)>=9:interfaces.append({'name':name.strip(),'rx_bytes':int(values[0]),'tx_bytes':int(values[8])})
    except (OSError,ValueError,IndexError):abort(503,'Không đọc được số liệu tài nguyên từ procfs.')
    total=meminfo.get('MemTotal',0);available=meminfo.get('MemAvailable',meminfo.get('MemFree',0));used=max(0,total-available)
    cache=max(0,meminfo.get('Cached',0)+meminfo.get('SReclaimable',0)+meminfo.get('Buffers',0)-meminfo.get('Shmem',0))
    swap_total=meminfo.get('SwapTotal',0);swap_free=meminfo.get('SwapFree',0);swap_used=max(0,swap_total-swap_free)
    return jsonify(cpus=cpus,memory={'total':total,'available':available,'used':used,'cache':cache,'percent':round(used/total*100,1) if total else 0},swap={'total':swap_total,'used':swap_used,'free':swap_free,'percent':round(swap_used/swap_total*100,1) if swap_total else 0},interfaces=interfaces,sampled_at=time.monotonic())

@app.post('/api/system/processes/<int:pid>/signal')
@require('admin')
@csrf
def signal_process(pid):
    linux_procfs_required()
    data=request.get_json(silent=True) or {};actions={'stop':signal.SIGSTOP,'continue':signal.SIGCONT,'end':signal.SIGTERM,'kill':signal.SIGKILL}
    action=data.get('action');expected_start=data.get('start_time')
    if action not in actions:abort(400,'Thao tác tiến trình không hợp lệ.')
    if not isinstance(expected_start,int) or expected_start<0:abort(400,'Thiếu mã định danh tiến trình hợp lệ.')
    try:row=process_snapshot(pid)
    except (OSError,ValueError,IndexError):abort(404,'Tiến trình không còn tồn tại.')
    if row['start_time']!=expected_start:abort(409,'PID đã được tái sử dụng; hãy tải lại danh sách tiến trình.')
    protected={name.strip().casefold() for name in os.environ.get('FILEMANAGER_PROTECTED_PROCESSES','core_r,core-r,corer').split(',') if name.strip()}
    if pid<=1 or row['uid']==0 or row['process_group']==os.getpgrp() or any(pattern in row['name'].casefold() for pattern in protected):
        abort(403,'Tiến trình này được bảo vệ và không thể điều khiển từ giao diện.')
    try:os.kill(pid,actions[action])
    except ProcessLookupError:abort(404,'Tiến trình đã kết thúc.')
    except PermissionError:abort(403,'Quyền hệ điều hành không cho phép thao tác này.')
    except OSError as error:abort(400,f'Không thể gửi tín hiệu: {error.strerror or error}')
    audit(f'process_{action}',f'pid/{pid}',f"name={row['name']} uid={row['uid']}")
    return jsonify(ok=True,message=f"Đã gửi lệnh {action} tới {row['name']} (PID {pid}).")

