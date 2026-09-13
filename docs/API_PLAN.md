# Plano de implementação da API — Resolve Aí

Este plano cobre somente o backend descrito no desafio. O frontend será desenvolvido em outro projeto e consumirá a API por HTTP.

## 1. Objetivo do MVP

Entregar uma API REST que permita:

- ao **solicitante** criar uma conta, autenticar-se, registrar e acompanhar suas próprias ocorrências, anexar imagens, comentar, consultar o histórico e avaliar uma resolução;
- ao **gestor** consultar todas as ocorrências, aplicar filtros, definir prioridade, atribuir um responsável, atualizar o status, comentar, registrar a solução e consultar indicadores;
- manter uma trilha de auditoria imutável para toda mudança de status;
- executar a aplicação e suas dependências com Docker, publicar a API em cloud e disponibilizar documentação OpenAPI.

## 2. Decisões propostas

### Stack

- Runtime e gerenciador: Bun.
- Linguagem: TypeScript em modo estrito.
- HTTP: Express 5.
- Banco de dados: PostgreSQL.
- Contrato: OpenAPI 3.1, exposto em `/docs` e `/openapi.json`.
- Autenticação: access token JWT de curta duração e refresh token rotativo e revogável.
- Senhas: Argon2id.
- Validação: schemas compartilhados na borda da aplicação (por exemplo, Zod).
- Persistência: migrations versionadas e consultas/repositórios com transações explícitas.
- Testes: `bun:test`, com banco PostgreSQL isolado para integração.
- Imagens: armazenamento de objetos compatível com S3; em desenvolvimento, MinIO. O banco guarda apenas metadados e a chave do objeto.

### Arquitetura

Organizar por módulos de negócio, mantendo HTTP, aplicação, domínio e infraestrutura separados:

```text
src/
  app.ts
  server.ts
  config/
  shared/{errors,http,middleware,observability}/
  modules/
    auth/
    users/
    categories/
    incidents/
    comments/
    attachments/
    ratings/
    dashboard/
db/{migrations,seeds}/
spec/{unit,integration}/
```

Controllers devem tratar HTTP, serviços/casos de uso devem aplicar regras, e repositórios devem concentrar acesso ao PostgreSQL. Transições de estado ficam no domínio e são persistidas com seu histórico na mesma transação.

## 3. Regras de domínio

### Perfis

- `requester` (solicitante): acessa apenas ocorrências criadas por ele.
- `manager` (gestor): acessa e administra todas as ocorrências.
- Contas públicas são sempre criadas como `requester`. O primeiro gestor é criado por seed ou comando administrativo, nunca por cadastro público.
- No MVP, responsáveis por ocorrências são usuários com perfil `manager`. Se surgir a necessidade de técnicos sem poderes administrativos, deve ser criado um terceiro perfil em vez de ampliar silenciosamente as permissões.

### Estados e transições

Estados: `open`, `under_review`, `in_progress`, `resolved`, `cancelled`.

| Origem         | Destino        | Regra                                 |
| -------------- | -------------- | ------------------------------------- |
| `open`         | `under_review` | gestor inicia a análise               |
| `under_review` | `in_progress`  | gestor inicia o atendimento           |
| `in_progress`  | `resolved`     | gestor informa a solução aplicada     |
| `open`         | `cancelled`    | gestor informa observação obrigatória |
| `under_review` | `cancelled`    | gestor informa observação obrigatória |
| `in_progress`  | `cancelled`    | gestor informa observação obrigatória |

`resolved` e `cancelled` são finais. Cada transição grava, de forma atômica, status anterior, novo status, data/hora, usuário responsável e observação. Na criação, registrar um evento inicial com `previous_status = null` e `new_status = open`.

### Outras regras

- Prioridades: `low`, `medium`, `high`, `critical`; inicialmente `medium`.
- Categorias são dados cadastráveis, não enum fixo no código; o seed inclui iluminação, equipamentos, acessibilidade, limpeza, vazamento, segurança, manutenção e outros.
- Título, descrição, categoria e localização são obrigatórios na criação.
- A solução é obrigatória para resolver uma ocorrência.
- Comentário vazio é inválido; comentários são ordenados por criação e não são editáveis no MVP.
- Uma ocorrência resolvida aceita no máximo uma avaliação, feita somente por seu solicitante, com nota inteira de 1 a 5 e comentário opcional.
- Mudanças de prioridade e responsável também devem gerar eventos de auditoria próprios.
- Datas são armazenadas em UTC e retornadas em ISO 8601.

## 4. Modelo de dados inicial

| Tabela               | Campos essenciais                                                                                                                                               |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `users`              | `id`, `name`, `email` único, `password_hash`, `role`, `active`, timestamps                                                                                      |
| `refresh_tokens`     | `id`, `user_id`, `token_hash`, `expires_at`, `revoked_at`, timestamps                                                                                           |
| `categories`         | `id`, `name`, `slug` único, `active`, timestamps                                                                                                                |
| `incidents`          | `id`, `requester_id`, `assignee_id`, `category_id`, `title`, `description`, localização, `status`, `priority`, `solution`, `resolved_at`, timestamps, `version` |
| `attachments`        | `id`, `incident_id`, `uploaded_by`, `object_key`, `file_name`, `mime_type`, `size`, timestamps                                                                  |
| `comments`           | `id`, `incident_id`, `author_id`, `body`, timestamps                                                                                                            |
| `status_history`     | `id`, `incident_id`, `previous_status`, `new_status`, `changed_by`, `observation`, `created_at`                                                                 |
| `assignment_history` | `id`, `incident_id`, `previous_assignee_id`, `new_assignee_id`, `changed_by`, `reason`, `created_at`                                                            |
| `priority_history`   | `id`, `incident_id`, `previous_priority`, `new_priority`, `changed_by`, `reason`, `created_at`                                                                  |
| `ratings`            | `id`, `incident_id` único, `requester_id`, `score`, `comment`, timestamps                                                                                       |

Localização deve começar com `address` e `details`, podendo incluir `latitude` e `longitude`. Índices mínimos: e-mail, status, prioridade, categoria, solicitante, responsável e data de criação. Usar UUIDs, foreign keys, checks e unicidade no banco, não apenas na aplicação.

## 5. Contrato HTTP proposto

Prefixo: `/api/v1`. JSON usa nomes em `camelCase` e enums estáveis em inglês; textos de interface ficam no frontend.

### Plataforma e autenticação

| Método | Rota             | Acesso                    | Finalidade                    |
| ------ | ---------------- | ------------------------- | ----------------------------- |
| `GET`  | `/health`        | público                   | estado do processo e do banco |
| `POST` | `/auth/register` | público                   | criar solicitante             |
| `POST` | `/auth/login`    | público                   | obter access e refresh token  |
| `POST` | `/auth/refresh`  | público com refresh token | rotacionar tokens             |
| `POST` | `/auth/logout`   | autenticado               | revogar refresh token         |
| `GET`  | `/me`            | autenticado               | retornar usuário atual        |
| `GET`  | `/categories`    | autenticado               | listar categorias ativas      |

### Ocorrências e colaboração

| Método | Rota                                       | Acesso                   | Finalidade                                            |
| ------ | ------------------------------------------ | ------------------------ | ----------------------------------------------------- |
| `POST` | `/incidents`                               | solicitante              | criar ocorrência                                      |
| `GET`  | `/incidents`                               | autenticado              | solicitante vê as suas; gestor vê todas e usa filtros |
| `GET`  | `/incidents/:id`                           | participante autorizado  | detalhes da ocorrência                                |
| `GET`  | `/incidents/:id/history`                   | participante autorizado  | histórico cronológico                                 |
| `POST` | `/incidents/:id/comments`                  | participante autorizado  | adicionar comentário                                  |
| `GET`  | `/incidents/:id/comments`                  | participante autorizado  | listar comentários                                    |
| `POST` | `/incidents/:id/attachments`               | solicitante proprietário | enviar imagem                                         |
| `GET`  | `/incidents/:id/attachments/:attachmentId` | participante autorizado  | obter URL temporária/download                         |
| `POST` | `/incidents/:id/rating`                    | solicitante proprietário | avaliar ocorrência resolvida                          |

Filtros de `GET /incidents`: `status`, `categoryId`, `priority`, `assigneeId`, `createdFrom`, `createdTo`, `page`, `pageSize`, `sort`. O retorno paginado usa `{ data, meta: { page, pageSize, total, totalPages } }`.

### Administração da ocorrência

| Método  | Rota                         | Acesso | Finalidade                                        |
| ------- | ---------------------------- | ------ | ------------------------------------------------- |
| `PATCH` | `/incidents/:id/priority`    | gestor | alterar prioridade com justificativa              |
| `PATCH` | `/incidents/:id/assignee`    | gestor | atribuir/reatribuir responsável com justificativa |
| `POST`  | `/incidents/:id/transitions` | gestor | executar uma transição de status                  |
| `GET`   | `/dashboard/summary`         | gestor | indicadores filtrados por período                 |

Corpo da transição: `{ "to": "under_review", "observation": "...", "solution": null }`. Usar um endpoint de comando evita que um `PATCH` genérico contorne a máquina de estados.

Dashboard: totais por status, categoria e prioridade; tempo médio de resolução; quantidade em atraso; média e distribuição das avaliações. Como o PDF não define SLA, “em atraso” deve ser implementado somente depois de aprovada uma regra de prazo configurável.

### Padrão de respostas e erros

- Criação: `201`; leitura/alteração: `200`; comandos sem corpo: `204` quando aplicável.
- Falhas: `400` entrada malformada, `401` não autenticado, `403` sem permissão, `404` inexistente ou invisível ao usuário, `409` conflito/regra de estado, `413` upload grande, `415` tipo inválido, `422` validação semântica, `429` limite excedido.
- Envelope de erro: `{ "error": { "code": "INVALID_STATUS_TRANSITION", "message": "...", "details": [], "requestId": "..." } }`.
- Aplicar controle otimista (`version`) nas ações administrativas para evitar atualizações concorrentes perdidas.

## 6. Plano incremental de entrega

### Marco 0 — Alinhamento e contrato

- Confirmar decisões pendentes listadas na seção 9.
- Criar OpenAPI inicial com schemas, autenticação, exemplos e erros.
- Definir convenções, variáveis de ambiente e critérios de pronto.
- Entregável: contrato revisável pelo time do frontend antes da implementação.

### Marco 1 — Fundação executável

- Separar criação da aplicação do `listen`, adicionar config validada e encerramento seguro.
- Configurar migrations, seeds, pool, transações e bancos de desenvolvimento/teste.
- Implementar erro padronizado, request ID, logs estruturados e `/health`.
- Completar Docker Compose com API, PostgreSQL e MinIO; criar `.env.example` seguro.
- Testar bootstrap, migrations e health check.

### Marco 2 — Identidade e autorização

- Criar usuários, hash de senha, cadastro, login, refresh rotativo, logout e `/me`.
- Implementar middleware de autenticação, perfil e propriedade da ocorrência.
- Criar seed/comando para gestor.
- Testar duplicidade, credenciais inválidas, expiração/revogação e `401`/`403`.

### Marco 3 — Núcleo de ocorrências

- Criar categorias, ocorrências e histórico inicial.
- Implementar criação, detalhe, listagem paginada e filtros.
- Implementar máquina de estados e transação atômica com histórico.
- Testar todas as seis transições válidas, transições inválidas, estados finais e isolamento entre solicitantes.

### Marco 4 — Operação e colaboração

- Implementar comentários, prioridade, atribuição e auditoria desses eventos.
- Implementar solução obrigatória e resolução.
- Adicionar concorrência otimista e testes de autorização/atomicidade.

### Marco 5 — Imagens e avaliações

- Configurar storage, limites de tamanho/quantidade e allowlist de MIME (`image/jpeg`, `image/png`, `image/webp`).
- Validar o conteúdo real do arquivo, gerar chave não previsível e URL assinada curta.
- Implementar avaliação única de 1 a 5 apenas após resolução.
- Testar acesso indevido, arquivos inválidos, duplicidade e regras de estado.

### Marco 6 — Dashboard

- Criar agregações por período, status, categoria e prioridade.
- Calcular tempo médio de resolução e avaliações.
- Implementar atraso somente após definição do SLA.
- Validar agregados contra o mesmo conjunto de ocorrências da listagem.

### Marco 7 — Endurecimento e entrega

- Adicionar rate limiting, CORS configurável para o domínio do frontend, headers de segurança e limites de payload.
- Garantir que logs não contenham senha, token ou conteúdo sensível.
- Completar testes unitários e de integração, cobertura das jornadas e CI com lint, typecheck, migrations e testes.
- Gerar imagem Docker imutável, executar migrations no deploy, configurar health/readiness e publicar em cloud.
- Validar OpenAPI em CI e executar smoke test no ambiente publicado.

## 7. Estratégia de testes

- **Unidade:** máquina de estados, políticas de autorização, avaliação, solução e validações.
- **Integração:** rotas com PostgreSQL e storage isolados; cada teste limpa ou transaciona seus dados.
- **Contrato:** validar respostas contra OpenAPI e manter exemplos executáveis.
- **Segurança:** acesso cruzado entre solicitantes, elevação de perfil, token revogado, upload disfarçado, enum/UUID inválidos e rate limit.
- **Concorrência:** duas mudanças simultâneas na mesma ocorrência; apenas uma versão deve vencer.
- **Smoke:** health, login do gestor, criação e fluxo completo até avaliação no ambiente de deploy.

Comandos-alvo: `bun run dev`, `bun run lint`, `bun run typecheck`, `bun test`, `bun run db:migrate`, `bun run db:seed`, `bun run openapi:validate`.

## 8. Contrato de integração com o frontend

O projeto da API deve entregar ao projeto do frontend:

- URL por ambiente e configuração de CORS;
- arquivo OpenAPI versionado e changelog de breaking changes;
- coleção ou exemplos de requests, usuário gestor de demonstração e seed previsível;
- enumerações, paginação, formato de erro, limites de upload e fluxo de renovação de token documentados;
- uma versão de staging estável para integração.

O frontend não deve depender de mensagens de erro para lógica; deve usar `error.code`. Mudanças incompatíveis exigem nova versão da API ou período de depreciação.

## 9. Decisões que precisam de validação do grupo

Estas lacunas não são definidas no PDF e não devem ficar implícitas:

1. Cloud alvo e serviço de objetos (AWS, Azure, GCP ou alternativa).
2. Se o “responsável” é sempre gestor ou se haverá perfil técnico dedicado.
3. Limite e quantidade de imagens por ocorrência (sugestão inicial: 5 imagens de até 5 MB).
4. Se solicitante pode cancelar a própria ocorrência; o plano conservador permite transições somente ao gestor.
5. Política de SLA que determina “ocorrência em atraso”.
6. Necessidade de recuperação de senha e verificação de e-mail no MVP.
7. Política de retenção/exclusão de conta e anexos.

Essas decisões podem alterar o contrato e devem ser fechadas no Marco 0.

## 10. Critério de conclusão do MVP

O backend está pronto quando uma instalação limpa consegue subir pelo README, aplicar migrations e seeds, executar a suíte em um comando e completar por API a jornada: cadastro → login → criação com imagem → análise → atribuição → atendimento → comentário → solução → resolução → consulta do histórico → avaliação; todas as permissões e transições inválidas são rejeitadas, o dashboard reflete os dados persistidos, a documentação está publicada e o ambiente cloud passa no smoke test.
