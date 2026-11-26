"""System API routes."""
import app as core
from app import *
import subprocess

QNX_PIDIN=os.environ.get('FILEMANAGER_QNX_PIDIN','pidin')
QNX_TOP=os.environ.get('FILEMANAGER_QNX_TOP','top')

def _qnx_command(command, *args):
    try:
        result=subprocess.run([command,*args],capture_output=True,text=True,timeout=5,check=False)
    except (OSError,subprocess.TimeoutExpired) as error:
        abort(503,f'Không chạy được công cụ QNX {Path(command).name}: {error}')
    if result.returncode:
        abort(503,f'Công cụ QNX {Path(command).name} trả mã lỗi {result.returncode}.')
    return result.stdout

def _qnx_memory_bytes(value, unit):
    scale={'K':1024,'M':1024**2,'G':1024**3}.get(unit.upper())
    return int(float(value)*scale) if scale else None

def _qnx_memory_snapshot(top_output=''):
    info=_qnx_command(QNX_PIDIN,'info')
    cpu_count=len(re.findall(r'^\s*Processor\d+:',info,re.M))
    match=re.search(r'FreeMem:\s*([\d.]+)\s*([KMG])B\s*/\s*([\d.]+)\s*([KMG])B',info,re.I)
    if match:
        available=_qnx_memory_bytes(match.group(1),match.group(2))
        total=_qnx_memory_bytes(match.group(3),match.group(4))
        display_available=f'{match.group(1)} {match.group(2).upper()}B'
        display_total=f'{match.group(3)} {match.group(4).upper()}B'
    else:
        match=re.search(r'Memory:\s*([\d.]+)\s*([KMG])\s+total,\s*([\d.]+)\s*([KMG])\s+avail',top_output,re.I)
        if not match:abort(503,'Không phân tích được tổng/khả dụng RAM từ pidin info hoặc top.')
        total=_qnx_memory_bytes(match.group(1),match.group(2))
        available=_qnx_memory_bytes(match.group(3),match.group(4))
        display_total=f'{match.group(1)} {match.group(2).upper()}B'
        display_available=f'{match.group(3)} {match.group(4).upper()}B'
    if not total or available is None:abort(503,'QNX trả số liệu bộ nhớ không hợp lệ.')
    available=min(total,available)
    used=max(0,total-available)
    total_unit=display_total.split()[1];unit_scale={'KB':1024,'MB':1024**2,'GB':1024**3}[total_unit]
    display_used=f'{used/unit_scale:g} {total_unit}'
    return {'total':total,'available':available,'used':used,'cache':None,
            'display_total':display_total,'display_used':display_used,
            'percent':round(used/total*100,1),'cpu_count':max(1,cpu_count)}

def _qnx_cpu_snapshot(top_output):
    cpus=[]
    for line in top_output.splitlines():
        match=re.match(r'^\s*CPU\s+(\d+):\s+(OFFL|[\d.]+%)',line,re.I)
        if not match:continue
        offline=match.group(2).upper()=='OFFL'
        idle=100.0 if offline else float(match.group(2).rstrip('%'))
        cpus.append({'name':f'cpu{match.group(1)}','percent':max(0.0,min(100.0,100.0-idle))})
    if cpus:return cpus
    info=_qnx_command(QNX_PIDIN,'info')
    count=len(re.findall(r'^\s*Processor\d+:',info,re.M))
    return [{'name':f'cpu{index}','percent':0.0} for index in range(count)]

def _qnx_cpu_nanoseconds(value):
    text=value.strip().casefold().replace(',','')
    match=re.fullmatch(r'([+-]?[0-9]+(?:\.[0-9]+)?)\s*(ns|us|µs|ms|s)?',text)
    if match:
        scale={'ns':1,'us':1000,'µs':1000,'ms':1_000_000,'s':1_000_000_000,None:1}[match.group(2)]
        return int(float(match.group(1))*scale)
    parts=text.split(':')
    if len(parts)==3:
        try:return int((float(parts[0])*3600+float(parts[1])*60+float(parts[2]))*1_000_000_000)
        except ValueError:pass
    raise ValueError('pidin CPU time is not numeric')


def _qnx_process_snapshot(total_memory):
    # Delimiters keep paths/names and QNX's numeric counters separate.
    output=_qnx_command(QNX_PIDIN,'-F','%a|%N|%U|%z|%J|%P')
    page_size=4096
    try:page_size=int(os.sysconf('SC_PAGE_SIZE'))
    except (AttributeError,ValueError,OSError):pass
    sampled_at=time.monotonic();by_pid={}
    state_priority={'RUNNING':5,'READY':4,'STOPPED':3,'SIGSUSPEND':2,'NANOSLEEP':1}

    def add(pid,name,uid=0,thread_ticks=0,state='?',process_group=None):
        if pid<1 or not name:return
        row=by_pid.get(pid)
        if row is None:
            row={'pid':pid,'name':name,'uid':uid,'cpu_ticks':thread_ticks,
                 'state':state,'process_group':process_group if process_group is not None else pid}
            by_pid[pid]=row
        else:
            # pidin emits one row per thread; %z is that thread's accumulated CPU time.
            row['cpu_ticks']+=thread_ticks
            if state_priority.get(state,0)>state_priority.get(row['state'],0):row['state']=state

    for line in output.splitlines():
        fields=line.split('|')
        if len(fields)>=6:
            try:
                pid=int(fields[0].strip());uid=int(fields[2].strip(),0)
                thread_ticks=_qnx_cpu_nanoseconds(fields[3])
                process_group=int(fields[5].strip(),0)
            except ValueError:continue
            add(pid,fields[1].strip(),uid,thread_ticks,fields[4].strip().upper() or '?',process_group)

    # Older pidin versions can ignore the custom format; parse its documented table.
    if not by_pid:
        for line in _qnx_command(QNX_PIDIN).splitlines():
            fields=line.split()
            if len(fields)<3:continue
            if not fields[0].isdigit():continue
            try:pid=int(fields[0]);tid=int(fields[1])
            except ValueError:continue
            # Default columns: pid, tid, process path, priority, state, blocked-on.
            add(pid,fields[2],state=fields[4].upper() if len(fields)>4 else '?')

    processes=[]
    try:
        import pwd
    except ImportError:pwd=None
    for row in by_pid.values():
        pid=row['pid'];uid=row['uid'];rss_pages=0
        try:
            vmstat=(Path('/proc')/str(pid)/'vmstat').read_text(encoding='ascii',errors='replace')
            rss_match=re.search(r'^as_stats\.rss=(0x[0-9a-f]+|\d+)',vmstat,re.M|re.I)
            if rss_match:rss_pages=int(rss_match.group(1),0)
        except (OSError,ValueError):pass
        try:username=pwd.getpwuid(uid).pw_name if pwd else str(uid)
        except KeyError:username=str(uid)
        memory_bytes=rss_pages*page_size
        row.update(user=username,start_time=0,
            memory_bytes=memory_bytes,memory_percent=round(memory_bytes/total_memory*100,2) if total_memory else 0,
            sampled_at=sampled_at,can_control=False,control_reason='')
        processes.append(row)
    return processes


def _qnx_process_control_allowed(row,is_admin):
    protected={name.strip().casefold() for name in os.environ.get('FILEMANAGER_PROTECTED_PROCESSES','core_r,core-r,corer').split(',') if name.strip()}
    name=row['name'].casefold()
    service_group=os.getpgrp()
    reason=''
    if not is_admin:reason='Cần quyền quản trị viên'
    elif row['pid']<=1 or row['pid']==os.getpid() or row.get('process_group')==service_group:
        reason='Tiến trình hệ thống hoặc server được bảo vệ'
    elif any(pattern in name for pattern in protected):reason='Tiến trình được bảo vệ theo cấu hình'
    return not reason,reason

def _qnx_top_process_cpu():
    output=_qnx_command(QNX_TOP,'-b','-i','1','-D','1','-z','100')
    usage={}
    for line in output.splitlines():
        fields=line.split()
        if len(fields)<6 or not fields[0].isdigit() or not fields[1].isdigit():continue
        percent=next((value for value in fields[4:] if re.fullmatch(r'[0-9]+(?:[.,][0-9]+)?%',value)),None)
        if percent is None:continue
        pid=int(fields[0]);value=float(percent[:-1].replace(',','.'))
        usage[pid]=min(100.0,usage.get(pid,0.0)+value)
    return usage


def _qnx_system_processes():
    memory=_qnx_memory_snapshot()
    processes=_qnx_process_snapshot(memory['total'])
    top_cpu=_qnx_top_process_cpu()
    for row in processes:
        if row['pid'] in top_cpu:row['cpu_percent']=top_cpu[row['pid']]
    with dbconn() as db:user=db.execute('SELECT role FROM users WHERE username=?',(session.get('username',''),)).fetchone()
    is_admin=bool(user and user['role']=='admin')
    for row in processes:
        row['can_control'],row['control_reason']=_qnx_process_control_allowed(row,is_admin)
    return jsonify(processes=processes,total_memory=memory['total'],clock_ticks=1_000_000_000,
                   cpu_count=memory['cpu_count'],poll_interval_ms=5000,sampled_at=time.monotonic())

def _qnx_system_resources():
    top_output=_qnx_command(QNX_TOP,'-b','-i','1','-D','1')
    memory=_qnx_memory_snapshot(top_output)
    cpus=_qnx_cpu_snapshot(top_output)
    return jsonify(cpus=cpus,memory=memory,
        swap={'total':0,'used':0,'free':0,'percent':0},interfaces=[],network_supported=False,
        poll_interval_ms=5000,sampled_at=time.monotonic())

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
        abort(501,'Giám sát tiến trình cần Linux hoặc QNX có pidin, top và procfs.')

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
    if platform.system().upper()=='QNX':return _qnx_system_processes()
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
    if platform.system().upper()=='QNX':return _qnx_system_resources()
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
    data=request.get_json(silent=True) or {};actions={'stop':signal.SIGSTOP,'continue':signal.SIGCONT,'end':signal.SIGTERM,'kill':signal.SIGKILL}
    action=data.get('action');expected_start=data.get('start_time')
    if action not in actions:abort(400,'Thao tác tiến trình không hợp lệ.')
    if not isinstance(expected_start,int) or expected_start<0:abort(400,'Thiếu mã định danh tiến trình hợp lệ.')
    is_qnx=platform.system().upper()=='QNX'
    if is_qnx:
        processes=_qnx_process_snapshot(0)
        row=next((item for item in processes if item['pid']==pid),None)
        if row is None:abort(404,'Tiến trình không còn tồn tại.')
        if expected_start!=row['start_time'] or data.get('name')!=row['name'] or data.get('uid')!=row['uid']:
            abort(409,'Thông tin tiến trình đã thay đổi; hãy tải lại danh sách.')
        allowed,reason=_qnx_process_control_allowed(row,True)
        if not allowed:abort(403,reason)
    else:
        linux_procfs_required()
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

