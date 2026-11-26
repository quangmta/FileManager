function stopMonitorPolling() {
  if(monitorPollTimer){clearInterval(monitorPollTimer);monitorPollTimer=null;}
}

function updateMonitorPollInterval(interval) {
  if(!Number.isFinite(interval)||interval<1000||interval===monitorPollInterval)return;
  monitorPollInterval=interval;
  if(monitorPollTimer){clearInterval(monitorPollTimer);monitorPollTimer=setInterval(()=>{if(!document.hidden)refreshMonitorTab();},monitorPollInterval);}
}

function startMonitorPolling() {
  if(monitorPollTimer||monitorUnsupported)return;
  refreshMonitorTab();
  monitorPollTimer=setInterval(()=>{if(!document.hidden)refreshMonitorTab();},monitorPollInterval);
}

function selectMonitorTab(tab) {
  monitorTab=tab;
  $$('[data-monitor-tab]').forEach(button=>{const active=button.dataset.monitorTab===tab;button.classList.toggle('active',active);button.setAttribute('aria-selected',String(active));});
  $('#monitor-processes-panel').classList.toggle('hidden',tab!=='processes');
  $('#monitor-resources-panel').classList.toggle('hidden',tab!=='resources');
  $('#monitor-storage-panel').classList.toggle('hidden',tab!=='storage');
  if($('#monitor-view').classList.contains('hidden'))return;
  if(tab==='storage')loadDisk();else if(!monitorUnsupported)refreshMonitorTab();
}

async function refreshMonitorTab() {
  try {
    if(monitorTab==='processes')await loadProcesses();
    else if(monitorTab==='resources')await loadResources();
  } catch(error) {
    if(/procfs|QNX|Linux/i.test(error.message)){monitorUnsupported=true;stopMonitorPolling();$('#process-summary').textContent=error.message;$('#process-table-body').innerHTML=`<tr><td colspan="8" class="muted">${esc(error.message)}</td></tr>`;$('#resource-unavailable').textContent=error.message;$('#resource-unavailable').classList.remove('hidden');$('#resource-content').classList.add('hidden');}
    else toast(error.message,true);
  }
}

async function loadProcesses(forceRender=false) {
  const data=await api('/api/system/processes'),nextSamples=new Map(),clock=data.clock_ticks||100,cpuCount=data.cpu_count||1;
  updateMonitorPollInterval(data.poll_interval_ms);
  processRows=data.processes.map(process=>{
    const key=`${process.pid}:${process.start_time}`,previous=processSamples.get(key),elapsed=previous?process.sampled_at-previous.sampled_at:0,delta=previous?process.cpu_ticks-previous.cpu_ticks:0;
    nextSamples.set(key,{cpu_ticks:process.cpu_ticks,sampled_at:process.sampled_at});
    // Normalize one-core CPU usage to the total logical CPU capacity of the machine.
    const cpuPercent=Number.isFinite(process.cpu_percent)?process.cpu_percent:(elapsed>0?delta/clock/elapsed*100/cpuCount:0);
    return {...process,cpu_percent:Math.min(100,Math.max(0,cpuPercent))};
  });
  processSamples=nextSamples;updateProcessHistorySelector();recordProcessHistory();renderProcesses(forceRender);
}

function updateProcessHistorySelector() {
  const select=$('#process-history-select'),old=selectedProcessHistoryPid;
  select.innerHTML=processRows.map(row=>`<option value="${row.pid}">${row.pid} · ${esc(row.name)}</option>`).join('');
  const exists=processRows.some(row=>String(row.pid)===old);
  selectedProcessHistoryPid=exists?old:String(processRows[0]?.pid||'');
  if(selectedProcessHistoryPid!==old)processHistorySamples=[];
  select.value=selectedProcessHistoryPid;
}

function recordProcessHistory() {
  const row=processRows.find(item=>String(item.pid)===selectedProcessHistoryPid);if(!row)return;
  processHistorySamples.push({time:Date.now(),cpu:row.cpu_percent,memory:row.memory_percent,cores:row.cpu_cores||[]});
  if(processHistorySamples.length>30)processHistorySamples.shift();
  renderProcessHistory();
}

function renderProcessHistory() {
  const series=[{values:processHistorySamples.map(item=>item.cpu),color:'#18815d'},{values:processHistorySamples.map(item=>item.memory),color:'#e5a02c'}];
  const coreCount=Math.max(0,...processHistorySamples.map(item=>item.cores.length));
  for(let core=0;core<coreCount;core++)series.push({values:processHistorySamples.map(item=>item.cores[core]||0),color:resourceColors[(core+2)%resourceColors.length]});
  drawResourceChart('process-history-chart',series,{max:100});
}

async function showProcessDetails(pid) {
  const panel=$('#process-detail-panel'),content=$('#process-detail-content');
  panel.classList.remove('hidden');content.textContent='Đang tải chi tiết tiến trình…';
  try {
    const data=await api(`/api/system/processes/${pid}/details`),row=data.process;
    content.innerHTML=`<div class="process-detail-meta"><span><small>PID</small><b>${row.pid}</b></span><span><small>Người dùng</small><b>${esc(row.user||'—')}</b></span><span><small>Bộ nhớ RSS</small><b>${systemBytes(row.memory_bytes||0)}</b></span><span><small>Đường dẫn</small><b title="${esc(row.path||'—')}">${esc(row.path||'—')}</b></span><span><small>Thư mục làm việc</small><b title="${esc(row.cwd||'—')}">${esc(row.cwd||'—')}</b></span></div><p class="process-detail-command">${esc(row.command||row.name)}</p><h3>Thread (${row.threads.length})</h3><div class="process-detail-threads">${row.threads.map(thread=>`<span>TID ${thread.tid} · ${esc(thread.state||'?')} · Core ${thread.last_cpu??'—'}${Number.isFinite(thread.cpu_percent)?` · ${thread.cpu_percent.toFixed(1)}%`:''}</span>`).join('')||'<span class="muted">Không đọc được thread.</span>'}</div>`;
  } catch(error){content.textContent=error.message;}
}

function renderProcesses(force=false) {
  if(!force&&$('#process-table-body').contains(document.activeElement))return;
  const query=$('#process-query').value.trim().toLocaleLowerCase();
  const rows=processRows.filter(row=>`${row.name} ${row.user} ${row.pid}`.toLocaleLowerCase().includes(query)).sort((a,b)=>{
    const left=a[processSort.key],right=b[processSort.key],comparison=typeof left==='string'?left.localeCompare(right,undefined,{numeric:true,sensitivity:'base'}):(left??0)-(right??0);
    return comparison*processSort.direction||a.pid-b.pid;
  });
  $$('[data-process-sort]').forEach(button=>{const active=button.dataset.processSort===processSort.key;button.querySelector('span').textContent=active?(processSort.direction===1?'↑':'↓'):'';button.closest('th').setAttribute('aria-sort',active?(processSort.direction===1?'ascending':'descending'):'none');});
  $('#process-summary').textContent=`${rows.length.toLocaleString()} tiến trình${me?.role==='admin'?` · tự làm mới mỗi ${monitorPollInterval/1000} giây`:' · cần quyền quản trị để điều khiển tiến trình'}`;
  $('#process-table-body').innerHTML=rows.map(row=>{
    const stateName=({R:'Đang chạy',S:'Ngủ',D:'Chờ I/O',T:'Tạm dừng',Z:'Đã kết thúc',I:'Chờ',RUNNING:'Đang chạy',READY:'Sẵn sàng',STOPPED:'Tạm dừng',HELD:'Tạm dừng',RECEIVE:'Chờ nhận',SEND:'Chờ gửi',REPLY:'Chờ phản hồi',NANOSLEEP:'Ngủ',CONDVAR:'Chờ điều kiện',MUTEX:'Chờ khóa',SIGSUSPEND:'Chờ tín hiệu',INTR:'Chờ ngắt',SEM:'Chờ semaphore'})[row.state]||row.state;
    const reason=row.can_control?'':(me?.role!=='admin'?'Cần quyền quản trị viên':row.control_reason||'Không được phép điều khiển');
    const coreUsage=Array.isArray(row.cpu_cores)?`<div class="process-core-usage">${row.cpu_cores.map((value,index)=>{const percent=Math.max(0,Math.min(100,Number(value)||0));return `<span title="Core ${index}: ${percent.toFixed(1)}% CPU của core, phân bổ theo core gần nhất của thread"><b>C${index}</b><i><em style="width:${percent}%"></em></i><small>${percent.toFixed(1)}%</small></span>`;}).join('')}</div>`:'<span class="muted">—</span>';
    return `<tr><td class="process-name" title="${esc(row.name)}">${esc(row.name)}</td><td>${esc(row.user)}</td><td>${row.pid}</td><td>${row.cpu_percent.toFixed(1)}%</td><td>${coreUsage}</td><td>${systemBytes(row.memory_bytes)} <small>${row.memory_percent.toFixed(1)}%</small></td><td>${esc(stateName)}</td><td><div class="process-actions"><button class="secondary" type="button" data-process-details="${row.pid}">Chi tiết</button><select data-process-action="${row.pid}" aria-label="Thao tác với ${esc(row.name)}" ${row.can_control?'':'disabled title="'+esc(reason)+'"'}><option value="stop">Tạm dừng</option><option value="continue">Tiếp tục</option><option value="end">Kết thúc</option><option value="kill">Buộc dừng</option></select><button class="secondary" type="button" data-process-run="${row.pid}" data-start-time="${row.start_time}" ${row.can_control?'':'disabled title="'+esc(reason)+'"'}>Thực thi</button></div></td></tr>`;
  }).join('')||'<tr><td colspan="8" class="muted">Không tìm thấy tiến trình.</td></tr>';
  $$('[data-process-details]').forEach(button=>button.onclick=()=>showProcessDetails(Number(button.dataset.processDetails)));
  $$('[data-process-run]').forEach(button=>button.onclick=()=>{
    const select=$(`[data-process-action="${button.dataset.processRun}"]`),row=processRows.find(item=>item.pid===Number(button.dataset.processRun)&&item.start_time===Number(button.dataset.startTime));
    if(row)executeProcessAction(row,select.value);
  });
}

function executeProcessAction(process,action) {
  const run=async()=>{
    try {const result=await api(`/api/system/processes/${process.pid}/signal`,{method:'POST',body:JSON.stringify({action,start_time:process.start_time,name:process.name,uid:process.uid})});toast(result.message);await loadProcesses(true);}
    catch(error){toast(error.message,true);await loadProcesses(true).catch(()=>{});}
  };
  if(action==='end'||action==='kill')confirmModal(action==='kill'?'Buộc dừng tiến trình?':'Kết thúc tiến trình?',`${process.name} (PID ${process.pid}) sẽ nhận tín hiệu ${action==='kill'?'KILL':'TERM'}.`,run);
  else run();
}

function resourceCpuPercent(current,previous) {
  if(!previous)return 0;
  const length=Math.min(8,current.length,previous.length),total=current.slice(0,length).reduce((sum,value,index)=>sum+value-previous[index],0);
  const idle=(current[3]||0)-(previous[3]||0)+(current[4]||0)-(previous[4]||0);
  return total>0?Math.max(0,Math.min(100,(total-idle)/total*100)):0;
}

function formatRate(bytesPerSecond) {
  const rate=Math.max(0,Number(bytesPerSecond)||0);
  return rate<1024?`${Math.round(rate)} B/s`:`${size(rate)}/s`;
}

function drawResourceChart(id,series,{max=100,valueLabel=value=>`${value.toFixed(0)}%`}={}) {
  const canvas=$('#'+id),rect=canvas.getBoundingClientRect(),dpr=window.devicePixelRatio||1;
  if(rect.width<2||rect.height<2)return;
  canvas.width=Math.round(rect.width*dpr);canvas.height=Math.round(rect.height*dpr);
  const ctx=canvas.getContext('2d');ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,rect.width,rect.height);
  const left=8,right=52,top=8,bottom=23,width=rect.width-left-right,height=rect.height-top-bottom;
  ctx.font='10px sans-serif';ctx.textBaseline='middle';ctx.textAlign='right';ctx.lineWidth=1;
  for(let tick=0;tick<=2;tick++){const ratio=tick/2,y=top+height*(1-ratio);ctx.strokeStyle='#e5e8e7';ctx.beginPath();ctx.moveTo(left,y);ctx.lineTo(left+width,y);ctx.stroke();ctx.fillStyle='#7b8581';ctx.fillText(valueLabel(max*ratio),rect.width-4,y);}
  for(let tick=0;tick<=6;tick++){const x=left+width*tick/6;ctx.strokeStyle='#eceeed';ctx.beginPath();ctx.moveTo(x,top);ctx.lineTo(x,top+height);ctx.stroke();}
  ctx.fillStyle='#7b8581';ctx.textBaseline='top';ctx.textAlign='left';ctx.fillText('1 phút',left,rect.height-bottom+5);ctx.textAlign='center';ctx.fillText('30 giây',left+width/2,rect.height-bottom+5);ctx.textAlign='right';ctx.fillText('hiện tại',left+width,rect.height-bottom+5);
  for(const line of series){const values=line.values||[];if(values.length<2)continue;const offset=Math.max(0,30-values.length);ctx.strokeStyle=line.color;ctx.lineWidth=1.8;ctx.lineJoin='round';ctx.lineCap='round';ctx.beginPath();values.forEach((value,index)=>{const x=left+(offset+index)/29*width,y=top+height-Math.max(0,Math.min(1,value/max))*height;if(index)ctx.lineTo(x,y);else ctx.moveTo(x,y);});ctx.stroke();}
}

const resourceColors=['#e91e63','#ff7f2a','#ffd600','#a8e63c','#7e57c2','#00a7a7','#607d8b','#f44336','#8bc34a','#03a9f4','#c2185b','#9c27b0'];
function renderResourceCharts() {
  const coreSeries=Object.entries(resourceHistory.cores).map(([name,values],index)=>({name,values,color:resourceColors[index%resourceColors.length]}));
  drawResourceChart('cpu-history',coreSeries,{max:100});
  $('#cpu-cores-grid').innerHTML=coreSeries.map(line=>`<div class="cpu-core-legend"><i style="background:${line.color}"></i><b>${esc(line.name.toUpperCase())}</b><span>${(line.values.at(-1)||0).toFixed(1)}%</span></div>`).join('');
  drawResourceChart('memory-history',[{values:resourceHistory.memory,color:'#d4145a'},{values:resourceHistory.swap,color:'#45a83d'}],{max:100});
  const networkMax=Math.max(1024,...resourceHistory.networkDown,...resourceHistory.networkUp);
  drawResourceChart('network-history',[{values:resourceHistory.networkDown,color:'#1683cf'},{values:resourceHistory.networkUp,color:'#f04432'}],{max:networkMax,valueLabel:value=>formatRate(value)});
}

const healthValues={cpu:null,memory:null,disk:null,temperature:null};
const healthThresholdDefaults={cpu:85,memory:90,disk:90,temperature:80};
function healthThreshold(key){const input=$(`#health-${key==='memory'?'ram':key==='temperature'?'temp':key}-threshold`);const value=Number(input?.value);return Number.isFinite(value)?value:healthThresholdDefaults[key];}
function updateMonitorHealth(values={}) {
  Object.assign(healthValues,values);const warnings=[];
  for(const [key,label] of [['cpu','CPU'],['memory','RAM'],['disk','Ổ đĩa'],['temperature','Nhiệt độ']]){
    const value=healthValues[key];if(Number.isFinite(value)&&value>=healthThreshold(key))warnings.push(`${label} ${value.toFixed(1)}${key==='temperature'?' °C':'%'}`);
  }
  const status=$('#monitor-health-status');
  status.classList.toggle('alert',warnings.length>0);status.classList.toggle('healthy',!warnings.length);
  status.textContent=warnings.length?`Cảnh báo: ${warnings.join(' · ')}`:`Trong ngưỡng · CPU ${Number.isFinite(healthValues.cpu)?healthValues.cpu.toFixed(1)+'%':'—'} · RAM ${Number.isFinite(healthValues.memory)?healthValues.memory.toFixed(1)+'%':'—'} · ổ đĩa ${Number.isFinite(healthValues.disk)?healthValues.disk.toFixed(1)+'%':'—'} · nhiệt độ ${Number.isFinite(healthValues.temperature)?healthValues.temperature.toFixed(1)+' °C':'không có cảm biến'}.`;
}
function initHealthThresholds(){
  for(const [key,defaultValue] of Object.entries(healthThresholdDefaults)){
    const input=$(`#health-${key==='memory'?'ram':key==='temperature'?'temp':key}-threshold`);if(!input)continue;
    input.value=localStorage.getItem(`filescope-health-${key}`)||defaultValue;
    input.onchange=()=>{localStorage.setItem(`filescope-health-${key}`,String(healthThreshold(key)));updateMonitorHealth();};
  }
  updateMonitorHealth();
}

async function loadResources() {
  const data=await api('/api/system/resources'),elapsed=data.sampled_at-(resourceSample?.sampled_at||data.sampled_at);
  updateMonitorPollInterval(data.poll_interval_ms);
  const previousCpus=new Map((resourceSample?.cpus||[]).map(cpu=>[cpu.name,cpu.ticks]));
  const cores=data.cpus.map(cpu=>({name:cpu.name,percent:Number.isFinite(cpu.percent)?Math.max(0,Math.min(100,cpu.percent)):resourceCpuPercent(cpu.ticks,previousCpus.get(cpu.name))}));
  updateMonitorHealth({cpu:cores.length?Math.max(...cores.map(core=>core.percent)):null,memory:data.memory.percent,temperature:data.temperature?.celsius??null});
  const coreNames=new Set(cores.map(core=>core.name));
  Object.keys(resourceHistory.cores).forEach(name=>{if(!coreNames.has(name))delete resourceHistory.cores[name];});
  cores.forEach(core=>{const history=resourceHistory.cores[core.name]||(resourceHistory.cores[core.name]=[]);history.push(core.percent);if(history.length>30)history.shift();});
  const previousInterfaces=new Map((resourceSample?.interfaces||[]).map(item=>[item.name,item]));
  const interfaces=data.interfaces.map(item=>{const before=previousInterfaces.get(item.name);return {...item,rx_rate:before&&elapsed>0?Math.max(0,(item.rx_bytes-before.rx_bytes)/elapsed):0,tx_rate:before&&elapsed>0?Math.max(0,(item.tx_bytes-before.tx_bytes)/elapsed):0};});
  resourceSample=data;
  resourceHistory.memory.push(data.memory.percent);resourceHistory.swap.push(data.swap.percent);
  resourceHistory.networkDown.push(interfaces.reduce((sum,item)=>sum+item.rx_rate,0));resourceHistory.networkUp.push(interfaces.reduce((sum,item)=>sum+item.tx_rate,0));
  for(const key of ['memory','swap','networkDown','networkUp'])if(resourceHistory[key].length>30)resourceHistory[key].shift();
  const received=interfaces.reduce((sum,item)=>sum+item.rx_bytes,0),sent=interfaces.reduce((sum,item)=>sum+item.tx_bytes,0);
  const memoryUsed=data.memory.display_used||systemBytes(data.memory.used),memoryTotal=data.memory.display_total||systemBytes(data.memory.total);
  $('#memory-detail').textContent=`${memoryUsed} (${data.memory.percent.toFixed(1)}%) của ${memoryTotal}`;
  $('#memory-cache').textContent=data.memory.cache===null?'Cache —':`Cache ${systemBytes(data.memory.cache)}`;
  $('#swap-detail').textContent=data.swap.total?`${systemBytes(data.swap.used)} (${data.swap.percent.toFixed(1)}%) của ${systemBytes(data.swap.total)}`:'Không có swap';
  $('#network-download').textContent=formatRate(resourceHistory.networkDown.at(-1)||0);
  $('#network-upload').textContent=formatRate(resourceHistory.networkUp.at(-1)||0);
  $('#network-received-total').textContent=`Tổng nhận ${size(received)}`;
  $('#network-sent-total').textContent=`Tổng gửi ${size(sent)}`;
  $('#network-interfaces').innerHTML=interfaces.map(item=>`<div class="network-interface"><b>${esc(item.name)}</b><span>↓ ${formatRate(item.rx_rate)}</span><span>↑ ${formatRate(item.tx_rate)}</span></div>`).join('')||'<p class="muted">Không có giao diện mạng.</p>';
  $('#network-resource-section').classList.toggle('hidden',data.network_supported===false);
  renderResourceCharts();
}

async function loadDisk() {
  try {
    const data = await api('/api/disk');
    updateMonitorHealth({disk:data.partitions.length?Math.max(...data.partitions.map(partition=>partition.percent)):null});
    $('#disk-grid').innerHTML = data.partitions.map(partition => `<article class="disk-card"><div class="disk-head"><span class="disk-icon">◉</span><span><b>${esc(partition.mount)}</b><small>Phân vùng</small></span><b class="percent">${partition.percent}%</b></div><div class="progress"><i style="width:${Math.min(partition.percent, 100)}%"></i></div><div class="disk-stats"><span><b>${size(partition.used)}</b><small>Đã sử dụng</small></span><span><b>${size(partition.free)}</b><small>Còn trống</small></span><span><b>${size(partition.total)}</b><small>Tổng dung lượng</small></span></div>${partition.free<data.reserve?`<p class="capacity-warning">Dung lượng trống thấp hơn mức dự phòng ${size(data.reserve)}.</p>`:''}</article>`).join('') || '<p>Không đọc được thông tin phân vùng.</p>';
  } catch (error) { toast(error.message, true); }
}
$('#refresh-disk').onclick = loadDisk;
$$('[data-monitor-tab]').forEach(button=>button.onclick=()=>selectMonitorTab(button.dataset.monitorTab));
$('#refresh-monitor').onclick=()=>monitorTab==='storage'?loadDisk():refreshMonitorTab();
$('#process-query').oninput=()=>renderProcesses(true);
$('#process-history-select').onchange=event=>{selectedProcessHistoryPid=event.target.value;processHistorySamples=[];recordProcessHistory();};
$('#process-detail-close').onclick=()=>$('#process-detail-panel').classList.add('hidden');
$$('[data-process-sort]').forEach(button=>button.onclick=()=>{const key=button.dataset.processSort;if(processSort.key===key)processSort.direction*=-1;else{processSort.key=key;processSort.direction=['cpu_percent','memory_bytes'].includes(key)?-1:1;}renderProcesses(true);});
initHealthThresholds();
window.addEventListener('resize',()=>{if(!$('#monitor-view').classList.contains('hidden')&&monitorTab==='resources')renderResourceCharts();});

