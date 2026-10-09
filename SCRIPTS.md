# Guia de automações — Automation HUB

Este documento explica como criar scripts de automação compatíveis com o hub. Qualquer linguagem que rode via linha de comando funciona — os exemplos aqui usam Python.

---

## Conceito fundamental: o hub é a nova interface

Se a sua automação tem uma interface gráfica (janela, menu CLI, formulário próprio, Tkinter, Qt, etc.), **remova-a completamente antes de integrar ao hub.** Só o código de negócio vai para o hub.

**Por quê?** O hub substitui a interface do robô:

| O que era na automação | O que passa a ser no hub |
|---|---|
| Janela/formulário de entrada | Campos configurados no cadastro do robô |
| Upload de arquivo na UI | Campo de arquivo no formulário do hub |
| Barra de progresso própria | `AH_PROGRESS\|N\|mensagem` no stdout |
| Logs impressos na tela | `AH_LOG\|level\|mensagem` no stdout |
| Botão "salvar resultado" | Arquivo gravado em `AUTOMATION_OUTPUT_DIR` |
| Tela de conclusão | Página de execução do hub com arquivos para download |

**O que sobrevive a migração:**
- A lógica de negócio (consultas, planilhas, automação de browser, etc.)
- Leitura de parâmetros — mas agora de `AUTOMATION_PARAMETERS_FILE` (JSON), não de inputs de tela
- Escrita de resultados — mas agora em `AUTOMATION_OUTPUT_DIR`, não em caminhos fixos

**O que é removido:**
- Toda importação de bibliotecas de UI (`tkinter`, `PyQt`, `rich`, `click` com prompt interativo, etc.)
- `input()` e qualquer leitura do stdin
- Caminhos hardcoded (`C:\...\resultado.xlsx`)
- Qualquer código que espera o usuário clicar em algo

**Exemplo de migração:**

```python
# ANTES — automação com interface própria
import tkinter as tk
root = tk.Tk()
cnpj = entry.get()
resultado_path = "C:\\Users\\joao\\Desktop\\resultado.xlsx"
# ... lógica ...
messagebox.showinfo("Concluído", "Arquivo salvo!")

# DEPOIS — compatível com o hub
import os, json
params = json.load(open(os.environ['AUTOMATION_PARAMETERS_FILE']))
cnpj = params['cnpj']
resultado_path = os.path.join(os.environ['AUTOMATION_OUTPUT_DIR'], 'resultado.xlsx')
# ... mesma lógica ...
print("AH_PROGRESS|100|Concluído")
```

---

## 1. Estrutura do arquivo .zip

Envie um `.zip` (ou `.rar`) contendo todos os arquivos do projeto. O hub extrai tudo numa pasta dedicada ao robô e configura o comando de execução automaticamente.

```
minha-automacao.zip
├── main.py               ← script principal (informado no campo "Script principal")
├── requirements.txt      ← dependências Python (opcional, instalado automaticamente)
├── utils.py              ← outros módulos que main.py importa
└── ...
```

> **Importante:** todos os arquivos devem estar na **raiz** do zip, não dentro de subpastas.

### requirements.txt

Se o script depende de bibliotecas externas, inclua um `requirements.txt` padrão:

```
openpyxl==3.1.2
requests==2.31.0
pandas
```

O hub instala essas dependências automaticamente numa pasta isolada por robô. Não é necessário instalar nada no servidor manualmente.

---

## 2. Variáveis de ambiente

O hub injeta as seguintes variáveis de ambiente no processo do script a cada execução:

| Variável | O que contém |
|---|---|
| `AUTOMATION_EXECUTION_ID` | ID único da execução (UUID) |
| `AUTOMATION_INPUT_DIR` | Pasta com os arquivos enviados pelo usuário no formulário |
| `AUTOMATION_OUTPUT_DIR` | Pasta onde o script deve gravar os arquivos de saída |
| `AUTOMATION_METADATA_DIR` | Pasta com os arquivos `parameters.json` e `context.json` |
| `AUTOMATION_PARAMETERS_FILE` | Caminho direto para `parameters.json` |
| `AUTOMATION_CONTEXT_FILE` | Caminho direto para `context.json` |

### parameters.json

Contém os valores preenchidos pelo usuário no formulário de execução. O formato é um objeto JSON com os nomes dos campos como chaves:

```json
{
  "cnpj": "12345678000199",
  "competencia": "2024-01",
  "incluirAnexos": true
}
```

### context.json

Informações sobre o robô e os caminhos da execução:

```json
{
  "executionId": "abc-123",
  "robot": {
    "id": "uuid-do-robo",
    "slug": "consulta-sintegra",
    "name": "Consulta Sintegra CE"
  },
  "inputDir": "/caminho/para/input",
  "outputDir": "/caminho/para/output",
  "metadataDir": "/caminho/para/metadata"
}
```

---

## 3. Lendo parâmetros no script

```python
import os
import json

# Lê os parâmetros preenchidos pelo usuário
parameters_file = os.environ['AUTOMATION_PARAMETERS_FILE']
with open(parameters_file, 'r', encoding='utf-8') as f:
    params = json.load(f)

cnpj = params.get('cnpj', '')
competencia = params.get('competencia', '')
incluir_anexos = params.get('incluirAnexos', False)
```

---

## 4. Arquivos de entrada

Arquivos enviados pelo usuário ficam em `AUTOMATION_INPUT_DIR`. Para acessá-los:

```python
import os

input_dir = os.environ['AUTOMATION_INPUT_DIR']

# Lista todos os arquivos enviados
arquivos = os.listdir(input_dir)

# Acessa um arquivo específico por campo (nome configurado na automação)
planilha = os.path.join(input_dir, 'planilha_entrada.xlsx')
```

---

## 5. Arquivos de saída

Qualquer arquivo gravado em `AUTOMATION_OUTPUT_DIR` fica disponível para download no hub após a execução. Não há necessidade de nenhuma configuração extra.

```python
import os

output_dir = os.environ['AUTOMATION_OUTPUT_DIR']
caminho_saida = os.path.join(output_dir, 'resultado.xlsx')

# Grava o arquivo de saída
workbook.save(caminho_saida)
```

---

## 6. Comunicação com o hub (stdout)

O script se comunica com o hub imprimindo linhas no stdout com prefixos específicos. Qualquer linha que não corresponda a um prefixo vira um log automático visível na tela de execução.

### Progresso

Atualiza a barra de progresso e o passo atual visível no hub.

```
AH_PROGRESS|<0-100>|<mensagem>
```

```python
print("AH_PROGRESS|10|Iniciando consulta")
print("AH_PROGRESS|50|Processando CNPJs")
print("AH_PROGRESS|90|Gerando planilha")
```

### Logs

Grava uma mensagem no log da execução com nível de severidade.

```
AH_LOG|<info|warn|error>|<mensagem>
```

```python
print("AH_LOG|info|Conexão estabelecida")
print("AH_LOG|warn|CNPJ sem resultado, pulando")
print("AH_LOG|error|Timeout ao consultar o servidor")
```

### Métricas

Registra um valor numérico acumulado. Usado para calcular o tempo economizado na tela de relatórios.

```
AH_METRIC|<chave>|<valor>
```

A chave deve corresponder ao campo **"Chave da métrica no robô"** configurado nas definições da automação.

```python
# Incrementa a cada item processado
print(f"AH_METRIC|itens_processados|1")

# Ou registra o total de uma vez
total = 42
print(f"AH_METRIC|itens_processados|{total}")
```

> Valores com vírgula ou ponto decimal são aceitos: `AH_METRIC|tempo_total|1.5`

---

## 7. Código de saída

O hub usa o código de saída do processo para determinar o resultado da execução:

| Código | Resultado |
|---|---|
| `0` | ✅ Sucesso |
| qualquer outro | ❌ Erro |

Em Python, erros não capturados e `sys.exit(1)` resultam em erro. Finalizações normais retornam `0` automaticamente.

```python
import sys

try:
    # lógica da automação
    pass
except Exception as e:
    print(f"AH_LOG|error|Falha crítica: {e}")
    sys.exit(1)
```

---

## 8. Exemplo completo

```python
import os
import json
import sys

def main():
    # 1. Lê parâmetros
    with open(os.environ['AUTOMATION_PARAMETERS_FILE'], encoding='utf-8') as f:
        params = json.load(f)

    cnpjs = params.get('cnpjs', '').splitlines()
    if not cnpjs:
        print("AH_LOG|error|Nenhum CNPJ informado.")
        sys.exit(1)

    output_dir = os.environ['AUTOMATION_OUTPUT_DIR']
    total = len(cnpjs)

    print(f"AH_PROGRESS|10|Iniciando consulta de {total} CNPJs")

    for i, cnpj in enumerate(cnpjs, start=1):
        cnpj = cnpj.strip()
        if not cnpj:
            continue

        try:
            # ... lógica de consulta ...
            print(f"AH_LOG|info|CNPJ {cnpj} consultado com sucesso")
            print(f"AH_METRIC|itens_processados|1")
        except Exception as e:
            print(f"AH_LOG|warn|Erro ao consultar {cnpj}: {e}")

        progresso = int(10 + (i / total) * 80)
        print(f"AH_PROGRESS|{progresso}|Processando {i}/{total}")

    # Grava saída
    resultado_path = os.path.join(output_dir, 'resultado.txt')
    with open(resultado_path, 'w', encoding='utf-8') as f:
        f.write("Consulta finalizada.\n")

    print("AH_PROGRESS|100|Concluído")

if __name__ == '__main__':
    main()
```

---

## 9. Arquivos intermediários e screenshots de erro

Arquivos gravados em `AUTOMATION_OUTPUT_DIR` ficam disponíveis para download **somente quando a execução termina** (com sucesso, erro ou cancelamento). Não há como disponibilizar arquivos para download enquanto o script ainda está rodando.

Para comunicar ao usuário que um arquivo foi salvo durante a execução, use `AH_LOG` — o arquivo estará disponível no final:

```python
import os

output_dir = os.environ['AUTOMATION_OUTPUT_DIR']

# Salva um arquivo intermediário (ex: planilha parcial, screenshot de erro)
planilha_path = os.path.join(output_dir, 'resultado_parcial.xlsx')
workbook.save(planilha_path)

# Avisa o usuário via log (o arquivo aparece para download quando a execução terminar)
print(f"AH_LOG|info|Planilha parcial salva: resultado_parcial.xlsx")
```

### Screenshots de erro com Playwright/nodriver

Se o script usa automação de browser, capture screenshots quando um elemento não for encontrado — isso ajuda a identificar em qual tela o robô travou:

```python
async def consultar(page, dado: str):
    try:
        elemento = await asyncio.wait_for(page.find("Botão Exemplo"), timeout=30)
        await elemento.click()
    except Exception as exc:
        # Salva screenshot no output para diagnóstico
        screenshot = os.path.join(output_dir, f"erro_{dado}.png")
        try:
            await page.save_screenshot(screenshot)
            print(f"AH_LOG|warn|Screenshot salvo: erro_{dado}.png")
        except Exception:
            pass
        # Recarrega a página para tentar o próximo item
        await page.get("https://...")
        raise
```

> **Padrão recomendado:** use `asyncio.wait_for(..., timeout=N)` em todas as chamadas que buscam elementos na página. Sem timeout, o script pode travar indefinidamente esperando um elemento que nunca aparece.

---

## 10. Dicas e cuidados

- **Encoding:** sempre use `encoding='utf-8'` ao abrir arquivos para evitar erros com acentos
- **Caminhos:** nunca use caminhos fixos (`C:\...` ou `/home/...`). Use sempre as variáveis de ambiente
- **Logs vs prints:** prints simples viram logs automáticos — use os prefixos `AH_LOG` apenas quando quiser controlar o nível (info/warn/error)
- **Progresso:** envie atualizações de progresso regularmente para que o hub mostre andamento em tempo real
- **Saída vazia:** se nenhum arquivo for gravado em `AUTOMATION_OUTPUT_DIR`, a execução termina como sucesso mas sem arquivos para download — isso é válido para automações que não geram arquivos
- **Múltiplos arquivos de saída:** todos os arquivos dentro de `AUTOMATION_OUTPUT_DIR` ficam disponíveis para download, inclusive em subpastas

---

## 11. Disparar uma execução via API

Qualquer cliente HTTP pode acionar e monitorar execuções no hub. Esta seção documenta o fluxo completo: autenticar, descobrir o ID do robô, criar a execução, aguardar o resultado e baixar os arquivos gerados.

**URL base:** `http://hubcontroller.com.br` (ou `http://localhost:3000` em desenvolvimento)

A autenticação é feita via **cookie de sessão**. Use um cliente que preserve cookies automaticamente (ex: `requests.Session()` em Python).

---

### 11.1 Autenticar

```http
POST /api/auth/login
Content-Type: application/json

{
  "login": "USUARIO",
  "password": "senha"
}
```

A resposta define um cookie `session` que deve ser enviado em todas as requisições seguintes. O campo `login` aceita nome de usuário ou e-mail.

---

### 11.2 Descobrir o ID do robô

```http
GET /api/robots
```

Retorna a lista de robôs acessíveis ao usuário. Cada item contém:

```json
{
  "id": "cuid-do-robo",
  "slug": "consulta-sintegra",
  "name": "Consulta Sintegra CE",
  "isActive": true,
  "schema": { ... }
}
```

Você também pode buscar um robô diretamente pelo slug:

```http
GET /api/robots/consulta-sintegra
```

O campo `schema` descreve os campos do formulário — use-o para saber quais parâmetros enviar.

---

### 11.3 Criar uma execução

```http
POST /api/executions
Content-Type: multipart/form-data

robotId=<id-do-robo>
parameters={"cnpj":"12345678000199","competencia":"2024-01"}
notes=Disparado via API (opcional)
```

A resposta contém o ID da execução criada:

```json
{
  "id": "cuid-da-execucao",
  "status": "queued",
  "progress": 0
}
```

**Para enviar arquivos junto com a execução:** adicione cada arquivo como um campo do multipart com o mesmo nome configurado no campo do formulário (`fileInputName`).

---

### 11.4 Aguardar o resultado (polling)

```http
GET /api/executions/<id-da-execucao>
```

Faça polling até `status` ser `success`, `error` ou `canceled`.

Campos relevantes da resposta:

| Campo | Descrição |
|---|---|
| `status` | `queued` → `running` → `success` \| `error` \| `canceled` |
| `progress` | 0–100 |
| `currentStep` | Texto do último `AH_PROGRESS` |
| `outputFiles` | Lista de arquivos gerados (ver 11.5) |
| `logs` | Logs da execução |

---

### 11.5 Baixar arquivos de saída

O campo `outputFiles` da execução retorna uma lista de objetos:

```json
[
  {
    "id": "cuid-do-arquivo",
    "name": "resultado.xlsx",
    "path": "executions/<id>/output/resultado.xlsx",
    "size": 4096
  }
]
```

Para baixar, use a URL `/storage/<path>` com o cookie de sessão:

```http
GET /storage/executions/<id-da-execucao>/output/resultado.xlsx
```

---

### 11.6 Exemplo completo em Python

```python
import time
import requests

BASE_URL = "http://hubcontroller.com.br"  # ou http://localhost:3000

session = requests.Session()

# 1. Login
resp = session.post(f"{BASE_URL}/api/auth/login", json={
    "login": "USUARIO",
    "password": "senha"
})
resp.raise_for_status()

# 2. Buscar robô pelo slug
resp = session.get(f"{BASE_URL}/api/robots/consulta-sintegra")
resp.raise_for_status()
robot = resp.json()
robot_id = robot["id"]

# 3. Criar execução
resp = session.post(f"{BASE_URL}/api/executions", data={
    "robotId": robot_id,
    "parameters": '{"cnpj":"12345678000199","competencia":"2024-01"}',
    "notes": "Disparado via API",
})
resp.raise_for_status()
execution_id = resp.json()["id"]
print(f"Execução criada: {execution_id}")

# 4. Aguardar conclusão (polling a cada 5 segundos)
TERMINAL = {"success", "error", "canceled"}
while True:
    resp = session.get(f"{BASE_URL}/api/executions/{execution_id}")
    resp.raise_for_status()
    execution = resp.json()
    status = execution["status"]
    progress = execution.get("progress", 0)
    step = execution.get("currentStep", "")
    print(f"[{status}] {progress}% — {step}")

    if status in TERMINAL:
        break
    time.sleep(5)

print(f"Resultado final: {status}")

# 5. Baixar arquivos de saída
for f in execution.get("outputFiles", []):
    url = f"{BASE_URL}/storage/{f['path']}"
    download = session.get(url)
    download.raise_for_status()
    with open(f["name"], "wb") as out:
        out.write(download.content)
    print(f"Arquivo salvo: {f['name']}")
```

---

### 11.7 Exemplo com arquivos de entrada

Para robôs que recebem arquivos via formulário, envie-os como campos do multipart. O nome do campo deve corresponder ao `name` configurado no schema do robô (campo `fileInputName`):

```python
with open("planilha.xlsx", "rb") as f:
    resp = session.post(f"{BASE_URL}/api/executions", data={
        "robotId": robot_id,
        "parameters": '{}',
    }, files={
        "planilha_entrada": ("planilha.xlsx", f, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
    })
resp.raise_for_status()
```

---

### 11.8 Cancelar uma execução em andamento

```http
POST /api/executions/<id-da-execucao>/cancel
```

```python
session.post(f"{BASE_URL}/api/executions/{execution_id}/cancel").raise_for_status()
```

---

### 11.9 Resumo dos endpoints

| Método | Endpoint | Descrição |
|---|---|---|
| `POST` | `/api/auth/login` | Autenticar (define cookie de sessão) |
| `GET` | `/api/robots` | Listar robôs disponíveis |
| `GET` | `/api/robots/:slug` | Detalhe de um robô (schema incluso) |
| `POST` | `/api/executions` | Criar execução (multipart/form-data) |
| `GET` | `/api/executions/:id` | Status, progresso e arquivos da execução |
| `POST` | `/api/executions/:id/cancel` | Cancelar execução |
| `GET` | `/storage/executions/:id/output/:arquivo` | Baixar arquivo de saída |

---

## 12. Cadastrar uma automação no hub

Automações são cadastradas na página **Configurações → Robôs** (requer role `admin`). Este guia explica cada campo disponível e seu propósito.

---

### 12.1 Identidade

| Campo | Obrigatório | Descrição |
|---|---|---|
| **Nome** | Sim | Nome exibido no catálogo e em todo o hub. Ex: `Consulta Sintegra CE` |
| **Slug** | Sim | Identificador URL-friendly, único, imutável após criação. Ex: `consulta-sintegra-ce`. Use apenas letras minúsculas, números e hífens. |
| **Resumo** | Não | Uma linha descrevendo o que a automação faz — aparece nos cards do catálogo. |
| **Descrição** | Não | Texto longo exibido no topo da página de execução. Pode detalhar casos de uso, limitações e instruções. |
| **Categoria** | Não | Texto livre para agrupar robôs no catálogo. Ex: `Fiscal`, `Pessoal`, `Contábil`. |
| **Ícone** | Não | Ícone visual do card. Opções: `bot` (padrão), `bank`, `receipt`, `chart`. |
| **Versão** | Não | Versão semântica do script. Ex: `1.0.0`. Exibida no card e na página de detalhes. |
| **Status** | Sim | `Ativa` — disponível para execução. `Inativa` — aparece no catálogo mas bloqueia execuções (exibe "Em manutenção"). |

---

### 12.2 Acesso e orquestração

| Campo | Padrão | Descrição |
|---|---|---|
| **Departamentos com acesso** | (vazio = todos) | Se nenhum departamento for marcado, qualquer usuário da empresa pode executar. Se um ou mais forem marcados, apenas usuários daqueles departamentos têm acesso. |
| **Concorrência máxima** | 1 | Quantas execuções desse robô podem rodar em paralelo. `1` significa que a próxima fica em fila até a anterior terminar. |
| **Grupos de conflito** | (vazio) | Tags separadas por vírgula. Robôs com a mesma tag não rodam simultaneamente. Ex: `sefaz-ce` impede dois robôs que usam o mesmo portal de colidir. |

---

### 12.3 Script da automação

A forma mais simples de cadastrar um robô é enviar um `.zip` ou `.rar` com todos os arquivos do projeto.

| Campo | Descrição |
|---|---|
| **Arquivo (.zip ou .rar)** | Pacote com o script e todos os módulos auxiliares. O hub extrai na pasta do robô e instala as dependências do `requirements.txt` automaticamente. |
| **Script principal** | Nome do arquivo de entrada dentro do zip. Ex: `main.py`. O hub monta o comando `python main.py` automaticamente — você não precisa preencher o campo "Comando" neste caso. |

> Para scripts que exigem comando personalizado (outro interpretador, flags, etc.), preencha **Comando de execução** e **Pasta de execução** manualmente em vez de usar o upload.

**Comando de execução** (opcional): linha de comando completa para iniciar o robô. Ex: `python main.py` ou `node index.js`. Usado quando o upload de script não for o método escolhido.

**Pasta de execução** (opcional): diretório de trabalho onde o comando é executado. Normalmente preenchido automaticamente pelo upload.

---

### 12.4 Campos do formulário (`schema.fields`)

Os campos definem o formulário que o usuário preenche antes de executar o robô. Os valores preenchidos chegam ao script via `AUTOMATION_PARAMETERS_FILE` (JSON).

Para adicionar um campo, clique em **+ Campo** na seção "Campos do formulário" no cadastro do robô.

Cada campo tem as seguintes propriedades:

| Propriedade | Descrição |
|---|---|
| **Nome interno** | Chave do JSON em `parameters.json`. Sem espaços. Ex: `cnpj`, `data_inicio`, `incluir_inativos`. |
| **Label** | Texto exibido acima do campo no formulário. Ex: `CNPJ da empresa`. |
| **Tipo** | Controla o componente renderizado (ver tabela abaixo). |
| **Obrigatório** | Se marcado, o hub impede o envio sem preenchimento. |
| **Valor padrão** | Pré-preenche o campo quando o formulário é aberto. |
| **Placeholder** | Texto de sugestão exibido dentro do campo vazio. Ex: `00.000.000/0001-00`. |
| **Opções** | Lista de opções separadas por vírgula — obrigatório para `select` e `radio`. Ex: `Mensal,Trimestral,Anual`. |

#### Tipos de campo disponíveis

| Tipo | Componente exibido | Quando usar | Valor em `parameters.json` |
|---|---|---|---|
| `text` | Input de texto | CPF, CNPJ, nome, código, qualquer texto livre | `"string"` |
| `date` | Input de data (date picker nativo) | Competência, período, data de referência | `"YYYY-MM-DD"` |
| `textarea` | Área de texto multilinha (ocupa largura total) | Lista de CNPJs, observações longas, texto livre | `"string"` |
| `select` | Dropdown de opções | Escolha entre valores fixos (UF, tipo de relatório) | `"opção selecionada"` |
| `radio` | Botões de opção side-by-side | 2–4 opções onde o usuário precisa ver todas | `"opção selecionada"` |
| `checkbox` | Caixa de marcação (Ativar/desativar) | Flags booleanas (incluir anexos, modo debug) | `true` ou `false` |

> `textarea` e `radio` e `checkbox` sempre ocupam a largura total do formulário. Os demais campos ocupam metade (2 colunas em grid).

**Exemplo de schema com campos:**

```json
{
  "fields": [
    {
      "name": "cnpj",
      "label": "CNPJ da empresa",
      "type": "text",
      "required": true,
      "placeholder": "00.000.000/0001-00"
    },
    {
      "name": "competencia",
      "label": "Competência",
      "type": "date",
      "required": true
    },
    {
      "name": "tipo_relatorio",
      "label": "Tipo de relatório",
      "type": "select",
      "options": ["Mensal", "Trimestral", "Anual"],
      "defaultValue": "Mensal"
    },
    {
      "name": "incluir_inativos",
      "label": "Incluir registros inativos",
      "type": "checkbox"
    },
    {
      "name": "cnpjs_lista",
      "label": "Lista de CNPJs (um por linha)",
      "type": "textarea",
      "placeholder": "12.345.678/0001-99\n98.765.432/0001-00"
    }
  ],
  "fileInputs": []
}
```

---

### 12.5 Uploads de arquivo (`schema.fileInputs`)

Quando o robô precisa que o usuário envie um arquivo (planilha de entrada, PDF, etc.), adicione um `fileInput`. Para adicionar, clique em **+ Upload** na seção "Uploads de arquivo" no cadastro.

| Propriedade | Descrição |
|---|---|
| **Nome interno** | Chave do campo de arquivo no formulário. Ex: `planilha_entrada`. O arquivo chegará em `AUTOMATION_INPUT_DIR/` com este nome associado. |
| **Label** | Texto exibido acima do botão de upload. Ex: `Planilha de funcionários`. |
| **Tipos aceitos** | Filtro de extensões no seletor de arquivos. Ex: `.xlsx,.xls` ou `.pdf` ou `image/*`. |
| **Texto de ajuda** | Dica exibida abaixo do campo. Ex: `Deve conter as colunas Nome, CPF e Salário.` |
| **Obrigatório** | Se marcado, bloqueia o envio sem arquivo. |
| **Múltiplos arquivos** | Permite selecionar mais de um arquivo no mesmo campo. |

**Como acessar o arquivo no script:**

```python
import os

input_dir = os.environ['AUTOMATION_INPUT_DIR']

# O arquivo fica em input_dir com um nome único gerado pelo hub.
# Para pegar o primeiro arquivo de qualquer nome:
arquivos = os.listdir(input_dir)
if arquivos:
    planilha = os.path.join(input_dir, arquivos[0])
```

> Se o robô tiver múltiplos campos de arquivo, todos os arquivos ficam em `AUTOMATION_INPUT_DIR` — use `os.listdir()` para iterar sobre todos ou confie na ordem de upload caso precise distingui-los.

---

### 12.6 Métrica de tempo economizado

O hub calcula automaticamente quanto tempo a automação economizou comparando o número de unidades processadas com o tempo que levaria para fazer manualmente.

| Campo | Descrição |
|---|---|
| **Tempo manual por unidade (segundos)** | Quantos segundos uma pessoa levaria para processar uma unidade manualmente. Ex: `60` para 1 minuto por empresa. |
| **Nome da unidade** | Como chamar cada unidade no relatório. Ex: `empresa`, `nota fiscal`, `cliente`. |
| **Chave da métrica no robô** | O nome usado no `AH_METRIC` do script. Ex: `itens_processados`. O hub soma todos os valores enviados com essa chave durante a execução. |

**Exemplo no script:**

```python
# A cada empresa processada:
print("AH_METRIC|itens_processados|1")

# Ou de uma vez ao final:
total_empresas = 42
print(f"AH_METRIC|itens_processados|{total_empresas}")
```

Com `manualSecondsPerUnit = 60` e `42` unidades processadas, o hub exibirá **42 minutos economizados** naquela execução.

---

### 12.7 Recursos e suporte

Campos opcionais que aparecem no card "Recursos do robô" na página de detalhes da automação.

| Campo | Descrição |
|---|---|
| **Label da documentação** | Texto do link de documentação. Padrão: `Documentação`. |
| **Link da documentação** | URL para manual, Notion, Confluence, etc. |
| **Label do suporte** | Texto do contato de suporte. Ex: `Falar com Davi`. |
| **Contato do suporte** | E-mail, ramal ou link. Ex: `davi@empresa.com.br`. |
| **Política de dados** | Texto livre descrevendo o que a automação acessa e como trata os dados. Exibido abaixo dos links. |

---

### 12.8 Modelos de entrada (arquivos de exemplo)

Após salvar o robô, é possível anexar arquivos de exemplo para ajudar o usuário a montar a planilha correta.

| Campo | Descrição |
|---|---|
| **Arquivo modelo** | Planilha, PDF ou qualquer arquivo de referência. |
| **Relacionado ao upload** | (Opcional) Vincula o modelo a um campo de arquivo específico. Quando preenchido, o link de download aparece diretamente embaixo do campo de upload correspondente. |
| **Título** | Nome legível exibido no botão de download. Ex: `Planilha de notas fiscais`. |
| **Instruções** | Descrição do que o arquivo contém ou como preenchê-lo. |

---

### 12.9 Resumo completo dos campos de cadastro

```json
{
  "name": "Nome exibido no hub",
  "slug": "identificador-url-unico",
  "summary": "Uma linha descrevendo o robô (para o card)",
  "description": "Descrição longa exibida na página de detalhes",
  "category": "Fiscal",
  "icon": "bot",
  "version": "1.0.0",
  "isActive": true,
  "allowedDepartments": ["fiscal", "contabil"],
  "maxConcurrency": 1,
  "conflictKeys": "sefaz-ce",
  "command": "python main.py",
  "workingDirectory": "C:\\robots\\meu-robo",
  "manualSecondsPerUnit": 60,
  "unitLabel": "empresa",
  "unitMetricKey": "itens_processados",
  "documentationLabel": "Manual",
  "documentationUrl": "https://notion.so/...",
  "supportLabel": "Suporte",
  "supportValue": "davi@empresa.com.br",
  "dataPolicy": "Acessa apenas dados da empresa selecionada. Nenhuma informação é armazenada externamente.",
  "schema": {
    "fields": [
      {
        "name": "cnpj",
        "label": "CNPJ",
        "type": "text",
        "required": true,
        "placeholder": "00.000.000/0001-00"
      }
    ],
    "fileInputs": [
      {
        "name": "planilha_entrada",
        "label": "Planilha de entrada",
        "accept": ".xlsx,.xls",
        "multiple": false,
        "required": true,
        "helperText": "Use o modelo disponível abaixo."
      }
    ]
  }
}
```

#### Departamentos disponíveis

Os slugs de departamento aceitos no campo `allowedDepartments`:

`pessoal` · `fiscal` · `contabil` · `tecnologia` · `inovacao` · `legalizacao` · `certificacao` · `auditoria` · `rh`

Deixe o array vazio (`[]`) para liberar a automação para toda a empresa.

---

## 13. Repositório de scripts — fluxo com GitHub

Os scripts de todos os robôs ficam no repositório privado **[Controller-Desenvolvimento/hub-robots](https://github.com/Controller-Desenvolvimento/hub-robots)**. O hub monitora esse repositório e aplica atualizações automaticamente — sem precisar fazer upload de zip ou reiniciar o servidor.

---

### 13.1 Como funciona a sincronização

O hub roda `git pull` na pasta `C:\robots` (onde os scripts ficam) a cada **5 minutos** em background. Quando você faz um `push` no GitHub, o hub vai pegar a atualização no próximo ciclo — ou imediatamente se você clicar no botão de sync manual.

```
Você edita no VS Code → git push → hub faz git pull → script atualizado na próxima execução
```

O botão de sync manual fica em **Configurações → Robôs**, no topo da lista de automações. Ele mostra quando foi o último sync e um ícone de refresh para forçar imediatamente.

---

### 13.2 Estrutura do repositório

Cada robô é uma **subpasta** com o nome do slug da automação:

```
hub-robots/
├── dam/
│   ├── run.py              ← script principal
│   ├── dam_bot.py          ← módulo auxiliar
│   └── requirements.txt
├── spedgov/
│   ├── run.py
│   ├── spedgov_bot.py
│   ├── df_processor.py
│   └── requirements.txt
├── consulta-sintegra/      ← nova automação
│   ├── main.py
│   └── requirements.txt
└── ...
```

O campo **Pasta de execução** no cadastro do robô no hub deve apontar para a subpasta correspondente: `C:\robots\dam`, `C:\robots\spedgov`, etc.

---

### 13.3 Configurar o VS Code para contribuir

**Pré-requisito:** ter Git instalado e uma conta GitHub com acesso ao repositório.

```bash
# 1. Clonar o repositório (fazer apenas uma vez)
git clone https://github.com/Controller-Desenvolvimento/hub-robots.git
cd hub-robots

# 2. Abrir no VS Code
code .
```

No VS Code, o painel **Source Control** (Ctrl+Shift+G) mostra os arquivos modificados e permite commitar e fazer push sem sair do editor.

---

### 13.4 Fluxo para atualizar um robô existente

```bash
# Pegar as últimas alterações antes de começar (sempre fazer isso primeiro)
git pull

# Editar os arquivos do robô no VS Code
# ...

# Commitar as mudanças
git add dam/
git commit -m "fix: corrigir seletor de CNPJ na tela de login"

# Enviar para o GitHub
git push
```

O hub vai pegar a atualização em até 5 minutos — ou use o botão de sync em Configurações → Robôs para aplicar na hora.

---

### 13.5 Fluxo para adicionar um novo robô

```bash
# 1. Criar a pasta do novo robô no repositório
mkdir meu-novo-robo
cd meu-novo-robo

# 2. Criar os arquivos do script
# main.py, requirements.txt, etc.

# 3. Commitar e enviar
git add .
git commit -m "feat: adicionar robô Consulta SEFAZ"
git push

# 4. Cadastrar o robô no hub (Configurações → Robôs → Nova automação)
#    - Pasta de execução: C:\robots\meu-novo-robo
#    - Script principal: main.py  (ou via campo "Comando de execução": python main.py)
```

---

### 13.6 O que NÃO commitar

O `.gitignore` do repositório já ignora automaticamente:

| Ignorado | Por quê |
|---|---|
| `venv/`, `.venv/` | Ambiente virtual — cada máquina tem o seu, pesado (~centenas de MB) |
| `__pycache__/`, `*.pyc` | Cache do Python — gerado automaticamente |
| `.env` | Credenciais — nunca devem entrar no git |
| `*.log`, `tmp/` | Arquivos temporários |

Se uma dessas pastas aparecer no painel do VS Code, não adicione ao commit — o `.gitignore` deve ter falhado ou a pasta foi criada fora do padrão esperado.

---

### 13.7 Acesso ao repositório

O repositório é **privado**. Quem tem acesso atualmente:

| Conta | Permissão |
|---|---|
| Organização `Controller-Desenvolvimento` | Dona do repositório (membros: `davi-baptista`, `InovController` etc.) |
| `christiansousadev` | Write (leitura e escrita) |
| `matheusbng` | Write (leitura e escrita) |
| `MatheusBrunoMB` | Write (leitura e escrita) |

Para adicionar ou remover colaboradores: acessar [github.com/Controller-Desenvolvimento/hub-robots/settings/access](https://github.com/Controller-Desenvolvimento/hub-robots/settings/access) com uma conta Owner da organização.
