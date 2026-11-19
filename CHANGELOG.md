# Registro de mudanças

Mudanças do Automation Hub por data. Este arquivo é **público**: descreve o que mudou no produto, no banco e na
configuração, sem dados de infraestrutura. O desenho detalhado de cada funcionalidade está no `CLAUDE.md`.

## 2026-11-18 — Nova aba "Suporte" (chamados)

### Novo
- **Aba Suporte** (menu "Acompanhamento", depois de "Tempo ganho"): qualquer pessoa abre um chamado (algo não funciona,
  sugestão ou dúvida; sobre o Hub, um robô, um painel/BI ou outro assunto; urgência Crítica/Alta/Média/Baixa, sem prazos) e
  acompanha as respostas. **Quem não é administrador vê só os próprios chamados** (nem o gestor do departamento vê os dos
  outros). Administradores e a Inovação veem todos, com indicadores (abertos, sem resposta, tempo até a 1ª resposta, robô com
  mais chamados), filtros (urgência, pessoa, departamento, tipo, robô, busca, ordem), responsável, status (Aberto, Em análise,
  Aguardando resposta, Resolvido, Não é problema), urgência ajustável e **notas internas** que quem abriu nunca vê.
- **Sem e-mail:** o aviso é dentro do Hub. Um número ao lado de "Suporte" no menu mostra as novidades (administrador: chamados
  esperando a Inovação; pessoa: respostas novas aos seus chamados), com uma bolinha na lista, e o sino também avisa.
- **Botão "Reportar problema"** na tela da execução: o chamado já abre sobre o robô e leva o erro, os parâmetros digitados
  (**senhas ficam de fora**) e o fim do log.
- **Anexos** na abertura e em qualquer resposta, dos dois lados: Ctrl+V de um print, arrastar ou escolher; imagens
  (png, jpg, gif, webp, até 10 MB) e arquivos (xlsx, xls, csv, pdf, doc, docx, txt, até 25 MB); até 5 por mensagem. Só quem
  abriu o chamado e os administradores baixam (mesma proteção do `/storage`). Os anexos de um chamado **encerrado há mais de
  90 dias são apagados** do disco (o texto e o registro do anexo ficam: no lugar do arquivo aparece o nome, o tamanho e o aviso
  "apagado automaticamente, por segurança, 90 dias depois de o chamado ser encerrado"); `SUPPORT_ATTACHMENT_RETENTION_DAYS` muda o
  prazo (0 = nunca apagar). Os chamados em si nunca são apagados: ficam na aba "Encerrados" como histórico.
- **Juntar chamados** (administrador): o Hub sugere os parecidos (mesmo tipo e mesmo assunto, abertos, até 14 dias de diferença)
  e também dá para marcar caixinhas na lista e clicar em "Juntar chamados". No principal, o administrador vê o que cada autor
  escreveu e **responde uma vez**: a resposta (com anexos) chega na conversa de cada um; o status do principal vale para todos;
  a nota interna nunca vai. Cada pessoa continua vendo só o próprio chamado. Dá para desligar um chamado do grupo.
- **Lista paginada no servidor, sem limite de chamados** (25 por página): situação (em aberto/encerrados/todos), busca por título ou
  número, urgência, pessoa, departamento, tipo, robô, "atribuídos a mim" e ordem são aplicados no banco; a seleção para juntar vale
  entre páginas. Indicadores e sugestões de juntar olham os chamados em aberto e os dos últimos 30 dias.
- Quem abriu confirma ("Sim, obrigado" / "Sim, concordo") ou reabre ("Ainda acontece"). O rascunho de um chamado novo fica
  guardado no navegador.

### Banco e configuração
- Migração **aditiva** `20261118150000_add_support_tickets`: tabelas `SupportTicket`, `SupportMessage`, `SupportAttachment`,
  cinco enums e a coluna opcional `Notification.supportTicketId`. Nada existente é alterado ou removido (voltar para a versão
  anterior do Hub é seguro: as tabelas novas ficam sem uso).
- Variável nova, opcional: `SUPPORT_ATTACHMENT_RETENTION_DAYS` (padrão 90).

## 2026-11-17 — Faixa do painel recolhida e tela cheia

### Mudado
- **A faixa com o nome do painel (e o X para fechar) fica recolhida.** Ao abrir um painel ela aparece por alguns segundos e
  recolhe, sobrando só uma tira fina no topo; passar o mouse nessa tira (ou tocar nela, no celular/tablet, ou chegar com Tab)
  mostra a faixa de novo, por cima do painel, e ela some meio segundo depois que o mouse sai. O painel ganha cerca de 40 px
  de altura.
- **Tela cheia sem a faixa.** Com o painel aberto, o F11 (ou o novo botão de **tela cheia** da faixa) coloca a página inteira
  em tela cheia, sem a tira e sem a faixa; o chat do Hub continua visível. **Esc ou F11 saem da tela cheia.** Se o navegador
  já estava no F11 antes de abrir o painel, ele continua no F11 do navegador (a página não consegue desfazê-lo): o Esc mostra
  "Para sair da tela cheia, aperte F11".
- **O Esc não fecha mais o painel.** Só o X fecha (o voltar do navegador também continua fechando).
- Só frontend: sem mudança no banco, na API nem nos painéis.

## 2026-11-16 — "Atualizar" de dentro do painel acompanhado até o fim real

### Corrigido
- **O botão "Atualizar" de dentro do painel deixava de ser acompanhado aos 2 minutos.** O IIS (que fica na frente do Hub)
  encerra requisições longas aos 2 min; o Hub entendia isso como "o navegador fechou" e voltava o estado anterior, mas o
  painel seguia atualizando (o Indicadores Fiscal leva ~7 min). Efeitos: o "Atualizado há…" na lista de painéis não andava
  depois de uma atualização feita por dentro, e o bloqueio de atualização duplicada expirava aos 2 min (um novo clique
  disparava uma segunda carga com a primeira ainda rodando). Agora o Hub repassa esse clique por uma **conexão própria** com
  o painel, independente do navegador e do IIS: se o navegador sai, o Hub continua esperando a resposta do painel e só então
  marca o fim (ok ou erro, com o motivo). Até lá, a lista mostra "atualizando", a consulta `/__hub/atualizacao` diz que está
  atualizando e um novo clique é recusado (409). Painel que corta a conexão no meio gera erro registrado e o navegador não
  fica esperando. O botão do Hub (de fora) já funcionava assim e não mudou.
- Sem mudança no banco nem nas telas dos painéis.

## 2026-11-16 — Avisos do robô por e-mail (sem parar) e print da tela no e-mail de erro

### Novo
- **`AH_ALERT|texto`: aviso do robô sem parar a execução.** O robô imprime essa linha e o Hub guarda o aviso no log
  ("AVISO: ...") e, no fim de uma execução **agendada**, manda **um e-mail "Atenção"** com os avisos mesmo que ela tenha
  terminado com sucesso. Se a execução terminar em erro, os avisos vão numa seção do próprio e-mail de erro (e do e-mail
  final do reinício). Avisos repetidos contam uma vez; no máximo 10 por e-mail, 300 caracteres cada. Execução manual não
  manda e-mail (os avisos ficam no log). `SCHEDULE_ALERT_EMAILS=false` desliga também este e-mail.
- **Print da tela no e-mail de erro.** O robô que salvar uma imagem `erro_*.png` (ou `.jpg`) na pasta de saída da execução
  (`AUTOMATION_OUTPUT_DIR`) tem essa imagem **anexada** ao e-mail de erro de execução agendada (até 2 imagens de 2 MB, lidas
  antes de a saída ser empacotada) e aparece dentro do e-mail. Os robôs devem borrar os dados antes de salvar (privacidade);
  a imagem também fica na tela da execução, como os outros arquivos de saída (retenção de 30 dias).
- `AH_LOG|warning|...` agora vale como `warn` (antes aparecia como texto cru "AH_LOG|warning|...").
- Sem mudança no banco.

## 2026-11-16 — Reinício automático também quando o agendamento termina com erro

### Novo
- **Erro na 1ª tentativa de um agendamento com T0/T1/T2 também é refeito uma vez.** Antes só era refeito o que passava do
  T2 (45 min, por exemplo) ou era interrompido pelo reinício do Hub; um robô que terminava cedo com erro só mandava o
  e-mail e esperava o próximo horário do dia. Agora, depois de uma espera (5 min por padrão), o Hub roda de novo, uma única
  vez, com os mesmos parâmetros e prioridade na fila. **O e-mail de erro da 1ª tentativa fica retido**: só sai e-mail se a
  2ª também falhar (um só, com as duas tentativas), como já era no reinício por T2. Vale também para o travamento
  (45 min sem nenhuma saída). Quem depende do ciclo (o Excel, do Gestta) continua esperando durante a espera e o
  reinício; se o reinício der certo, é liberado.
- Só vale para agendamentos **com** T0/T1/T2 e só para erro recente (até 30 min). Agendamento "sem verificação" segue só com o
  e-mail de erro comum.
- Configuração (opcional, no `.env` da API): `SCHEDULE_RESTART_ON_ERROR=false` desliga; `SCHEDULE_ERROR_RESTART_DELAY_MINUTES`
  muda a espera (0 a 60, padrão 5).
- Sem mudança no banco.

## 2026-11-13 — Nomes com acento vindos do Athenas e acesso aos painéis

### Novo
- **"Quem pode ver" = departamentos E pessoas, somados, em BIs, painéis e automações.** Antes, nos painéis, marcar
  "usuários específicos" ignorava os departamentos e nos BIs e automações só havia departamentos. Agora as duas listas
  ficam marcadas ao mesmo tempo: tem acesso quem estiver em qualquer uma. Só departamentos: só eles; só pessoas: só
  elas; nada marcado: todos. Pessoas marcadas passam também do "só gestores". A tela ganhou dois botões
  (**Departamentos** / **Usuários específicos**, cada um com o contador do que está marcado), uma linha de resumo
  ("Terão acesso: Comercial (o departamento inteiro) + 2 pessoas marcadas") e um **buscador** de usuários (por nome ou
  e-mail, sem diferenciar acentos) com "Mostrar só os marcados". Vale nas três telas de cadastro (Painéis, Sites/BIs e
  Robôs) e na tela de Sites.
- **BI com painel vinculado:** ao liberar pessoas num BI, as que ainda não enxergam o painel vinculado entram na lista de
  pessoas dele (o chat do João no BI usa o chat do painel) e a tela avisa quem foi acrescentado. Remover alguém do BI não
  remove do painel. Painel aberto a todos, ou a quem já passa pelo departamento, não é alterado.
- A lista de pessoas liberadas só é enviada a administradores (quem não administra recebe a lista vazia).

### Corrigido
- **Rotas de site com `:id` não conferiam o acesso:** qualquer usuário logado (chamando a API direto, já que a tela
  esconde os botões) lia os dados de qualquer site, inclusive o endereço de BIs restritos, baixava o ícone e podia
  disparar a atualização do Power BI de um BI que não via. Agora leitura, atualização do Power BI e ícone usam a mesma
  regra de acesso da lista de sites (404 se não puder ver). Um teste falha se uma rota nova com `:id` não conferir o
  acesso nem exigir administrador.
- **Usuário sem acesso a nenhum painel (504) por causa do nome.** O proxy dos painéis (`/d/<slug>/`) envia o nome do
  usuário num cabeçalho HTTP (`X-Hub-User-Name`); o Node recusa o caractere "�" (`ERR_INVALID_CHAR`) e a requisição inteira
  falhava, só para quem tinha o nome quebrado. Agora nome e e-mail passam por `headerSafe` (caractere inválido vira `?`).
- **Nomes com acento ficavam com "�" (ex.: "Ara�jo").** Causa: a coluna `NOME` do Athenas (charset NONE) guarda bytes
  Windows-1252 de 1 byte e o driver os lia como UTF-8, perdendo a letra. A consulta agora pede os bytes crus
  (`CAST(NOME AS VARCHAR(255) CHARACTER SET OCTETS)`) e o Hub decodifica (UTF-8 estrito; senão Windows-1252). O cadastro do
  Athenas não é alterado: o Hub só lê.
- **Nome bom não é mais sobrescrito por um quebrado.** No login, se o nome que chega do Athenas tem "�" e o salvo não tem,
  mantém o salvo; se o salvo estava quebrado e chega um bom, corrige sozinho. O log registra o caso (só os bytes fora do ASCII).

- **Acesso direto ao painel (`/d/<painel>/`) agora segue a mesma regra do resto do Hub.** O guarda dessa rota só olhava
  departamentos: ignorava a lista de pessoas e o "só gestor" e, com a lista de departamentos vazia (painel restrito a
  pessoas), deixava entrar qualquer usuário logado. Agora usa `canAccessDashboard` (admin/Inovação, lista de pessoas,
  "só gestor" e departamentos), como a lista de painéis, o chat e os downloads. Quem abria um painel pelo endereço
  direto sem ter acesso pela regra do Hub passa a receber "Acesso negado".
- **Conexões websocket dos painéis (Streamlit) agora exigem sessão e acesso.** O evento "upgrade" do servidor não passa
  pelo guarda HTTP, então a conexão era repassada ao painel sem conferir login nem permissão. Agora exige o cookie de
  sessão (ou `?t=`) e a mesma regra de acesso (`canAccessDashboard`); sem isso responde 401/403/404 e fecha a conexão.
  Os painéis do tipo servidor (FastAPI) não usam websocket e não são afetados. **Desligar** (volta ao comportamento
  antigo): `PANEL_WS_AUTH=false` no `.env` da API e reiniciar o Hub. Testado com um Streamlit real e um navegador real
  numa instância isolada (banco descartável, só em 127.0.0.1) antes de ir para produção.

Banco: migração aditiva `20261113130000_add_site_robot_allowed_users` (`Site.allowedUserIds` e `Robot.allowedUserIds`,
compatível com a versão anterior; os dados existentes não mudam). Quem já estava com o nome quebrado se corrige no próximo login (ou por `UPDATE` pontual).
Testes: `test/athenas-name-header.test.ts`.

### Painéis: aviso de atualização em andamento
- Quem pede para atualizar um painel que **já está sendo atualizado** (outra pessoa, o agendador ou o "Atualizar" de
  dentro do painel) recebe o aviso "Este painel já está sendo atualizado (desde 14:32)" em vez de um ícone vermelho sem
  explicação (a mensagem existia no servidor, mas saía como erro genérico 500; agora é 409).
- O botão de atualizar da lista de painéis passa a girar e ficar desabilitado também quando a atualização foi iniciada
  por outro, com a dica "Atualizando desde 14:32…" (antes só girava para quem clicou, naquela página). Enquanto algum painel
  atualiza, a lista confere o estado a cada 3 s (era 15 s).
- `POST /dashboards/:id/update` passou a conferir o acesso ao painel (antes só exigia login; a tela escondia o botão).
- `GET /dashboards` traz `updatingSince` (desde quando está atualizando; `null` se não está).

### Painéis: "Atualizar" de dentro do painel não dispara uma segunda carga
- Se o painel **já está sendo atualizado** (outra pessoa, agendamento, botão do Hub ou o próprio usuário depois de um F5), o
  "Atualizar" de dentro do painel passa a ser **recusado pelo Hub com 409** e não chega ao painel. Antes, dois cliques viravam
  duas cargas completas (em paralelo nos painéis sem trava de leitura, o que dobrava RAM e consultas; uma atrás da outra nos demais).
- Nova consulta atendida pelo próprio Hub dentro do endereço de cada painel: `GET /d/<slug>/__hub/atualizacao` →
  `{ "atualizando": true|false, "desde": "<data ISO>"|null }` (passa pelo mesmo guarda de sessão e acesso do `/d`). A resposta 409
  também traz `atualizando` e `desde`. Telas de painel podem usar isso para mostrar "Atualizando…" (inclusive depois de um F5) e
  saber com certeza quando terminou.
- Só o "Atualizar tudo" (o `updatePath` do painel) é recusado; atualizar uma fonte só (`.../atualizar/<fonte>`) segue como antes.
- **Telas dos painéis (fora deste repositório):** para a recusa aparecer como "Atualizando…" até o fim, a tela do painel precisa
  tratar o 409 e consultar a rota acima. Telas que não tratam continuam funcionando como antes, só sem esse efeito.

## 2026-11-12 — Alertas de agendamentos e painéis, verificação por tempo (T0/T1/T2), teto de tempo e dependência

PR #1 (`8748a95`), PR #2 (`2781272`). Marco de restauração no GitHub: tag `alertas-agendamentos-2026-11-12`.

### Novo

**E-mails de alerta para a Inovação (só execuções agendadas)**
- Erro, travamento (vigia de inatividade) e interrupção por reinício do Hub mandam e-mail com robô, agendamento,
  horários, motivo e link da execução. Execuções manuais e canceladas pelo usuário nunca enviam. Sem e-mail de recuperação.
- Destinatários: a lista `MAIL_BI_ALERT_TO` (a mesma dos alertas de BI). Envio em segundo plano: falha de e-mail não
  atrapalha a fila.
- O link usa `HUB_PUBLIC_URL`; endereço local (`localhost`, `127.x`...) nunca vai para o e-mail (sem endereço válido o
  e-mail sai sem link).

**Verificação por tempo (T0/T1/T2), por agendamento (só administrador edita)**
- Tempos em minutos desde o **início** da execução: T0; T1 = T0 + valor de T1; T2 = T1 + valor de T2.
- T0 e T1 avisam por e-mail que ainda está rodando. Em T2 a execução é cancelada e **reiniciada do começo, uma única vez**
  (prioridade na fila, mesmos parâmetros e arquivos-modelo).
- O reinício não manda avisos intermediários: se falhar, travar ou passar do próprio T2, sai **um** e-mail final
  ("REINICIADA — continua com problema") com as duas tentativas.
- Execução agendada interrompida pelo reinício do Hub é refeita uma vez (só em agendamentos com verificação).
- Em branco = "sem verificação" (comportamento anterior). Salvar sem enviar os campos preserva a configuração existente.

**Teto de tempo** (só para agendamentos sem T0/T1/T2): passou do teto rodando, a execução é cancelada e avisa por e-mail,
**sem reiniciar**.

**Dependência entre agendamentos**
- Um agendamento pode depender de outro (ex.: "Atualizar Planilhas Excel" depende de "Gestta"). A execução entra na fila no
  horário dela, fica **retida** e só começa quando o ciclo do outro agendamento (incluindo o reinício) terminar com sucesso.
- Qualquer outro desfecho (erro, cancelado em T2/teto, cancelado à mão) **pula** aquele ciclo: fica no histórico como
  cancelada, com o motivo; o ciclo seguinte recomeça normal.
- Execuções manuais nunca ficam retidas, e uma execução manual do outro agendamento não libera a agendada.
- Regras ao salvar: só se depende de agendamento com T0/T1/T2 ou teto; sem auto-dependência nem ciclos; não dá para tirar o
  limite de tempo de quem tem dependentes. Agendamento desativado: dependência ignorada; apagado: campo limpo.
- Os e-mails de falha definitiva citam quem deixou de rodar ("Não executou"); se o dependente é pulado sem ter sido citado,
  sai um e-mail próprio de "agendamento pulado".

**Painéis (atualização programada)**
- Falhou: nova tentativa após 5 min (`PANEL_UPDATE_RETRY_MINUTES`); se a 2ª falhar, **um** e-mail com as duas tentativas e
  motivos. Botão do Hub e "Atualizar" de dentro do painel não repetem nem enviam e-mail.
- O "Atualizar" de dentro do painel passa a mover o selo "Atualizado há…", que conta a partir do **fim** da atualização.
- Horário perdido (Hub fora do ar ou deploy no minuto exato) é recuperado até 60 min depois
  (`PANEL_UPDATE_CATCHUP_MINUTES`), uma vez. Painel parado de propósito não é atualizado nem avisa.
- Atualização que ficou "Atualizando…" por causa de um reinício vira erro e é retomada. O motivo da falha só aparece para
  administradores.

**Fila de execuções:** execuções retidas por dependência não são iniciadas e mantêm o motivo próprio.

**Tela de agendamentos (administrador):** campos T0/T1/T2 com exemplo de horários ao vivo, teto de tempo e "Depende de outro
agendamento?" (só lista agendamentos com limite de tempo).

### Banco de dados (migrações aditivas, compatíveis com a versão anterior)
| Migração | O que adiciona |
|---|---|
| `20261112150000_add_dashboard_update_retry` | `Dashboard.lastUpdateError`, `Dashboard.updateRetryAt` |
| `20261112160000_add_schedule_time_checks` | `ScheduledTask.verifyT0/T1/T2Minutes`; `Execution.attempt`, `restartOfId`, `checkStage` |
| `20261112170000_add_schedule_dependency_and_limit` | `ScheduledTask.maxRuntimeMinutes`, `dependsOnTaskId` (FK `ON DELETE SET NULL`); `Execution.waitingOnExecutionId`, `dependencyNotified` |

### Configuração (`apps/api/.env`, todas opcionais)
`HUB_PUBLIC_URL`, `SCHEDULE_ALERT_EMAILS` (`false` desliga todos os e-mails de agendamentos/painéis),
`PANEL_UPDATE_RETRY_MINUTES` (5), `PANEL_UPDATE_CATCHUP_MINUTES` (60).

### Deploy
- **Correção do script de auto-deploy** (PR #2): quando o `schema.prisma` muda, a API só é compilada depois do
  `prisma generate` (antes a compilação usava o cliente antigo e falhava com `TS2339`); o rollback regenera o cliente a partir
  do esquema antigo. Ver a seção do auto-deploy no `CLAUDE.md`, que também traz a recuperação manual.

### Robôs (repositório separado)
- **Atualizar Planilhas Excel (BI):** cópia de segurança das planilhas antes de atualizar (pasta `BackupPlanilhas`, extensão
  `.bak`) e restauração automática se a original sumir ou corromper. Já estava aplicada na pasta de robôs do servidor desde 12/11/2026 e agora também está versionada no repositório de robôs (PR #3, mesclada em 12/11/2026).

### Testes
- Suíte da API: 246 testes (245 passam, 1 opcional é ignorado). 23 usam um PostgreSQL descartável e só rodam com
  `TEST_DATABASE_URL` apontando para um banco chamado `hub_dev` (a trava recusa qualquer outro).
- Corrigida uma falha intermitente nos testes no Windows (limpeza de pasta temporária com `EPERM` reprovava o arquivo inteiro).

### Como desligar ou reverter
- Todos os e-mails de agendamentos/painéis: `SCHEDULE_ALERT_EMAILS=false` e reiniciar o Hub.
- Verificação por tempo, teto e dependência de um agendamento: esvaziar T0/T1/T2 e o teto, e escolher "Nenhum" em "Depende de".
- Código: as migrações só adicionam colunas, então a versão anterior continua funcionando se a PR #1 for revertida.

### Limites conhecidos
- Os marcos de T0/T1/T2, o teto e a liberação de dependentes são conferidos a cada 30 s: podem atrasar até ~30 s.
- O tempo conta a partir do início da execução; tempo de espera na fila não entra.
- O Hub só enxerga o código de saída do robô: um robô que termina com código 0 mesmo tendo falhado parcialmente conta como sucesso.
