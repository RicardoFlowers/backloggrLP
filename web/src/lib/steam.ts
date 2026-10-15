// Tudo que fala com a Steam fica aqui. Roda só no servidor, porque usa a chave secreta.
// O `server-only` faz o build quebrar se alguém importar este arquivo num client component.
import 'server-only';

import {
  autoStateFor,
  type Game,
  type LibraryErrorCode,
  type LibraryWarning,
  type SteamProfile,
} from './backlog';

const WEB_API = 'https://api.steampowered.com';
const STORE_API = 'https://store.steampowered.com/api';
const CDN = 'https://cdn.cloudflare.steamstatic.com/steam/apps';

const ONE_DAY = 60 * 60 * 24;
const TIMEOUT_MS = 8_000;

/** Quantos jogos por chamada de preço, e quantas chamadas ao mesmo tempo (pra loja não bloquear a gente). */
const PRICE_BATCH_SIZE = 100;
const PRICE_PARALLEL = 4;

/** Erro "esperado": a rota transforma em resposta com código. Qualquer outro erro é bug ou Steam fora. */
export class SteamError extends Error {
  readonly code: LibraryErrorCode;

  constructor(code: LibraryErrorCode) {
    super(code);
    this.name = 'SteamError';
    this.code = code;
  }
}

// ---------- O que a pessoa cola ----------

export type ProfileRef = { kind: 'steamId'; steamId: string } | { kind: 'vanity'; vanity: string };

/** SteamID64: 17 dígitos, sempre começando com 765611 ou 765612. */
const STEAM_ID_64 = /^76561[12]\d{11}$/;
/** Nome personalizado: o que vem depois de /id/ no link do perfil. */
const VANITY = /^[\w-]{2,32}$/;
const PROFILE_URL = /^(?:https?:\/\/)?(?:www\.)?steamcommunity\.com\/(id|profiles)\/([^/?#\s]+)/i;

/**
 * Aceita os formatos que a pessoa costuma colar:
 *   https://steamcommunity.com/id/fulano/      steamcommunity.com/profiles/7656119...
 *   7656119... (o número puro)                  fulano (só o nome personalizado)
 */
export function parseProfileInput(raw: string): ProfileRef | null {
  const input = raw.trim();
  if (STEAM_ID_64.test(input)) return { kind: 'steamId', steamId: input };

  const match = PROFILE_URL.exec(input);
  if (match) {
    const [, type, value] = match;
    if (type.toLowerCase() === 'profiles') {
      return STEAM_ID_64.test(value) ? { kind: 'steamId', steamId: value } : null;
    }
    return VANITY.test(value) ? { kind: 'vanity', vanity: value } : null;
  }

  return VANITY.test(input) ? { kind: 'vanity', vanity: input } : null;
}

// ---------- Infra de chamada ----------

async function getJson<T>(url: URL | string, init: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (await response.json()) as T;
}

/** Chamada à Web API oficial. A chave vai na URL, por isso o log nunca mostra a URL inteira. */
async function webApi<T>(method: string, params: Record<string, string>, init: RequestInit): Promise<T> {
  const key = process.env.STEAM_API_KEY;
  if (!key) throw new Error('STEAM_API_KEY não configurada (.env.local ou variáveis da Vercel)');

  const url = new URL(`${WEB_API}/${method}`);
  url.search = new URLSearchParams({ key, format: 'json', ...params }).toString();

  try {
    return await getJson<T>(url, init);
  } catch (error) {
    console.error(`[steam] ${method} falhou:`, error instanceof Error ? error.message : error);
    throw new SteamError('STEAM_UNAVAILABLE');
  }
}

// ---------- Chamadas ----------

async function resolveVanity(vanity: string): Promise<string> {
  const data = await webApi<{ response: { success: number; steamid?: string } }>(
    'ISteamUser/ResolveVanityURL/v1/',
    { vanityurl: vanity },
    { next: { revalidate: ONE_DAY } }, // nome -> ID quase nunca muda
  );
  if (data.response.success !== 1 || !data.response.steamid) throw new SteamError('PROFILE_NOT_FOUND');
  return data.response.steamid;
}

interface PlayerSummary {
  personaname: string;
  profileurl: string;
  avatarfull: string;
  /** Sem login, a Steam só devolve 1 (não visível pra gente) ou 3 (público). */
  communityvisibilitystate: number;
}

async function getPlayerSummary(steamId: string): Promise<PlayerSummary | null> {
  const data = await webApi<{ response: { players: PlayerSummary[] } }>(
    'ISteamUser/GetPlayerSummaries/v2/',
    { steamids: steamId },
    { cache: 'no-store' }, // a pessoa pode ter acabado de mudar a privacidade e estar tentando de novo
  );
  return data.response.players[0] ?? null;
}

interface OwnedGame {
  appid: number;
  name?: string;
  /** Minutos. */
  playtime_forever: number;
  /** Unix em segundos; 0 ou ausente = nunca jogou. */
  rtime_last_played?: number;
}

interface OwnedGames {
  game_count?: number;
  games?: OwnedGame[];
}

async function getOwnedGames(steamId: string): Promise<OwnedGames> {
  const data = await webApi<{ response?: OwnedGames }>(
    'IPlayerService/GetOwnedGames/v1/',
    {
      steamid: steamId,
      include_appinfo: 'true',
      include_played_free_games: 'true',
      skip_unvetted_apps: 'false', // sem isso alguns jogos somem da lista
    },
    { cache: 'no-store' },
  );
  return data.response ?? {};
}

interface PriceOverview {
  currency: string;
  /** Centavos, preço cheio. */
  initial: number;
  /** Centavos, com desconto do momento. */
  final: number;
}

/** Com filters=price_overview, jogo grátis volta com `data: []` (array vazio) em vez de objeto. */
type AppDetails = Record<string, { success: boolean; data?: { price_overview?: PriceOverview } | [] } | null>;

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

/** Playtests são apps grátis separados do jogo ("Fulano Playtest"). */
const PLAYTEST = /\bplaytest\b/i;

interface StoreInfo {
  /** appId -> preço cheio em centavos */
  prices: Map<number, number>;
  /** appIds que a loja informa como gratuitos */
  free: Set<number>;
  /** false se algum lote falhou */
  complete: boolean;
}

/**
 * Preço cheio atual na Steam BR (não é o que a pessoa pagou: a Steam não expõe isso)
 * e quais jogos são gratuitos. Busca em lotes com cache de 1 dia.
 * Lote que falha não derruba o resultado, só marca como incompleto.
 */
async function getStoreInfo(appIds: number[]): Promise<StoreInfo> {
  const prices = new Map<number, number>();
  const free = new Set<number>();
  let complete = true;
  const batches = chunk(appIds, PRICE_BATCH_SIZE);

  for (let i = 0; i < batches.length; i += PRICE_PARALLEL) {
    const group = batches.slice(i, i + PRICE_PARALLEL);
    const results = await Promise.allSettled(
      group.map((ids) =>
        getJson<AppDetails | null>(`${STORE_API}/appdetails?appids=${ids.join(',')}&cc=br&filters=price_overview`, {
          next: { revalidate: ONE_DAY },
        }),
      ),
    );

    for (const result of results) {
      // A loja às vezes responde 200 com `null` (excesso de chamadas, lote inválido): conta como falha.
      if (result.status === 'rejected' || !result.value) {
        complete = false;
        if (result.status === 'rejected') {
          console.error('[steam] appdetails falhou:', result.reason instanceof Error ? result.reason.message : result.reason);
        }
        continue;
      }
      for (const [appId, entry] of Object.entries(result.value)) {
        if (!entry?.success || !entry.data) continue; // fora da loja ou indisponível no Brasil: segue pago, sem preço
        if (Array.isArray(entry.data)) {
          free.add(Number(appId)); // jogo grátis vem com `data: []`
          continue;
        }
        const overview = entry.data.price_overview;
        if (overview?.currency === 'BRL') prices.set(Number(appId), overview.initial);
      }
    }
  }

  return { prices, free, complete };
}

// ---------- O que a rota usa ----------

export interface SteamLibrary {
  profile: SteamProfile;
  games: Game[];
  warnings: LibraryWarning[];
}

/** A partir do que a pessoa colou, devolve o perfil e os jogos já classificados. */
export async function getSteamLibrary(rawInput: string): Promise<SteamLibrary> {
  const ref = parseProfileInput(rawInput);
  if (!ref) throw new SteamError('INVALID_INPUT');

  const steamId = ref.kind === 'steamId' ? ref.steamId : await resolveVanity(ref.vanity);

  const summary = await getPlayerSummary(steamId);
  if (!summary) throw new SteamError('PROFILE_NOT_FOUND');
  if (summary.communityvisibilitystate !== 3) throw new SteamError('PRIVATE_PROFILE');

  const owned = await getOwnedGames(steamId);
  // Perfil público mas sem game_count = "detalhes dos jogos" está privado.
  // Biblioteca realmente vazia vem com game_count: 0 e segue como lista vazia (a tela trata).
  if (owned.game_count === undefined) throw new SteamError('PRIVATE_GAMES');
  const ownedGames = owned.games ?? [];

  const warnings: LibraryWarning[] = [];

  // Quem marca "manter meu tempo de jogo privado" pode vir com tudo zerado.
  // 5+ jogos sem nenhum minuto jogado é muito mais provável ser isso do que verdade.
  if (ownedGames.length >= 5 && ownedGames.every((game) => game.playtime_forever === 0)) {
    warnings.push('PLAYTIME_HIDDEN');
  }

  // Preço e "é grátis?" só importam pra pilha (nunca abertos e mal começados). Ordenar deixa a chave do cache estável.
  const pileIds = ownedGames
    .filter((game) => autoStateFor(game.playtime_forever) !== 'played')
    .map((game) => game.appid)
    .sort((a, b) => a - b);
  const { prices, free, complete } = await getStoreInfo(pileIds);
  if (!complete) warnings.push('PRICES_PARTIAL');

  const games: Game[] = ownedGames
    .map((game) => ({
      appId: game.appid,
      name: game.name ?? `App ${game.appid}`,
      playtimeMinutes: game.playtime_forever,
      lastPlayedAt: game.rtime_last_played ? new Date(game.rtime_last_played * 1000).toISOString() : null,
      priceCents: prices.get(game.appid) ?? null,
      autoState: autoStateFor(game.playtime_forever),
      isFree: free.has(game.appid) || PLAYTEST.test(game.name ?? ''),
      coverUrl: `${CDN}/${game.appid}/library_600x900.jpg`,
      headerUrl: `${CDN}/${game.appid}/header.jpg`,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));

  return {
    profile: {
      steamId,
      name: summary.personaname,
      avatarUrl: summary.avatarfull,
      profileUrl: summary.profileurl,
    },
    games,
    warnings,
  };
}
