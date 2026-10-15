/* eslint-disable @typescript-eslint/no-require-imports -- preload do Node (--require) precisa ser CommonJS */
// Preload pro servidor Next: intercepta toda chamada à Steam com respostas simuladas.
// Nada sai pra rede. Cada chamada vira uma linha em MOCK_LOG, pra conferir cache e lotes.
const fs = require('node:fs');
const { MockAgent, setGlobalDispatcher } = require('undici');

const LOG = process.env.MOCK_LOG;
const log = (line) => LOG && fs.appendFileSync(LOG, line + '\n');

const agent = new MockAgent();
agent.disableNetConnect();
agent.enableNetConnect(/^(localhost|127\.0\.0\.1)(:\d+)?$/);
setGlobalDispatcher(agent);

const SEP_2026 = Math.floor(Date.UTC(2026, 8, 1) / 1000);
const JAN_2025 = Math.floor(Date.UTC(2025, 0, 1) / 1000);
const AUG_2026 = Math.floor(Date.UTC(2026, 7, 1) / 1000);

const g = (appid, name, playtime_forever, rtime_last_played = 0) => ({ appid, name, playtime_forever, rtime_last_played });

const PROFILES = {
  // público, biblioteca variada
  '76561198000000001': {
    visibility: 3,
    name: 'Fulano',
    games: [
      g(10, 'Hollow Knight', 0),
      g(20, 'Celeste', 45, SEP_2026),
      g(30, 'Elden Ring', 6000, AUG_2026),
      g(40, 'Dota 2', 30000, SEP_2026),
      g(50, 'Disco Elysium', 0),
      g(60, 'Hades', 90, JAN_2025),
      g(70, 'Free game', 0),
      g(80, 'Delisted', 0),
      g(90, 'Algum Jogo Playtest', 0),
    ],
  },
  '76561198000000002': { visibility: 1, name: 'Privado' }, // perfil privado
  '76561198000000003': { visibility: 3, name: 'Jogos privados', ownedRaw: {} }, // detalhes dos jogos privados
  '76561198000000004': {
    visibility: 3,
    name: 'Tempo oculto',
    games: [1, 2, 3, 4, 5, 6].map((n) => g(200 + n, `Jogo ${n}`, 0)),
  },
  '76561198000000005': { visibility: 3, name: 'Vazio', games: [] },
  '76561198000000006': {
    visibility: 3,
    name: 'Pilhão',
    games: [
      ...Array.from({ length: 250 }, (_, i) => g(1000 + i, `Pilha ${i}`, 0)),
      g(99999, 'Lote quebrado', 0),
      g(5000, 'Um jogado', 600, AUG_2026),
    ],
  },
  '76561198000000007': { visibility: 3, name: 'Steam caiu', ownedStatus: 500 },
};

const VANITIES = { fulano: '76561198000000001' };

const json = (statusCode, body) => ({
  statusCode,
  data: JSON.stringify(body),
  responseOptions: { headers: { 'content-type': 'application/json' } },
});

const query = (path) => new URL(path, 'https://mock.local').searchParams;

const api = agent.get('https://api.steampowered.com');

api
  .intercept({ path: (p) => p.startsWith('/ISteamUser/ResolveVanityURL/v1/'), method: 'GET' })
  .reply((opts) => {
    const q = query(opts.path);
    log(`resolve ${q.get('vanityurl')} key=${q.get('key')}`);
    const steamid = VANITIES[q.get('vanityurl')];
    return json(200, { response: steamid ? { steamid, success: 1 } : { success: 42, message: 'No match' } });
  })
  .persist();

api
  .intercept({ path: (p) => p.startsWith('/ISteamUser/GetPlayerSummaries/v2/'), method: 'GET' })
  .reply((opts) => {
    const id = query(opts.path).get('steamids');
    log(`summary ${id}`);
    const profile = PROFILES[id];
    const players = profile
      ? [
          {
            steamid: id,
            personaname: profile.name,
            profileurl: `https://steamcommunity.com/profiles/${id}/`,
            avatarfull: `https://avatars.example/${id}.jpg`,
            communityvisibilitystate: profile.visibility,
          },
        ]
      : [];
    return json(200, { response: { players } });
  })
  .persist();

api
  .intercept({ path: (p) => p.startsWith('/IPlayerService/GetOwnedGames/v1/'), method: 'GET' })
  .reply((opts) => {
    const q = query(opts.path);
    const id = q.get('steamid');
    log(`owned ${id} skip_unvetted_apps=${q.get('skip_unvetted_apps')} include_appinfo=${q.get('include_appinfo')}`);
    const profile = PROFILES[id];
    if (!profile) return json(200, { response: {} });
    if (profile.ownedStatus) return json(profile.ownedStatus, {});
    if (profile.ownedRaw) return json(200, { response: profile.ownedRaw });
    return json(200, { response: { game_count: profile.games.length, games: profile.games } });
  })
  .persist();

const PRICES = { 10: 4699, 20: 3699, 50: 8999, 60: 4799 };

agent
  .get('https://store.steampowered.com')
  .intercept({ path: (p) => p.startsWith('/api/appdetails'), method: 'GET' })
  .reply((opts) => {
    const q = query(opts.path);
    const ids = q.get('appids').split(',').map(Number);
    log(`appdetails n=${ids.length} cc=${q.get('cc')} filters=${q.get('filters')}`);
    if (ids.includes(99999)) return json(500, {});
    const body = {};
    for (const id of ids) {
      if (id === 70) body[id] = { success: true, data: [] }; // grátis
      else if (id === 80) body[id] = { success: false }; // fora da loja
      else if (id >= 1000 && id < 2000) body[id] = { success: true, data: { price_overview: { currency: 'BRL', initial: 1000, final: 500 } } };
      else if (PRICES[id]) body[id] = { success: true, data: { price_overview: { currency: 'BRL', initial: PRICES[id], final: PRICES[id] } } };
      else body[id] = { success: false };
    }
    return json(200, body);
  })
  .persist();
