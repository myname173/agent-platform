// Caddy HTTPS 入口验收探针。
// 三个坑，都踩过：
//  1. 必须绕过系统代理（https_proxy 会劫持 CONNECT 隧道）
//  2. Caddy 的路由按 **Host 头** 匹配，不是按 SNI。连 127.0.0.1 会带
//     Host: 127.0.0.1:8445，匹配不到站点，得到 Caddy 的默认空 200（看起来像"代理坏了"）。
//     所以 host 必须写成证书里的名字：localhost 或 LAN_IP。
//  3. Node 对 IP 默认不发 SNI，用 LAN IP 访问时要显式给 servername。
import https from 'node:https';

const LAN = process.env.LAN_IP || '192.168.209.141';
const targets = [
  { port: 8443, name: '控制台', path: '/', re: /<title[^>]*>([^<]{0,60})/i },
  { port: 8444, name: 'LobeHub', path: '/', re: /<title[^>]*>([^<]{0,60})/i },
  { port: 8445, name: 'n8n', path: '/healthz', re: null },
  { port: 8446, name: 'MinIO', path: '/', re: /<title[^>]*>([^<]{0,60})/i },
];

function get(host, port, path) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const req = https.request(
      { host, port, path, method: 'GET', servername: host, rejectUnauthorized: false, timeout: 20000,
        headers: { 'User-Agent': 'caddy-probe/1.0', Accept: 'text/html,*/*' } },
      (res) => {
        const chunks = [];
        let n = 0;
        res.on('data', (c) => { chunks.push(c); n += c.length; if (n > 300000) res.destroy(); });
        res.on('end', () => fin(res, chunks, n, t0, resolve));
        res.on('close', () => fin(res, chunks, n, t0, resolve));
      }
    );
    req.on('error', (e) => resolve({ ok: false, ms: Date.now() - t0, err: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, ms: Date.now() - t0, err: 'timeout' }); });
    req.end();
  });
}
let done = false;
function fin(res, chunks, n, t0, resolve) {
  if (done) return;
  done = true;
  resolve({ ok: true, status: res.statusCode, bytes: n, ms: Date.now() - t0,
    ctype: res.headers['content-type'] || '', via: res.headers['via'] || '',
    body: Buffer.concat(chunks).toString('utf8') });
}

let pass = 0, fail = 0;
for (const host of ['localhost', LAN]) {
  console.log(`\n===== Host = ${host} =====`);
  for (const t of targets) {
    done = false;
    const r = await get(host, t.port, t.path);
    if (!r.ok) { console.log(`  :${t.port} ${t.name.padEnd(7)} FAIL ${r.ms}ms ${r.err}`); fail++; continue; }
    const m = t.re ? t.re.exec(r.body) : null;
    const title = m ? String(m[1]).trim().slice(0, 40) : '';
    // "代理生效"的判据是 Via 头里带 Caddy，且上游给了正常响应。
    // 307/302 也算 —— 控制台跳 /auth/sign-in、LobeHub 跳登录页，都是上游自己的行为。
    const ok = /Caddy/.test(r.via) && r.status < 400 && r.bytes > 0;
    ok ? pass++ : fail++;
    console.log(
      `  ${ok ? 'OK ' : 'BAD'} :${t.port} ${t.name.padEnd(7)} HTTP ${r.status}  ${String(r.bytes).padStart(7)}B  ${String(r.ms).padStart(5)}ms  via="${r.via}"  ${r.ctype.slice(0, 28)}  ${title || r.body.slice(0, 40).replace(/\s+/g, ' ')}`
    );
  }
}
console.log(`\n结果：pass=${pass} fail=${fail}`);
