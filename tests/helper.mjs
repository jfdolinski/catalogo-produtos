// Sobe um PostgreSQL descartável (PGlite, em memória) e o catálogo apontando para ele, numa porta livre.
// Cada arquivo de teste tem o seu banco: nada aqui toca em dados reais.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, () => { const { port } = s.address(); s.close(() => res(port)); }); });

export async function startStack({ env = {} } = {}) {
  const pg = await PGlite.create();
  const pgPort = await freePort();
  const pgServer = new PGLiteSocketServer({ db: pg, port: pgPort, host: '127.0.0.1' });
  await pgServer.start();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalogo-teste-'));
  const port = await freePort();
  const token = 'token-de-teste';
  const base = `http://localhost:${port}`;
  let logs = '';
  let srv;
  // Sobe o servidor (e de novo em restart(): o mesmo banco, como numa nova publicação)
  const boot = async () => {
    srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'src/server.js')], {
      cwd: ROOT,
      env: { ...process.env, DATA_DIR: dir, ADMIN_TOKEN: token, PORT: String(port), DATABASE_URL: `postgres://postgres@127.0.0.1:${pgPort}/postgres`, DB_POOL_MAX: '1', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    srv.stdout.on('data', (d) => { logs += d; });
    srv.stderr.on('data', (d) => { logs += d; });
    for (let i = 0; i < 200; i++) {
      try { if ((await fetch(`${base}/api/v1/categories`)).ok) break; } catch { /* subindo */ }
      if (srv.exitCode !== null) throw new Error(`o servidor parou ao subir:\n${logs}`);
      await wait(100);
    }
  };
  await boot();
  const restart = async () => {
    const exited = new Promise((r) => srv.once('exit', r));
    srv.kill();
    await exited;
    await boot();
  };
  const H = { Authorization: `Bearer ${token}` };
  const api = async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { ...H, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await r.text();
    let b; try { b = JSON.parse(text); } catch { b = text; }
    return { s: r.status, b, headers: r.headers };
  };
  const upload = async (url, files, fields = {}) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.append(k, v);
    const types = { png: 'image/png', jpg: 'image/jpeg', xml: 'text/xml', zip: 'application/zip', csv: 'text/csv', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
    for (const [k, name, content] of files) fd.append(k, new Blob([content], { type: types[name.split('.').pop()] ?? '' }), name);
    const r = await fetch(base + url, { method: 'POST', headers: H, body: fd });
    const text = await r.text();
    let b; try { b = JSON.parse(text); } catch { b = text; }
    return { s: r.status, b };
  };
  // Consulta direta no banco (mesmo processo do PGlite)
  const sql = async (q, ...params) => (await pg.query(q, params)).rows;
  const stop = async () => {
    srv.kill();
    await wait(300);
    await pgServer.stop().catch(() => {});
    await pg.close().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };
  return { base, port, dir, token, H, api, upload, sql, stop, restart, logs: () => logs, pg };
}

// Registro dos resultados; no fim, código de saída 1 se algo falhou
export function checker() {
  let failures = 0;
  const ok = (name, cond, info = '') => {
    console.log(`${cond ? 'OK   ' : 'FALHA'} ${name}${info !== '' ? ` — ${typeof info === 'string' ? info : JSON.stringify(info)}` : ''}`);
    if (!cond) failures++;
  };
  return { ok, failures: () => failures };
}

export const gtin = (stem) => {
  const d = stem.split('').map(Number).reverse();
  const sum = d.reduce((a, x, i) => a + x * (i % 2 === 0 ? 3 : 1), 0);
  return stem + ((10 - (sum % 10)) % 10);
};
