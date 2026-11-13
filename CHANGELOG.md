# Registro de mudanças

Mudanças do Automation Hub por data. Este arquivo é **público**: descreve o que mudou no produto, no banco e na
configuração, sem dados de infraestrutura. O desenho detalhado de cada funcionalidade está no `CLAUDE.md`.

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
- **`GET /sites/:id` não conferia o acesso:** qualquer usuário logado lia os dados de qualquer site, inclusive o endereço de
  BIs restritos. Agora usa a mesma regra de acesso da lista de sites.
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
