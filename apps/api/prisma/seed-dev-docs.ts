// Script manual (não roda no boot) para popular/atualizar os registros de Dev Docs.
// Uso: cd apps/api && npx tsx prisma/seed-dev-docs.ts
// Idempotente: usa upsert por id, então rodar de novo só atualiza o conteúdo.
// Depois de rodar, o conteúdo pode continuar sendo editado normalmente pela UI
// (Configurações → Dev Docs) — este arquivo é só a fonte de verdade inicial/versionada.

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { config } from 'dotenv';
import { join } from 'node:path';

config({ path: join(__dirname, '..', '.env') });

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

type Doc = {
  id: string;
  title: string;
  category: string;
  summary: string;
  howToUse: string;
  codeExample?: string;
  language?: string;
  endpoint?: string;
  tags: string[];
  order: number;
};

const docs: Doc[] = [
  {
    id: 'devdoc_protocolo_hub',
    order: 1,
    category: 'Robôs',
    title: 'Protocolo do robô com o hub',
    summary:
      'Para que serve: o contrato completo entre o hub e o script de um robô — como o robô recebe seus parâmetros e pastas de entrada/saída, e como ele avisa o hub do que está fazendo. O hub roda o robô como um processo comum (Python, .exe, o que for) e não tem nenhuma forma de "olhar dentro" dele: tudo que sabe é o que combinaram por env vars/arquivos na entrada, e o que o robô escreve na tela (stdout/stderr) durante a execução.',
    howToUse: `Parte 0 — o que o robô recebe do hub antes de começar

Quando alguém dispara uma execução, o hub cria uma pasta própria pra ela e passa 7 variáveis de ambiente pro processo:
- AUTOMATION_EXECUTION_ID: o id dessa execução.
- AUTOMATION_EXECUTION_DIR: a pasta raiz dessa execução (contém input/, output/ e metadata/).
- AUTOMATION_INPUT_DIR: pasta com os arquivos que o usuário anexou no formulário (se o robô tiver fileInputs no schema).
- AUTOMATION_OUTPUT_DIR: pasta onde o robô deve gravar os arquivos finais — é o que vira "resultado" pra baixar depois.
- AUTOMATION_METADATA_DIR: pasta com parameters.json e context.json (ver abaixo).
- AUTOMATION_PARAMETERS_FILE: caminho direto pro parameters.json (evita você montar o caminho na mão).
- AUTOMATION_CONTEXT_FILE: caminho direto pro context.json.

parameters.json é exatamente o que a pessoa preencheu no formulário de execução (schema.fields do robô, ver doc de cadastro de robô via API) — um objeto JSON simples, chave por nome do campo.

context.json traz um resumo da execução, útil pra logging/depuração:
{ "executionId", "robot": { "id", "slug", "name" }, "inputDir", "outputDir", "metadataDir" }

O que fazer com os arquivos de saída: grave tudo em AUTOMATION_OUTPUT_DIR (qualquer extensão — .xlsx, .csv, .pdf, .zip, o que for). Ao final da execução com sucesso, o hub lista tudo que está nessa pasta e registra cada arquivo no histórico pra download. Se houver 2 ou mais arquivos, o hub zipa tudo automaticamente num único output.zip antes de registrar (e apaga os originais) — com 0 ou 1 arquivo, não zipa. Isso não é configurável por robô, é automático baseado na quantidade de arquivos.

Recomendação de organização (evita dor de cabeça com dependências conflitantes entre robôs): uma pasta por robô no servidor, com o próprio venv/requirements.txt, e o comando cadastrado apontando pro Python de dentro desse venv (ex.: C:\\Robos\\meu-robo\\.venv\\Scripts\\python.exe automation.py) em vez do Python global da máquina.

Parte 1 — as 3 mensagens que o robô pode mandar de volta

Quando alguém dispara uma execução, o hub inicia o comando cadastrado no robô e fica lendo, linha por linha, tudo que o processo escreve na tela. Cada linha é interpretada assim, na ordem:

1. AH_PROGRESS|N|mensagem
   Atualiza a barra de progresso da execução. N é 0-100 (fora da faixa é ajustado automaticamente, não dá erro). A mensagem aparece como "etapa atual" na tela de acompanhamento e também vira um registro de log.

2. AH_LOG|nivel|mensagem
   Grava um log visível na execução. nivel tem que ser exatamente "info", "warn" ou "error". Cuidado: se você digitar um nível diferente (ex.: "warning" em vez de "warn"), a linha NÃO dá erro — ela simplesmente não é reconhecida como AH_LOG e cai na regra 4 abaixo, ou seja, aparece como log comum com o texto "AH_LOG|warning|..." literal na tela. Isso passa batido fácil durante o desenvolvimento do robô.

3. AH_METRIC|chave|valor
   Soma um número a um contador da execução (ex.: quantos itens foram processados). É a base do cálculo de tempo economizado — ver a Parte 2 abaixo.

4. Qualquer outra linha (não é nenhuma das três acima)
   Vira log comum automaticamente — nível "info" se veio da saída normal, nível "error" se veio da saída de erro. Ou seja, você não precisa se preocupar em formatar erros: se o script quebrar e imprimir o traceback (comportamento padrão do Python quando um erro não é tratado), ele já aparece como log de erro na tela de acompanhamento, sem fazer nada especial.

Cuidados práticos (o que mais gera dor de cabeça):
- No Windows, a saída do Python é "represada" por padrão quando não está num terminal interativo — sem "flush=True" em cada print, as mensagens só chegam ao hub em lotes ou só no final, e a barra de progresso parece travada.
- Sempre chame sys.stdout.reconfigure(encoding='utf-8', errors='replace') no início do script no Windows. Sem isso, qualquer acento numa mensagem pode travar o processo no meio da execução.
- Mantenha cada mensagem numa linha só (sem quebra de linha no meio) — senão o hub não reconhece o prefixo.

Parte 2 — como o AH_METRIC vira "tempo economizado" nos relatórios

O número que aparece no relatório de ganho para a diretoria ("este robô economizou X horas") não é mágica: é uma conta simples feita a partir do que o próprio robô reportou pelo AH_METRIC, multiplicado por uma estimativa configurada no cadastro do robô.

No cadastro do robô (Configurações → Automações → editar robô) existem 3 campos ligados a isso:
- "Chave da métrica de unidades" (unitMetricKey): qual AH_METRIC representa "1 unidade de trabalho" para esse robô. Padrão: itens_processados.
- "Segundos manuais por unidade" (manualSecondsPerUnit): quanto tempo um humano levaria para fazer 1 unidade na mão.
- "Rótulo da unidade" (unitLabel): só o nome pra exibição (ex.: "nota fiscal", "empresa", "CNPJ consultado").

Ponto importante: toda vez que chega um AH_METRIC com essa chave, o hub SOMA ao total da execução — não é "o último valor que vale". Isso muda como você deve emitir a métrica:
- Opção A: reportar sempre "1" a cada item processado, dentro do loop.
- Opção B: reportar o total acumulado, mas só UMA VEZ, no final.
Nunca misture as duas — se o robô manda o total acumulado (1, depois 2, depois 3...) a cada iteração, o hub soma 1+2+3=6 em vez de 3, e o relatório fica errado.

Quando a execução termina com sucesso, esse total vira o "tanto processado" daquela execução, e o relatório de tempo economizado calcula: tempo economizado = quantidade processada × segundos manuais por unidade. Isso entra nos totais gerais e nos rankings por robô, por usuário e por departamento.

Nota: métricas com uma chave DIFERENTE da configurada no robô também são aceitas e aparecem como log ("Metrica registrada: chave=valor"), mas hoje não entram em nenhum relatório — servem só de rastro pra depuração. Só a chave configurada no robô conta para o tempo economizado.`,
    codeExample: `import json
import os
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding='utf-8', errors='replace')  # obrigatório no Windows

parameters = json.loads(Path(os.environ["AUTOMATION_PARAMETERS_FILE"]).read_text(encoding="utf-8"))
input_dir = Path(os.environ["AUTOMATION_INPUT_DIR"])
output_dir = Path(os.environ["AUTOMATION_OUTPUT_DIR"])

print("AH_PROGRESS|0|Iniciando...", flush=True)
print("AH_LOG|info|Arquivo carregado", flush=True)

lista = list(input_dir.glob("*"))
total = 0
for item in lista:
    try:
        processar(item)
        total += 1
        print(f"AH_PROGRESS|{int(total/len(lista)*100)}|{total}/{len(lista)}", flush=True)
    except Exception as e:
        # não precisa formatar como AH_LOG — cair no stderr já vira log de erro sozinho
        print(f"Falha no item {item}: {e}", file=sys.stderr, flush=True)

(output_dir / "resultado.xlsx").write_bytes(gerar_planilha_resultado())  # grave tudo em output_dir

# Reportar o total UMA ÚNICA VEZ no final (nunca a cada item E no final juntos)
print(f"AH_METRIC|itens_processados|{total}", flush=True)
print("AH_PROGRESS|100|Concluído", flush=True)
# exit code 0 = sucesso; qualquer outro valor = falha`,
    language: 'python',
    endpoint: 'GET /api/reports/time-savings',
    tags: ['protocolo', 'rpa', 'stdout', 'log', 'progresso', 'métrica', 'tempo economizado', 'env vars', 'parameters.json', 'output', 'iniciante'],
  },
  {
    id: 'devdoc_sso_dauth',
    order: 2,
    category: 'Autenticação',
    title: 'Login automático nos painéis',
    summary:
      'Para que serve: dashboards externos (Streamlit/FastAPI hospedados dentro do hub, ver doc "Como funcionam os painéis") não precisam ter tela de login própria. Quando alguém já logado no hub abre um painel em /d/<slug>/, o hub identifica quem é e passa isso pro dashboard via headers — o dashboard só confia no hub, nunca conversa direto com o navegador sem passar por ele.',
    howToUse: `Como o fluxo funciona de ponta a ponta (apps/api/src/main.ts, middleware registrado antes do catch-all da SPA para qualquer path começando em /d/):

1. Quando o front-end do hub monta um link pra abrir um painel, ele inclui o token de sessão atual na URL: /d/<slug>/?t=<token>. Isso é necessário porque, na primeira visita, ainda não existe cookie nenhum pra esse domínio/path.

2. O middleware olha primeiro a query ?t=, e só se não tiver usa o cookie "dauth" existente. Essa ordem é de propósito: se o usuário deslogou e logou de novo, o cookie antigo (de uma sessão já invalidada) ainda pode estar no navegador — usar sempre o token mais recente da query evita um bug chato de "não consigo abrir o painel depois de logar de novo".

3. O token (seja da query ou do cookie) é validado contra a tabela Session no banco (precisa existir, não estar expirado, e o usuário precisa estar ativo). Se inválido: requisição de API (sub-rota contendo /api/ ou método não é GET/HEAD) recebe 401 em JSON; navegação de página recebe redirect pra "/".

4. Se validou e o token veio da query (?t=), o hub grava um cookie "dauth" (HttpOnly, Path=/d, SameSite=Lax, validade de 7 dias — igual à sessão do hub) e redireciona para a mesma URL sem o ?t=, pra não deixar o token exposto na barra de endereço/histórico do navegador.

5. Com o usuário identificado, o hub decide o que fazer de acordo com o tipo do dashboard (ver doc de Painéis externos):
   - type "html": serve o arquivo estático direto (sendFile) — não passa nenhum header de usuário, porque não tem processo nenhum rodando por trás pra ler.
   - type "streamlit" / "server": a requisição é encaminhada por um proxy reverso pro processo Python correspondente. É NESSE encaminhamento que o hub injeta dois headers simples:
       X-Hub-User-Name: <nome do usuário>
       X-Hub-User-Email: <email do usuário>

Atenção — isso é diferente de "um header X-Hub-User com um JSON contendo id/role/departments": só existem esses dois headers de texto puro, nome e email. Se o seu dashboard precisa saber o cargo/departamento do usuário para decidir o que mostrar, hoje ele precisa resolver isso sozinho (ex.: consultando a própria lógica de departamento pelo email) — o hub não manda essa informação.

Importante: o dashboard NUNCA deve ser exposto direto na porta local dele (ex.: acessar http://10.100.1.18:8501 diretamente) — só o acesso via /d/<slug>/ passa pela validação de sessão. Isso é convenção de operação, não um bloqueio técnico automático: se a porta estiver acessível na rede, alguém pode contornar o proxy. Prefira sempre --server.address 127.0.0.1 (Streamlit) ou --host 127.0.0.1 (uvicorn) no comando do servidor, assim o processo só aceita conexões locais e o único caminho de entrada é o proxy do hub.

⚠️ Não confundir com o SSO de Sites (ver doc "Login automático em sites (SSO)"): aquele é um mecanismo bem mais pesado — token de uso único trocado servidor-a-servidor — porque o site de destino é uma aplicação separada, com o próprio domínio, que o hub não intercepta requisição por requisição. Painéis não precisam disso e NÃO usam esse fluxo: como o hub já intercepta e reencaminha toda requisição de /d/<slug>/, a identidade simplesmente "viaja junto" no proxy, sem nenhuma troca de token acontecer. Se você notar os dois mecanismos e ficar em dúvida qual usar: painel hospedado dentro do hub (tipo streamlit/server/html cadastrado em Painéis) usa este aqui; qualquer outro sistema com domínio/porta própria fora do hub usa o outro.`,
    codeExample: `# FastAPI — ler o usuário identificado pelo hub
from fastapi import Request

@app.get("/dados-privados")
def dados(request: Request):
    nome = request.headers.get("X-Hub-User-Name")
    email = request.headers.get("X-Hub-User-Email")
    if not email:
        # Em teoria não deveria acontecer (o hub só encaminha requests já autenticados),
        # mas é defesa contra alguém acessar a porta diretamente por engano.
        return {"erro": "Sem usuário identificado"}, 401
    return {"mensagem": f"Olá, {nome} ({email})"}`,
    language: 'python',
    endpoint: 'GET /d/<slug>/* (proxy autenticado)',
    tags: ['sso', 'autenticação', 'dashboard', 'proxy', 'dauth', 'cookie', 'painéis'],
  },
  {
    id: 'devdoc_sso_sites',
    order: 3,
    category: 'Autenticação',
    title: 'Login automático em sites (SSO)',
    summary:
      'Para que serve: para um sistema que já tem domínio, porta e sessão própria — e não é hospedado dentro do hub como painel — este é o jeito de deixar o botão "Abrir" do catálogo de Sites já entrar logado, sem o usuário digitar senha de novo. Existe um guia completo e pronto para repassar a outro time em docs/integracao-sso.md, na raiz do repositório — este doc é o resumo rápido do mesmo mecanismo.',
    howToUse: `Diferença chave em relação ao doc "Login automático nos painéis": lá a identidade "viaja de carona" porque o hub intercepta e reencaminha toda requisição do painel. Aqui NÃO — o site de destino é uma aplicação totalmente separada (domínio/porta próprios) que o hub não intercepta depois do clique inicial. Por isso precisa de uma troca de token pontual, em vez de um proxy contínuo.

Fluxo completo:
1. No cadastro do site (Configurações → Sites → editar), ative "SSO habilitado". Isso muda o botão "Abrir"/"Ver" daquele site: em vez de um link direto pra site.url, o hub passa a gerar um token antes de abrir.
2. Ao clicar, o front-end do hub chama GET /api/auth/sso (autenticado com a sessão de quem clicou) e recebe um token de uso único, válido por 30 segundos.
3. O hub abre {site.url}/hub-sso/?token=<token>&hub=<origem do hub> numa nova aba. O parâmetro "hub" existe pra você não fixar a URL do hub no seu código (ela muda entre ambientes).
4. O SEU sistema precisa ter essa rota "/hub-sso/". Do lado do SERVIDOR dele (nunca do navegador), chama GET {hub}/api/auth/sso-verify?token=<token>.
5. O hub responde uma única vez com { athenasLogin, name, email } (e já invalida o token nesse instante) — ou 401 se o token já tiver sido usado, expirado, ou não existir.
6. Seu sistema cria a PRÓPRIA sessão local pra esse usuário (cookie, JWT, o que já usar hoje) e redireciona pra dentro da aplicação. O hub nunca cria sessão nenhuma no site de destino, só entrega "quem é essa pessoa".

Pontos de segurança que valem saber antes de implementar:
- Token de uso único: uma segunda tentativa com o mesmo token sempre dá 401, mesmo dentro dos 30s.
- Não tem chave de API nem segredo compartilhado — a única proteção é o token aleatório de 256 bits mais o TTL curto e o uso único. Trate a URL com o token na query string como sensível (não logue ela inteira).
- Os tokens ficam em memória do processo da API, não no banco — um restart do hub invalida qualquer token gerado e ainda não trocado (irrelevante na prática, já que o TTL é de só 30s).
- Se o seu sistema precisa de integração contínua (sincronizar usuários em lote, consultar permissões periodicamente) esse fluxo não é a ferramenta certa — ele foi pensado pra uma única troca pontual, iniciada por um clique real de alguém no hub.

Ver docs/integracao-sso.md para o contrato completo dos dois endpoints e um exemplo de implementação da rota /hub-sso/ em FastAPI.`,
    codeExample: `# FastAPI — implementando a rota /hub-sso/ do lado do site de destino
import httpx
from fastapi import APIRouter, Query
from fastapi.responses import RedirectResponse

router = APIRouter()

@router.get("/hub-sso/")
async def hub_sso(token: str = Query(...), hub: str = Query(...)):
    async with httpx.AsyncClient() as client:
        resp = await client.get(f"{hub}/api/auth/sso-verify", params={"token": token}, timeout=5)

    if resp.status_code != 200:
        return RedirectResponse("/login?erro=sso_invalido")

    dados = resp.json()  # {"athenasLogin": "...", "name": "...", "email": "..."}
    # localizar/criar o usuário local por athenasLogin (ou email) e
    # criar a sessão da SUA aplicação aqui — o hub não faz isso por você
    criar_sessao_local(login=dados["athenasLogin"], nome=dados["name"], email=dados["email"])
    return RedirectResponse("/")`,
    language: 'python',
    endpoint: 'GET /api/auth/sso · GET /api/auth/sso-verify',
    tags: ['sso', 'autenticação', 'sites', 'token', 'integração'],
  },
  {
    id: 'devdoc_dashboards_externos',
    order: 4,
    category: 'Painéis',
    title: 'Como funcionam os painéis',
    summary:
      'Para que serve: em vez de cada dashboard BI (Streamlit, FastAPI) precisar do próprio domínio, HTTPS e login, o hub adota ele como "filho": sobe o processo, expõe em /d/<slug>/, cuida da autenticação (ver doc de SSO) e opcionalmente dispara atualizações de dados em horários agendados. Existe um prompt pronto para integrar um projeto novo em PROMPT_NOVO_DASHBOARD.md, na raiz do repositório — este doc explica o "por quê" por trás daquele prompt.',
    howToUse: `Existem 3 tipos de dashboard (campo "type" no cadastro, Configurações → Painéis), tratados de formas bem diferentes pelo DashboardService (apps/api/src/dashboard/dashboard.service.ts):

• type "html": o caso mais simples. É um HTML/JS/CSS estático (pode ser um zip com vários arquivos) que fica salvo em storage/dashboards/<id>/. O hub só serve o arquivo indicado em "mainFile" com sendFile — não tem processo, não tem porta, não tem proxy.

• type "streamlit": o hub sobe o próprio processo (python -m streamlit run <mainFile> --server.port <porta> --server.baseUrlPath /d/<slug> ...) dentro da pasta de storage do dashboard. Como o Streamlit sabe nativamente que vive num sub-caminho (--server.baseUrlPath), ele já gera os links internos certos — não precisa reescrever nada.

• type "server": pensado para qualquer coisa que não seja Streamlit — o exemplo típico é um FastAPI rodando com uvicorn. Você cadastra um "serverCommand" livre (ex.: X:\\...\\venv\\Scripts\\uvicorn.exe app:app --host 127.0.0.1 --port {PORT}) e um "serverWorkingDirectory". O hub substitui {PORT} pelo número real e spawna o comando ali. Diferente do Streamlit, esses apps NÃO sabem que estão atrás de /d/<slug> — por isso o hub faz um pathRewrite no proxy removendo esse prefixo antes de encaminhar (é exatamente o problema descrito no PROMPT_NOVO_DASHBOARD.md: se o HTML do app usa caminhos absolutos como /static/... ou fetch("/api/..."), o navegador ignora o prefixo e quebra — por isso a instrução de trocar para caminhos relativos).

Portas: para streamlit/server, o hub aloca automaticamente uma porta livre no intervalo 8500-8599 (função allocatePort, testa com net.createServer) e grava no banco (streamlitPort) — não precisa (e não deve) escolher a porta manualmente, exceto para saber qual usar dentro do próprio serverCommand via {PORT}.

Ciclo de vida do processo:
- Ao reiniciar o hub (deploy, restart do PM2), ele reconecta automaticamente todo dashboard streamlit/server que estava ativo, recriando o proxy e tentando religar o processo.
- Truque de resiliência: se a porta que já estava salva no banco continuar ocupada mas o hub não tiver mais o processo na memória (aconteceu um restart e o processo Python sobreviveu sozinho), o hub NÃO tenta subir um segundo processo na mesma porta — ele assume que é o processo antigo ainda vivo e só reconecta o proxy nele.
- Start/Stop manuais existem em Configurações → Painéis → botões da linha do dashboard (admin only). O log das últimas ~50 linhas de stdout/stderr do processo aparece ali mesmo, útil pra depurar um dashboard que não sobe.
- No Windows, "parar" mata a árvore de processos inteira (taskkill /F /T /PID) — importante porque uvicorn/streamlit costumam ter processos filhos (workers), matar só o PID principal deixaria órfãos.

Atualização agendada de dados: se o dashboard tiver "updatePath" preenchido (ex.: /api/atualizar), o DashboardSchedulerService (checagem a cada 1 minuto) dispara um POST pra http://localhost:<porta><updatePath> nos horários configurados em "updateTimesOfDay" (lista de HH:MM), combinado com "updateFrequency" (daily/weekly usa updateDayOfWeek/monthly usa updateDayOfMonth). Isso serve pra separar "quando o usuário abre o painel" de "quando os dados são recalculados" — útil quando o processamento é pesado (ex.: ler uma planilha grande) e não faz sentido rodar a cada visita. Depois que a atualização responde OK, o hub ainda dá um GET best-effort em cada path de "warmupPaths" — pensado pra pré-aquecer cache/renderização das páginas mais visitadas antes do primeiro usuário chegar. Esse mesmo endpoint pode ser chamado manualmente por qualquer usuário logado, no botão "Atualizar" do card do painel (POST /api/dashboards/:id/update) — não precisa esperar o horário agendado pra forçar um refresh.

Onde as coisas vivem no sistema de arquivos:
- storage/dashboards/<id>/ — arquivos do dashboard (upload de zip ou arquivo único, via Configurações → Painéis → upload).
- Para type "server" com serverWorkingDirectory apontando pra fora do storage do hub (comum quando o projeto Python já existe em outra pasta, ex.: X:\\INOVAÇÃO\\BI\\...), o hub roda o comando ali mesmo — não copia nada.

Como cadastrar um painel direto por API (sem abrir o formulário):
POST /api/dashboards, com token de admin (ver doc "Autenticar um script na API"). Diferente de Robôs/Sites, o corpo é multipart/form-data (não JSON puro), porque aceita um arquivo/zip já no mesmo request — mas o arquivo é opcional na criação, dá pra criar o registro primeiro e mandar os arquivos depois em POST /api/dashboards/:id/upload. Campos aceitos: slug e name (obrigatórios), description, type ("streamlit"/"server", qualquer outra coisa vira "html"), isActive, allowedDepartments (lista, mande como texto JSON: '["fiscal","rh"]'), mainFile, serverCommand, serverWorkingDirectory, updatePath, warmupPaths (lista, mesma regra de JSON), updateFrequency, updateTimesOfDay (lista de "HH:mm", também JSON), updateDayOfWeek, updateDayOfMonth. Diferente de Robôs/Sites, este endpoint NÃO é upsert — criar sempre cria um novo registro; pra editar um já existente use PATCH /api/dashboards/:id (esse sim aceita JSON puro, sem multipart). Cuidado: um slug duplicado não dá um erro amigável — quebra com um erro de banco (constraint única), então vale conferir a lista antes de criar.`,
    codeExample: `import requests

BASE_URL = "http://10.100.1.18:3000/api"
TOKEN = "token-obtido-no-login"  # ver doc de autenticação de script
headers = {"Authorization": f"Bearer {TOKEN}"}

# Exemplo: cadastrar um FastAPI já existente em outra pasta (type: server)
resp = requests.post(
    f"{BASE_URL}/dashboards",
    headers=headers,
    data={
        "slug": "bi-performance-fiscal",
        "name": "BI Performance Fiscal",
        "type": "server",
        "serverCommand": r"X:\\INOVACAO\\BI\\bi_performance_fiscal\\venv\\Scripts\\uvicorn.exe app:app --host 127.0.0.1 --port {PORT}",
        "serverWorkingDirectory": r"X:\\INOVACAO\\BI\\bi_performance_fiscal",
        "mainFile": "static/index.html",
        "updatePath": "/api/atualizar",
        "updateFrequency": "daily",
        "updateTimesOfDay": '["06:30"]',       # arrays viajam como texto JSON no multipart
        "allowedDepartments": '["fiscal"]',
    },
    # file=... é opcional aqui; pode subir depois em POST /api/dashboards/{id}/upload
)
print(resp.json())

# No app.py do FastAPI, o dashboard não sabe que vive em /d/bi-performance-fiscal/:
# por isso os HTMLs em static/ precisam usar caminhos relativos, não /static/... nem /api/...
# (ver PROMPT_NOVO_DASHBOARD.md na raiz do repo para o passo a passo de correção)`,
    language: 'python',
    endpoint: 'GET /d/<slug>/* · POST /api/dashboards · POST /api/dashboards/:id/update · POST /api/dashboards/:id/start|stop',
    tags: ['dashboard', 'painéis', 'proxy', 'streamlit', 'fastapi', 'uvicorn', 'agendamento', 'admin', 'api'],
  },
  {
    id: 'devdoc_api_external_metrics',
    order: 5,
    category: 'Integrações',
    title: 'Registrar tempo economizado',
    summary:
      'Para que serve: quando algo economiza tempo mas NÃO é um robô que o hub executa (ex.: um dashboard Power BI que baixa dados de N empresas, um script que roda em outra máquina) ainda é possível fazer isso contar no relatório de tempo economizado do hub, sem precisar cadastrar um robô "de mentira" pra isso. É um endpoint de ingestão simples, autenticado por uma chave única compartilhada (não por usuário nem por robô).',
    howToUse: `Endpoint: POST /api/metrics/external
Autenticação: header x-metrics-key, comparado contra a variável de ambiente EXTERNAL_METRICS_API_KEY do hub. É uma chave ÚNICA para todo o hub (não uma por robô/dashboard) — qualquer script autorizado usa a mesma. Se a variável de ambiente não estiver definida, o endpoint rejeita todo mundo (não existe modo "sem autenticação" aqui).

Corpo da requisição (JSON):
- source (obrigatório): identificador curto da origem, ex.: "bi_dre_contabil". É normalizado automaticamente (minúsculas, espaços trocados por "_").
- action (obrigatório): o que foi feito, ex.: "baixar_empresa".
- sourceName (opcional): nome bonito pra exibir nos relatórios (ex.: "DRE Contábil"). Se não vier, o relatório usa o próprio "source".
- label (opcional): descrição do item específico (ex.: "Empresa XPTO Ltda").
- unitLabel (opcional, padrão "empresa"): nome da unidade, só pra exibição.
- unitsProcessed (opcional, padrão 1): quantas unidades esse evento representa.
- manualSecondsPerUnit (opcional, padrão 0): quanto tempo levaria fazer 1 unidade manualmente.
- userName / userEmail / department (opcional): quem gerou o evento. Se o userEmail bater com um usuário real do hub, o relatório atribui o ganho àquele usuário automaticamente; senão usa o nome/email cru mesmo.

O hub calcula manualEstimatedSeconds = unitsProcessed × manualSecondsPerUnit e devolve esse valor na resposta, só pra conferência — o cálculo "de verdade" que aparece no relatório de tempo economizado é feito de novo a partir dos mesmos números.

Onde isso aparece depois: cada evento vira uma linha na tabela ExternalMetric, e o relatório de tempo economizado (GET /api/reports/time-savings) mistura essas linhas com as execuções de robôs de verdade, usando um "robô sintético" com id ext:<source> — na prática, aparece na lista de robôs do relatório como se fosse mais um robô, com o nome sourceName.

⚠️ Não confundir com POST /api/integrations/time-savings (ver doc "Robô que roda fora do hub"): aquele endpoint exige um robô já cadastrado no hub (com apiKey própria) e cria uma Execution de verdade, atribuída aquele robô específico. Este aqui (/api/metrics/external) é o caminho mais leve, pra coisas que nem fazem sentido virar um "robô" — não cria execução, não aparece no histórico de execuções, só entra na conta de tempo economizado.`,
    codeExample: `import requests

requests.post(
    "http://10.100.1.18:3000/api/metrics/external",
    headers={"x-metrics-key": "SUA_CHAVE_AQUI"},  # igual a EXTERNAL_METRICS_API_KEY no .env do hub
    json={
        "source": "bi_dre_contabil",
        "sourceName": "DRE Contábil",
        "action": "baixar_empresa",
        "label": "Empresa XPTO Ltda",
        "unitLabel": "empresa",
        "unitsProcessed": 1,
        "manualSecondsPerUnit": 180,  # levaria 3min pra baixar manualmente
        "userEmail": "joao.silva@empresa.com",
    },
)
# resposta: {"ok": true, "id": "...", "manualEstimatedSeconds": 180}`,
    language: 'python',
    endpoint: 'POST /api/metrics/external',
    tags: ['api', 'métricas', 'power-bi', 'streamlit', 'integração', 'time-savings', 'x-metrics-key'],
  },
  {
    id: 'devdoc_api_integrations_time_savings',
    order: 6,
    category: 'Integrações',
    title: 'Robô que roda fora do hub',
    summary:
      'Para que serve: para robôs que já existem e rodam FORA do runner do hub (não são spawnados pelo ExecutionRunnerService — ex.: rodam num agendador do Windows numa outra máquina, ou já existiam antes do hub) mas ainda assim precisam aparecer no histórico de execuções e nos relatórios do robô como se tivessem rodado normalmente pelo hub.',
    howToUse: `Endpoint: POST /api/integrations/time-savings
Autenticação: header Authorization: Bearer <apiKey>. Diferente da chave única do /metrics/external, aqui cada ROBÔ tem a própria chave — gerada em Configurações → Automações → editar robô → "Gerar chave de API" (a chave só é mostrada uma vez na hora de gerar, o hub guarda só o hash). O robô também precisa estar marcado como "externo" (isExternal) no cadastro — robôs normais (rodados pelo próprio runner) não usam esse caminho.

Corpo da requisição (JSON):
- secondsSaved (obrigatório): tempo economizado em segundos, tem que ser positivo. Existe um limite de sanidade de 30 dias por execução — valores maiores são rejeitados (proteção contra erro comum de mandar minutos em vez de segundos, ou vice-versa).
- userLogin (obrigatório): login/email de quem "rodou" o robô (usado pra tentar vincular a um usuário real do hub, e pra dedup).
- userName (opcional): nome de exibição, se o login não for suficiente.
- unitsProcessed (opcional): quantas unidades processadas, mesmo conceito do doc de AH_METRIC.
- notes (opcional): observação livre.
- externalId (opcional, mas recomendado): identificador único do lado de quem está chamando (ex.: o id do job/lote no seu próprio sistema).

O que acontece no hub ao receber a chamada:
1. Valida a apiKey e resolve qual Robot ela pertence.
2. Se externalId foi enviado e já existe uma execução anterior com o mesmo robotId + externalId, a chamada NÃO cria nada novo — devolve a execução existente com deduplicated: true. Isso existe porque integrações via HTTP sofrem retry de rede; sem essa proteção, um retry duplicaria o "tempo economizado" reportado.
3. Tenta achar um usuário do hub cujo login/email bata com userLogin. Se não achar, ainda tenta reconciliar contra o Athenas (integração de login existente, ver LOGIN_ATHENAS_REFERENCIA.md) pra pelo menos descobrir o nome da pessoa e o departamento.
4. Cria uma Execution de verdade, já como status "success", 100% de progresso, com manualEstimatedSeconds = secondsSaved. Ou seja: para todo o resto do sistema (histórico, relatórios, ranking por robô/usuário/departamento), essa execução é indistinguível de uma execução normal — a diferença é só que ela nasceu pronta, sem ter passado pelo runner.

Quando usar este endpoint em vez de /metrics/external: use este quando já existe (ou faz sentido existir) um Robot cadastrado especificamente para aquele processo, e você quer que ele apareça no histórico de execuções normal do robô (com dono, tela de detalhe, etc). Use /metrics/external quando é mais um "contador" solto de tempo economizado, sem robô por trás.

Erros possíveis: 401 = chave ausente, incorreta, revogada, ou o robô não está marcado como externo; 400 = campo obrigatório faltando ou secondsSaved fora da faixa válida (confira o corpo contra a lista de campos acima).`,
    codeExample: `import requests, uuid

API_KEY = "chave-gerada-no-cadastro-do-robo"
BASE_URL = "http://10.100.1.18:3000/api"

resp = requests.post(
    f"{BASE_URL}/integrations/time-savings",
    headers={"Authorization": f"Bearer {API_KEY}"},
    json={
        "secondsSaved": 420,           # 7 minutos economizados nesta rodada
        "userLogin": "joao.silva",     # login do Athenas ou email do hub
        "unitsProcessed": 12,
        "notes": "Lote processado via agendador do Windows na máquina X",
        "externalId": str(uuid.uuid4()),  # gere um id estável do seu lado p/ evitar duplicar em retry
    },
)
print(resp.json())  # {"success": true, "executionId": "...", "deduplicated": false}`,
    language: 'python',
    endpoint: 'POST /api/integrations/time-savings',
    tags: ['api', 'integração', 'robô externo', 'api-key', 'execução', 'time-savings', 'idempotência'],
  },
  {
    id: 'devdoc_sistema_admin',
    order: 7,
    category: 'Administração',
    title: 'Ajustes do sistema',
    summary:
      'Para que serve: a VM de produção tem RAM e disco compartilhados com outros serviços da empresa (Power BI Gateway, dashboards Streamlit, Firebird, etc.) — este painel (Configurações → Sistema, admin only) existe pra ajustar os principais limites de segurança do hub sem precisar de deploy nem editar o .env manualmente na VM.',
    howToUse: `O que cada configuração controla (GET/PATCH /api/system/settings):

- runnerMaxConcurrency (1-10): quantas execuções de robô podem rodar em paralelo. Em produção está em 1, de propósito — a VM tem só ~3-4GB livres e cada robô Python/Playwright pode abrir um Chrome inteiro. Subir esse número sem testar antes é a causa mais provável de a VM travar.
- runnerMemoryThreshold (50-99%): se o uso de memória da VM passar desse percentual, o runner para de iniciar novas execuções (mesmo tendo slot de concorrência livre) até a memória baixar. É uma segunda camada de proteção além do limite de concorrência.
- executionRetentionDays: depois de quantos dias uma execução finalizada SEM arquivo de saída (sem output) tem seus logs e arquivos apagados pelo RetentionService. A linha da execução no banco continua existindo (pros relatórios), só o conteúdo pesado é limpo.
- executionRetentionDaysWithOutput: mesma ideia, mas pra execuções que geraram arquivo de saída — o padrão é bem maior (90 dias) porque o output é geralmente o motivo de alguém querer voltar numa execução antiga.

Importante: essas configurações NÃO ficam no banco de dados — o endpoint reescreve o arquivo apps/api/.env na VM (persistToEnv, faz um replace-or-append de cada chave) e os novos valores só entram em pleno efeito depois que o processo relê o .env. Como o Node não recarrega .env sozinho em runtime pra tudo, algumas dessas configs efetivamente pedem um "pm2 restart automation-hub" pra valer 100% — se mudar aqui e algo não parecer ter aplicado, esse é o primeiro passo antes de investigar mais.

Outras ações do painel:
- GET /api/system/storage-size: soma recursivamente o tamanho de toda a pasta storage/ (execuções, painéis, sites, robôs) — é uma varredura de disco real a cada chamada, não um valor em cache, então evite chamar isso num loop.
- GET /api/system/browse-dir: um navegador de diretórios do servidor (lista drives no Windows, pastas dentro de um caminho). Existe só de apoio pra outras telas — por exemplo, ao cadastrar um painel do tipo "server" (ver doc de Painéis externos), em vez de digitar o caminho completo à mão você pode navegar até a pasta do projeto Python.
- POST /api/system/sweep: dispara manualmente a limpeza de retenção (o mesmo job que corre automaticamente a cada 6h) sem esperar o próximo ciclo — útil depois de mudar os dias de retenção e querer ver o efeito na hora, ou pra liberar espaço em disco de emergência.`,
    codeExample: `// PATCH /api/system/settings — exemplo de corpo (admin only)
{
  "runnerMaxConcurrency": 2,
  "runnerMemoryThreshold": 85,
  "executionRetentionDays": 30,
  "executionRetentionDaysWithOutput": 90
}
// Depois de ajustar concorrência/memória, sempre validar com uma execução real
// e acompanhar "pm2 monit" antes de considerar a mudança segura em produção.`,
    language: 'json',
    endpoint: 'GET/PATCH /api/system/settings · GET /api/system/storage-size · POST /api/system/sweep',
    tags: ['sistema', 'admin', 'runner', 'retenção', 'storage', 'configuração', 'produção'],
  },
  {
    id: 'devdoc_auth_script',
    order: 8,
    category: 'Cadastro via API',
    title: 'Autenticar um script na API',
    summary:
      'Para que serve: todos os documentos desta categoria ("Cadastrar isso ou aquilo direto pela API") pedem a mesma coisa antes de qualquer coisa: um token válido. Este doc é o pré-requisito comum — leia-o primeiro. Serve tanto para um script Python quanto para uma IA que você conecte na API do hub.',
    howToUse: `O hub NÃO usa cookie de sessão pra chamadas de API (só os painéis externos usam um cookie próprio, "dauth" — ver doc de SSO). A autenticação normal é por token Bearer, igual a maioria das APIs modernas:

1. POST /api/auth/login
   Corpo: { "email": "seu@login", "password": "sua-senha" } (o campo pode se chamar "email" ou "login", os dois funcionam, é só um alias). Sem autenticação nenhuma pra chamar este endpoint — mas tem limite de 10 tentativas por minuto por IP, então não adianta tentar forçar senha por aqui.

2. A resposta é um JSON puro (não um Set-Cookie): { "token": "64 caracteres em hexadecimal", "user": { "id", "name", "email", "role", "departments" } }. Guarde esse "token".

3. Em toda chamada seguinte, mande o header:
   Authorization: Bearer <token>

4. O token vale 7 dias (mesma tabela de sessão que o navegador usa) — não precisa logar de novo a cada chamada, só quando expirar ou se alguém invalidar a sessão (logout). Se um script vai rodar por muito tempo/repetidamente, trate um 401 fazendo login de novo.

5. Ter um token válido só garante que você "é alguém" — não que pode tudo. A maioria dos endpoints de cadastro (robôs, sites, painéis, sistema) também exige role "admin" (ou fazer parte do departamento "inovacao"). Um token de um usuário comum recebe 403 Forbidden nesses endpoints, mesmo autenticado corretamente.

Existe também uma referência visual e interativa de todas as rotas em /api/docs (Swagger). Lá tem um botão "Authorize" — cole o token obtido no passo 2 (sem a palavra "Bearer", o Swagger já adiciona) e todos os "Try it out" da página passam a mandar o header certo. É um bom lugar pra explorar rotas que ainda não têm um doc dedicado aqui.`,
    codeExample: `import requests

BASE_URL = "http://10.100.1.18:3000/api"

login = requests.post(f"{BASE_URL}/auth/login", json={
    "email": "admin@empresa.com",
    "password": "sua-senha",
})
login.raise_for_status()
token = login.json()["token"]

headers = {"Authorization": f"Bearer {token}"}

# sanity check: confirma quem é o usuário autenticado
me = requests.get(f"{BASE_URL}/auth/me", headers=headers)
print(me.json())  # {"id": "...", "name": "...", "role": "admin", ...}`,
    language: 'python',
    endpoint: 'POST /api/auth/login · GET /api/auth/me',
    tags: ['api', 'autenticação', 'token', 'bearer', 'script', 'ia', 'swagger', 'iniciante'],
  },
  {
    id: 'devdoc_api_criar_robo',
    order: 9,
    category: 'Cadastro via API',
    title: 'Cadastrar robô pela API',
    summary:
      'Para que serve: em vez de preencher o formulário em Configurações → Automações campo por campo, um admin — ou uma IA com o token certo — pode criar ou atualizar a definição de um robô com uma única chamada HTTP. Útil pra cadastrar várias automações de uma vez, versionar a definição num script, ou deixar uma IA montar o cadastro a partir de uma conversa.',
    howToUse: `Pré-requisito: um token de admin (ver doc "Autenticar um script na API"). Usuários não-admin recebem 403.

Endpoint: POST /api/robots, corpo em JSON puro (não multipart).

É um "upsert": mandar o corpo SEM "id" cria um robô novo; mandar COM um "id" que já existe edita esse robô; mandar um "id" que não existe dá erro. Ou seja, o mesmo endpoint serve pra criar e pra editar.

Campos mais usados pra deixar o robô funcional:
- name (obrigatório) — único campo realmente obrigatório.
- slug (opcional) — se não vier, é gerado automaticamente a partir do name.
- command — o comando de shell que o hub vai executar (ex.: "python robo.py" ou o caminho de um .exe).
- workingDirectory — pasta onde o comando roda.
- allowedDepartments — lista de siglas de departamento (ex.: ["fiscal","rh"]); vazio = visível pra todo mundo.
- category, icon, summary, description — só afetam a exibição no catálogo.
- manualSecondsPerUnit, unitLabel, unitMetricKey — usados no cálculo de tempo economizado (ver doc "Protocolo do robô com o hub").
- maxConcurrency — quantas execuções desse robô específico podem rodar ao mesmo tempo.
- conflictKeys — texto separado por vírgula; robôs que compartilham uma chave nunca rodam ao mesmo tempo entre si (útil quando dois robôs disputam o mesmo recurso, ex.: o mesmo login num site).
- isExternal — marque true se este robô NÃO vai rodar pelo runner do hub, e sim reportar execuções de fora via a API de integrações (ver doc "Robô que roda fora do hub").
- schema — define o formulário que a pessoa vê na hora de executar o robô (ver formato abaixo).

O que este endpoint NÃO faz: subir o script/código do robô (isso é um upload de zip/rar em POST /api/robots/:id/scripts, feito depois de criar o robô) e gerar a chave de API de execução do robô (POST /api/robots/:id/api-key, também depois de criado).

Formato do campo "schema" (o formulário de execução):
{
  "fields": [ { "name", "label", "type", "required", "placeholder", "options", "defaultValue", "adminOnly" } ],
  "fileInputs": [ { "name", "label", "accept", "multiple", "required", "helperText" } ]
}
"type" aceita "text", "textarea", "select", "radio", "checkbox", ou qualquer tipo de <input> HTML (number, date, email...). "select" e "radio" exigem a lista "options". "adminOnly": true esconde o campo de quem não é admin. O hub NÃO valida o formato desse JSON na hora de salvar — um schema mal formado só vai dar problema visual no formulário depois, não erro na criação do robô, então vale testar abrindo a tela de execução após cadastrar.`,
    codeExample: `import requests

BASE_URL = "http://10.100.1.18:3000/api"
headers = {"Authorization": f"Bearer {TOKEN}"}  # token de admin, ver doc de autenticação

novo_robo = {
    "name": "Consulta CNPJ em lote",
    "command": "python consulta_cnpj.py",
    "workingDirectory": r"C:\\robots\\consulta-cnpj",
    "category": "fiscal",
    "allowedDepartments": ["fiscal"],
    "manualSecondsPerUnit": 90,
    "unitLabel": "CNPJ consultado",
    "unitMetricKey": "itens_processados",
    "schema": {
        "fields": [
            {"name": "uf", "label": "UF", "type": "select", "options": ["CE", "SP", "RJ"], "required": True},
        ],
        "fileInputs": [
            {"name": "planilha", "label": "Planilha de CNPJs", "accept": ".xlsx", "required": True},
        ],
    },
}

resp = requests.post(f"{BASE_URL}/robots", headers=headers, json=novo_robo)
robo = resp.json()
print(robo["id"], robo["slug"])

# Editar depois: mesma rota, mas incluindo o "id" no corpo
requests.post(f"{BASE_URL}/robots", headers=headers, json={**novo_robo, "id": robo["id"], "isActive": True})`,
    language: 'python',
    endpoint: 'POST /api/robots',
    tags: ['api', 'robô', 'cadastro', 'schema', 'automação', 'admin'],
  },
  {
    id: 'devdoc_api_criar_site',
    order: 10,
    category: 'Cadastro via API',
    title: 'Cadastrar site ou BI pela API',
    summary:
      'Para que serve: as abas "Sistemas" e "BI" (dentro de Sites, no menu) são a MESMA tabela no banco — só muda um campo "category". Este doc ensina a cadastrar os dois tipos direto por API, incluindo os campos específicos de Power BI (grupo, dataset, atualização agendada).',
    howToUse: `Pré-requisito: token de admin (ver doc de autenticação de script).

Endpoint: POST /api/sites, corpo em JSON, também é "upsert" por id (com id existente edita, sem id cria).

Campos comuns aos dois tipos:
- name (obrigatório) — também define o slug automaticamente (o slug não pode ser escolhido à mão, é sempre derivado do nome).
- url (obrigatório).
- description — opcional.
- category — mande exatamente "bi" para aparecer na aba BI; qualquer outro valor (ou omitir) cai na aba "Sistemas".
- allowedDepartments — mesma regra dos robôs, vazio = todo mundo vê.
- minRole — mande "manager" para restringir a gestores e admins; qualquer outro valor libera pra qualquer usuário autenticado.
- order — número que define a posição na listagem (menor aparece primeiro).

Campos que só fazem sentido com category "bi":
- powerbiGroupId / powerbiDatasetId — pode colar a URL completa do relatório do Power BI nesses campos (ex.: "https://app.powerbi.com/groups/xxxx/datasets/yyyy") — o hub extrai o UUID automaticamente, não precisa recortar à mão.
- powerbiScheduledTimes — lista de horários ("HH:mm") de atualização automática do dataset.
- powerbiShowRefresh — mostra ou esconde o botão de atualização manual no card.
- ssoEnabled — habilita passar a identidade do usuário do hub pro relatório Power BI (RLS).

Cuidado: como o slug SEMPRE vem do "name", cadastrar dois sites com nomes muito parecidos pode gerar conflito de slug — e o erro nesse caso não é uma mensagem amigável, é um erro genérico de restrição única do banco. Se for cadastrar vários de uma vez por script, vale conferir a lista de nomes existentes antes (GET /api/sites).`,
    codeExample: `import requests

BASE_URL = "http://10.100.1.18:3000/api"
headers = {"Authorization": f"Bearer {TOKEN}"}

novo_bi = {
    "name": "BI Performance Fiscal",
    "url": "https://app.powerbi.com/groups/xxxx/reports/yyyy",
    "category": "bi",
    "allowedDepartments": ["fiscal"],
    "powerbiGroupId": "https://app.powerbi.com/groups/11111111-1111-1111-1111-111111111111",
    "powerbiDatasetId": "https://app.powerbi.com/.../datasets/22222222-2222-2222-2222-222222222222",
    "powerbiScheduledTimes": ["06:00", "12:00"],
    "powerbiShowRefresh": True,
}

resp = requests.post(f"{BASE_URL}/sites", headers=headers, json=novo_bi)
print(resp.json())`,
    language: 'python',
    endpoint: 'POST /api/sites',
    tags: ['api', 'site', 'bi', 'power-bi', 'cadastro', 'admin'],
  },
  {
    id: 'devdoc_api_criar_agendamento',
    order: 11,
    category: 'Cadastro via API',
    title: 'Agendar execução pela API',
    summary:
      'Para que serve: em vez de configurar o agendamento na tela de Agendamentos, é possível criar (ou deixar uma IA criar) o agendamento já com os parâmetros de execução certos, direto por API. Diferente dos outros documentos desta categoria, este endpoint NÃO é admin-only — qualquer usuário autenticado com acesso ao robô pode chamar.',
    howToUse: `Pré-requisito: um token válido (ver doc de autenticação de script) de um usuário que tenha acesso ao robô que vai ser agendado — não precisa ser admin.

Endpoint: POST /api/scheduled-tasks. Diferente de Robôs/Sites, o corpo é multipart/form-data (não JSON puro), porque aceita arquivos de template junto no mesmo request. Também é "upsert" por id.

Campos:
- name (obrigatório).
- robotId (obrigatório) — o robô precisa existir e você precisa ter acesso a ele.
- frequency (obrigatório) — "once", "daily", "weekly" ou "monthly".
- timesOfDay — lista de horários "HH:mm" (mande como texto JSON no multipart, ex.: '["08:00","14:00"]'); precisa de pelo menos um horário válido.
- dayOfWeek — só é usado quando frequency é "weekly" (0=domingo...6=sábado).
- dayOfMonth — só é usado quando frequency é "monthly".
- startDate — data a partir de quando o agendamento passa a valer.
- parameters — objeto com os mesmos campos definidos no "schema.fields" do robô (ver doc de cadastro de robô) — mande também como texto JSON no multipart.
- recipientScope — "all", "departments" ou "specific": quem recebe o resultado dessa execução agendada.
- recipientDepartments / recipientUserIds — preenchidos conforme o recipientScope escolhido.
- creditMode — "creator", "users" ou "department": de quem é o "crédito" do tempo economizado nos relatórios quando a execução for automática.
- (arquivos) — se o robô tiver algum item em schema.fileInputs marcado como required: true, este agendamento PRECISA vir com um arquivo anexado pra aquele campo, senão a criação falha com erro.`,
    codeExample: `import requests, json

BASE_URL = "http://10.100.1.18:3000/api"
headers = {"Authorization": f"Bearer {TOKEN}"}

resp = requests.post(
    f"{BASE_URL}/scheduled-tasks",
    headers=headers,
    data={
        "name": "Consulta CNPJ — todo dia às 7h",
        "robotId": "id-do-robo-aqui",
        "frequency": "daily",
        "timesOfDay": json.dumps(["07:00"]),
        "parameters": json.dumps({"uf": "CE"}),
        "recipientScope": "specific",
        "recipientUserIds": json.dumps(["id-do-usuario-aqui"]),
    },
    files={
        "planilha": open("cnpjs.xlsx", "rb"),  # nome do campo = mesmo "name" do fileInput no schema do robô
    },
)
print(resp.json())`,
    language: 'python',
    endpoint: 'POST /api/scheduled-tasks',
    tags: ['api', 'agendamento', 'automação', 'multipart', 'cadastro'],
  },
];

// Fundido no doc "devdoc_protocolo_hub" — removido do banco se ainda existir de uma rodada anterior.
const removedIds = ['devdoc_metric_tempo'];

async function main() {
  await prisma.devDoc.deleteMany({ where: { id: { in: removedIds } } });
  for (const doc of docs) {
    await prisma.devDoc.upsert({
      where: { id: doc.id },
      create: { ...doc, tags: doc.tags },
      update: { ...doc, tags: doc.tags },
    });
    console.log(`OK: ${doc.title}`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
