// Testes das partes puras (sem rede): interpretação do link, estatísticas e sugestões.
// Rodar com: npx tsx --conditions=react-server --test test/unit.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { autoStateFor, computeStats, drawFromPile, pickSuggestions, type Game } from '../src/lib/backlog';
import { parseProfileInput } from '../src/lib/steam';

test('parseProfileInput aceita os formatos comuns', () => {
  const id = '76561198000000001';
  assert.deepEqual(parseProfileInput(id), { kind: 'steamId', steamId: id });
  assert.deepEqual(parseProfileInput(`  https://steamcommunity.com/profiles/${id}/  `), { kind: 'steamId', steamId: id });
  assert.deepEqual(parseProfileInput(`steamcommunity.com/profiles/${id}`), { kind: 'steamId', steamId: id });
  assert.deepEqual(parseProfileInput(`http://www.steamcommunity.com/profiles/${id}?l=brazilian`), { kind: 'steamId', steamId: id });
  assert.deepEqual(parseProfileInput('https://steamcommunity.com/id/fulano/'), { kind: 'vanity', vanity: 'fulano' });
  assert.deepEqual(parseProfileInput('https://steamcommunity.com/id/Fulano_99-x/games/?tab=all'), { kind: 'vanity', vanity: 'Fulano_99-x' });
  assert.deepEqual(parseProfileInput('HTTPS://STEAMCOMMUNITY.COM/ID/fulano'), { kind: 'vanity', vanity: 'fulano' });
  assert.deepEqual(parseProfileInput('fulano'), { kind: 'vanity', vanity: 'fulano' });
  // contas novas já passam de 76561200000000000
  assert.deepEqual(parseProfileInput('76561202255233023'), { kind: 'steamId', steamId: '76561202255233023' });
});

test('parseProfileInput recusa o que não é perfil', () => {
  for (const bad of [
    '',
    '   ',
    'https://store.steampowered.com/app/1145360/Hades/',
    'https://steamcommunity.com/profiles/123',
    'Fulano da Silva',
    'https://s.team/p/abcd-efgh',
    'a',
  ]) {
    assert.equal(parseProfileInput(bad), null, `deveria recusar: "${bad}"`);
  }
});

test('autoStateFor usa o limite de 2h', () => {
  assert.equal(autoStateFor(0), 'never');
  assert.equal(autoStateFor(1), 'barely');
  assert.equal(autoStateFor(119), 'barely');
  assert.equal(autoStateFor(120), 'played');
});

function game(
  appId: number,
  name: string,
  playtimeMinutes: number,
  priceCents: number | null,
  lastPlayedAt: string | null = null,
  isFree = false,
): Game {
  return {
    appId,
    name,
    playtimeMinutes,
    lastPlayedAt,
    priceCents,
    autoState: autoStateFor(playtimeMinutes),
    isFree,
    coverUrl: '',
    headerUrl: '',
  };
}

const library: Game[] = [
  game(20, 'Celeste', 45, 3699, '2026-09-01T00:00:00.000Z'),
  game(80, 'Delisted', 0, null),
  game(50, 'Disco Elysium', 0, 8999),
  game(40, 'Dota 2', 30000, null, '2026-10-01T00:00:00.000Z'),
  game(30, 'Elden Ring', 6000, null, '2026-08-01T00:00:00.000Z'),
  game(70, 'Free game', 0, null, null, true),
  game(90, 'Grátis mal começado', 30, null, '2026-10-01T00:00:00.000Z', true),
  game(60, 'Hades', 90, 4799, '2025-01-01T00:00:00.000Z'),
  game(10, 'Hollow Knight', 0, 4699),
];

test('computeStats sem marcações', () => {
  assert.deepEqual(computeStats(library), {
    totalGames: 9,
    neverPlayed: 3,
    barelyPlayed: 2,
    pileCount: 5,
    pilePercent: 56,
    estimatedHoursToClear: 90,
    yearsAtOneHourPerDay: 0.2,
    pileValueCents: 4699 + 3699 + 8999 + 4799,
    pileGamesWithoutPrice: 1,
    totalPlaytimeHours: 603,
  });
});

test('computeStats tira da pilha o que a pessoa marcou', () => {
  const stats = computeStats(library, { 50: 'finished', 20: 'dropped', 30: 'finished' });
  assert.equal(stats.pileCount, 3);
  assert.equal(stats.neverPlayed, 2);
  assert.equal(stats.barelyPlayed, 1);
  assert.equal(stats.pileValueCents, 4699 + 4799);
  assert.equal(stats.totalGames, 9);
});

test('computeStats com biblioteca vazia não divide por zero', () => {
  const stats = computeStats([]);
  assert.equal(stats.pilePercent, 0);
  assert.equal(stats.pileCount, 0);
  assert.equal(stats.yearsAtOneHourPerDay, 0);
});

test('jogo grátis nunca entra na pilha nem nas sugestões', () => {
  const free = library.filter((g) => g.isFree).map((g) => g.appId);
  for (let i = 0; i < 20; i++) {
    for (const s of pickSuggestions(library, {}, () => i / 20)) assert.ok(!free.includes(s.game.appId));
  }
  assert.equal(drawFromPile(library, {}, new Set([10, 20, 50, 60, 80])), null);
});

test('pickSuggestions: retomar, mais caro e sorteio, sem repetir', () => {
  const suggestions = pickSuggestions(library, {}, () => 0);
  assert.deepEqual(
    suggestions.map((s) => [s.kind, s.game.name]),
    [
      ['resume', 'Celeste'],
      ['priciest', 'Disco Elysium'],
      ['random', 'Delisted'],
    ],
  );
});

test('pickSuggestions respeita marcações e pilha pequena', () => {
  const marked = { 20: 'finished', 60: 'dropped', 50: 'playing', 80: 'dropped' } as const;
  const suggestions = pickSuggestions(library, marked, () => 0.99);
  assert.deepEqual(
    suggestions.map((s) => [s.kind, s.game.name]),
    [['priciest', 'Hollow Knight']],
  );
  assert.deepEqual(pickSuggestions([], {}, () => 0), []);
});

test('drawFromPile nunca devolve excluído nem jogo fora da pilha', () => {
  const exclude = new Set([10, 20, 50, 60]);
  for (let i = 0; i < 20; i++) {
    const drawn = drawFromPile(library, {}, exclude, () => i / 20);
    assert.equal(drawn?.name, 'Delisted');
  }
  assert.equal(drawFromPile(library, {}, new Set([10, 20, 50, 60, 80])), null);
});
