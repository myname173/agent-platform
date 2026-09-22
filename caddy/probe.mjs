// Caddy HTTPS 入口验收探针。
//
// 四个坑，全踩过，所以这个脚本刻意绕开它们：
//  1. 必须绕过系统代理（https_proxy 会劫持 CONNECT 隧道）
//  2. Caddy 的路由按 **Host 头** 匹配，不是按 SNI。连 127.0.0.1 会带
//     Host: 127.0.0.1:8445，匹配不到站点，得到 Caddy 的默认空 200 ——
//     看起来和"代理坏了"一模一样。所以 host 必须写成证书里的名字。
//  3. 用 IP 访问时客户端**不发 SNI**（RFC 6066 禁止），浏览器和 curl 都遵守。
//     没 SNI → Caddy 匹配不到站点 → 握手直接断（20ms 失败，不是超时也不是证书错）。
//     Caddyfile 用 default_sni 兜底，所以这里单开一节"不送 SNI"验一遍 —— 那才是手机的真实路径。
//  4. LobeHub 会用 APP_URL 拼绝对跳转地址把人送回 http。Caddyfile 里做了
//     header_down Location 重写，所以这里要断言 Location 仍是 https 且主机名不变。
import https from 'node:https';

const LAN = process.env.LAN_IP || '192.168.209.141';
const targets = [
  { port: 8443, name: '控制台', path: '/' },
  { port: 8444, name: 'LobeHub', path: '/' },
  { port: 8445, name: 'n8n', path: '/healthz' },
  { port: 8446, name: 'MinIO', path: '/' },
];

function get(host, port, path, { noSni = false } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const req = https.request(
      { host, port, path, method: 'GET',
        servername: noSni ? undefined : host,
        rejectUnauthorized: false, timeout: 20000,
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
    loc: res.headers['location'] || '',
    body: Buffer.concat(chunks).toString('utf8') });
}

let pass = 0, fail = 0;
const cases = [
  { label: 'Host = localhost（发 SNI）', host: 'localhost', noSni: false },
  { label: `Host = ${LAN}（发 SNI）`, host: LAN, noSni: false },
  { label: `Host = ${LAN}（不发 SNI，手机真实路径）`, host: LAN, noSni: true },
];

for (const c of cases) {
  console.log(`\n===== ${c.label} =====`);
  for (const t of targets) {
    done = false;
    const r = await get(c.host, t.port, t.path, { noSni: c.noSni });
    if (!r.ok) {
      console.log(`  BAD :${t.port} ${t.name.padEnd(7)} FAIL ${r.ms}ms ${r.err}`);
      fail++;
      continue;
    }
    // 代理生效的判据：Via 带 Caddy + 上游给了正常响应。
    // 307/302 也算 —— 控制台跳 /auth/sign-in、LobeHub 跳登录页都是上游自己的行为。
    let ok = /Caddy/.test(r.via) && r.status < 400 && r.bytes > 0;
    let note = '';
    if (ok && r.loc) {
      // LobeHub 的跳转必须留在 https，且主机名与入口一致（header_down Location 重写的结果）
      const staysHttps = r.loc.startsWith('https://') || r.loc.startsWith('/');
      const hostKept = !/https?:\/\//.test(r.loc) || r.loc.includes(c.host);
      const noCallbackLeak = !/callbackUrl=http%3A/i.test(r.loc);
      if (!staysHttps || !hostKept || !noCallbackLeak) ok = false;
      note = ` Location="${r.loc.slice(0, 72)}"`;
    }
    ok ? pass++ : fail++;
    console.log(
      `  ${ok ? 'OK ' : 'BAD'} :${t.port} ${t.name.padEnd(7)} HTTP ${r.status}  ${String(r.bytes).padStart(6)}B  ${String(r.ms).padStart(5)}ms  via="${r.via}"${note}`
    );
  }
}
console.log(`\n结果：pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
