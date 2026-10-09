import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';

const BASE_URL = 'https://chat.hubcontroller.com.br/api';
const TOKEN_TTL_MS = 4.5 * 60 * 60 * 1000; // JWT real dura 5h — renova um pouco antes
const REQUEST_TIMEOUT_MS = 20 * 1000;
const RAZAO_EXPORT_TIMEOUT_MS = 45 * 1000;

interface EmpresaSuggestion {
  codigo: number;
  razao: string;
  fantasia?: string;
  cnpj?: string;
  exibicao?: string;
}

interface ReportResult {
  status: 'ok' | 'empty' | 'ambiguous' | 'error';
  text: string;
  count?: number;
  meta?: Record<string, unknown>;
  empresaSuggestions?: EmpresaSuggestion[];
}

// Integra com a plataforma "Controller Intelligence" (chat.hubcontroller.com.br)
// pra consultar relatórios contábeis reais (Athenas/Firebird). Autentica via
// login Athenas (não é uma conta de serviço dedicada — é a conta pessoal do
// Davi, emprestada até o time de lá criar uma própria; ver conversa/nota em
// controller-intelligence-testes.txt) e cacheia o JWT entre chamadas.
//
// Cada endpoint tem peculiaridades próprias já testadas manualmente (nem
// sempre batem com a documentação técnica interna deles — ver o mesmo
// arquivo de notas):
//   - balancete: exige ano+mês juntos (ano sozinho dá 400).
//   - balanco: exige dt_ini+dt_fim; resolve empresa por nome com
//     desambiguação igual ao balancete (status "ambiguous" + suggestions).
//   - dre: mês é realmente opcional aqui (ano sozinho = ano inteiro); NÃO
//     tem "text" pronto na resposta "ok" (só "data": lista de linhas) — o
//     resumo é montado aqui. Nome ambíguo não devolve sugestões, só um erro
//     genérico pedindo código.
//   - razao / faturamento / livrofiscal: só aceitam código numérico da
//     empresa, não resolvem por nome.
@Injectable()
export class ControllerIntelligenceService {
  private readonly logger = new Logger(ControllerIntelligenceService.name);
  private token: string | null = null;
  private tokenIssuedAt = 0;

  private isConfigured(): boolean {
    return Boolean(process.env.CONTROLLER_INTELLIGENCE_LOGIN && process.env.CONTROLLER_INTELLIGENCE_PASSWORD);
  }

  private async ensureToken(forceRefresh = false): Promise<string> {
    if (!this.isConfigured()) {
      throw new InternalServerErrorException('Integração com o Controller Intelligence não está configurada.');
    }
    if (!forceRefresh && this.token && Date.now() - this.tokenIssuedAt < TOKEN_TTL_MS) {
      return this.token;
    }

    const nomeAcesso = process.env.CONTROLLER_INTELLIGENCE_LOGIN;
    const password = process.env.CONTROLLER_INTELLIGENCE_PASSWORD;

    let response: Response;
    try {
      response = await fetch(`${BASE_URL}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ loginType: 'athenas', nomeAcesso, password }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      this.logger.error(`Falha de rede ao logar no Controller Intelligence: ${err instanceof Error ? err.message : String(err)}`);
      throw new InternalServerErrorException('Não foi possível conectar ao sistema de relatórios contábeis agora.');
    }

    const data = (await response.json().catch(() => null)) as { ok?: boolean; data?: { token?: string } } | null;
    if (!response.ok || !data?.ok || !data.data?.token) {
      this.logger.error(`Login no Controller Intelligence falhou: status=${response.status} body=${JSON.stringify(data)}`);
      throw new InternalServerErrorException('Não foi possível autenticar no sistema de relatórios contábeis.');
    }

    this.token = data.data.token;
    this.tokenIssuedAt = Date.now();
    return this.token;
  }

  private async getJson(path: string, retryOn401 = true, retryOnNetworkError = true): Promise<{ status: number; data: Record<string, unknown> }> {
    const token = await this.ensureToken();
    let response: Response;
    try {
      response = await fetch(`${BASE_URL}${path}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      const timedOut = err instanceof Error && err.name === 'TimeoutError';
      this.logger.error(`Falha de rede ao consultar ${path}: ${err instanceof Error ? err.message : String(err)}`);
      // O serviço externo oscila às vezes (conexão derrubada, 502): uma nova
      // tentativa resolve a maioria. Timeout não repete — a consulta pesada
      // dobraria a carga justo no servidor que já está lento.
      if (retryOnNetworkError && !timedOut) {
        await new Promise((resolve) => setTimeout(resolve, 800));
        return this.getJson(path, retryOn401, false);
      }
      throw new InternalServerErrorException('Não foi possível consultar o sistema de relatórios contábeis agora.');
    }

    if (response.status === 401 && retryOn401) {
      await this.ensureToken(true);
      return this.getJson(path, false, retryOnNetworkError);
    }

    const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: response.status, data };
  }

  // Normaliza a resposta pros dois formatos que a API usa: negócio
  // ({status, text/data, meta, ...}) e erro de validação ({ok:false,
  // error:"..."}) — sem tratar os dois, um parâmetro faltando virava uma
  // mensagem genérica sem explicar o que faltou.
  private parseReportResponse(data: Record<string, unknown>, fallbackText: (data: Record<string, unknown>) => string | null): ReportResult {
    if (typeof data.status !== 'string') {
      const validationMessage = typeof data.error === 'string' ? data.error : null;
      return { status: 'error', text: validationMessage ?? 'Não foi possível interpretar a resposta do sistema de relatórios.' };
    }

    const text = typeof data.text === 'string' ? data.text : fallbackText(data) ?? 'Não foi possível interpretar a resposta do sistema de relatórios.';
    return {
      status: data.status as ReportResult['status'],
      text,
      count: typeof data.count === 'number' ? data.count : undefined,
      meta: (data.meta as Record<string, unknown>) ?? undefined,
      empresaSuggestions: Array.isArray(data.empresa_suggestions) ? (data.empresa_suggestions as EmpresaSuggestion[]) : undefined,
    };
  }

  private empresaParams(params: { empresaNome?: string; empresaCodigo?: number }): [string, string] {
    if (params.empresaCodigo) return ['empresa', String(params.empresaCodigo)];
    if (params.empresaNome) return ['empresa_nome', params.empresaNome];
    throw new InternalServerErrorException('Informe a empresa (nome ou código).');
  }

  // Não expõe as centenas de linhas de um relatório inteiro pro modelo — o
  // "text"/resumo que a própria API devolve (ou que montamos aqui, quando
  // ela não devolve) já é suficiente pra maioria das perguntas.
  // Detalhamento linha a linha fica pra uma versão futura.

  async consultarBalancete(params: { empresaNome?: string; empresaCodigo?: number; ano: number; mes: number }): Promise<ReportResult> {
    const query = new URLSearchParams();
    const [key, value] = this.empresaParams(params);
    query.set(key, value);
    query.set('ano', String(params.ano));
    query.set('mes', String(params.mes));

    const { data } = await this.getJson(`/balancete?${query.toString()}`);
    return this.parseReportResponse(data, () => null);
  }

  // Descobre o código numérico de uma empresa a partir do nome — usado pelas
  // ferramentas que só aceitam código (razão, faturamento, livro fiscal e
  // exportação de arquivo). O histórico da conversa guarda só o texto das
  // mensagens, então um código descoberto numa resposta anterior se perde na
  // seguinte; resolver aqui, no servidor, evita depender do modelo lembrar.
  // O balancete é a única consulta que devolve o código (meta.empresa_id) e
  // desambigua nomes, mas só quando há dado no mês — por isso tenta os 3
  // últimos meses fechados.
  async resolverEmpresa(nome: string): Promise<
    | { status: 'ok'; codigo: number; nome: string }
    | { status: 'ambiguous'; message: string; opcoes: Array<{ codigo: number; nome: string }> }
    | { status: 'error'; message: string }
  > {
    const now = new Date();
    for (let back = 1; back <= 3; back += 1) {
      const ref = new Date(now.getFullYear(), now.getMonth() - back, 1);
      const result = await this.consultarBalancete({ empresaNome: nome, ano: ref.getFullYear(), mes: ref.getMonth() + 1 });

      if (result.status === 'ambiguous') {
        return {
          status: 'ambiguous',
          message: result.text,
          opcoes: (result.empresaSuggestions ?? []).map((e) => ({ codigo: e.codigo, nome: e.exibicao ?? e.razao })),
        };
      }
      if (result.status === 'error') return { status: 'error', message: result.text };

      const id = result.meta?.empresa_id;
      if (result.status === 'ok' && typeof id === 'number') {
        return { status: 'ok', codigo: id, nome: String(result.meta?.empresa_nome ?? nome) };
      }
      // "empty": sem dado nesse mês — tenta o mês anterior.
    }
    return {
      status: 'error',
      message: `Encontrei a empresa "${nome}", mas ela não tem movimento recente pra eu identificar o código. Informe o código numérico dela.`,
    };
  }

  async consultarBalanco(params: { empresaNome?: string; empresaCodigo?: number; dtIni: string; dtFim: string }): Promise<ReportResult> {
    const query = new URLSearchParams();
    const [key, value] = this.empresaParams(params);
    query.set(key, value);
    query.set('dt_ini', params.dtIni);
    query.set('dt_fim', params.dtFim);

    const { data } = await this.getJson(`/balanco?${query.toString()}`);
    return this.parseReportResponse(data, () => null);
  }

  async consultarDRE(params: { empresaNome?: string; empresaCodigo?: number; ano: number; mes?: number }): Promise<ReportResult> {
    const query = new URLSearchParams();
    const [key, value] = this.empresaParams(params);
    query.set(key, value);
    query.set('ano', String(params.ano));
    if (params.mes) query.set('mes', String(params.mes));

    const { data } = await this.getJson(`/dre?${query.toString()}`);
    return this.parseReportResponse(data, (d) => {
      const rows = Array.isArray(d.data) ? (d.data as Array<{ nome?: string; valor?: string }>) : [];
      if (rows.length === 0) return null;
      return rows.map((r) => `${r.nome ?? '?'}: ${r.valor ?? '?'}`).join('\n');
    });
  }

  async consultarRazao(params: { empresaCodigo: number; anoFiscal: number; dtIni: string; dtFim: string }): Promise<ReportResult> {
    const query = new URLSearchParams({
      empresa: String(params.empresaCodigo),
      ano_fiscal: String(params.anoFiscal),
      dt_ini: params.dtIni,
      dt_fim: params.dtFim,
    });

    const { data } = await this.getJson(`/razao?${query.toString()}`);
    return this.parseReportResponse(data, () => null);
  }

  async consultarFaturamento(params: { empresaCodigo: number; dtIni: string; dtFim: string }): Promise<ReportResult> {
    const query = new URLSearchParams({ empresa: String(params.empresaCodigo), dt_ini: params.dtIni, dt_fim: params.dtFim });

    const { data } = await this.getJson(`/faturamento?${query.toString()}`);
    return this.parseReportResponse(data, () => null);
  }

  async consultarLivroFiscal(params: {
    empresaCodigo: number;
    dtIni: string;
    dtFim: string;
    tipoRelatorio?: '00' | '01' | '02' | '10' | '11';
  }): Promise<ReportResult> {
    const query = new URLSearchParams({ empresa: String(params.empresaCodigo), dt_ini: params.dtIni, dt_fim: params.dtFim });
    if (params.tipoRelatorio) query.set('tipo_relatorio', params.tipoRelatorio);

    const { data } = await this.getJson(`/livrofiscal?${query.toString()}`);
    return this.parseReportResponse(data, () => null);
  }

  // Gera o arquivo (xlsx/pdf) de um relatório pra download via
  // POST /<tipo>/executar (não o /executar genérico que a documentação
  // técnica interna descreve). Testado em 2026-10-05: os seis relatórios
  // exportam (antes balanco/razao davam 404 e faturamento/livrofiscal 403
  // "acesso_negado_athenas"). Particularidades: o DRE exige ano+mês aqui
  // (só o ano dá 500 "Parâmetro inválido: mes"), e o razão com todas as
  // contas é lento (~5s por dia de período).
  async exportarArquivo(params: {
    tipoRelatorio: 'balancete' | 'dre' | 'balanco' | 'razao' | 'faturamento' | 'livrofiscal';
    empresaCodigo: number;
    ano: number;
    mes?: number;
    dtIni?: string;
    dtFim?: string;
    formato: 'xlsx' | 'pdf';
  }): Promise<{ ok: true; buffer: Buffer; filename: string } | { ok: false; error: string }> {
    const token = await this.ensureToken();
    const body = JSON.stringify({
      report: params.tipoRelatorio,
      empresa: params.empresaCodigo,
      ano: params.ano,
      ...(params.mes ? { mes: params.mes } : {}),
      ...(params.dtIni && params.dtFim ? { dt_ini: params.dtIni, dt_fim: params.dtFim } : {}),
      format: params.formato,
    });

    let response: Response;
    try {
      response = await fetch(`${BASE_URL}/${params.tipoRelatorio}/executar`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(params.tipoRelatorio === 'razao' ? RAZAO_EXPORT_TIMEOUT_MS : REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      this.logger.error(`Falha de rede ao exportar ${params.tipoRelatorio}: ${err instanceof Error ? err.message : String(err)}`);
      return { ok: false, error: 'Não foi possível gerar o arquivo agora.' };
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (!response.ok || contentType.includes('json') || contentType.includes('html')) {
      const text = await response.text().catch(() => '');
      let message = `Não foi possível gerar o arquivo (status ${response.status}).`;
      try {
        const parsed = JSON.parse(text) as { error?: string; reply?: string };
        message = parsed.error === 'acesso_negado_athenas'
          ? 'Exportar arquivo desse relatório não está disponível para este tipo de acesso.'
          : parsed.reply || parsed.error || message;
      } catch {
        // resposta não era JSON (ex.: página de erro HTML) — mantém a mensagem genérica
      }
      this.logger.warn(`Exportação de ${params.tipoRelatorio} falhou: status=${response.status} body=${text.slice(0, 300)}`);
      return { ok: false, error: message };
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    const disposition = response.headers.get('content-disposition') ?? '';
    const match = /filename="?([^"]+)"?/.exec(disposition);
    const filename = match?.[1] ?? `${params.tipoRelatorio}.${params.formato}`;
    return { ok: true, buffer, filename };
  }
}
