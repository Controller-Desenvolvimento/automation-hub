# Registro de mudanças

Mudanças do Automation Hub por data. Este arquivo é **público**: descreve o que mudou no produto, no banco e na
configuração, sem dados de infraestrutura. O desenho detalhado de cada funcionalidade está no `CLAUDE.md`.

## 2026-11-19 — Simulador: "por mês" passa a usar meses do calendário

### Corrigido
- Ao levar o período para "1 mês", o simulador dividia os dias do período por um mês médio de 30,4375 dias. Com **outubro inteiro**
  (31 dias) isso dava 9,7 h para 119 execuções de 5 min, quando o esperado é 9,9 h. Agora a conta é **pelo calendário**: um mês
  inteiro vale exatamente 1 (outubro, novembro e fevereiro), um pedaço de mês vale a fração dos dias dele (19 dias de novembro =
  19/30) e vários meses somam (01/10 a 30/11 = 2). Vale para cada robô (um robô novo conta desde o 1º dia dele), para o relatório
  hoje/simulado, as pessoas e a faixa. O gráfico de evolução mensal não mudou (já era mês a mês).

## 2026-11-19 — Correções da auditoria das últimas entregas (simulador e Saúde dos robôs)

### Corrigido
- **Simulador de ganhos: o "Até" do período agora conta.** Os dias do período eram contados do "De" até **hoje**, ignorando o "Até":
  um período que termina no passado (ex.: 01/10 a 31/10 consultado em 19/11, 50 dias em vez de 31) dividia o resultado por meses a
  mais. Saíam **subestimados** o "simulado por mês", a diferença, o relatório hoje/simulado, as pessoas e a faixa. Períodos que
  terminam hoje (últimos 30 dias, este mês) já estavam certos. Agora vale do "De" ao "Até" (nunca depois de hoje), e o dia segue o
  fuso do relatório, não o do servidor.
- **Simulador: resultado e cenários não somem mais** ao ir para a "Lista" e voltar (a tela do simulador ficava desmontada).
- **Tempo menor que 1 segundo** (ex.: 0,4 s) agora é recusado na tela, no "Configurar" e no simulador (arredondava para 0).
- **Saúde dos robôs:** a frase do robô sem nenhum sucesso repetia "nenhum sucesso no período"; a do servidor no limite dizia "e 9h (7
  dias) e outros" (dois "e"); a dica do "i" ficava parada no lugar errado se a página rolasse com ela aberta (agora fecha).

## 2026-11-19 — Correção: digitar datas nos filtros de período

### Corrigido (só frontend; sem mudança na API nem no banco)
- Em **Tempo ganho** (intervalo personalizado "De" / "Até") e em **Saúde dos robôs** (período "Datas"), digitar uma data à mão
  bagunçava o período: cada tecla virava filtro, e o campo de data passa por valores pela metade (ano 0002, 0020, 0202...) ou vazios
  enquanto se digita. Em Tempo ganho o "Até" pela metade ficava menor que o "De", e a tela **apagava o "De"** para acompanhá-lo
  (e ainda consultava o relatório a cada tecla). Agora cada campo guarda o que está sendo digitado e **só vira filtro quando a data
  está completa** (ano de 2000 a 2100); apagar um pedaço do campo não muda o período. Atalhos de período e "Todo o histórico"
  continuam substituindo o que estava digitado.

## 2026-11-19 — Tempo ganho: evolução mensal e cenários no simulador (etapa 3b de "Robôs sem ganho")

### Adicionado (só administradores e Inovação; sem mudança no banco; a simulação continua não gravando nada)
- **Evolução mensal** no resultado da simulação (últimos 12 meses, independente do período escolhido): barras com o ganho atual do
  relatório + o **extra simulado** aplicado às execuções reais de cada mês, e uma faixa de cima com a **variação sobre o mês
  anterior**. Começa no 1º mês **completo** de dados; o mês em andamento aparece pontilhado e sem projeção (a variação dele é
  parcial). "Todo o relatório" ou "Só os simulados" (tira o ganho dos demais robôs), dica ao passar o mouse e "Ver os números em
  tabela".
- **Cenários A–D:** "Guardar como Cenário X" guarda o resultado (e como foi simulado) e compara até 4 lado a lado (ganho por mês
  e por ano, pessoas, relatório simulado, faixa conservador/otimista, robôs com tempo, base), com o maior destacado. Remover libera
  a letra. Os cenários ficam só na tela aberta (não são gravados); guardar só vale com o resultado atualizado.
- API: a resposta de `POST /api/reports/robots-without-gain/simulate` traz `monthly` (`months` e `cut`).

## 2026-11-19 — Tempo ganho: simulador de ganhos (etapa 3a de "Robôs sem ganho")

### Adicionado (só administradores e Inovação; sem mudança no banco; a simulação não grava nada)
- Na aba **"Robôs sem ganho"** há agora duas sub-abas: **Lista** e **Simular ganhos** (`aba=simular` na URL). O simulador projeta as
  **execuções reais do período escolhido** para 1 mês, robô por robô, com o tempo que a pessoa chutar:
  - **Quais robôs:** só os sem ganho, ou somando os que já têm ganho (mantêm o tempo atual ou aceitam um **novo tempo**).
  - **Como informar:** o mesmo tempo para todos ou por robô (com o padrão para os em branco; dá para excluir robôs da conta);
    **por execução** ou **por item** (usa a métrica que o robô mais informa; execução sem a quantidade usa a média do robô e é
    contada como "estimada"); em segundos, minutos ou horas; jornada da pessoa (padrão 7 h × 21 dias úteis).
  - **Resultado:** ganho a mais por mês e por ano, pessoas equivalentes, relatório hoje × simulado, **faixa**
    conservador/provável/otimista (metade / 1 / 1,5 vez os tempos informados), tabela por robô e frases sobre o resultado
    (período curto, robô sem tempo, tempo acima da jornada, quem mais pesa, o que o ganho equivale em pessoas...).
  - Qualquer mudança depois de simular marca o resultado como desatualizado até clicar em **Simular** de novo.
  - **"Usar estes tempos na configuração"** (com confirmação): grava o tempo nos robôs sem ganho da simulação, pela mesma rota
    do "Configurar"; só vale daqui para frente.
- API: `POST /api/reports/robots-without-gain/simulate` (só administradores).
- Ainda não feitos (etapa 3b): gráfico de evolução mensal e cenários A–D para comparar lado a lado; recalcular o passado.

## 2026-11-19 — Tempo ganho: aba "Robôs sem ganho" (etapa 1)

### Adicionado (só administradores e Inovação; sem mudança no banco)
- Nova aba **"Robôs sem ganho"** na tela Tempo ganho (ao lado de Visão geral e Execuções, com o número de robôs que rodaram sem
  tempo configurado). Lista os robôs **ativos do Hub** com tempo manual 0 (toda execução deles entra no relatório com 0 h): execuções
  com sucesso no período, última execução, departamentos e as métricas (`AH_METRIC`) que o robô já informa, com a média por execução.
  Robôs externos ficam de fora (o sistema deles informa o tempo ganho de cada execução).
- **"Configurar"** abre uma janela: tempo manual por item (segundos, minutos ou horas), o que é um item e como contar (cada
  execução = 1 item, ou pela métrica que o robô informa), com **prévia** de quanto isso somaria no período. Salva só esses 3
  campos no cadastro do robô, por uma rota nova (`PATCH /api/robots/:id/time-savings`); o `POST /api/robots` continua sendo o upsert
  total e não foi usado.
- **Só vale daqui para frente:** as execuções já gravadas guardam o ganho calculado na hora e não mudam (nenhum número já
  apresentado se altera). Recalcular o passado ficou para uma etapa seguinte, com registro de quem aplicou.
- Na Visão geral, o painel de qualidade dos dados ganhou o link "Configurar o tempo desses robôs →" (só para administradores).
- API: `GET /api/reports/robots-without-gain?from=&to=` (só administradores).

## 2026-11-19 — Saúde dos robôs: "i" que cabe na tela

### Mudado (só administradores; só leitura; sem mudança no banco; só frontend)
- A dica do **"i"** agora mede o próprio tamanho e fica sempre inteira na janela: abre embaixo do "i" se couber; senão **sobe** (fica
  acima dele); se nem assim couber, encosta na borda da janela. Na horizontal nunca passa das bordas. Antes passava da tela e cortava.
- O "i" do gráfico de erros por categoria **não mostra mais "Quem age"** (continua o significado e o exemplo de cada categoria).

## 2026-11-19 — Saúde dos robôs: escolher o robô de cada quadro da duração

### Mudado (só administradores; só leitura; sem mudança no banco)
- No gráfico **"Duração por dia"**, cada um dos 4 quadros ganhou um seletor de robô. Por padrão continuam os 4 mais usados (o título
  diz isso); ao trocar, o título passa a "robôs escolhidos" e aparece "Voltar aos 4 mais usados". A escolha fica na URL
  (`duracao=`), então o F5 e o link mantêm os robôs. Robô usado em outro quadro fica desabilitado na lista.
- Se um robô escolhido deixa de ter dados ao mudar o período ou o filtro, o quadro **fica vazio com aviso** (não volta sozinho ao
  padrão): a pessoa escolhe outro. Quadro sem escolha também fica vazio.
- API: `/api/robot-health?duracao=id1,id2,,id4` e, na resposta, `durationSlots`, `durationCustom` e `durationOptions`.

## 2026-11-19 — Saúde dos robôs, etapa 3: capacidade do servidor, ciclos agendados e Insights

### Adicionado (só administradores; só leitura; sem mudança no banco)
- **Horários de pico do servidor:** quantos robôs rodam ao mesmo tempo em cada hora do dia (barra = pior momento, linha vermelha =
  limite do servidor), com a faixa de tempo ocupado por hora e quatro cartões: horário mais cheio, quantos horários chegaram ao
  limite, horário mais ocupado e **bons horários para agendar**. Segue o período e ignora o filtro manual/agendada.
- **Resultado dos ciclos agendados:** por agendamento, quantos ciclos deram certo de primeira, quantos o reinício automático
  salvou, quantos falharam de vez e quantos foram cancelados ou pulados.
- **Insights:** frases prontas, por regras fixas, com o "i" mostrando a conta (erros sem motivo, robôs que pedem atenção,
  queda na taxa, agendamento acima do limite de reinício, servidor no limite, fila das manuais, agendamentos que falham, etc.).
  Alternância **Gráficos | Insights** no topo, com selo dos pontos de atenção.
- A API de `/api/robot-health` devolve a mais `capacity`, `cycles` e `insights`; as execuções canceladas passam a levar o motivo.

## 2026-11-19 — Saúde dos robôs: visual igual ao do protótipo HTML aprovado (etapas 1 e 2)

### Mudado (só administradores; só leitura; sem mudança no banco)
- **Cores e ordem das categorias como no HTML:** Entrada (laranja), Sistema externo (verde-água), Hub (amarelo), Configuração
  (violeta), Robô (magenta) e Sem causa (ardósia), nessa ordem. Antes a ordem e as cores estavam diferentes.
- **Linhas suaves** (interpolação monótona) com **área em degradê**, pontos com anel, rótulo do último valor, linha **dourada
  tracejada** da média e trechos sem dados ligados por tracejado; **barras com degradê**, ponta arredondada e vão de 2 px; grade
  **pontilhada**; eixo fixo à esquerda e área rolável (começa no dia mais recente); dica flutuante que acompanha o mouse.
- **Mapa "Resultado por robô, dia a dia" como no HTML:** células que ocupam a largura do cartão, 0% de erro em verde-água claro,
  com erro numa **rampa vermelha** (quanto mais erro, mais forte), sem execução = contorno tracejado, legenda em faixas (0%, até
  25%, 25% a 50%, 50% ou mais), robôs do que mais executou para o que menos, nomes e datas fixos. Sem símbolos dentro das células.
- **Indicadores** centralizados, com barra de acento, rótulo em maiúsculas, pílula de variação (verde/vermelho/estável),
  **minigráfico** com ponto dourado e "i" que explica período atual, comparado, variação e minigráfico. Agora: Execuções, Taxa de
  sucesso, **Duração típica (mediana, com "95% terminam em até")** e **Erros sem causa**.
- **Duração** como no HTML: **mediana e 95% mais lentos** de cada um dos robôs mais usados, com a linha do **T2** do agendamento.
- **Causas de erro (Pareto)** com barras em pílula e degradê, **acumulado**, e clique na causa para ver o que significa e quais robôs
  a tiveram. **Tabela de robôs** com **Tendência** (minigráfico), **Última com sucesso** e **Duração típica**.
- Cartões macios com ponto dourado no título; o "i" é o círculo com "i" em itálico; cada gráfico tem **Gráfico/Tabela**; o
  **Agrupar por Dia/Semana/Mês** voltou para o cabeçalho dos gráficos de evolução (os três mudam juntos).

## 2026-11-19 — Saúde dos robôs, etapa 2: evolução, duração e mapa robô × dia

### Novo (só administradores; só leitura; sem mudança no banco)
- **Resultado das execuções** (colunas empilhadas: sucesso, "fora da conta" = canceladas e erros do Hub, erro do robô) e
  **Taxa de sucesso** (linha por dia, semana ou mês, com a faixa da zona crítica, 40% de erro ou mais; o período sem
  execução concluída quebra a linha em vez de virar 0%; ponto vazado = menos de 5 concluídas). Ambos com detalhe ao passar o
  mouse ou pelo teclado e "Ver como tabela".
- **Duração dos robôs mais usados**: um gráfico pequeno por robô (os 4 com mais execuções), só execuções com sucesso, todos
  na mesma cor, com a média do período e o último ponto em destaque.
- **Resultado por robô, dia a dia** (mapa): uma linha por robô e uma célula por dia (semana acima de 62 dias, mês acima de
  180). Verde = só sucessos; amarelo com ! = alguns erros; vermelho com × = 40% ou mais de erro; cinza = só canceladas ou erros do Hub;
  vazio = não rodou. Os robôs com mais erros ficam no topo. Passe o mouse ou use as setas do teclado; há "Ver como tabela".
- O controle **Agrupar por (Dia, Semana, Mês)** passou para a barra de filtros e vale para todos os gráficos de evolução.
- Falta a etapa 3 (capacidade do servidor e horários de pico, ciclos agendados e Insights).

## 2026-11-19 — Nova aba "Saúde dos robôs" (etapa 1, só administradores)

### Novo
- **Saúde dos robôs** (menu Administração; **só administradores e a Inovação**: os demais não veem o item e a API responde
  404). Etapa 1 de 3, a partir do protótipo aprovado:
  - **Indicadores** com comparação com o período anterior de mesmo tamanho: execuções, taxa de sucesso, erros dos robôs e
    duração média (cada um com um "i" que explica a conta).
  - **Erros por categoria** (gráfico de barras empilhadas por dia, semana ou mês, com legenda, detalhe ao passar o mouse e
    "Ver como tabela"). O **"i" explica as 6 categorias**: Entrada, Sistema externo, Hub, Robô, Configuração e Sem causa
    (significado, exemplo e quem age). "Travou: 45 min sem nenhuma saída" conta como **Robô**.
  - **Principais causas de erro** (cada erro é lido pela mensagem e colocado numa causa conhecida).
  - **Tabela de robôs**: situação (Crítico a partir de 40% de erro, Atenção a partir de 15%, Saudável, Poucos dados com menos de 5
    execuções concluídas), taxa de sucesso (com "piorou/melhorou" frente ao período anterior), execuções, erros, duração média,
    principal causa e último uso; ordenável, com busca e filtro por situação.
  - Filtros: período (7, 30, 60, 90 dias, este mês, mês passado, todo o histórico ou datas) e origem (todas, manuais,
    agendadas); ficam na URL.
- **Regras das contas:** só robôs que rodam no Hub (os externos não entram em nenhuma conta); erros do **Hub** (reinício do
  servidor) e execuções canceladas **não** entram na taxa de sucesso; duração só de execuções com sucesso.
- Só leitura: não altera execuções, robôs nem o vigia de 45 minutos. Sem mudança no banco. Etapas 2 e 3 (gráficos de evolução,
  mapa robô × dia, capacidade do servidor, ciclos agendados e Insights) vêm depois.

## 2026-11-19 — Suporte: "Histórico da situação" só abre ao clicar no texto

### Corrigido
- A linha inteira do "Histórico da situação" expandia/recolhia o histórico, inclusive o espaço vazio à direita. Agora só o texto
  (com o ícone) é clicável. Só frontend.

## 2026-11-19 — Suporte: reabrir chamado visível e "Sim, obrigado(a)"

### Corrigido
- **Quem abriu um chamado encerrado clicava em "Reabrir chamado" e "nada acontecia".** O formulário (motivo + "Confirmar
  reabertura") abria no fim da página, fora da tela, e o botão sumia. Agora o formulário aparece **logo abaixo da faixa verde**,
  com o cursor já na caixa de texto, e a tela não precisa rolar.

### Mudado
- **O cartão "Administrar" (urgência e responsável) some quando o chamado está encerrado** e volta se ele for reaberto. A urgência
  continua no resumo do encerramento ("Resolvido por … · Urgência …").
- "Sim, obrigado" passou a **"Sim, obrigado(a)"** (botão e a mensagem registrada na conversa); em "Não é problema" continua "Sim,
  concordo". A API mudou só esse texto (sem mudança no banco).

## 2026-11-19 — Suporte: cartão "Situação" (encerrar, reabrir e histórico de quem fez o quê)

### Mudado (só frontend: sem mudança na API nem no banco)
- **Cartão "Situação" para a Inovação**, no lugar do seletor de status da lateral e do menu do botão Enviar (que saíram; o
  Enviar voltou a ser simples). Em andamento mostra as opções (Em análise, Aguardando usuário, Resolvido, Não é problema);
  **encerrar pede Cancelar / Confirmar**. Encerrado, as opções somem e fica o resumo **"Resolvido por [nome] em [data] ·
  Urgência [grau]"** com o botão **Reabrir chamado**, que abre um painel (reabrir como Aberto, Em análise ou Aguardando
  usuário, com mensagem opcional para quem abriu) com **Confirmar reabertura / Cancelar**.
- **Histórico da situação** (cartão da Inovação e faixa de quem abriu): quem abriu, quem mudou cada status, **quem resolveu e
  quem reabriu**, com nome e hora. As linhas de status da conversa também mostram o nome de quem mudou.
- **Quem abriu o chamado** vê no encerrado "Resolvido por [nome da Inovação] em [data] · Urgência [grau]" e, ao reabrir, o botão é
  "Confirmar reabertura" (com motivo obrigatório e Cancelar).

## 2026-11-19 — Suporte: botão Enviar com menu e reabrir chamado separado de responder

### Mudado (só frontend: sem mudança na API nem no banco)
- **Um só lugar para mudar o status ao responder.** Sai o campo "Depois de enviar". O botão **Enviar** da Inovação ganha um menu:
  "Enviar e aguardar usuário", "Enviar e resolver" e "Enviar e marcar como Não é problema" (num chamado encerrado, "Enviar e
  reabrir"). O clique principal só responde e mantém o status. O seletor "Status" da lateral continua para mudar sem escrever.
- **Quem abriu um chamado encerrado não vê mais a caixa de resposta**, para que um "obrigado" não reabra o chamado (e mande e-mail
  de reaberto) sem querer. Ele agradece com **"Sim, obrigado" / "Sim, concordo"** (registra a confirmação, não reabre) e, se ainda
  acontece, clica em **"Ainda acontece (reabrir)"** / **"Reabrir chamado"**, que abre um formulário com o motivo obrigatório e
  anexos; só ao enviar o chamado reabre e a Inovação é avisada.
- Corrigido: o rótulo "Responder (reabre o chamado)" aparecia também para administradores, para quem não é verdade (a resposta da
  Inovação não reabre; só a de quem abriu).

## 2026-11-19 — Suporte: e-mail para a equipe de Inovação

### Novo
- **A equipe de Inovação recebe e-mail do Suporte** (mesmos destinatários e remetente dos alertas de BI: `MAIL_FROM`,
  `MAIL_PASSWORD`, `MAIL_BI_ALERT_TO`): quando uma pessoa **abre um chamado**, **responde** um chamado ou o **reabre** ("ainda
  acontece"). Chamados abertos por quem já é da Inovação/admin, respostas da própria Inovação e notas internas **não** mandam
  e-mail. Várias respostas seguidas no mesmo chamado viram **um e-mail só** (de novo depois de 10 minutos); chamado novo e
  reaberto avisam sempre. Chamado crítico leva "(CRÍTICO)" no assunto e a cor vermelha.
- **O e-mail leva só o resumo e o link** (número, título, quem abriu e departamento, tipo, assunto, urgência, responsável e o
  botão "Abrir o chamado no Hub"): o texto da mensagem e os anexos **não** vão por e-mail, porque podem ter dados de clientes ou
  de RH. Quem abriu o chamado continua sem receber e-mail (acompanha pelo número no menu e pelo sino).
- Endereço do link: `HUB_PUBLIC_URL` (ou o primeiro `ALLOWED_ORIGIN` que não seja local); sem endereço válido o e-mail sai sem o
  botão. Um problema de envio nunca atrapalha abrir ou responder o chamado.

### Configuração
- Nova variável, opcional: `SUPPORT_ALERT_EMAILS=false` desliga só os e-mails do Suporte (independente de `SCHEDULE_ALERT_EMAILS`).
  Sem mudança no banco.

## 2026-11-18 — Nova aba "Suporte" (chamados)

### Novo
- **Aba Suporte** (menu "Acompanhamento", depois de "Tempo ganho"): qualquer pessoa abre um chamado (algo não funciona,
  sugestão ou dúvida; sobre o Hub, um robô, um painel/BI ou outro assunto; urgência Crítica/Alta/Média/Baixa, sem prazos) e
  acompanha as respostas. **Quem não é administrador vê só os próprios chamados** (nem o gestor do departamento vê os dos
  outros). Administradores e a Inovação veem todos, com indicadores (abertos, sem resposta, tempo até a 1ª resposta, robô com
  mais chamados), filtros (urgência, pessoa, departamento, tipo, robô, busca, ordem), responsável, status (Aberto, Em análise,
  Aguardando resposta, Resolvido, Não é problema), urgência ajustável e **notas internas** que quem abriu nunca vê.
- **Aviso dentro do Hub** (o e-mail para a Inovação veio em 19/11): Um número ao lado de "Suporte" no menu mostra as novidades (administrador: chamados
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
