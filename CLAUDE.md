# Automation Hub — Contexto do Projeto

## O que é este projeto

Hub de automação interno usado por gestores para monitorar funcionários executando robôs RPA. Permite visualizar execuções em tempo real, ver quem está rodando o quê, quanto tempo o robô economizou e gerar relatórios de ganho para a diretoria.

## Estrutura do monorepo

```
automation-hub/
├── apps/
│   ├── api/          # Backend NestJS (porta 3000)
│   ├── web/          # Frontend React + Vite (porta 5173 em dev)
│   └── worker/       # Worker service (não utilizado ativamente)
├── integrations/
│   └── bot-sintegra-ce/   # Exemplo de robô Python (Playwright + Behave)
└── examples/
    └── python/
        └── xlsx-log-test/ # Exemplo de robô Python simples
```

## Stack

### Backend (`apps/api`)
- **NestJS 11** com Express
- **PostgreSQL 15+** via **Prisma 7** (adapter pg)
- **TypeScript 5.7**, CommonJS
- Porta padrão: `3000`
- Serve o frontend React em produção (pasta `../web/dist`)
- Serve arquivos estáticos em `/storage/` (protegido por sessão)

### Frontend (`apps/web`)
- **React 19** + **Vite 8** + **TypeScript 5.9**
- **TailwindCSS 3** + **Radix UI** (Dialog, Slot)
- **React Router 7**, **Lucide React**
- Porta de dev: `5173` (proxy `/api` e `/storage` para porta 3000)
- **Build obrigatório** para refletir mudanças quando servido pelo backend:
  ```bash
  cd apps/web && npm run build
  ```

## Comandos principais

### API
```bash
cd apps/api
npm run start:dev   # desenvolvimento com watch
npm run build       # compilar
npm run start:prod  # produção (node dist/main)
```

### Web
```bash
cd apps/web
npm run dev         # servidor de desenvolvimento Vite
npm run build       # gerar dist/ para produção
```

## Variáveis de ambiente (`apps/api/.env`)

```
DATABASE_URL=postgresql://hub:<senha>@localhost:5433/hub?schema=public
RUNNER_MAX_CONCURRENCY=2
RUNNER_MEMORY_THRESHOLD_PERCENT=90
ALLOWED_ORIGIN=http://localhost:5173
PORT=3000  # opcional
EXECUTION_RETENTION_DAYS=30  # retenção de arquivos/logs de execuções (0 = nunca limpar)
EXECUTION_STALL_TIMEOUT_MINUTES=45  # watchdog: cancela como erro uma execução sem NENHUMA saída (stdout/stderr) por esse tempo (0 = desligado)
```

Relatório "Tempo ganho" (todas opcionais, valores padrão entre parênteses; ver `apps/api/src/reports/time-savings-metrics.ts`):
`TIME_SAVINGS_WORKDAY_HOURS` (7, jornada do FTE), `TIME_SAVINGS_OUTLIER_PERCENTILE` (99), `TIME_SAVINGS_OUTLIER_MIN_SAMPLE` (20),
`TIME_SAVINGS_OUTLIER_MIN_MULTIPLE` (5, × mediana), `TIME_SAVINGS_RUN_RATE_WINDOW_DAYS` (90), `TIME_SAVINGS_RUN_RATE_MIN_DAYS` (28),
`TIME_SAVINGS_RUN_RATE_MIN_ACTIVE_DAYS` (10).

## Banco de dados

### Modelos principais

| Modelo | Descrição |
|---|---|
| `User` | Usuários com role e departamentos |
| `Session` | Sessões de 7 dias (token hasheado com SHA-256) |
| `Robot` | Definição dos robôs (schema, comando, departamentos permitidos) |
| `Execution` | Cada execução de um robô (status, progresso, logs, arquivos) |
| `ExecutionLog` | Logs em tempo real de cada execução |
| `ExecutionFile` | Arquivos de entrada/saída de cada execução |
| `ScheduledTask` | Agendamentos recorrentes (once/daily/weekly/monthly) |
| `RobotInputExample` | Arquivos de exemplo para download pelo usuário |

### Enums importantes

**UserRole:** `admin` | `manager` | `employee`

**Department:** `pessoal` | `fiscal` | `contabil` | `tecnologia` | `inovacao` | `legalizacao` | `certificacao` | `auditoria` | `rh`

**ExecutionStatus:** `queued` | `running` | `success` | `error` | `canceled`

**ScheduleFrequency:** `once` | `daily` | `weekly` | `monthly`

### Migrações
```bash
cd apps/api
npx prisma migrate dev    # criar migração em dev
npx prisma migrate deploy # aplicar em produção
npx prisma studio         # UI visual do banco
```

## Controle de acesso

| Role | O que vê/pode fazer |
|---|---|
| `admin` | Tudo — CRUD de robôs, todos os usuários, todas as execuções |
| `manager` | Execuções do próprio departamento, agendamentos do departamento |
| `employee` | Apenas as próprias execuções e agendamentos |

Robôs com `allowedDepartments` vazio são acessíveis por todos. Se preenchido, só usuários dos departamentos listados podem executar.

## Arquitetura do runner de execuções

O `ExecutionRunnerService` processa uma fila a cada 3 segundos:
1. Verifica slots disponíveis (`RUNNER_MAX_CONCURRENCY`)
2. Verifica memória do servidor (`RUNNER_MEMORY_THRESHOLD_PERCENT`)
3. Verifica `conflictKeys` — robôs com mesma chave não rodam em paralelo
4. Spawna o processo do robô com `shell: true`
5. Passa variáveis de ambiente ao processo filho:
   - `AUTOMATION_EXECUTION_ID`
   - `AUTOMATION_INPUT_DIR`
   - `AUTOMATION_OUTPUT_DIR`
   - `AUTOMATION_METADATA_DIR`
   - `AUTOMATION_PARAMETERS_FILE`
   - `AUTOMATION_CONTEXT_FILE`

### Protocolo de comunicação robô → hub (stdout)

| Prefixo | Exemplo | Efeito |
|---|---|---|
| `AH_PROGRESS\|N\|mensagem` | `AH_PROGRESS\|75\|Processando linhas` | Atualiza barra de progresso |
| `AH_LOG\|level\|mensagem` | `AH_LOG\|info\|Arquivo lido` | Grava log com nível |
| `AH_METRIC\|chave\|valor` | `AH_METRIC\|itens_processados\|42` | Registra métrica (usada para calcular tempo economizado) |

Qualquer linha que não case com os prefixos vira log automático.

## APIs principais

```
POST /api/auth/register
POST /api/auth/login
GET  /api/auth/me
POST /api/auth/logout

GET  /api/robots/hub          # visão geral do dashboard
GET  /api/robots
GET  /api/robots/:id
POST /api/robots              # admin only
DELETE /api/robots/:id        # admin only

GET  /api/executions
GET  /api/executions/:id
POST /api/executions          # multipart: parameters + arquivos
POST /api/executions/:id/cancel

GET  /api/scheduled-tasks
POST /api/scheduled-tasks
DELETE /api/scheduled-tasks/:id

GET  /api/users               # admin only
PATCH /api/users/:id          # admin only

GET  /api/reports/time-savings

GET  /storage/*               # arquivos estáticos (requer autenticação)
```

## Páginas do frontend

| Rota | Página | Acesso |
|---|---|---|
| `/` | Dashboard | Todos |
| `/robots` | Catálogo de robôs | Todos |
| `/robots/:id` | Detalhe + formulário de execução | Todos |
| `/executions/:id` | Monitoramento de execução | Todos |
| `/history` | Histórico de execuções | Todos |
| `/schedules` | Agendamentos | Todos |
| `/time-savings` | Relatório de tempo economizado | Todos |
| `/settings` | Gerenciar robôs e usuários | Admin only |

## Decisões de design relevantes

- **Token de sessão** nunca é armazenado em banco — apenas o SHA-256 hash
- **Senha** usa scrypt com salt aleatório e `timingSafeEqual` na comparação
- **Arquivos de output** em `/storage/` são protegidos por middleware de sessão (não são públicos)
- **CORS** restrito à origem configurada em `ALLOWED_ORIGIN`
- **Rate limiting** in-memory em `/auth/login` e `/auth/register`: 10 tentativas por IP por minuto
- **Logs** não são carregados na listagem de execuções — apenas no detalhe individual
- `terminateProcessTree` usa `taskkill` no Windows e `process.kill(-pid)` no Linux/Mac
- O frontend em produção é servido pelo próprio NestJS a partir de `apps/web/dist`
- **Retenção:** `RetentionService` (`src/maintenance/`) roda a cada 6h e apaga arquivos (`storage/executions/<id>/`) e `ExecutionLog` de execuções finalizadas há mais de `EXECUTION_RETENTION_DAYS` dias (marca `Execution.cleanedAt`; a linha da execução permanece para relatórios). Também purga sessões expiradas.
- **Uploads** têm limite de 50MB por arquivo e 15 arquivos por request (`shared/upload.ts`) — memory storage do multer sem limite derrubaria a RAM da VM
- **`/storage`** valida sessão E autorização por recurso (`shared/storage-access.ts`): execuções seguem `canAccessExecution`, exemplos seguem `canAccessRobot`, scripts/pip são admin-only
- **Chat do hub × chat de IA dos painéis:** um BI (Site `category=bi`) pode ter `Site.linkedDashboardId` apontando pra um painel (Dashboard `type=server`, com `POST /chatkit` próprio). Quando o usuário abre esse BI em "Ver", o chat do hub manda as perguntas direto ao `/chatkit` do painel (`site-chat/bi-chat-bridge.service.ts`; tradução dos eventos em `chatkit-events.ts`, testada em `test/chatkit-events.test.ts`), sem passar por modelo do hub (custo = o do chat do painel). A conversa continua pelo `thread_id` (em memória, 30 min). Exige acesso ao Site (`canAccessSite`) E ao Dashboard (`canAccessDashboard`); sem vínculo/permissão cai no chat normal. Não conhece os filtros que o usuário escolheu no Power BI (só os dados do painel). **Desligar:** desvincular o BI em Sites → editar → "Chat de IA (painel vinculado)", ou `BI_CHAT_BRIDGE_ENABLED=false` no `.env` + reiniciar. Vinculados hoje (2026-10-08): Performance Pessoal → BI PERFORMANCE PESSOAL; Controle de Processos Seletivos RH → BI RH; Indicadores Fiscal → BI INDICADORES FISCAL (painel só para `inovacao`: gestores de fiscal caem no chat normal até esse painel liberar `fiscal`); Performance Comercial → DASHBOARD PERFORMANCE DEPARTAMENTO COMERCIAL; Performance Contábil → BI PERFORMANCE CONTÁBIL; Performance Fiscal → BI PERFORMANCE FISCAL; TOPCERT → TOPCERT. Sem vínculo: Balanços e DRE Contábil (o painel BI DRE Contábil ainda não tem `/chatkit`), Performance Selo, Performance Geral e Relatório Departamento Pessoal (sem painel equivalente confirmado; o BI Financeiro usa marcação `.f` nos filtros, que o leitor `.campo-filtro` do hub não enxerga).
- **Painel em tela cheia com chat do hub:** na aba Painéis de Sites, o botão "Abrir" (único botão do painel) abre o painel num iframe em tela cheia (`components/dashboard-viewer.tsx`, mesma origem do hub, via `/d/<slug>/`), sem botão de abrir em nova aba. O painel aberto mora na URL (`/sites?tab=paineis&painel=<slug>`): F5 mantém o painel, o voltar do navegador fecha e o avançar reabre; link direto também funciona (slug inexistente/sem acesso limpa o parâmetro). A aba interna do painel (Colaborador, Cliente, Tarefas...) também mora na URL (`&pagina=static/tarefas.html`, atualizada com `replace` a cada página carregada no iframe, validada em `lib/panel-path.ts`), então o F5 reabre na mesma aba; ao abrir numa página interna o visualizador "aquece" o login pela raiz do painel (`?t=` não funciona em caminho de arquivo: o hub redireciona para `.../arquivo.html/`) e só então abre o caminho direto. Os cliques no menu do próprio painel viram `location.replace` (não entram no histórico do navegador), e abrir de novo começa na página inicial. Para o F5 não piscar o menu do hub, o `index.html` cria uma cobertura `#boot-cover` (skeleton, mesma estrutura/medidas de `components/panel-skeleton.tsx` — mexeu num, ajuste o outro) antes do React quando a URL é `/sites?...&painel=`; `lib/boot-cover.ts` a remove quando a tela cheia do painel está montada (`sites-page.tsx`), no login (`app.tsx`) ou após 20s (segurança). Painéis do tipo `server` registram o escopo `{ dashboardId, getScreenContext }` no chat do hub; a cada pergunta o navegador lê a página + filtros do iframe (`lib/panel-screen-context.ts`, mesma lógica do `coletarContextoTela()` do `theme.js` dos painéis: `.campo-filtro`, `_obterSelecionados()`), sanitiza no servidor (`site-chat/screen-context.ts`) e a ponte repassa ao `POST /chatkit?contexto=…` do painel. O chat próprio do painel continua dentro do iframe (o robô do hub fica no mesmo canto de sempre, padronizado). **Conversas separadas:** `SiteChatMessage.scope` = `hub` (chat do hub) ou `dash:<id do painel>` (conversa com o assistente daquele painel; o BI vinculado e o próprio painel compartilham a mesma, pois falam com o mesmo assistente). Histórico, "Limpar conversa" e o contexto do modelo do hub são por escopo (`site-chat/conversation-scope.ts`; `GET/DELETE /site-chat/messages?scope=`); o widget recarrega o histórico ao entrar/sair de um painel. Observação: o painel leva alguns segundos após o último texto para fechar o stream (grava logs/métricas dele), então o evento `done` chega depois do texto aparecer. Painéis novos só precisam da rota `/chatkit` (protocolo ChatKit, `?contexto={pagina,filtros}`) e da mesma estrutura de filtros; outra estrutura = filtros vazios (não quebra).
- **O João (assistente do hub):** o chat do hub e o mascote são o João, fixo para todos (sem escolha de mascote; a coluna `User.mascotSkin` ficou sem uso). Quadros em `apps/web/public/mascots/joao/mascot-<modo>-<n>.png` (modos e nº de quadros em `MASCOT_ANIMATIONS`, no `site-chat-widget.tsx`): `waiting` (parado), `idle` (atento, quando há balão de dica), `running` (arrastando; `run-left` é o espelho de `run-right`), `jumping` (soltou), `waving` (acena ao abrir o chat, ao voltar da bolinha e, às vezes, sozinho na tela inicial), `failed` (triste e senta, ao ocultar), `review` (pensando, enquanto responde) e `tablet` (com painel/BI aberto). Quadros novos precisam ter o mesmo tamanho visual do João em pé (senão ele "cresce" na troca de animação). Os textos e o prompt dele ("Oi, eu sou o João!") ficam no widget e em `site-chat.service.ts`.
- **Registro** cria contas com `isActive: false` — um admin precisa ativar em `/settings` antes do primeiro login (o primeiro usuário do sistema continua virando admin ativo)
- **Priority** de execução só é aceito de admins (empregados não furam a fila)

## Integração de novos robôs

Para adicionar um novo robô:
1. Criar o robô via `POST /api/robots` (admin) com `command` e `workingDirectory`
2. O script deve ler parâmetros de `AUTOMATION_PARAMETERS_FILE` (JSON)
3. Arquivos de entrada ficam em `AUTOMATION_INPUT_DIR/`
4. Arquivos de saída devem ser gravados em `AUTOMATION_OUTPUT_DIR/`
5. Usar os prefixos `AH_PROGRESS`, `AH_LOG`, `AH_METRIC` no stdout para comunicar progresso
6. Retornar exit code `0` para sucesso, qualquer outro para erro

Veja o exemplo em `integrations/bot-sintegra-ce/` para referência Python.

## Infraestrutura e Deploy

Detalhes de infraestrutura (VM de produção, IIS/ARR, HTTPS, Oracle Cloud, IPs, credenciais de dev e comandos de deploy)
ficam em `CLAUDE.local.md`, que é **ignorado pelo git** (repositório público) e lido automaticamente pelo Claude Code
nesta máquina. Não copie esses dados para arquivos versionados.

### Repositório GitHub
- **URL:** https://github.com/Controller-Desenvolvimento/automation-hub (público)
- **Organização:** Controller-Desenvolvimento (membros: davi-baptista, InovController e outros)
- **Branch principal:** `master`
- Push pela conta `davi-baptista` (`gh auth status`); autor dos commits: Davi Baptista.
- Robôs: repositório privado `Controller-Desenvolvimento/hub-robots` (clonado em `ROBOTS_REPO_DIR`).
### Auto deploy (servidor Windows)
Todo push no `master` é publicado sozinho no servidor: a tarefa agendada `AutomationHubAutoDeploy` roda `infra/windows/deploy.ps1` a cada minuto (instalar/remover: `infra/windows/install-autodeploy.ps1`, na sessão do usuário do servidor, junto do PM2). O servidor **busca** o código (não há como o GitHub entrar nele), e o resultado aparece no commit como o check `deploy/servidor`.
- **O que muda decide o caminho** (compara com o commit que está de fato no ar, guardado em `apps/api/storage/deploy-deployed.json`): só docs/infra → nada a reiniciar; `apps/web` → compila numa pasta paralela e troca a `dist` (**sem reiniciar nada**, as automações nem sentem); `apps/api` → compila em `dist-next` e **segura a fila**: grava `storage/deploy-pending.json`, o `ExecutionRunnerService` para de iniciar execuções novas (ficam na fila) e o admin vê o aviso (`components/deploy-banner.tsx`, `GET /api/system/deploy`). Quando não há execução rodando, migra o banco (se precisa), troca a `dist`, reinicia o PM2 e confere a saúde; se não subir, volta sozinho pra versão anterior (aviso vermelho pro admin). O botão "Atualizar agora" (`POST /api/system/deploy/force`) cancela o que está rodando e libera o reinício.
- **Regras:** a pasta do servidor não pode ter alterações locais não commitadas (o deploy se recusa a mexer nela e avisa); só avança em fast-forward; mudou `package-lock.json` da API → para o PM2, `npm ci`, recompila e sobe (breve indisponibilidade); migrações do banco precisam ser **compatíveis com a versão anterior** (adicionar antes de remover), porque rodam antes do reinício e uma volta atrás não as desfaz; o `deploy-pending.json` esquecido por mais de 6 h é ignorado (a fila nunca fica parada pra sempre).
- **Operação:** log em `apps/api/storage/deploy.log`; `powershell -File infra\windows\deploy.ps1 -DryRun` mostra o que faria sem alterar nada; `-CheckEnv` diagnostica o ambiente (git, pm2, banco, saúde, gh). Para pausar: `install-autodeploy.ps1 -Uninstall`. Para o status aparecer no GitHub sem depender do `gh` logado, coloque um token (permissão "Commit statuses: write") em `%USERPROFILE%\.automation-hub-deploy-token`.

- O `.gitignore` exclui: `node_modules/`, `.env*`, `dist/`, `apps/api/data/`, `.claude/`, `tmp/`, `logs/`, `CLAUDE.local.md` e notas internas.
- Produção: VM Windows da empresa com PM2 (`automation-hub`) atrás de IIS/ARR; deploy manual = `git pull`, `npm run build` em `apps/web` e `apps/api`, `pm2 restart automation-hub`.
