// Bate na rota real (next start) com a Steam simulada e confere respostas, cache e lotes.
// Uso: node test/e2e.mjs <baseUrl> <mockLog>
import assert from 'node:assert/strict';
import fs from 'node:fs';

const [base, mockLog] = process.argv.slice(2);
const KEY = 'test-key-123';

async function call(profile) {
  const url = profile === undefined ? `${base}/api/steam/library` : `${base}/api/steam/library?profile=${encodeURIComponent(profile)}`;
  const res = await fetch(url);
  const text = await res.text();
  assert.ok(!text.includes(KEY), 'a chave nunca pode aparecer na resposta');
  return { status: res.status, body: JSON.parse(text) };
}

const logLines = () => fs.readFileSync(mockLog, 'utf8').trim().split('\n').filter(Boolean);
const count = (prefix) => logLines().filter((l) => l.startsWith(prefix)).length;

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push(`ok   ${name}`);
  } catch (error) {
    results.push(`FAIL ${name}\n     ${error.message.split('\n').join('\n     ')}`);
  }
}

await check('perfil público via link /id/ → 200 com números certos', async () => {
  const { status, body } = await call('https://steamcommunity.com/id/fulano/');
  assert.equal(status, 200);
  assert.equal(body.profile.name, 'Fulano');
  assert.equal(body.profile.steamId, '76561198000000001');
  assert.deepEqual(body.warnings, []);
  assert.deepEqual(body.stats, {
    totalGames: 9,
    neverPlayed: 3,
    barelyPlayed: 2,
    pileCount: 5,
    pilePercent: 56,
    estimatedHoursToClear: 90,
    yearsAtOneHourPerDay: 0.2,
    pileValueCents: 22196,
    pileGamesWithoutPrice: 1,
    totalPlaytimeHours: 602,
  });
  assert.deepEqual(
    body.games.map((g) => g.name),
    ['Algum Jogo Playtest', 'Celeste', 'Delisted', 'Disco Elysium', 'Dota 2', 'Elden Ring', 'Free game', 'Hades', 'Hollow Knight'],
  );
  const celeste = body.games.find((g) => g.appId === 20);
  assert.equal(celeste.autoState, 'barely');
  assert.equal(celeste.lastPlayedAt, '2026-09-01T00:00:00.000Z');
  assert.equal(celeste.priceCents, 3699);
  assert.equal(celeste.coverUrl, 'https://cdn.cloudflare.steamstatic.com/steam/apps/20/library_600x900.jpg');
  const hk = body.games.find((g) => g.appId === 10);
  assert.equal(hk.lastPlayedAt, null);
  assert.equal(body.games.find((g) => g.appId === 70).priceCents, null); // grátis
  assert.equal(body.games.find((g) => g.appId === 70).isFree, true); // loja diz que é grátis
  assert.equal(body.games.find((g) => g.appId === 90).isFree, true); // playtest pelo nome
  assert.equal(body.games.find((g) => g.appId === 80).isFree, false); // fora da loja continua pago
  assert.equal(body.games.find((g) => g.appId === 10).isFree, false);
  assert.equal(body.games.find((g) => g.appId === 30).priceCents, null); // jogado: nem busca preço
  assert.equal(count('resolve fulano key=test-key-123'), 1, 'resolve deveria ter sido chamado com a chave');
  assert.ok(logLines().some((l) => l === 'owned 76561198000000001 skip_unvetted_apps=false include_appinfo=true'));
  assert.ok(logLines().some((l) => l === 'appdetails n=7 cc=br filters=price_overview'), 'só os nunca abertos e mal começados (7 jogos) vão pra loja');
});

await check('segunda busca do mesmo perfil usa cache (nome→ID e preços), mas relê biblioteca', async () => {
  const before = { resolve: count('resolve'), appdetails: count('appdetails'), summary: count('summary 76561198000000001'), owned: count('owned 76561198000000001') };
  const { status } = await call('steamcommunity.com/id/fulano');
  assert.equal(status, 200);
  assert.equal(count('resolve'), before.resolve, 'ResolveVanityURL deveria vir do cache');
  assert.equal(count('appdetails'), before.appdetails, 'preços deveriam vir do cache');
  assert.equal(count('summary 76561198000000001'), before.summary + 1, 'resumo do perfil não deve usar cache');
  assert.equal(count('owned 76561198000000001'), before.owned + 1, 'biblioteca não deve usar cache');
});

await check('SteamID64 puro também funciona (sem resolver nome)', async () => {
  const before = count('resolve');
  const { status, body } = await call('76561198000000001');
  assert.equal(status, 200);
  assert.equal(body.stats.pileCount, 5);
  assert.equal(count('resolve'), before);
});

await check('perfil privado → 403 PRIVATE_PROFILE, sem pedir a biblioteca', async () => {
  const { status, body } = await call('https://steamcommunity.com/profiles/76561198000000002');
  assert.equal(status, 403);
  assert.equal(body.error.code, 'PRIVATE_PROFILE');
  assert.equal(count('owned 76561198000000002'), 0);
});

await check('detalhes dos jogos privados → 403 PRIVATE_GAMES', async () => {
  const { status, body } = await call('https://steamcommunity.com/profiles/76561198000000003/');
  assert.equal(status, 403);
  assert.equal(body.error.code, 'PRIVATE_GAMES');
  assert.match(body.error.message, /detalhes dos jogos/);
});

await check('tempo de jogo escondido → 200 com aviso PLAYTIME_HIDDEN', async () => {
  const { status, body } = await call('76561198000000004');
  assert.equal(status, 200);
  assert.deepEqual(body.warnings, ['PLAYTIME_HIDDEN']);
  assert.equal(body.stats.neverPlayed, 6);
});

await check('biblioteca vazia → 200 com lista vazia', async () => {
  const { status, body } = await call('76561198000000005');
  assert.equal(status, 200);
  assert.deepEqual(body.games, []);
  assert.equal(body.stats.totalGames, 0);
  assert.equal(body.stats.pilePercent, 0);
  assert.deepEqual(body.warnings, []);
});

await check('pilha grande: 251 jogos em 3 lotes; lote quebrado vira PRICES_PARTIAL', async () => {
  const before = count('appdetails');
  const { status, body } = await call('76561198000000006');
  assert.equal(status, 200);
  assert.deepEqual(body.warnings, ['PRICES_PARTIAL']);
  assert.equal(body.stats.pileCount, 251);
  assert.equal(body.stats.pileValueCents, 200 * 1000);
  assert.equal(body.stats.pileGamesWithoutPrice, 51);
  assert.equal(count('appdetails') - before, 3);
  assert.equal(count('appdetails n=100'), 2);
  assert.equal(count('appdetails n=51'), 1);
});

await check('Steam fora do ar → 502 STEAM_UNAVAILABLE', async () => {
  const { status, body } = await call('76561198000000007');
  assert.equal(status, 502);
  assert.equal(body.error.code, 'STEAM_UNAVAILABLE');
});

await check('nome personalizado que não existe → 404', async () => {
  const { status, body } = await call('https://steamcommunity.com/id/naoexiste');
  assert.equal(status, 404);
  assert.equal(body.error.code, 'PROFILE_NOT_FOUND');
});

await check('SteamID que não existe → 404', async () => {
  const { status, body } = await call('76561198000000099');
  assert.equal(status, 404);
  assert.equal(body.error.code, 'PROFILE_NOT_FOUND');
});

await check('link que não é de perfil → 400', async () => {
  const { status, body } = await call('https://store.steampowered.com/app/1145360/Hades/');
  assert.equal(status, 400);
  assert.equal(body.error.code, 'INVALID_INPUT');
});

await check('sem parâmetro → 400', async () => {
  const { status, body } = await call(undefined);
  assert.equal(status, 400);
  assert.equal(body.error.code, 'INVALID_INPUT');
});

console.log(results.join('\n'));
const failed = results.filter((r) => r.startsWith('FAIL')).length;
console.log(`\n${results.length - failed}/${results.length} cenários ok`);
process.exit(failed ? 1 : 0);
