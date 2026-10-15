// GET /api/steam/library?profile=<link do perfil, SteamID64 ou nome personalizado>
// Devolve LibraryResponse (200) ou LibraryErrorResponse (400/403/404/502). Tipos em @/lib/backlog.
import { NextResponse, type NextRequest } from 'next/server';

import {
  computeStats,
  type LibraryErrorCode,
  type LibraryErrorResponse,
  type LibraryResponse,
} from '@/lib/backlog';
import { getSteamLibrary, SteamError } from '@/lib/steam';

const STATUS: Record<LibraryErrorCode, number> = {
  INVALID_INPUT: 400,
  PROFILE_NOT_FOUND: 404,
  PRIVATE_PROFILE: 403,
  PRIVATE_GAMES: 403,
  STEAM_UNAVAILABLE: 502,
};

// Texto padrão. A tela pode trocar por algo mais completo (ex.: passo a passo com print da Steam).
const MESSAGES: Record<LibraryErrorCode, string> = {
  INVALID_INPUT:
    'Não reconheci esse perfil. Cola o link do seu perfil da Steam (steamcommunity.com/id/... ou /profiles/...).',
  PROFILE_NOT_FOUND: 'Não achei esse perfil na Steam. Confere se o link tá certo?',
  PRIVATE_PROFILE:
    'Seu perfil da Steam está privado, então não dá pra ver seus jogos. Deixa o perfil público nas configurações de privacidade e tenta de novo.',
  PRIVATE_GAMES:
    'Seu perfil é público, mas os detalhes dos jogos não. Nas configurações de privacidade da Steam, deixa os detalhes dos jogos como público e tenta de novo.',
  STEAM_UNAVAILABLE: 'A Steam não respondeu agora. Tenta de novo em alguns segundos.',
};

function errorResponse(code: LibraryErrorCode) {
  const body: LibraryErrorResponse = { error: { code, message: MESSAGES[code] } };
  return NextResponse.json(body, { status: STATUS[code] });
}

export async function GET(request: NextRequest) {
  const profile = request.nextUrl.searchParams.get('profile') ?? '';

  try {
    const library = await getSteamLibrary(profile);
    const body: LibraryResponse = { ...library, stats: computeStats(library.games) };
    return NextResponse.json(body);
  } catch (error) {
    if (error instanceof SteamError) return errorResponse(error.code);
    console.error('[api/steam/library] erro inesperado:', error);
    return errorResponse('STEAM_UNAVAILABLE');
  }
}
