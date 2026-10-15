# Backloggr — app (v0)

Projeto Next 15 (App Router, TypeScript) do produto. A LP antiga continua no `index.html` da raiz do repositório, servida pelo GitHub Pages, até a troca de domínio.

## Rodando

```bash
cd web
npm install
cp .env.example .env.local   # coloque sua STEAM_API_KEY (https://steamcommunity.com/dev/apikey, domínio backloggr.com.br)
npm run dev
```

Teste a API em `http://localhost:3000/api/steam/library?profile=<link do seu perfil Steam>`.

Na Vercel: ao importar o repositório, defina **Root Directory = `web`** e cadastre `STEAM_API_KEY` nas variáveis de ambiente.

## Onde está cada coisa

| Arquivo | O que faz |
|---|---|
| `src/lib/backlog.ts` | Lógica pura: estados, estatísticas, sugestões e os tipos da API. Roda no servidor **e** no navegador. |
| `src/lib/steam.ts` | Fala com a Steam. Só servidor (usa a chave). |
| `src/app/api/steam/library/route.ts` | `GET /api/steam/library?profile=...` |
| `test/` | Testes unitários e cenários com a Steam simulada. |

## Contrato da API

- `200` → `LibraryResponse`: `profile`, `games`, `stats`, `warnings`
- `400 INVALID_INPUT` · `404 PROFILE_NOT_FOUND` · `403 PRIVATE_PROFILE` · `403 PRIVATE_GAMES` · `502 STEAM_UNAVAILABLE` → `{ error: { code, message } }`
- `warnings`: `PLAYTIME_HIDDEN` (tudo com 0h: provavelmente tempo de jogo oculto) e `PRICES_PARTIAL` (valor da pilha incompleto)

Quando a pessoa marca um jogo, a tela recalcula com `computeStats(games, userStates)`, `pickSuggestions(games, userStates)` e `drawFromPile(...)` pro "sortear de novo".

## O que conferir no primeiro teste com a chave real

Os testes usam respostas simuladas da Steam. Com a chave de verdade, confira:

1. **Seu perfil volta com `warnings: []`.** Se `PRICES_PARTIAL` aparecer sempre, a loja não aceitou 100 jogos por chamada: diminua `PRICE_BATCH_SIZE` em `steam.ts` (tente 50).
2. **Perfil com detalhes dos jogos privados** volta `403 PRIVATE_GAMES`. Se voltar 200 com lista vazia, a Steam está respondendo diferente do esperado.
3. **Capas:** algumas URLs `library_600x900.jpg` não existem. A tela precisa de fallback (`onError` → `headerUrl`).

## Testes

```bash
npm test           # unitários: link do perfil, estatísticas, sugestões
npm run test:e2e   # build + servidor com a Steam simulada, 13 cenários
```

Mantenha o TypeScript na versão 5: com o TypeScript 7 o build do Next 15 deixou de resolver os imports `@/...`.
