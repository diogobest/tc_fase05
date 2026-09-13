# Backlog — Gestão de Ocorrências

Backlog derivado do fluxo de solicitantes e gestores no diagrama do Mermaid.

## P0 — Fundação do projeto

- [ ] **Configurar persistência com PostgreSQL**
  - Definir migrations e conexão por variáveis de ambiente.
  - Criar tabelas para usuários, ocorrências, anexos, comentários, histórico, responsáveis e avaliações.
  - Adicionar índices para categoria, status, prioridade, solicitante, responsável e data de criação.
  - **Aceite:** a aplicação cria/atualiza o schema por migration e conecta ao banco do `docker-compose.yml`.

- [ ] **Definir regras e estados da ocorrência**
  - Categorias: cadastrar uma lista inicial e permitir evolução sem alterar o código.
  - Prioridades: baixa, média, alta e crítica.
  - Status: aberta, em análise, em atendimento, resolvida e cancelada.
  - Validar transições de status e registrar cada mudança no histórico.
  - **Aceite:** transições inválidas são rejeitadas e as válidas deixam uma trilha de auditoria.

- [ ] **Implementar a máquina de estados da ocorrência**
  - Permitir `aberta → em análise` pela ação **Analisar**.
  - Permitir `em análise → em atendimento` pela ação **Iniciar atendimento**.
  - Permitir `em atendimento → resolvida` pela ação **Concluir**.
  - Permitir o cancelamento a partir de `aberta`, `em análise` ou `em atendimento`.
  - Tratar `resolvida` e `cancelada` como estados finais, sem novas transições.
  - Centralizar essas regras no domínio para que não possam ser contornadas por outra rota.
  - **Aceite:** somente as seis transições descritas acima são aceitas pela API.

- [ ] **Persistir uma auditoria completa em toda mudança de status**
  - Registrar status anterior, novo status, data/hora, usuário responsável e observação.
  - Tornar a observação obrigatória ao cancelar e configurável nas demais transições.
  - Gravar a ocorrência e seu histórico na mesma transação de banco de dados.
  - Manter os registros imutáveis e retorná-los em ordem cronológica.
  - **Aceite:** toda transição bem-sucedida gera exatamente um registro de histórico; em caso de falha, nenhuma das duas alterações é persistida.

- [ ] **Criar estrutura base da API**
  - Separar rotas, controllers, serviços, repositórios, validações e tratamento de erros.
  - Adicionar endpoint de health check e encerramento seguro da aplicação.
  - Padronizar respostas e erros HTTP.
  - **Aceite:** `GET /health` informa o estado da API e do banco.

## P0 — Conta e autenticação

- [ ] **Implementar criação de conta do solicitante**
  - Receber nome, e-mail e senha; validar dados e impedir e-mails duplicados.
  - Armazenar somente o hash da senha.
  - **Aceite:** uma conta válida é criada e dados inválidos retornam erros claros.

- [ ] **Implementar autenticação e autorização por perfil**
  - Criar login e mecanismo de sessão/token.
  - Proteger rotas privadas e diferenciar os perfis `solicitante` e `gestor`.
  - Garantir que solicitantes acessem somente as próprias ocorrências.
  - **Aceite:** credenciais inválidas e acessos sem permissão retornam `401`/`403`.

## P0 — Jornada do solicitante

- [ ] **Permitir registrar uma ocorrência**
  - Receber título, descrição, categoria e localização.
  - Definir status inicial como `aberta` e prioridade inicial conforme regra de negócio.
  - Registrar criação no histórico.
  - **Aceite:** o solicitante autenticado cria uma ocorrência e recebe seu identificador.

- [ ] **Permitir anexar imagem à ocorrência**
  - Validar tipo, tamanho e quantidade de arquivos.
  - Definir armazenamento local ou em serviço de objetos e salvar apenas a referência no banco.
  - Impedir acesso não autorizado aos anexos.
  - **Aceite:** imagens válidas podem ser enviadas e consultadas; arquivos inválidos são rejeitados.

- [ ] **Permitir acompanhar ocorrências e consultar histórico**
  - Listar as ocorrências do solicitante com paginação.
  - Exibir detalhes, status atual, responsável, comentários e linha do tempo de alterações.
  - **Aceite:** o histórico aparece em ordem cronológica e não pode ser alterado pelo solicitante.

- [ ] **Permitir adicionar comentários**
  - Criar comentários vinculados ao autor e à ocorrência.
  - Registrar data/hora e impedir conteúdo vazio.
  - **Aceite:** solicitante e gestor autorizados veem os comentários em ordem cronológica.

- [ ] **Permitir avaliar uma resolução**
  - Aceitar nota e comentário opcional somente para ocorrências resolvidas.
  - Permitir uma avaliação por ocorrência e somente pelo solicitante proprietário.
  - **Aceite:** avaliações duplicadas ou feitas antes da resolução são rejeitadas.

## P1 — Jornada do gestor

- [ ] **Criar listagem administrativa de ocorrências**
  - Listar todas as ocorrências com paginação e ordenação.
  - Filtrar por categoria, status, prioridade e responsável.
  - **Aceite:** filtros podem ser combinados e mantêm uma resposta paginada consistente.

- [ ] **Permitir alterar a prioridade**
  - Restringir a ação ao gestor e exigir uma justificativa.
  - Registrar valor anterior, novo valor, autor e data no histórico.
  - **Aceite:** a alteração é refletida imediatamente e é auditável.

- [ ] **Permitir atribuir um responsável**
  - Selecionar um usuário elegível e permitir reatribuição com justificativa.
  - Registrar atribuições e reatribuições no histórico.
  - **Aceite:** a ocorrência informa o responsável atual e preserva atribuições anteriores.

- [ ] **Permitir atualizar o status**
  - Expor ações explícitas para analisar, iniciar atendimento, concluir e cancelar.
  - Aplicar as transições definidas na máquina de estados do domínio.
  - Receber uma observação e registrar cada alteração no histórico.
  - **Aceite:** somente gestores autorizados alteram o status e a trilha de auditoria é preservada.

- [ ] **Permitir registrar a solução aplicada**
  - Exigir a descrição da solução antes de marcar a ocorrência como resolvida.
  - Registrar autor e data da resolução.
  - **Aceite:** não é possível concluir uma ocorrência sem uma solução documentada.

- [ ] **Criar dashboard gerencial**
  - Exibir totais por status, categoria e prioridade.
  - Exibir tempo médio de resolução, ocorrências em atraso e avaliações recebidas.
  - Permitir filtro por período.
  - **Aceite:** os indicadores correspondem aos dados retornados pela listagem no mesmo período.

## P1 — Qualidade, segurança e entrega

- [ ] **Documentar a API**
  - Publicar contrato OpenAPI com exemplos, autenticação, filtros e erros.
  - **Aceite:** todos os endpoints públicos podem ser testados pela documentação.

- [ ] **Adicionar testes automatizados**
  - Cobrir regras de domínio com testes unitários.
  - Cobrir autenticação, permissões e jornadas principais com testes de integração.
  - Testar todas as transições permitidas, os estados finais e cada transição inválida.
  - Verificar atomicidade e os cinco campos obrigatórios do histórico de status.
  - Incluir cenários de falha e isolamento de dados entre solicitantes.
  - **Aceite:** a suíte roda por um único comando e não depende de estado manual prévio.

- [ ] **Aplicar controles de segurança e observabilidade**
  - Validar e sanitizar entradas, limitar requisições e uploads e proteger segredos.
  - Adicionar logs estruturados com identificador de requisição, sem dados sensíveis.
  - **Aceite:** falhas importantes são rastreáveis e senhas/tokens nunca aparecem nos logs.

- [ ] **Preparar execução e integração contínua**
  - Completar `.env.example`, revisar o Docker Compose e adicionar comandos de lint, typecheck e test.
  - Configurar CI para validar cada alteração.
  - **Aceite:** um novo ambiente inicia seguindo apenas o README e a CI passa com o projeto limpo.

## Ordem sugerida

1. Fundação do projeto e modelo de dados.
2. Cadastro, autenticação e autorização.
3. Criação e acompanhamento de ocorrências pelo solicitante.
4. Operações do gestor e histórico auditável.
5. Avaliação e dashboard.
6. Documentação, testes, segurança e CI.
