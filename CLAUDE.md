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
SERVER_PATH_DRIVES=X=\\servidor\compartilhamento  # unidades de rede vistas pelo servidor, p/ campos `serverpath` (letra=caminho; vários separados por `;`)
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
- **Chat do hub × chat de IA dos painéis:** um BI (Site `category=bi`) pode ter `Site.linkedDashboardId` apontando pra um painel (Dashboard `type=server`, com `POST /chatkit` próprio). Quando o usuário abre esse BI em "Ver", o chat do hub manda as perguntas direto ao `/chatkit` do painel (`site-chat/bi-chat-bridge.service.ts`; tradução dos eventos em `chatkit-events.ts`, testada em `test/chatkit-events.test.ts`), sem passar por modelo do hub (custo = o do chat do painel). A conversa continua pelo `thread_id` (em memória, 30 min). Exige acesso ao Site (`canAccessSite`) E ao Dashboard (`canAccessDashboard`); sem vínculo/permissão cai no chat normal. Não conhece os filtros que o usuário escolheu no Power BI (só os dados do painel). **Desligar:** desvincular o BI em Sites → editar → "Chat de IA (painel vinculado)", ou `BI_CHAT_BRIDGE_ENABLED=false` no `.env` + reiniciar. Vinculados hoje (2026-10-15, 9 de 11 BIs): Performance Pessoal → BI PERFORMANCE PESSOAL; Controle de Processos Seletivos RH → BI RH; Indicadores Fiscal → BI INDICADORES FISCAL (painel só para `inovacao`: gestores de fiscal caem no chat normal até esse painel liberar `fiscal`); Performance Comercial → DASHBOARD PERFORMANCE DEPARTAMENTO COMERCIAL; Performance Contábil → BI PERFORMANCE CONTÁBIL; Performance Fiscal → BI PERFORMANCE FISCAL; TOPCERT → TOPCERT; Balanços e DRE Contábil → BI DRE Contábil; Performance Geral → BI Financeiro (vínculo inferido: o painel é o "Dashboard Financeiro de Custos" e libera o departamento `sucesso_do_cliente`, o mesmo do BI; o BI Financeiro tem lista fechada de usuários — `allowedUserIds` — então só quem está na lista usa o chat do painel, os demais caem no chat normal). Sem vínculo: Performance Selo (não existe painel) e Relatório Departamento Pessoal (o painel BI RELATÓRIO PESSOAL, porta 8513, ainda não tem chat: 404 em `/chatkit` e `/api/chatkit`; vincular só depois de ele ter; o BI RELATÓRIO PESSOAL - HML é cópia de homologação e não deve ser vinculado).
- **Painel em tela cheia com chat do hub:** na aba Painéis de Sites, o botão "Abrir" (único botão do painel) abre o painel num iframe em tela cheia (`components/dashboard-viewer.tsx`, mesma origem do hub, via `/d/<slug>/`), sem botão de abrir em nova aba. O "Abrir" é um link de verdade (`<Link>` para `?tab=paineis&painel=<slug>`): clique normal abre na mesma aba; Ctrl/Cmd+clique, botão do meio ou "abrir link em nova aba" abrem uma aba nova direto no painel. O painel aberto mora na URL (`/sites?tab=paineis&painel=<slug>`): F5 mantém o painel, o voltar do navegador fecha e o avançar reabre; link direto também funciona (slug inexistente/sem acesso limpa o parâmetro). A aba interna do painel (Colaborador, Cliente, Tarefas...) também mora na URL (`&pagina=static/tarefas.html`, atualizada com `replace` a cada página carregada no iframe, validada em `lib/panel-path.ts`), então o F5 reabre na mesma aba; ao abrir numa página interna o visualizador "aquece" o login pela raiz do painel (`?t=` não funciona em caminho de arquivo: o hub redireciona para `.../arquivo.html/`) e só então abre o caminho direto. Os cliques no menu do próprio painel viram `location.replace` (não entram no histórico do navegador), e abrir de novo começa na página inicial. Para o F5 não piscar o menu do hub, o `index.html` cria uma cobertura `#boot-cover` (skeleton, mesma estrutura/medidas de `components/panel-skeleton.tsx` — mexeu num, ajuste o outro) antes do React quando a URL é `/sites?...&painel=`; `lib/boot-cover.ts` a remove quando a tela cheia do painel está montada (`sites-page.tsx`), no login (`app.tsx`) ou após 20s (segurança). Painéis do tipo `server` registram o escopo `{ dashboardId, getScreenContext }` no chat do hub; a cada pergunta o navegador lê a página + filtros do iframe (`lib/panel-screen-context.ts`: usa a função global `coletarContextoTela()` da própria página quando ela existe — é o caso do BI DRE Contábil, que não tem `.campo-filtro` — e, senão, a mesma lógica do `theme.js` dos painéis: `.campo-filtro`, `_obterSelecionados()`), sanitiza no servidor (`site-chat/screen-context.ts`) e a ponte repassa ao `POST /chatkit?contexto=…` do painel, junto com `X-Hub-User-Email`/`X-Hub-User-Name` (a ponte chama o painel direto, sem o proxy `/d/<slug>` que injeta esses cabeçalhos pro navegador; sem eles o painel não sabe quem pergunta e pode cair na seleção de outro usuário). O chat próprio do painel continua dentro do iframe (o robô do hub fica no mesmo canto de sempre, padronizado). **Conversas separadas:** `SiteChatMessage.scope` = `hub` (chat do hub) ou `dash:<id do painel>` (conversa com o assistente daquele painel; o BI vinculado e o próprio painel compartilham a mesma, pois falam com o mesmo assistente). Histórico, "Limpar conversa" e o contexto do modelo do hub são por escopo (`site-chat/conversation-scope.ts`; `GET/DELETE /site-chat/messages?scope=`); o widget recarrega o histórico ao entrar/sair de um painel. Observação: o painel leva alguns segundos após o último texto para fechar o stream (grava logs/métricas dele), então o evento `done` chega depois do texto aparecer. Painéis novos só precisam da rota `/chatkit` (protocolo ChatKit, `?contexto={pagina,filtros}`) e da mesma estrutura de filtros; outra estrutura = filtros vazios (não quebra).
- **Links e arquivos gerados pelo chat de IA dos painéis:** as mensagens do João renderizam `**negrito**` e links markdown (`lib/chat-markdown.ts`, só peças React, nunca HTML; `javascript:`/`data:`/`//`/relativo solto viram só texto; `http(s)` abre em outra aba). Quando o painel gera um Excel/CSV a pedido do chat, o texto traz `[Baixar Excel (nome.xlsx)](../chatkit-download/<32hex>__<nome>.xlsx)` (também aceitos `/api/chatkit-download/…` e `/d/<slug>/chatkit-download/…`); esse link vira um botão de download que só funciona com um painel no escopo do chat (`dash:<id>`). O clique chama `POST /api/site-chat/panel-download {dashboardId, file}` (`panel-download.service.ts`: exige `canAccessDashboard`, nome no formato `^[0-9a-f]{32}__…`) e recebe um link assinado de 60 s (`storage-links.ts`, chave `panel:<id>:<arquivo>`) para `GET /api/site-chat/panel-download`, que busca `/chatkit-download/<arquivo>` (ou `/api/chatkit-download/…`) direto na porta do painel e repassa o binário em fluxo, mantendo `Content-Disposition`, com `no-store` e sem buffering. Não usa o proxy `/d/<slug>/` de propósito: ele depende do cookie `dauth`, que só existe depois de abrir um painel. Os arquivos do painel duram 24 h (depois: 404 com aviso). Testes: `test/panel-download.test.ts`, `test/chat-markdown.test.ts`.
- **O João (assistente do hub):** o chat do hub e o mascote são o João, fixo para todos (sem escolha de mascote; a coluna `User.mascotSkin` ficou sem uso). Quadros em `apps/web/public/mascots/joao/mascot-<modo>-<n>.png` (modos e nº de quadros em `MASCOT_ANIMATIONS`, no `site-chat-widget.tsx`): `waiting` (parado), `idle` (atento, quando há balão de dica), `running` (arrastando; `run-left` é o espelho de `run-right`), `jumping` (soltou), `waving` (acena ao abrir o chat, ao voltar da bolinha e, às vezes, sozinho na tela inicial), `failed` (triste e senta, ao ocultar), `review` (pensando, enquanto responde) e `tablet` (com painel/BI aberto). Quadros novos precisam ter o mesmo tamanho visual do João em pé (senão ele "cresce" na troca de animação). Os textos e o prompt dele ("Oi, eu sou o João!") ficam no widget e em `site-chat.service.ts`.
- **Erros de rede na interface:** `lib/api.ts` lança `ApiError` (com `status`; 0 = nem chegou ao servidor) e troca a página HTML de erro do IIS (502/503 quando o hub reinicia ou está sobrecarregado) por uma mensagem curta; `isTransientError` diz o que vale tentar de novo (tudo menos 400/401/403/404). A tela de execução (`pages/execution-page.tsx`) atualiza a cada 2,5 s e, numa falha passageira, mantém o que já mostra, avisa "conexão interrompida" e tenta de novo a cada 5 s — antes uma falha trocava a página inteira pelo erro e parava de atualizar.
- **Rodar novamente** (tela da execução, só para execuções com erro/canceladas; quem executou ou admin — `ExecutionsService.cloneExecution`, `POST /executions/:id/retry` e `/retry-with-output`): cria uma execução nova do mesmo usuário com os **mesmos parâmetros** (inclusive CPF/senha digitados na original — por isso um colega não pode repetir a de outro). "Com as mesmas entradas" copia os arquivos enviados; "com a planilha final como entrada" troca a planilha enviada pela planilha que a execução deixou na saída (o robô a grava a cada linha, então ela já traz o que foi feito e o robô pula essas linhas) — serve para continuar de onde parou depois de um reinício do hub, cancelamento ou erro. A saída com 2+ arquivos fica num `output.zip` (os originais são apagados), então a planilha é lida de dentro do zip; o nome da entrada nova é o da planilha original com a extensão da final. Várias planilhas na saída: vale a de mesmo nome da enviada, ou o `fileName` do corpo; senão a API devolve 400 listando os nomes. Testes: `test/executions-retry.test.ts`. **Reinício do hub mata o que está rodando:** o PM2 sobe só no logon do `robot1`; sair (logoff) da sessão remota derruba hub e robôs (fechar a janela só desconecta). Ao voltar, a execução órfã vira erro "interrompida" com os arquivos recuperados.
- **Parâmetros da execução** (`Execution.inputJson`: empresa, CPF, senha... digitados ao rodar; `shared/execution-parameters.ts`): a tela da execução tem o cartão "Parâmetros" (`ParametersCard`, em `execution-page.tsx`) com todos eles — as senhas aparecem escondidas (pontos, com a quantidade de caracteres) e um botão do olho mostra; serve para achar "senha digitada errada" sem ligar para o suporte. **Quem vê as senhas:** quem executou e administradores (inclui Inovação); gestor do departamento ou destinatário de execução agendada vê os parâmetros SEM os campos de senha (`hiddenParameters` na resposta; senha = campo `type: "password"` do formulário do robô ou nome com senha/password/secret/token). Só o **detalhe** (`GET /executions/:id`) leva `inputJson`; histórico, resultados, execuções recentes da tela inicial e a resposta do cancelamento nunca levam (`withoutParameters`). O valor completo continua no banco porque "Rodar novamente" reaproveita. Testes: `test/execution-parameters.test.ts`.
- **Download de arquivos** (`downloadFile` em `lib/api.ts`): `/storage` exige `Authorization`, que um link comum não manda; antes o frontend baixava com `fetch` + blob, que carrega o arquivo INTEIRO na memória do navegador antes de salvar (há entradas de até ~700 MB: a tela parecia parada por minutos e o download podia ser cancelado). Agora, para `/storage/...`, o frontend pede `POST /api/storage/link` (`storage/storage.controller.ts`), que confere `canAccessStoragePath` + se o arquivo existe no disco (apagado pela retenção → 404 com mensagem clara) e devolve um link `?dl=<token>` assinado (HMAC, 1 minuto, um único caminho, segredo só na memória do servidor — reiniciar o hub invalida os links abertos; `shared/storage-links.ts`). `shared/storage-middleware.ts` aceita esse link (resposta com `Content-Disposition: attachment`; Range funciona) ou o cabeçalho antigo. O navegador baixa direto para o disco, com a barra de progresso dele. Se o servidor ainda não tem a rota (deploy em andamento) o frontend cai no jeito antigo (blob, com a revogação do objeto adiada 60 s). O aviso (toast) agora dura de 3 a 10 s conforme o tamanho do texto — com 3 s fixos as mensagens de erro sumiam antes de serem lidas. Testes: `test/storage-links.test.ts` (servidor Express de verdade).
- **Janelas de console no servidor (Windows):** o hub roda sem console (o PM2 o inicia assim), e nessa condição todo processo de console que ele inicia (um `cmd` por painel, um por robô, `taskkill`, `netstat`...) abre uma janela de prompt na sessão de quem usa a máquina. Todas as chamadas que iniciam processo passam `windowsHide: WINDOWS_HIDE` (`shared/process-options.ts`): o processo e os filhos (python, chromedriver) rodam normalmente, só sem janela; janelas de aplicativos (Chrome de um robô com "mostrar navegador", Excel) não são afetadas. **Não feche à mão as janelas de cmd antigas: cada uma é um painel rodando.** Para voltar a ver as janelas (depurar um robô), `HUB_SHOW_CONSOLES=true` no `.env` da API + reiniciar. O teste `test/windows-hidden-consoles.test.ts` prova com um processo "desanexado" (sem console, como o hub) que a janela some, tem um controle opcional (`TEST_CONSOLE_CONTROL=1`, abre uma janela por ~2 s) que prova que o detector enxerga a janela do jeito antigo, e uma trava que falha se alguma chamada nova de `spawn`/`execSync` em `src/` ficar sem `windowsHide`. Não cobre o `site-eventos` (outro projeto, iniciado direto pelo PM2 com o Python do ambiente dele).
- **Registro** cria contas com `isActive: false` — um admin precisa ativar em `/settings` antes do primeiro login (o primeiro usuário do sistema continua virando admin ativo)
- **Priority** de execução só é aceito de admins (empregados não furam a fila)
- **Reiniciar painel** (Configurações → Painéis → botão "Reiniciar", `POST /api/dashboards/:id/restart`, admin): para o processo, espera a porta liberar (se um processo antigo ficou preso nela, encerra quem a segura — só na faixa 8500–8599), apaga os `__pycache__` do projeto (menos `node_modules`/`venv`/`data`) e sobe um processo NOVO (`DashboardService.restart`). Diferente de Parar + Iniciar: o "Iniciar" reaproveita o que estiver escutando na porta em vez de subir outro (necessário para o hub reencontrar painéis depois de reiniciar), então um processo antigo preso fazia o painel continuar com o código velho. O cache do navegador é outro motivo de "atualizei e não mudou": os painéis entregam estáticos só com `Last-Modified`/`ETag`, sem `Cache-Control`, e o navegador adivinha a validade (dias, para um arquivo antigo; Ctrl+F5 não ajuda porque o painel vive num iframe criado por script). Por isso o proxy (`setupProxy`) acrescenta `Cache-Control: no-cache` quando o painel não manda o dele (guarda e revalida pelo ETag), e a resposta do Reiniciar leva `Clear-Site-Data: "cache"` (só vale para o navegador de quem clicou, e só em HTTPS/localhost). Cópias antigas já guardadas em outros navegadores expiram sozinhas. O evento de saída de um processo já parado/substituído é ignorado (`isSupersededExit`) — antes ele gravava `error` no banco por cima de `stopped`. Testes: `test/dashboard-restart.test.ts` (sobe painéis Python de verdade na porta 8597).

- **Campo `serverpath` (escolher caminho do servidor):** em `schema.fields` do robô, `type: "serverpath"` mostra um campo de texto + botão "Procurar" que abre um navegador das pastas que o **servidor** enxerga (ex.: unidade X:); o robô recebe só o caminho (string em `AUTOMATION_PARAMETERS_FILE`), sem upload. Config do campo: `rootPath` (raiz permitida), `pick` (`file`|`folder`), `accept` (extensões, se arquivo). O navegador (`GET /api/robots/:id/browse?field=&path=`, `shared/server-path.ts`) e a validação na criação da execução só aceitam caminhos DENTRO do `rootPath` do schema (nunca informado pelo cliente; `..`, outra raiz ou prefixo parecido são recusados). A letra da unidade não fica conectada no processo do hub, então `SERVER_PATH_DRIVES` (no `.env`, fora do git) traduz `X:` para o caminho de rede; o robô precisa fazer a mesma tradução ao abrir o caminho. Componente: `components/server-path-picker.tsx` (usado em `robot-detail-page` e `schedules-page`). Exemplo: ADECE — Preencher Nº do Documento.

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
