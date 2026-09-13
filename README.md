# Resolvi Aí

API de gestão de ocorrências do Hackathon FSDT — Fase 5.

## Executar com Docker

Crie o arquivo de ambiente e suba os serviços:

```bash
cp .env.example .env
docker compose up --build
```

O container da API aguarda o PostgreSQL ficar saudável, aplica as migrations pendentes e inicia na porta `3000`.

## Executar localmente

Requer Bun e PostgreSQL. Instale as dependências:

```bash
bun install
```

Configure `.env`, aplique o schema e inicie:

```bash
bun run db:migrate
bun run start
```

## Validar

```bash
bun run typecheck
bun test
```

O modelo relacional usa UUIDs, categorias cadastráveis, histórico imutável de status, atribuição e prioridade, além de constraints para responsáveis gestores, resolução e avaliação. O plano completo da API está em [`docs/API_PLAN.md`](docs/API_PLAN.md).

## API

A API REST usa o prefixo `/api/v1`. O health check está em `/health`, o contrato OpenAPI em `/openapi.json` e a interface interativa em `/docs`.

O seed administrativo exige `MANAGER_PASSWORD` e cria ou atualiza o usuário configurado por `MANAGER_EMAIL`. Access tokens duram 15 minutos por padrão; refresh tokens são rotativos e revogáveis.

Uploads aceitam o corpo binário da imagem (`image/jpeg`, `image/png` ou `image/webp`) e o nome opcional no header `X-File-Name`. Cada ocorrência aceita até cinco imagens de 5 MB, armazenadas no diretório configurado em `UPLOAD_DIRECTORY`.

### update swagger

`bun run openapi:validate`
