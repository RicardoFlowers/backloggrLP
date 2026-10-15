// Lógica pura do backlog: sem fetch, sem chave, sem nada de servidor.
// Por isso dá pra importar tanto na rota de API quanto nas telas (client components):
// quando a pessoa marca um jogo como zerado, a tela recalcula tudo com estas mesmas funções.

/** Abaixo disso (em minutos) o jogo conta como "mal começado". */
export const BARELY_PLAYED_MINUTES = 120;

/** Mesma média da calculadora da LP. Numa próxima etapa vira dado real por jogo (IGDB). */
export const AVG_HOURS_TO_BEAT = 18;

/** Estado que sai só do tempo de jogo que a Steam informa. */
export type AutoState = 'never' | 'barely' | 'played';

/** Estado que a própria pessoa marca na prateleira. */
export type UserState = 'playing' | 'finished' | 'dropped';

/** appId -> estado marcado. Na v0 isso vive no localStorage do navegador. */
export type UserStates = Record<number, UserState>;

export interface Game {
  appId: number;
  name: string;
  playtimeMinutes: number;
  /** ISO 8601. null quando nunca jogou (ou a Steam não informou). */
  lastPlayedAt: string | null;
  /** Preço cheio atual na Steam BR, em centavos. null = sem preço (grátis, fora da loja ou a busca falhou). */
  priceCents: number | null;
  autoState: AutoState;
  /** Capa vertical. Nem todo jogo tem: a tela precisa de fallback (onError -> headerUrl). */
  coverUrl: string;
  headerUrl: string;
}

export interface BacklogStats {
  totalGames: number;
  /** Os dois contadores abaixo contam só o que ainda está na pilha (já descontando o que a pessoa marcou). */
  neverPlayed: number;
  barelyPlayed: number;
  pileCount: number;
  /** 0–100, inteiro. */
  pilePercent: number;
  estimatedHoursToClear: number;
  /** Uma casa decimal. */
  yearsAtOneHourPerDay: number;
  /** Soma só dos jogos da pilha que têm preço. */
  pileValueCents: number;
  pileGamesWithoutPrice: number;
  totalPlaytimeHours: number;
}

// ---------- Contrato da API (o que a rota devolve e as telas consomem) ----------

export interface SteamProfile {
  steamId: string;
  name: string;
  avatarUrl: string;
  profileUrl: string;
}

/** Avisos que não impedem o resultado, mas mudam o que a tela deve mostrar. */
export type LibraryWarning =
  | 'PLAYTIME_HIDDEN' // tudo veio com 0 min: provavelmente a pessoa esconde o tempo de jogo
  | 'PRICES_PARTIAL'; // parte dos preços não carregou: o valor da pilha está subestimado

export type LibraryErrorCode =
  | 'INVALID_INPUT' // não parece link nem ID de perfil
  | 'PROFILE_NOT_FOUND' // nome personalizado ou ID que não existe
  | 'PRIVATE_PROFILE' // o perfil inteiro está privado
  | 'PRIVATE_GAMES' // perfil público, mas "detalhes dos jogos" não
  | 'STEAM_UNAVAILABLE'; // Steam fora do ar, lenta, ou problema de configuração do nosso lado

export interface LibraryResponse {
  profile: SteamProfile;
  games: Game[];
  stats: BacklogStats;
  warnings: LibraryWarning[];
}

export interface LibraryErrorResponse {
  error: { code: LibraryErrorCode; message: string };
}

// ---------- Regras ----------

export function autoStateFor(playtimeMinutes: number): AutoState {
  if (playtimeMinutes <= 0) return 'never';
  if (playtimeMinutes < BARELY_PLAYED_MINUTES) return 'barely';
  return 'played';
}

/** Está na pilha: a Steam diz que mal foi tocado e a pessoa ainda não marcou nada nele. */
export function isInPile(game: Game, userStates: UserStates = {}): boolean {
  if (userStates[game.appId]) return false;
  return game.autoState !== 'played';
}

export function computeStats(games: Game[], userStates: UserStates = {}): BacklogStats {
  let neverPlayed = 0;
  let barelyPlayed = 0;
  let pileValueCents = 0;
  let pileGamesWithoutPrice = 0;
  let totalMinutes = 0;

  for (const game of games) {
    totalMinutes += game.playtimeMinutes;
    if (!isInPile(game, userStates)) continue;

    if (game.autoState === 'never') neverPlayed++;
    else barelyPlayed++;

    if (game.priceCents === null) pileGamesWithoutPrice++;
    else pileValueCents += game.priceCents;
  }

  const pileCount = neverPlayed + barelyPlayed;
  const estimatedHoursToClear = pileCount * AVG_HOURS_TO_BEAT;

  return {
    totalGames: games.length,
    neverPlayed,
    barelyPlayed,
    pileCount,
    pilePercent: games.length > 0 ? Math.round((pileCount / games.length) * 100) : 0,
    estimatedHoursToClear,
    yearsAtOneHourPerDay: Math.round((estimatedHoursToClear / 365) * 10) / 10,
    pileValueCents,
    pileGamesWithoutPrice,
    totalPlaytimeHours: Math.round(totalMinutes / 60),
  };
}

// ---------- "Comece por aqui" ----------

export type SuggestionKind =
  | 'resume' // o mal começado que você tocou por último: metade do caminho já andado
  | 'priciest' // o mais caro que você nunca abriu: o argumento da culpa
  | 'random'; // sorteio do resto da pilha

export interface Suggestion {
  kind: SuggestionKind;
  game: Game;
}

function timeOf(iso: string | null): number {
  return iso ? new Date(iso).getTime() : 0;
}

/** Sorteia um jogo da pilha que não esteja em `exclude`. null se não sobrar nenhum. */
export function drawFromPile(
  games: Game[],
  userStates: UserStates = {},
  exclude: ReadonlySet<number> = new Set(),
  random: () => number = Math.random,
): Game | null {
  const options = games.filter((game) => isInPile(game, userStates) && !exclude.has(game.appId));
  if (options.length === 0) return null;
  return options[Math.floor(random() * options.length)] ?? null;
}

/**
 * Até 3 sugestões, cada uma por um motivo diferente e sem repetir jogo.
 * `random` é injetável pra dar pra testar com resultado fixo.
 */
export function pickSuggestions(
  games: Game[],
  userStates: UserStates = {},
  random: () => number = Math.random,
): Suggestion[] {
  const pile = games.filter((game) => isInPile(game, userStates));
  const suggestions: Suggestion[] = [];
  const used = new Set<number>();

  const resume = pile
    .filter((game) => game.autoState === 'barely' && game.lastPlayedAt !== null)
    .sort((a, b) => timeOf(b.lastPlayedAt) - timeOf(a.lastPlayedAt))[0];
  if (resume) {
    suggestions.push({ kind: 'resume', game: resume });
    used.add(resume.appId);
  }

  const priciest = pile
    .filter((game) => game.autoState === 'never' && game.priceCents !== null && !used.has(game.appId))
    .sort((a, b) => (b.priceCents ?? 0) - (a.priceCents ?? 0))[0];
  if (priciest) {
    suggestions.push({ kind: 'priciest', game: priciest });
    used.add(priciest.appId);
  }

  const drawn = drawFromPile(games, userStates, used, random);
  if (drawn) suggestions.push({ kind: 'random', game: drawn });

  return suggestions;
}
