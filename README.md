# bsky for you

Uma interface estática inspirada no Bluesky que transforma o feed de `following` em uma experiência tipo "For You".

## O que faz

- autentica com `handle + app password`
- busca os posts recentes do seu feed
- ranqueia por engajamento e recência
- mostra também o feed global oficial `What's Hot`
- funciona em GitHub Pages sem backend próprio

## Como funciona

O app usa a API oficial do Bluesky direto no navegador:

- `com.atproto.server.createSession` para login
- `app.bsky.feed.getTimeline` para o seu feed de seguindo
- `app.bsky.feed.getFeed` com o feed oficial `whats-hot` para a coluna global

## Rodando localmente

Como é um site estático, basta servir a pasta com qualquer servidor simples:

```bash
python -m http.server 8000
```

ou

```bash
npx serve .
```

## Deploy

O repositório já vem com workflow de GitHub Pages em [`.github/workflows/deploy-pages.yml`](/C:/Users/Pandora/Documents/bsky-for-you/.github/workflows/deploy-pages.yml).

Ao fazer push para `main`, o GitHub Actions publica o conteúdo da raiz do projeto.

## Segurança

- use uma `app password`, não a senha principal da conta
- o projeto não armazena a senha
- somente preferências visuais e o handle ficam no `localStorage`
