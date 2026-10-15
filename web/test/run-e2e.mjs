// Sobe `next start` com a Steam simulada, roda os cenários e derruba o servidor.
// Pré-requisito: `npx next build`.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const outDir = process.env.E2E_OUT ?? path.join(root, '.e2e');
fs.mkdirSync(outDir, { recursive: true });

function startServer({ port, withKey, mockLog, serverLog }) {
  fs.writeFileSync(mockLog, '');
  const out = fs.openSync(serverLog, 'w');
  const env = {
    ...process.env,
    MOCK_LOG: mockLog,
    NEXT_TELEMETRY_DISABLED: '1',
    NODE_OPTIONS: `--require ${path.join(root, 'test/steam-mock.cjs')}`,
  };
  if (withKey) env.STEAM_API_KEY = 'test-key-123';
  else delete env.STEAM_API_KEY;
  return spawn(path.join(root, 'node_modules/.bin/next'), ['start', '-p', String(port)], {
    cwd: root,
    env,
    stdio: ['ignore', out, out],
  });
}

async function waitUntilUp(base) {
  for (let i = 0; i < 60; i++) {
    try {
      await fetch(base);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error(`servidor não subiu em ${base}`);
}

function run(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: root, stdio: 'inherit' });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

let failed = false;

// O Data Cache do Next sobrevive a reinícios (fica em .next/cache/fetch-cache): limpa pra cada rodada começar do zero.
fs.rmSync(path.join(root, '.next/cache/fetch-cache'), { recursive: true, force: true });

// 1) Cenários com chave configurada
{
  const port = 3123;
  const base = `http://127.0.0.1:${port}`;
  const mockLog = path.join(outDir, 'mock.log');
  const serverLog = path.join(outDir, 'server.log');
  const server = startServer({ port, withKey: true, mockLog, serverLog });
  try {
    await waitUntilUp(base);
    const code = await run(process.execPath, ['test/e2e.mjs', base, mockLog]);
    if (code !== 0) failed = true;
  } finally {
    server.kill('SIGTERM');
  }
  const logs = fs.readFileSync(serverLog, 'utf8');
  const keyLeaked = logs.includes('test-key-123');
  console.log(`${keyLeaked ? 'FAIL' : 'ok  '} a chave não aparece no log do servidor`);
  if (keyLeaked) failed = true;
}

// 2) Sem STEAM_API_KEY: 502 pra pessoa, motivo claro no log pro dev
{
  const port = 3124;
  const base = `http://127.0.0.1:${port}`;
  const mockLog = path.join(outDir, 'mock-nokey.log');
  const serverLog = path.join(outDir, 'server-nokey.log');
  const server = startServer({ port, withKey: false, mockLog, serverLog });
  try {
    await waitUntilUp(base);
    const res = await fetch(`${base}/api/steam/library?profile=76561198000000001`);
    const body = await res.json();
    await new Promise((r) => setTimeout(r, 300));
    const logs = fs.readFileSync(serverLog, 'utf8');
    const ok = res.status === 502 && body.error.code === 'STEAM_UNAVAILABLE' && logs.includes('STEAM_API_KEY não configurada');
    console.log(`${ok ? 'ok  ' : 'FAIL'} sem chave → 502 pra pessoa e aviso claro no log`);
    if (!ok) {
      failed = true;
      console.log(res.status, body, logs.slice(-500));
    }
  } finally {
    server.kill('SIGTERM');
  }
}

process.exit(failed ? 1 : 0);
