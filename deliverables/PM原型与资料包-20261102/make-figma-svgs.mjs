/**
 * make-figma-svgs.mjs
 * 生成可拖进 Figma 的分层 SVG 画板（每个 <g id> 导入后成为一个命名 Group，<text> 成为可编辑文本图层）。
 * 颜色取自仓库真实 token：vercel.css（控制台浅色）/ operations-dashboard.tsx:40-49（暗色指挥台）
 * / pivot-theme-v2.css:13-66（前台绿色玻璃）/ Telegram 客户端配色。
 * 用法：node deliverables/PM原型与资料包-20261102/make-figma-svgs.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'figma');
mkdirSync(OUT, { recursive: true });

const FONT = "Geist, 'Segoe UI', 'Microsoft YaHei', sans-serif";
const MONO = "'Geist Mono', 'Cascadia Mono', Consolas, monospace";

/* ---------- 调色（逐字取自仓库） ---------- */
const L = { bg:'#FCFCFC', card:'#FFFFFF', border:'#E6E6E6', fg:'#0A0A0A', muted:'#737373',
  primary:'#0A0A0A', accent:'#F0F0F0', ok:'#10B981', warn:'#F59E0B', bad:'#EF4444', info:'#3B82F6', cyan:'#06B6D4' };
const D = { bg:'#0B1220', card:'#111827', head:'#0D1526', border:'#1F2937', fg:'#E5E7EB', muted:'#9CA3AF',
  primary:'#3B82F6', accent:'#06B6D4', ok:'#10B981', warn:'#F59E0B', bad:'#EF4444', rowSel:'#0F1B33' };
const P = { bg:'#030712', glass:'rgba(15,23,42,.62)', glassSide:'rgba(10,16,31,.68)', border:'rgba(34,197,94,.22)',
  fg:'#F8FAFC', muted:'#94A3B8', primary:'#16A34A', accent:'#34D399', grad1:'#4ADE80', grad2:'#34D399', mint:'rgba(52,211,153,.4)' };
const T = { bg:'#0E1621', card:'#17212B', me:'#2B5278', fg:'#E9EDF2', muted:'#7D8AA0', green:'#8BE3AD', link:'#7DB8E8' };

/* ---------- 绘图基元 ---------- */
const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const g = (id, body, x=0, y=0) => `<g id="${esc(id)}" transform="translate(${x},${y})">${body}</g>`;
const rect = (x,y,w,h,{fill='none',stroke='none',rx=0,opacity=1,dash='',sw=1}={}) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${fill}" `
  + (stroke!=='none'?`stroke="${stroke}" stroke-width="${sw}"${dash?` stroke-dasharray="${dash}"`:''}`:'')
  + (opacity!==1?` opacity="${opacity}"`:'')+`/>`;
const txt = (x,y,s,{size=13,fill=L.fg,weight=400,anchor='start',fam=FONT,opacity=1,spacing=0}={}) =>
  `<text x="${x}" y="${y}" font-family="${fam}" font-size="${size}" font-weight="${weight}" fill="${fill}" `
  + `text-anchor="${anchor}"${opacity!==1?` opacity="${opacity}"`:''}${spacing?` letter-spacing="${spacing}"`:''}>${esc(s)}</text>`;
const lines = (x,y,arr,{size=12,fill=L.fg,lh=16,weight=400,fam=FONT}={}) =>
  arr.map((t,i)=>txt(x,y+i*lh,t,{size,fill,weight,fam})).join('');
const circle = (cx,cy,r,{fill,stroke='none',sw=1}) =>
  `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}"${stroke!=='none'?` stroke="${stroke}" stroke-width="${sw}"`:''}/>`;
const line = (x1,y1,x2,y2,{stroke=L.border,sw=1,dash=''}={}) =>
  `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-width="${sw}"${dash?` stroke-dasharray="${dash}"`:''}/>`;
const arrow = (x1,y1,x2,y2,{stroke=L.muted,sw=1.5,label='',c={}}={}) => {
  const a = Math.atan2(y2-y1,x2-x1), h=6;
  const p1 = `${x2},${y2}`;
  const p2 = `${(x2-h*Math.cos(a-0.4)).toFixed(1)},${(y2-h*Math.sin(a-0.4)).toFixed(1)}`;
  const p3 = `${(x2-h*Math.cos(a+0.4)).toFixed(1)},${(y2-h*Math.sin(a+0.4)).toFixed(1)}`;
  return `<g id="FlowArrow"><path d="M${x1},${y1} L${x2},${y2}" stroke="${stroke}" stroke-width="${sw}"/>`
    + `<polygon points="${p1} ${p2} ${p3}" fill="${stroke}"/>`
    + (label?txt((x1+x2)/2,(y1+y2)/2-5,label,{size:10,fill:stroke,...c}):'')+`</g>`;
};

/* 语义组件 */
const badge = (x,y,label,color,bgOpacity=.14) => {
  const w = 12 + label.length*6.2;
  return g('Badge/'+label, rect(0,0,w,18,{fill:color,rx:9,opacity:bgOpacity})+rect(0,0,w,18,{stroke:color,rx:9,sw:.8})
    +txt(w/2,12.5,label,{size:10,fill:color,anchor:'middle',weight:600}), x, y);
};
const btn = (x,y,label,{dark=false,primary=false}={}) => {
  const w = 16 + label.length*6.6, h=28;
  const fill = primary ? (dark?D.primary:L.primary) : (dark?D.card:L.card);
  const stroke = dark?D.border:L.border, fg = primary?'#FFFFFF':(dark?D.fg:L.fg);
  return g('Button/'+label, rect(0,0,w,h,{fill,stroke,rx:6})+txt(w/2,h/2+4,label,{size:11.5,fill:fg,anchor:'middle',weight:primary?600:400}), x, y);
};
const kpi = (x,y,w,label,value,sub,t=L) => g('KPI/'+label,
  rect(0,0,w,92,{fill:t.card,stroke:t.border,rx:8})
  +txt(14,24,label,{size:11,fill:t.muted})
  +txt(14,52,value,{size:22,weight:650,fill:t.fg})
  +txt(14,74,sub,{size:10.5,fill:t.muted}), x, y);
const cardBox = (x,y,w,h,title,desc,t=L) => g('Card/'+title,
  rect(0,0,w,h,{fill:t.card,stroke:t.border,rx:8})
  +txt(16,26,title,{size:13.5,weight:600,fill:t.fg})
  +(desc?lines(16,42,desc.split('\n'),{size:10.5,fill:t.muted,lh:14}):''), x, y);
const tableRows = (y0,cols,rows,w,t=L,ox=0,rowH=26) => {
  const widths = cols.map(c=>c.w);
  let out = rect(ox,y0,w,rowH,{fill:t.head||t.accent||t.bg,stroke:'none',rx:4});
  let x = ox+10;
  cols.forEach(c=>{ out += txt(x,y0+16,c.t,{size:10.5,fill:t.muted,weight:600,anchor:c.a==='num'?'end':'start'}); x += widths[cols.indexOf(c)]; });
  rows.forEach((r,i)=>{
    const y = y0+rowH*(i+1);
    out += line(ox,y+rowH,ox+w,y+rowH,{stroke:t.border});
    let x2 = ox+10;
    r.forEach((cell,j)=>{
      const alignRight = cols[j].a==='num';
      if (typeof cell === 'object' && cell && cell.badge) out += badge(x2,y+4,cell.badge,cell.color);
      else out += txt(x2,y+16,cell,{size:11,fill:t.fg,anchor:alignRight?'end':'start'});
      x2 += widths[j];
    });
  });
  return out;
};
const sidebar = (items,t=L) => {
  let out = rect(0,0,248,900,{fill:t.bg,stroke:t.border,rx:0});
  out += circle(28,34,14,{fill:t.primary})+txt(28,38,'P',{size:12,fill:'#FFF',anchor:'middle',weight:700});
  out += txt(50,32,'Kiranism',{size:12.5,weight:600,fill:t.fg})+txt(50,46,'PivotAI 运营中控台',{size:10,fill:t.muted});
  let y = 74;
  for (const it of items) {
    if (it.group){ out += txt(18,y,it.group,{size:10,fill:t.muted,spacing:.5}); y += 18; continue; }
    if (it.active){ out += rect(12,y-13,224,28,{fill:t.accent,stroke:t.border,rx:6}); }
    out += rect(18,y-8,10,10,{fill:t.muted,rx:2});
    out += txt(36,y+1,it.t,{size:12,fill:t.fg,weight:it.active?600:400});
    if (it.kbd) out += txt(226,y+1,it.kbd,{size:9.5,fill:t.muted,anchor:'end',fam:MONO});
    y += 30;
  }
  return g('Sidebar/导航 5 组 14 项（13 业务页 + Profile）', out);
};
const topbar = (w,crumb,t=L) => g('Topbar/'+crumb,
  rect(0,0,w,52,{fill:t.bg,stroke:t.border})+line(0,52,w,52,{stroke:t.border})
  +txt(20,32,crumb,{size:12,fill:t.muted})
  +rect(w-300,14,220,26,{fill:t.card,stroke:t.border,rx:8})+txt(w-286,31,'搜索命令…',{size:11,fill:t.muted})+txt(w-96,31,'⌘K',{size:10,fill:t.muted,fam:MONO})
  +badge(w-70,17,'引擎正常',t.ok)+circle(w-24,26,13,{fill:t.primary})+txt(w-24,30,'黄',{size:10,fill:'#fff',anchor:'middle'}));

const BOARDS = [];   // 收集每张画板，用于最后合成“一次拖入”的合板文件
const svgFile = (name,width,height,body,note='') => {
  BOARDS.push({ name, width, height, body, note });
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!-- ${note} -->
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
${body}
</svg>\n`;
  writeFileSync(join(OUT,name), xml, 'utf8');
  return { name, width, height, bytes: Buffer.byteLength(xml,'utf8'), groups:(xml.match(/<g id=/g)||[]).length, texts:(xml.match(/<text /g)||[]).length };
};
const frame = (title,width,height,fill,body) => g('Frame/'+title, rect(0,0,width,height,{fill,stroke:'none'})+body);

const out = [];

/* ============ 01 控制台 Overview 1440x900 ============ */
out.push(svgFile('01-控制台-Overview-1440x900.svg',1440,900,
  frame('控制台 Overview',1440,900,L.bg,
    sidebar([
      {group:'今日'},{t:'Overview',kbd:'o o',active:true},
      {group:'内容'},{t:'Docs',kbd:'d c'},{t:'Knowledge',kbd:'k b'},{t:'Topics',kbd:'t w'},{t:'Briefs',kbd:'b r'},
      {group:'协作'},{t:'People',kbd:'p p'},{t:'Playground',kbd:'p g'},
      {group:'平台'},{t:'Operations',kbd:'p o'},{t:'Keys',kbd:'k k'},{t:'Alerts',kbd:'a l'},{t:'Models',kbd:'m o'},{t:'Settings',kbd:'s e'},
      {group:'Account'},{t:'Profile'},{t:'Notifications'}
    ])
    + g('Main', rect(0,0,1192,900,{fill:L.bg})
      + topbar(1192,'今日 / Overview')
      + g('Page/Platform Overview',
          txt(24,86,'Platform Overview',{size:19,weight:640,fill:L.fg})
          + txt(24,106,'平台运行总览：对话、告警、知识库与嵌入额度。',{size:12,fill:L.muted})
          + btn(1040,70,'刷新')+btn(1100,70,'立即自检',{primary:true})
          /* KPI 行 */
          + kpi(24,124,272,'近 24h 对话量','38 轮','▲ 9 vs 昨日同时段 · R-OV-01')
          + kpi(308,124,272,'错误率','2.1%','累计 7/331 · 口径含网关，不含 admin webhook')
          + kpi(592,124,272,'平均延迟','1,840 ms','p95 4,620 ms（示意）')
          + kpi(876,124,272,'近 24h 成本','$0.0091','预算 $2 · 用量 0.5%')
          /* 三卡 */
          + cardBox(24,232,368,236,'最近告警','chat-alerts 每 15 分钟一轮；warn→critical 升级不受 24h 去重限制 · R-OV-02')
          + tableRows(232+70,['t告警','类型','级别','消息','触达'].map((x,i)=>({t:['时间','类型','级别','消息','触达'][i],w:[68,80,56,100,40][i]})),
              [['10:41','error_rate',{badge:'warn',color:L.warn},'错误率 60%（6/10）',{badge:'已触达',color:L.ok}],
               ['09:12','cost_budget',{badge:'warn',color:L.warn},'24h 花费超预算',{badge:'已触达',color:L.ok}],
               ['昨日','embedding_quota',{badge:'critical',color:L.bad},'额度 96% 已用',{badge:'触达失败',color:L.bad}]],344,L,24)
          + cardBox(404,232,368,236,'知识库','文档数 / 分块 / 嵌入额度；分块超长会让当日自检失败 · R-OV-03')
          + kpi(420,300,160,'文档','14','生效 12 · 下架 2')
          + kpi(592,300,160,'分块','812','HNSW · 1024 维')
          + rect(420,404,336,8,{fill:L.accent,rx:4})+rect(420,404,77,8,{fill:L.info,rx:4})
          + txt(420,428,'嵌入额度 23% · 231k / 1M tokens',{size:10.5,fill:L.muted})
          + cardBox(784,232,368,236,'推送与触达','晨报自动推送当前关闭；告警与提醒正常推送 · R-OV-04')
          + badge(804,300,'Telegram 已配置',L.ok)+badge(940,300,'团队 Webhook 未配置',L.warn)
          + btn(804,340,'发送测试推送')
          /* 今日段 */
          + txt(24,502,'今日',{size:12.5,weight:600,fill:L.fg})+txt(60,502,'需要你动手或等别人回话的事',{size:11,fill:L.muted})
          + line(100,498,1148,498,{stroke:L.border})
          + cardBox(24,516,368,200,'待办','待办不自动变提醒、提醒不自动变待办（设计红线）· R-TD-01')
          + lines(40,560,['☐ 周五交房租 · 逾期 1 天','☐ 整理季度 OKR · 今日到期','☐ 约阿哲对账流程 · 今日到期','☐ 给 Lily 发模板 · 11-08'],{size:11.5,fill:L.fg,lh:22})
          + btn(300,540,'完成',{primary:true})
          + cardBox(404,516,368,200,'提醒','控制台「取消」与 TG「知道了」写同一行 · R-RM-01')
          + tableRows(516+64,['标题','触发时间','状态','操作'].map((t,i)=>({t,w:[120,88,54,40][i]})),
              [['对账','15:00',{badge:'待触发',color:L.info},'取消'],
               ['归档','11-03',{badge:'待触发',color:L.info},'取消']],336,L,404)
          + cardBox(784,516,368,200,'派发','负责人无通道时回落机主并标 degraded · R-DP-01')
          + tableRows(516+64,['负责人','开放','逾期','待回执','通道'].map((t,i)=>({t,w:[112,52,52,56,64][i]})),
              [['阿哲','2','2','1',{badge:'TG',color:L.ok}],
               ['Lily','1','0','0',{badge:'Webhook',color:L.info}],
               ['老周','0','0','0',{badge:'无通道',color:L.warn}]],336,L,784)
          /* 平台段 */
          + txt(24,756,'平台',{size:12.5,weight:600,fill:L.fg})+txt(60,756,'运行状态与已经沉淀下来的内容',{size:11,fill:L.muted})
          + line(100,752,1148,752,{stroke:L.border})
          + cardBox(24,770,540,110,'平台自检','48 项 · 手动与定时分别统计 · POST /webhook/admin/selfcheck/run · R-SC-01')
          + txt(40,820,'最近一次：48/48 全绿（2026-10-30 实机）',{size:11.5,fill:L.fg})
          + cardBox(580,770,572,110,'模型成本','告警复用 Chat Stats 的成本数、不自己重算 · R-CF-01')
          + txt(596,814,'24h $0.0091 · 7d $0.1133 · 累计 $0.4745',{size:11.5,fill:L.fg})
          + rect(596,830,540,7,{fill:L.accent,rx:4})+rect(596,830,3,7,{fill:L.info,rx:4})
        )
    , 248, 0),0, 0),
  '控制台总览页 · 1440x900 · 对应 frontent/src/features/overview/components/platform-overview.tsx'))

/* ============ 02 Operations 暗色 ============ */
out.push(svgFile('02-控制台-Operations-暗色-1440x900.svg',1440,900,
  frame('控制台 Operations（暗色指挥台）',1440,900,D.bg,
    sidebar([
      {group:'今日'},{t:'Overview',kbd:'o o'},{group:'内容'},{t:'Docs',kbd:'d c'},{t:'Knowledge',kbd:'k b'},{t:'Topics',kbd:'t w'},{t:'Briefs',kbd:'b r'},
      {group:'协作'},{t:'People',kbd:'p p'},{t:'Playground',kbd:'p g'},
      {group:'平台'},{t:'Operations',kbd:'p o',active:true},{t:'Keys',kbd:'k k'},{t:'Alerts',kbd:'a l'},{t:'Models',kbd:'m o'},{t:'Settings',kbd:'s e'},
      {group:'Account'},{t:'Profile'},{t:'Notifications'}
    ],{...D,bg:'#0D1526',accent:D.rowSel})
    + g('Main', rect(0,0,1192,900,{fill:D.bg})
      + topbar(1192,'平台 / Operations',D)
      + txt(24,86,'运行态势',{size:19,weight:640,fill:D.fg})
      + txt(24,106,'Chat Gateway · 实时执行健康度',{size:12,fill:D.muted})
      + badge(700,68,'引擎正常',D.ok)+btn(790,64,'刷新',{dark:true})
      + g('RangeChips/全部 1h 24h 7d', ['全部','1h','24h','7d'].map((c,i)=>
          rect(866+i*54,66,50,26,{fill:i===2?D.primary:'none',stroke:i===2?D.primary:D.border,rx:13})
          + txt(891+i*54,83,c,{size:10.5,fill:i===2?'#fff':D.muted,anchor:'middle'})).join(''))
      + kpi(24,124,272,'总调用','331','窗口内 · 计数器随容器重启归零',D)
      + g('KPI/成功率环', rect(0,0,272,92,{fill:D.card,stroke:D.border,rx:8})
        + txt(14,24,'成功率',{size:11,fill:D.muted})+txt(14,74,'324 / 331',{size:10.5,fill:D.muted})
        + circle(212,46,34,{fill:'none',stroke:D.border,sw:6})
        + `<circle cx="212" cy="46" r="34" fill="none" stroke="${D.ok}" stroke-width="6" stroke-linecap="round" stroke-dasharray="213.6" stroke-dashoffset="4.5" transform="rotate(-90 212 46)"/>`
        + txt(212,51,'97.9%',{size:13,fill:D.fg,anchor:'middle',fam:MONO}), 308,124)
      + kpi(592,124,272,'平均延迟','1,840 ms','p95 4,620 ms（示意）',D)
      + kpi(876,124,272,'独立会话','12','unique_sessions',D)
      + cardBox(24,232,724,300,'最近执行（按延迟）','柱色 = success 绿 / error 红 · 点击行展开 error_raw（截断 2000 字符）· R-OP-01',D)
      + g('BarChart/延迟柱', Array.from({length:14},(_,i)=>{
          const hs=[38,62,45,91,52,77,120,64,49,58,103,71,44,66], ok=[1,1,1,0,1,1,0,1,1,1,0,1,1,1][i];
          const h=Math.min(96,hs[i]*0.7);
          return rect(40+i*48,400-h,34,h,{fill:ok?'#10B981':'#EF4444'});}).join(''),0,0)
      + tableRows(232+182,['时间','状态','模型','来源','Session','延迟','Token','错误'].map((t,i)=>({t,w:[70,64,96,84,74,50,50,150][i]})),
        [['10:42:07',{badge:'success',color:D.ok},'deepseek-chat','lobechat','pg-…-a','1.9s','1.4k','—'],
         ['10:41:52',{badge:'error',color:D.bad},'deepseek-chat','stream-bridge','tg-…-7','0.6s','—','upstream 429'],
         ['10:41:30',{badge:'success',color:D.ok},'deepseek-reasoner','curl-test','kb-…-3','4.6s','3.1k','—']],
        700,D,24)
      + cardBox(764,232,392,142,'按 Model 分布','R-OP-02',D)
      + rect(780,300,300,7,{fill:D.border,rx:4})+rect(780,300,234,7,{fill:D.primary,rx:4})+txt(780,296,'deepseek-chat 258',{size:10,fill:D.muted})
      + rect(780,330,300,7,{fill:D.border,rx:4})+rect(780,330,51,7,{fill:D.accent,rx:4})+txt(780,326,'deepseek-reasoner 57',{size:10,fill:D.muted})
      + cardBox(764,386,392,146,'按 Client 分布','clientColor()：lobechat 蓝 / curl 青 / 其余灰 · R-OP-03',D)
      + rect(780,454,300,7,{fill:D.border,rx:4})+rect(780,454,183,7,{fill:D.primary,rx:4})+txt(780,450,'lobechat 202',{size:10,fill:D.muted})
      + rect(780,484,300,7,{fill:D.border,rx:4})+rect(780,484,72,7,{fill:D.accent,rx:4})+txt(780,480,'stream-bridge 80',{size:10,fill:D.muted})
      + cardBox(24,546,724,150,'异步任务','输入 task_id 查询，3 秒轮询 /api/platform/jobs/{id} 直到终态 · R-OP-04',D)
      + g('StatusChips', ['排队中','执行中','等待重试','已完成','失败'].map((c,i)=>
          rect(40+i*104,614,96,26,{fill:i===1?D.primary:'none',stroke:i===1?D.primary:D.border,rx:13})
          + txt(88+i*104,631,c,{size:10.5,fill:i===1?'#fff':D.muted,anchor:'middle'})).join(''),0,0)
      + g('降级横幅/401', rect(24,712,1132,46,{fill:'#2A1414',stroke:'#7F1D1D',rx:8})
        + txt(40,732,'401 降级横幅（真实文案）：n8n 拒绝了控制台的请求（CHAT_API_KEY 无效或已变更）',{size:11.5,fill:'#FCA5A5'})
        + txt(40,750,'这是服务端之间的问题，不是你的登录过期 · frontent/src/lib/api-guard.ts:32-40',{size:10,fill:'#9CA3AF'}),0,0)
      + txt(24,790,'空态三句原文：「还没有执行记录」／「暂无执行数据」／「没有符合筛选条件的执行」',{size:10.5,fill:D.muted})
    , 248, 0),0,0),
  '运营指挥台 · 配色取 operations-dashboard.tsx:40-49 的 C 常量'))

/* ============ 03 Keys ============ */
out.push(svgFile('03-控制台-Keys-1440x900.svg',1440,900,
  frame('控制台 Keys（含签发一次性展示）',1440,900,L.bg,
    sidebar([{group:'平台'},{t:'Keys',kbd:'k k',active:true}],L)
    + g('Main', rect(0,0,1192,900,{fill:L.bg})
      + topbar(1192,'平台 / Keys')
      + txt(24,86,'API Keys',{size:19,weight:640})
      + txt(24,106,'主 key 之外为其他客户端签发托管 key：哈希存储、泄露即废、可单独吊销与限速',{size:12,fill:L.muted})
      + btn(1040,70,'签发新 Key',{primary:true})
      + cardBox(24,124,1132,330,'API Keys','原始 key 只在创建响应里出现一次；库里只有 SHA-256 · R-KK-01')
      + tableRows(124+70,['名称','状态','限流 (rpm)','预算（日/月）','滚动已用','累计成本','指纹','创建时间','操作'].map((t,i)=>({t,w:[92,74,72,96,84,84,92,92,150][i]})),
        [['phone',{badge:'启用',color:L.ok},'10','$3 / $40','6 / 60s','$0.1120','a91f…c2','10-18 11:02','停用 · 限额 · 预算 · 删除'],
         ['kiosk-web',{badge:'启用',color:L.ok},'30','$10 / $120','12 / 60s','$0.2431','7bd0…19','10-22 09:40','停用 · 限额 · 预算 · 删除'],
         ['legacy-app',{badge:'已吊销',color:L.bad},'0','不限','0 / 60s','$0.0310','f1e4…88','09-28 17:21','启用 · 删除']],1100,L,24)
      + lines(24,470,['限流按 key 维护 60 秒滚动窗口（以 chat_executions 落库计数），超限 429。',
        '牌价调整要同步改 chat-gateway 的 Prep Success Log 节点 PRICING 表，否则 cost_usd 与真实花费脱钩。'],{size:10.5,fill:L.muted,lh:16})
      + g('Dialog/Key 已创建（只显示这一次）',
          rect(560,560,560,236,{fill:'#FFFFFF',stroke:L.border,rx:12})
          + txt(584,596,'Key 已创建（只显示这一次）',{size:14,weight:600})
          + txt(584,616,'请立刻复制并保存到密钥管理器；控制台与数据库都不再保留明文。',{size:11,fill:L.muted})
          + rect(584,636,512,56,{fill:L.accent,stroke:L.border,rx:8,dash:'4 3'})
          + txt(600,660,'sk-pivot_7c1f9a2d4b8e6f05a3c7d9e1b2f4a6c8',{size:11.5,fill:L.fg,fam:MONO})
          + btn(584,706,'复制')+btn(1020,706,'我已保存',{primary:true})
          + txt(584,770,'验收：关闭后任何入口都查不回明文（R-KK-02）',{size:10.5,fill:L.muted}),0,0)
    , 248, 0),0,0),
  'Keys 页 + 签发弹窗'))

/* ============ 04 Alerts ============ */
out.push(svgFile('04-控制台-Alerts-1440x900.svg',1440,900,
  frame('控制台 Alerts（触达渠道 + 规则口径 + 历史）',1440,900,L.bg,
    sidebar([{group:'平台'},{t:'Alerts',kbd:'a l',active:true}],L)
    + g('Main', rect(0,0,1192,900,{fill:L.bg})
      + topbar(1192,'平台 / Alerts')
      + txt(24,86,'告警',{size:19,weight:640})
      + txt(24,106,'chat-alerts 每 15 分钟一轮；阈值来自 .env，控制台只读展示实际生效值',{size:12,fill:L.muted})
      + btn(1040,70,'立即跑一轮',{primary:true})
      + cardBox(24,124,540,220,'触达渠道','未配置时告警仍写库，只是投递不出去——要把「没渠道」说清楚，而不是静默 · R-AL-01')
      + badge(40,180,'Telegram · 机主',L.ok)+badge(176,180,'团队 Webhook 未配置',L.warn)
      + btn(40,212,'发送测试通知')
      + txt(40,262,'silence 维护窗口只停止投递、仍然记录',{size:10.5,fill:L.muted})
      + cardBox(592,124,564,220,'规则与阈值','去重口径是这页的产品核心 · R-AL-02')
      + tableRows(124+64,['规则','触发条件','升级','去重口径'].map((t,i)=>({t,w:[96,168,90,180][i]})),
        [['error_rate','窗口 60min · 样本≥5 · ≥50%','≥80% critical','冷却 60 分钟'],
         ['cost_budget','24h 花费 ≥ $2','≥ $5 critical','24h 一次，升级不受限'],
         ['embedding_quota','kb_usage ≥ 80%','≥ 95% critical','同类 24h 一次']],532,L,592)
      + cardBox(24,360,1132,300,'告警历史','ops_alerts 表现有 4 条（实机行数）· R-AL-03')
      + tableRows(360+64,['时间','类型','消息','错误率','触达'].map((t,i)=>({t,w:[88,110,470,80,120][i]})),
        [['11-02 09:41','error_rate','错误率 60.0%（6/10，窗口 60 分钟）超过阈值 50%','60.0%',{badge:'已触达',color:L.ok}],
         ['11-01 22:05','cost_budget','24h 花费 $2.14 超过预算 $2','',{badge:'已触达',color:L.ok}],
         ['10-31 15:20','embedding_quota','嵌入额度 96% 已用（1M tokens/模型）','',{badge:'触达失败',color:L.bad}],
         ['10-30 04:20','selfcheck','备份心跳 41.2h 未更新，超过 40h 阈值','',{badge:'未配置渠道',color:L.warn}]],1100,L,24)
      + lines(24,684,['错误率口径陷阱：stats 的错误率只覆盖网关 chat_executions，admin webhook 侧的 500 不计入 ——',
        '所以「2.1% 错误率」与「提醒创建全挂」可以同时为真。这条要写进验收标准，不能只写在脑子里。'],{size:10.5,fill:L.muted,lh:16})
      + g('Empty/空态', rect(24,740,1132,60,{fill:L.accent,stroke:L.border,rx:8,dash:'5 4'})
        + txt(590,776,'暂无告警记录——平台安静运行中。',{size:12,fill:L.muted,anchor:'middle'}),0,0)
    , 248, 0),0,0),
  'Alerts 页'))

/* ============ 05 Knowledge ============ */
out.push(svgFile('05-控制台-Knowledge-1440x900.svg',1440,900,
  frame('控制台 Knowledge（文档库 / 检索演练 / 摄取守卫）',1440,900,L.bg,
    sidebar([{group:'内容'},{t:'Knowledge',kbd:'k b',active:true}],L)
    + g('Main', rect(0,0,1192,900,{fill:L.bg})
      + topbar(1192,'内容 / Knowledge')
      + txt(24,86,'私域知识库',{size:19,weight:640})
      + txt(24,106,'私域知识库：文档摄取、状态与嵌入额度。解析在浏览器端完成，文件不上传服务器',{size:12,fill:L.muted})
      + btn(1030,70,'摄取新文档',{primary:true})
      + kpi(24,124,368,'文档','14','生效中 12 · 已下架 2 · R-KB-01')
      + kpi(406,124,368,'分块','812','pgvector · HNSW · 1024 维')
      + kpi(788,124,368,'嵌入额度','23%','231k / 1M tokens · 模型 qwen3.7-text-embedding-flash')
      + cardBox(24,232,1132,272,'','')
      + g('Tabs', rect(24,232,1132,40,{fill:L.card,stroke:'none'})+line(24,272,1156,272,{stroke:L.border})
        + txt(50,258,'文档库 (14)',{size:12,weight:600})+rect(40,268,96,2,{fill:L.primary})
        + txt(170,258,'检索演练',{size:12,fill:L.muted}),0,0)
      + tableRows(286,['标题','来源','状态','分块','创建时间','操作'].map((t,i)=>({t,w:[300,150,110,90,150,180][i]})),
        [['中台架构说明 v3','上传 PDF',{badge:'生效中',color:L.ok},'128','10-28 10:04','下架 → 确认下架?'],
         ['埋点字段清单','上传 XLSX',{badge:'生效中',color:L.ok},'42','10-27 15:30','下架 → 确认下架?'],
         ['招商日报口径','粘贴文本',{badge:'生效中',color:L.ok},'17','10-25 09:12','下架 → 确认下架?'],
         ['旧版部署手册','上传 MD',{badge:'已下架',color:L.muted},'96','09-30 11:20','恢复']],1100,L,24)
      + cardBox(24,520,540,236,'检索演练','Input + Top K Slider + 6 快捷词；只读路径，不改数据 · R-KB-02')
      + rect(40,578,400,28,{fill:L.card,stroke:L.border,rx:6})+txt(52,596,'数据看板口径按自然周还是滚动 7 天？',{size:11})
      + btn(452,578,'检索',{primary:true})
      + g('Hit/0.81', rect(40,624,490,42,{fill:L.card,stroke:L.border,rx:6})+txt(54,644,'中台架构说明 v3 §4.2',{size:11.5,weight:600})
        +txt(54,660,'口径统一按自然周（ISO 周），滚动 7 天只用于成本窗口',{size:10.5,fill:L.muted})+badge(470,632,'0.81',L.ok),0,0)
      + txt(40,700,'空态原文：「未找到相关内容…」／未提交时「在上方输入查询…」',{size:10.5,fill:L.muted})
      + cardBox(592,520,564,236,'摄取新文档（守卫）','分块守卫：单块超长会让当日自检失败，而不是静默毁掉检索质量 · R-KB-03')
      + rect(608,578,520,56,{fill:L.accent,stroke:L.border,rx:8,dash:'5 4'})+txt(868,612,'拖拽文件到此，或多选 / 直接粘贴文本',{size:11,fill:L.muted,anchor:'middle'})
      + lines(608,660,['chunk#0 612 tokens   chunk#1 588   chunk#2 640','chunk#3 1980 tokens → 超阈值：当日自检判失败，而不是静默毁掉检索'],{size:11,fill:L.fg,lh:18})
      + txt(608,700,'按钮：摄取 4 篇（loading：摄取中…） · 查看任务 → /dashboard/workflows?task_id=',{size:10.5,fill:L.muted})
    , 248, 0),0,0),
  'Knowledge 页'))

/* ============ 06 前台 PivotAI ============ */
out.push(svgFile('06-LobeChat前台-PivotAI-1440x900.svg',1440,900,
  frame('LobeChat 前台 PivotAI v2（玻璃拟态 · 绿系）',1440,900,P.bg,
    g('Background/Aurora 三段', rect(0,0,1440,900,{fill:'rgba(52,211,153,.22)'})
      + `<ellipse cx="180" cy="180" rx="380" ry="300" fill="rgba(52,211,153,.22)"/>`
      + `<ellipse cx="1240" cy="760" rx="360" ry="280" fill="rgba(34,197,94,.24)"/>`
      + `<ellipse cx="720" cy="360" rx="420" ry="260" fill="rgba(16,185,129,.15)"/>`,0,0)
    + g('Sidebar/会话列表（玻璃）', rect(0,0,272,900,{fill:P.glassSide,stroke:P.border})
      + circle(34,42,15,{fill:P.accent})+txt(34,47,'P',{size:12,fill:'#052E16',anchor:'middle',weight:800})
      + txt(58,40,'PivotAI',{size:13.5,weight:600,fill:P.fg})+txt(58,54,'从对话到执行 · Chat less. Ship more.',{size:9,fill:P.muted})
      + rect(18,76,236,32,{fill:'rgba(34,197,94,.12)',stroke:P.border,rx:10})+txt(136,96,'＋ 新建对话',{size:11.5,fill:'#DCFCE7',anchor:'middle'})
      + txt(20,134,'今天',{size:10,fill:P.muted,spacing:.5})
      + rect(14,142,244,30,{fill:'rgba(15,23,42,.6)',rx:9})+rect(14,142,3,30,{fill:P.accent})+txt(28,161,'🗂 看板口径与埋点整理',{size:11.5,fill:P.fg})
      + txt(28,199,'📡 动态监控复核',{size:11.5,fill:'#CBD5E1'})
      + txt(20,232,'更早',{size:10,fill:P.muted,spacing:.5})
      + txt(28,254,'🧾 发票结构化试点',{size:11.5,fill:'#CBD5E1'})+txt(28,282,'⏱ 提醒为什么没响',{size:11.5,fill:'#CBD5E1'})
      + rect(14,310,244,86,{fill:'rgba(15,23,42,.4)',stroke:'rgba(245,158,11,.35)',rx:9,dash:'4 3'})
      + lines(24,330,['⚠ 已知现象','切到服务端数据库模式后，v1 存在浏览器本地的'],{size:10.5,fill:'#FCD34D',lh:15})
      + txt(24,348,'服务端 ⇒ 列表初始为空，需导入或重发',{size:10,fill:P.muted})
      + line(0,828,272,828,{stroke:P.border})+circle(34,858,14,{fill:P.primary})+txt(34,862,'黄',{size:10,fill:'#DCFCE7',anchor:'middle'})
      + txt(56,856,'黄泽华 · 设置/外观',{size:10.5,fill:P.muted}),0,0)
    + g('Composer/输入区', rect(300,738,1112,104,{fill:P.glass,stroke:P.border,rx:16})
      + txt(326,776,'问点什么，或说「跑一下 会议行动项，正文：…」',{size:12,fill:P.muted})
      + ['🌊 流式','🧠 深度思考','📚 知识库','🧷 记忆'].map((c,i)=>
          rect(326+i*104,800,96,26,{fill:i<4?'rgba(52,211,153,.16)':'none',stroke:P.border,rx:8})+txt(374+i*104,817,c,{size:10.5,fill:'#DCFCE7',anchor:'middle'})).join('')
      + rect(742,800,150,26,{fill:'none',stroke:P.border,rx:8})+txt(817,817,'🎙 语音（来→回语音）',{size:10,fill:P.muted,anchor:'middle'})
      + rect(900,800,150,26,{fill:'none',stroke:P.border,rx:8})+txt(975,817,'🖼 图片（>8MB 失败）',{size:10,fill:P.muted,anchor:'middle'})
      + rect(1350,796,34,34,{fill:P.accent,rx:9})+txt(1367,818,'↑',{size:14,fill:'#04231A',anchor:'middle',weight:800}),0,0)
    + g('Messages/对话流',
        g('Msg/用户', rect(1000,150,400,52,{fill:'rgba(15,23,42,.72)',stroke:'rgba(52,211,153,.16)',rx:14})
          + txt(1016,172,'帮我把「11 月看板口径」派给阿哲，周五到期；',{size:11.5,fill:P.fg})
          + txt(1016,190,'顺便把上周的对账笔记存进知识库。',{size:11.5,fill:P.fg}),0,0)
        + g('Msg/AI + 工具轨迹', rect(300,220,760,150,{fill:P.glass,stroke:P.border,rx:14})
          + rect(316,236,3,40,{fill:P.accent})+txt(328,252,'深度思考 · 实时流（2 轮工具循环）',{size:10.5,fill:P.accent,weight:600})
          + txt(328,270,'先落待办 → 校验负责人通道 → 再走 kb_save；两步都是副作用工具，需要幂等保护。',{size:10.5,fill:P.muted})
          + txt(316,300,'已建待办并派给阿哲（11-06 到期）。24h 未回执会催办，第 3 次升级给你。',{size:11.5,fill:P.fg})
          + txt(316,320,'对账笔记已存进知识库，切了 17 个分块。',{size:11.5,fill:P.fg})
          + rect(316,334,712,26,{fill:'rgba(34,197,94,.06)',stroke:'rgba(52,211,153,.2)',rx:9})
          + txt(328,351,'✔ todo_add · 812 ms · idem=implicit_hit(session+tool+sha256(args))',{size:10,fill:'#A7F3D0',fam:MONO}),0,0)
        + g('Msg/搜索后端故障护栏', rect(300,390,760,96,{fill:P.glass,stroke:'rgba(245,158,11,.4)',rx:14})
          + rect(316,406,712,26,{fill:'rgba(245,158,11,.08)',stroke:'rgba(245,158,11,.4)',rx:9})
          + txt(328,423,'⚠ web_search empty:true · unresponsive_engines=[brave,duckduckgo,google cse,startpage]',{size:10,fill:'#FCD34D',fam:MONO})
          + txt(316,458,'这一步我没能拿到外部资料（SearXNG 引擎全部被封）—— 不代表查不到。',{size:11,fill:P.fg}),0,0)
        + g('Topbar/模型与状态', rect(272,0,1168,56,{fill:'rgba(10,16,31,.68)',stroke:P.border})
          + txt(300,34,'看板口径与埋点整理',{size:13,weight:600,fill:P.fg})
          + rect(470,16,180,26,{fill:'rgba(15,23,42,.6)',stroke:P.border,rx:8})+txt(484,33,'deepseek-chat',{size:11,fill:'#E2E8F0'})
          + rect(664,16,120,26,{fill:'none',stroke:P.border,rx:13})+txt(724,33,'流式 · 首字 1–3s',{size:10,fill:P.accent,anchor:'middle'})
          + rect(796,16,168,26,{fill:'none',stroke:P.border,rx:13})+txt(880,33,'服务端工具 16 + wf_* · ≤2 轮',{size:10,fill:P.accent,anchor:'middle'})
          + txt(1180,33,'左上 LobeHub / 右上 PivotAI：品牌不一致是已知缺口',{size:10,fill:P.muted}),0,0),0,0),
  '前台 · 颜色取自 custom-theme/pivot-theme-v2.css（v2 是绿系，不是 README 里旧的蓝青）')))

/* ============ 07 Telegram 阶梯 ============ */
out.push(svgFile('07-Telegram-推送与派发阶梯-1600x900.svg',1600,900,
  frame('Telegram 通道 · 推送形态与派发状态机',1600,900,T.bg,
    g('Phone/推送流', rect(0,0,400,880,{fill:T.bg,stroke:'#1F2B3A',rx:26})
      + rect(0,0,400,60,{fill:T.card,stroke:'none',rx:26})+line(0,60,400,60,{stroke:'#0D151D'})
      + circle(30,30,17,{fill:P.accent})+txt(30,35,'P',{size:12,fill:'#04231A',anchor:'middle',weight:800})
      + txt(56,26,'PivotAI',{size:12.5,weight:600,fill:T.fg})+txt(56,42,'bot · 推送与提醒',{size:10,fill:T.muted})
      + g('Msg/晨报', rect(16,84,368,300,{fill:T.card,stroke:'none',rx:13})
        + txt(30,106,'📰 晨报 · 2026-11-02',{size:11.5,weight:700,fill:T.green})
        + lines(30,128,['AI 大模型 最新进展','• 工具调用轮次压到 2 轮以内 —— 标题','工作流自动化与 Agent 平台','• n8n 2.37.7 数据表响应体变更 —— 标题','科技互联网要闻','• … —— 标题'],{size:10.5,fill:T.fg,lh:17})
        + txt(30,240,'平台状态',{size:10.5,weight:600,fill:'#A7F3D0'})
        + txt(30,258,'昨日 84 轮对话 · 错误率 2.1% · 自检 48 项全绿',{size:10.5,fill:T.fg})
        + txt(30,282,'## 待办速览',{size:10.5,weight:600,fill:'#A7F3D0'})
        + lines(30,300,['• 逾期 1 条：周五交房租（10-31）','• 今日到期 2 条：整理季度 OKR、约阿哲对账','• 其他未完成 2 条'],{size:10,fill:T.fg,lh:15})
        + txt(30,362,'（完成任意一条：直接说「XXX 办完了」）',{size:9.5,fill:T.muted}),0,0)
      + g('Msg/告警', rect(16,400,368,64,{fill:T.card,stroke:'none',rx:13})
        + txt(30,424,'[PivotAI 告警] error_rate',{size:10.5,weight:700,fill:'#FCA5A5',fam:MONO})
        + txt(30,444,'错误率 60.0%（6/10，窗口 60 分钟）超过阈值 50%',{size:10.5,fill:T.fg,fam:MONO}),0,0)
      + g('Msg/动态监控', rect(16,480,368,110,{fill:T.card,stroke:'none',rx:13})
        + txt(30,502,'📡 动态监控 · 新发现 2 条',{size:11,weight:700,fill:T.green})
        + lines(30,524,['▸ n8n 自托管 更新','  • 2.37.7 改了 rows 响应体解析 —— https://…','▸ AI Agent 编排框架','  • 长上下文检索新基线 —— https://…'],{size:10,fill:T.fg,lh:16})
        + txt(30,578,'每关键词 1–3 条 · ≤60 字 · time_range=day · 同夜 seen 去重',{size:9.5,fill:T.muted}),0,0)
      + g('Msg/语音降级规则', rect(16,606,368,110,{fill:T.card,stroke:'none',rx:13})
        + txt(30,628,'🎙 双向语音 · 镜像模式',{size:11,weight:600,fill:T.fg})
        + lines(30,650,['来语音 → 回语音（qwen-tts · 音色 Cherry）','回复 ≤900 字才合成；>900 字自动降级文字','识别失败：「这条语音我没听清…」'],{size:10,fill:T.muted,lh:16}),0,0)
      + rect(16,740,368,40,{fill:'#242F3D',rx:20})+txt(40,765,'Message',{size:11,fill:T.muted})
      + circle(356,760,17,{fill:T.me})+txt(356,765,'🎙',{size:12,fill:'#CFE6FF',anchor:'middle'}),0,0)
    + g('Phone/派发与催办（可点按钮）', rect(420,0,400,880,{fill:T.bg,stroke:'#1F2B3A',rx:26})
      + rect(420,0,400,60,{fill:T.card,rx:26})+circle(450,30,17,{fill:P.primary})+txt(450,35,'哲',{size:11,fill:'#DCFCE7',anchor:'middle'})
      + txt(476,26,'阿哲',{size:12.5,weight:600,fill:T.fg})+txt(476,42,'执行者 · Telegram 已绑定',{size:10,fill:T.muted})
      + g('Card/新任务', rect(436,84,368,132,{fill:T.card,rx:13})
        + txt(450,106,'📌 新任务 · 11 月看板口径对齐',{size:11,weight:700,fill:T.green})
        + txt(450,124,'到期 11-06',{size:9.5,fill:T.muted})
        + lines(450,144,['出看板初稿：自然周口径 + 埋点字段清单','来自机主，已写入 todos'],{size:10,fill:T.fg,lh:16})
        + rect(436,190,368,26,{fill:T.card,stroke:'#0D151D',rx:5})+txt(620,207,'我收到了',{size:10.5,fill:'#6FC4FF',anchor:'middle'})
        + rect(436,216,368,26,{fill:T.card,stroke:'#0D151D',rx:5})+txt(620,233,'已完成',{size:10.5,fill:T.green,anchor:'middle'}),0,0)
      + g('Card/催办 第 1 次', rect(436,256,368,86,{fill:T.card,rx:13})
        + txt(450,278,'⏰ 待办催办 · 已逾期 1 天',{size:11,weight:700,fill:T.green})
        + txt(450,296,'remind_count 0→1 · 24h 冷却',{size:9.5,fill:T.muted,fam:MONO})
        + rect(436,320,184,24,{fill:T.card,stroke:'#0D151D',rx:5})+txt(528,336,'我收到了',{size:10,fill:'#6FC4FF',anchor:'middle'})
        + rect(620,320,184,24,{fill:T.card,stroke:'#0D151D',rx:5})+txt(712,336,'已完成',{size:10,fill:T.green,anchor:'middle'}),0,0)
      + g('Card/逾期升级（发机主）', rect(436,372,368,96,{fill:T.me,rx:13})
        + txt(450,394,'🚨 逾期升级 · 来自 阿哲',{size:11,weight:700,fill:'#E2E8F0'})
        + lines(450,414,['11 月看板口径对齐 · 逾期 3 天、催办 2 次无回执','escalated=1，之后不再动（>2）'],{size:10,fill:'#CFE6FF',lh:15})
        + rect(436,444,184,24,{fill:T.card,stroke:'#0D151D',rx:5})+txt(528,460,'已完成',{size:10,fill:T.green,anchor:'middle'})
        + rect(620,444,184,24,{fill:T.card,stroke:'#0D151D',rx:5})+txt(712,460,'推迟 1 天',{size:10,fill:'#6FC4FF',anchor:'middle'}),0,0)
      + g('Card/无通道回落', rect(436,500,368,92,{fill:T.me,rx:13})
        + txt(450,522,'📌 新任务（回落机主）',{size:11,weight:700,fill:'#E2E8F0'})
        + lines(450,542,['审阅财务模板','（注：老周 没有可用通道，已改投机主）· status degraded'],{size:10,fill:'#CFE6FF',lh:15})
        + rect(436,568,368,24,{fill:T.card,stroke:'#0D151D',rx:5})+txt(620,584,'已完成 · 推迟 1 天',{size:10,fill:'#6FC4FF',anchor:'middle'}),0,0)
      + g('Card/提醒（知道了 / 稍后）', rect(436,624,368,92,{fill:T.card,rx:13})
        + txt(450,646,'⏰ 提醒 · 15:00 提醒对账',{size:11,weight:700,fill:T.green})
        + txt(450,666,'与财务对一遍 10 月成交口径',{size:10,fill:T.fg})
        + rect(436,682,368,24,{fill:T.card,stroke:'#0D151D',rx:5})+txt(620,698,'知道了',{size:10,fill:'#6FC4FF',anchor:'middle'})
        + rect(436,708,368,22,{fill:T.card,stroke:'#0D151D',rx:5})+txt(620,723,'1 小时后再提醒',{size:10,fill:'#6FC4FF',anchor:'middle'}),0,0)
      + rect(436,740,368,40,{fill:'#242F3D',rx:20})+txt(460,765,'Message',{size:11,fill:T.muted}),0,0)
    + g('状态机侧栏/写回口径', rect(840,20,740,840,{fill:'#141D26',stroke:'#1F2B3A',rx:16})
      + txt(868,56,'派发状态机：每个按钮对应一次真实写库',{size:14,weight:600,fill:T.fg})
      + txt(868,76,'点完会清空按钮（editMessageReplyMarkup）防止重复点击；非机主只能对派给自己的 todo 做 ta / td',{size:10.5,fill:T.muted})
      + [['我收到了（ta）','写 todos.ack_at → 停催但不关单（确认收到 ≠ 完成，这条最容易做错）'],
         ['已完成（td）','POST /webhook/admin/todos/complete → status=done，催办链当场停止'],
         ['推迟 1 天（ts:24）','写 todos.due_date += 24h，remind_count 保留'],
         ['知道了（ap:rd:<id>）','/admin/reminders/cancel → status=canceled；⚠ 现网 n8n 2.37.7 写成功却回 500，留下孤儿提醒'],
         ['1 小时后再提醒（ap:rs）','写 reminders.due_at + status=pending'],
         ['阶梯与冷却','只催「已指派 + open + 逾期 + 未 ack」；0/1 催本人，≥2 升级机主并 escalated=1，>2 不再动；两级间 24h 冷却'],
         ['投递失败','attempts ≥2 → reminders.status=failed，否则 pending 等下一轮'],
         ['提醒投递失败 vs 待办催办','两个 kind 不同：待办催办 / 逾期升级 / 提醒，混用会让用户收到他没要求过的推送']]
        .map(([k,v],i)=>{
          const y=120+i*88;
          return rect(868,y,6,60,{fill:T.green})+txt(888,y+18,k,{size:12,weight:600,fill:T.fg})
            + lines(888,y+38,String(v).split('；').slice(0,2),{size:10.5,fill:T.muted,lh:15});
        }).join(''),0,0),
  'Telegram 端 · 消息形态取自 n8n/workflows/*.json 的真实文案')))

/* ============ 08 用户旅程 / IA ============ */
const body08 =
    g('IA/控制台 13 页 → n8n 端点',
      txt(24,36,'① 控制台信息架构（14 项导航 = 13 业务页 + Profile → 27 条 api route → 39 条 webhook 路径）',{size:15,weight:650})
      + [['今日','Overview','/webhook/admin/overview'],['内容','Docs','/webhook/admin/docforge'],['内容','Knowledge','/webhook/admin/kb/ingest'],
         ['内容','Topics','/webhook/admin/tools/topic-watch'],['内容','Briefs','admin/briefs · briefs/run'],['协作','People','admin/people/manage'],
         ['协作','Playground','/api/chat → stream-bridge:3211'],['平台','Operations','/api/v1/executions · stats'],
         ['平台','Keys','admin/keys/manage'],['平台','Alerts','admin/alerts · alerts/test'],['平台','Models','admin/models'],
         ['平台','Settings','admin/settings（只读）'],['Account','Profile / Notifications','Clerk / 模板 demo']]
        .map(([grp,name,ep],i)=>{ const col=Math.floor(i/5), row=i%5, x=24+col*300, y=60+row*74;
          return rect(x,y,286,64,{fill:'#FAFAFA',stroke:L.border,rx:8})+txt(x+12,y+22,grp+' / '+name,{size:11.5,weight:600})
            +txt(x+12,y+42,ep,{size:10,fill:L.muted,fam:MONO}); }).join(''),0,0)
    + g('Journey/一次派发的跨端旅程',
      txt(24,470,'② 跨端用户旅程：一句话 → 落库 → 触达 → 回执 → 升级（这条链路是平台的骨架）',{size:15,weight:650})
      + rect(24,500,296,120,{fill:'#F5F5F5',stroke:L.border,rx:10})
      + txt(40,528,'1 · 用户在 LobeHub 说一句',{size:12,weight:600})
      + lines(40,550,['「把 11 月看板口径派给阿哲，周五到期」','前端不互调：LobeHub → stream-bridge → n8n'],{size:10.5,fill:L.muted,lh:16})
      + rect(368,500,296,120,{fill:'#F5F5F5',stroke:L.border,rx:10})
      + txt(384,528,'2 · 网关工具循环（≤2 轮）',{size:12,weight:600})
      + lines(384,550,['todo_add + 负责人通道校验','幂等：session+工具+sha256(args)，300s 窗口'],{size:10.5,fill:L.muted,lh:16})
      + rect(712,500,296,120,{fill:'#F5F5F5',stroke:L.border,rx:10})
      + txt(728,528,'3 · 落库 + 触达',{size:12,weight:600})
      + lines(728,550,['todos / chat_executions / admin_audit','notify：有通道发本人，无通道回落机主 degraded'],{size:10.5,fill:L.muted,lh:16})
      + rect(1056,500,264,120,{fill:'#F5F5F5',stroke:L.border,rx:10})
      + txt(1072,528,'4 · 回执与催办',{size:12,weight:600})
      + lines(1072,550,['ta 停催不关单 / td 收口 / ts 顺延','0→1 催本人，≥2 升级，>2 静默'],{size:10.5,fill:L.muted,lh:16})
      + rect(1368,500,208,120,{fill:'#FFF7ED',stroke:L.warn,rx:10})
      + txt(1384,528,'5 · 可见性',{size:12,weight:600,fill:'#92400E'})
      + lines(1384,550,['控制台「今日」段 + 派发表','周报段【待办】完成/开放/逾期'],{size:10.5,fill:L.muted,lh:16})
      + [336,680,1024,1336].map(x=>arrow(x,560,x+32,560,{})).join('')
      + g('FailurePaths/失败与降级路径',
        txt(24,676,'③ 失败与降级：原型必须画的三条，而不是只画 happy path',{size:14,weight:650})
        + [['上游 401/403 → 502 + 「n8n 拒绝了控制台的请求」，不伪装成用户登录过期','R-EX-01'],
           ['web_search 返回 200 + results:[] → empty:true 透传，模型说「后端故障，不代表查不到」','R-EX-02'],
           ['凌晨定时任务在桌面机器上会漏跑 → 多时间点 + Already Ran Today 守卫（fail-open）','R-EX-03'],
           ['提醒写成功但响应 500（n8n 2.37.7）→ 孤儿提醒：现网真实缺陷，验收要单独一条','R-EX-04'],
           ['沙箱审批按 sha256(代码原文) 绑定、一次性；模型不能自行联网，人点火','R-EX-05']]
          .map(([t,id],i)=>rect(24,700+i*38,1552,32,{fill:i===3?'#FEF2F2':'#FAFAFA',stroke:i===3?L.bad:L.border,rx:6})
            +txt(40,720+i*38,t,{size:11,fill:i===3?'#991B1B':L.fg})+txt(1500,720+i*38,id,{size:10,fill:L.muted,fam:MONO})).join(''),0,0),0,0);
out.push(svgFile('08-信息架构与跨端用户旅程-1600x900.svg',1600,900,
  frame('信息架构与跨端用户旅程',1600,900,'#FFFFFF',body08),
  '信息架构 + 用户旅程 + 失败路径（③ 段的 R-EX-04 是现网真实缺陷，不能画成已完成）'));

/* ---------- 合板：把 8 张画板拼成 1 个文件，Figma 里只需一次拖入 ---------- */
const GAP = 60, COLS = 4;
const rows = [];
for (let i = 0; i < BOARDS.length; i += COLS) rows.push(BOARDS.slice(i, i + COLS));
const colW = [], rowH = [];
rows.forEach((r, ri) => {
  rowH[ri] = Math.max(...r.map(b => b.height));
  r.forEach((b, ci) => { colW[ci] = Math.max(colW[ci] || 0, b.width); });
});
const cols = Math.max(...rows.map(r => r.length));
const totalW = colW.slice(0, cols).reduce((a, b) => a + b, 0) + GAP * (cols - 1);
const totalH = rowH.reduce((a, b) => a + b, 0) + GAP * (rows.length - 1);
const parts = [];
let oy = 0;
rows.forEach((r, ri) => {
  let ox = 0;
  r.forEach((b, ci) => {
    parts.push(`<g id="Board/${b.name}" transform="translate(${ox},${oy})">${b.body}</g>`);
    ox += colW[ci] + GAP;
  });
  oy += rowH[ri] + GAP;
});
const combined = `<?xml version="1.0" encoding="UTF-8"?>
<!-- 合板：${BOARDS.length} 张画板一次拖入 Figma。每张是 Board/<文件名> 顶层组，内部保留 Frame/、Card/、KPI/、Badge/、Button/ 命名层级。 -->
<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(totalW)}" height="${Math.round(totalH)}" viewBox="0 0 ${Math.round(totalW)} ${Math.round(totalH)}">
${parts.join('\n')}
</svg>\n`;
const COMBINED_NAME = '00-合板-全部画板-一次拖入.svg';
writeFileSync(join(OUT, COMBINED_NAME), combined, 'utf8');
console.log(`合板 ${COMBINED_NAME}: ${Math.round(totalW)}×${Math.round(totalH)} · ${(Buffer.byteLength(combined) / 1024).toFixed(0)} KB · ${BOARDS.length} Board`);

console.table(out);
console.log('输出目录：', OUT);
