# CtoPlayer

Reprodutor IPTV web com suporte a M3U e Xtream Codes. Criei esse projeto porque simplesmente nao achei nenhum player IPTV web que prestasse.

## Funcionalidades

- **M3U Playlist** - Carrega qualquer playlist M3U/M3U8 via URL
- **Xtream Codes** - Conecta direto na API do Xtream Codes (servidor + usuario + senha)
- **TV ao Vivo, Filmes e Series** - Organizado por categorias com sidebar
- **Player integrado** - HLS, MPEG-TS e MP4 com Plyr + hls.js + mpegts.js
- **Navegacao de episodios** - Proximo/anterior episodio com auto-play
- **Pular creditos** - Configuravel para pular os ultimos X segundos do episodio
- **Busca e ordenacao** - Filtro por nome, categoria, ultimos adicionados, A-Z
- **Scroll infinito** - Carrega itens sob demanda conforme voce rola a pagina
- **Multi-usuario** - Sessoes isoladas por cookie, cada usuario tem sua propria playlist
- **Sessao persistente** - Recarregou a pagina? A playlist continua la
- **Proxy integrado** - Resolve problemas de CORS automaticamente

## Instalacao

```bash
git clone https://github.com/seu-usuario/CtoPlayer.git
cd CtoPlayer
npm install
npm start
```

Acesse `http://localhost:3000` no navegador.

## Requisitos

- Node.js 18+

## Stack

- **Backend:** Node.js + Express
- **Frontend:** HTML/CSS/JS puro (zero frameworks)
- **Player:** Plyr + hls.js + mpegts.js (via CDN)

## Licenca

ISC
