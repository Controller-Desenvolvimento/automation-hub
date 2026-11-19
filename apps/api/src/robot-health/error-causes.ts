// Catálogo de causas de erro das execuções (tela "Saúde dos robôs"). Só texto e regras: sem banco, sem rede.
// A 1ª regra que casar vence; a última casa com qualquer mensagem. Para uma causa nova, acrescente uma regra ANTES das duas últimas.

/** De quem é a falha: define quem precisa agir e se o erro pesa contra o robô. */
export type ErrorCategory = 'entrada' | 'externo' | 'hub' | 'robo' | 'config' | 'sem';

// Ordem do protótipo aprovado (legenda, gráfico e tabelas): Entrada, Sistema externo, Hub, Configuração, Robô, Sem causa.
export const ERROR_CATEGORIES: readonly ErrorCategory[] = ['entrada', 'externo', 'hub', 'config', 'robo', 'sem'];

export const CATEGORY_INFO: Record<ErrorCategory, { label: string; summary: string; example: string; who: string; countsAgainstRobot: boolean }> = {
  entrada: {
    label: 'Entrada',
    summary: 'O dado que a pessoa enviou estava errado ou faltando.',
    example: 'Certificado vencido, planilha sem a coluna esperada, CPF ou senha recusados pelo portal.',
    who: 'Quem rodou o robô (orientação), não a Inovação.',
    countsAgainstRobot: true,
  },
  externo: {
    label: 'Sistema externo',
    summary: 'O portal ou site que o robô acessa falhou.',
    example: 'Portal com falha interna (HTTP 5xx), tempo esgotado esperando a tela, sessão já aberta no portal.',
    who: 'Ninguém em casa: normalmente esperar e tentar de novo.',
    countsAgainstRobot: true,
  },
  hub: {
    label: 'Hub',
    summary: 'O servidor do Hub interrompeu o robô.',
    example: 'O Hub foi reiniciado (atualização ou saída da sessão) durante a execução.',
    who: 'A Inovação, na infraestrutura. O robô não teve culpa.',
    countsAgainstRobot: false,
  },
  robo: {
    label: 'Robô',
    summary: 'A falha é do próprio robô: código ou jeito de usar o portal.',
    example:
      'Elemento não encontrado na tela, clique bloqueado por um pop-up, erro de programação não tratado e "travou: 45 min sem nenhuma saída" (o portal lento também pode causar; a correção é o robô escrever progresso e ter limite de espera).',
    who: 'A Inovação, corrigindo o robô.',
    countsAgainstRobot: true,
  },
  config: {
    label: 'Configuração',
    summary: 'Erro de cadastro do robô no Hub.',
    example: 'Comando ou pasta de execução errados ou ausentes.',
    who: 'A Inovação, em Configurações.',
    countsAgainstRobot: true,
  },
  sem: {
    label: 'Sem causa',
    summary: 'O robô falhou sem informar o motivo.',
    example: 'Código de saída 1 sem uma linha de erro (AH_LOG|error), ou processo encerrado à força.',
    who: 'A Inovação: o robô deve terminar com uma linha dizendo a causa e o que fazer.',
    countsAgainstRobot: true,
  },
};

export type ErrorCause = { category: ErrorCategory; cause: string; description: string; fallback: boolean };

type Rule = {
  cat: ErrorCategory;
  cause: string | ((message: string, match: RegExpMatchArray) => string);
  re: RegExp;
  d: string | ((message: string, match: RegExpMatchArray) => string);
};

const RULES: Rule[] = [
  { cat: 'hub', cause: 'Hub reiniciado durante a execução', re: /servidor do Hub foi reiniciado|Execução interrompida/i,
    d: 'O servidor do Hub reiniciou (atualização ou saída da sessão) e matou o robô. Se o robô salva o progresso, "Rodar novamente com a planilha final" continua de onde parou.' },
  { cat: 'config', cause: 'Robô sem comando configurado', re: /n[aã]o possui comando configurado/i,
    d: 'O cadastro do robô está sem comando ou pasta de execução. Corrigir em Configurações.' },
  { cat: 'config', cause: 'Hub não conseguiu iniciar o processo', re: /spawn .*ENOENT/i,
    d: 'O Windows não achou o programa ou a pasta do robô. Costuma ser pasta de execução errada ou ausente.' },
  { cat: 'robo', cause: 'Travou: sem nenhuma saída por muito tempo', re: /minutos sem nenhuma atividade/i,
    d: 'O vigia do Hub cancelou o robô por ficar sem escrever nada (45 minutos, por padrão). Normalmente uma tela esperando algo que não vem; também pode ser portal lento.' },
  { cat: 'externo', cause: 'Já há uma sessão aberta no portal', re: /j[aá] est[aá] logado/i,
    d: 'O portal (SEFAZ-CE) só aceita um login por usuário e já havia outra sessão aberta. Esperar ou encerrar a outra sessão.' },
  { cat: 'entrada', cause: 'Login recusado pelo portal (CPF ou senha)', re: /Login recusado|senha do contador/i,
    d: 'O portal recusou o acesso. Conferir CPF e senha informados.' },
  { cat: 'externo', cause: (m) => (/^HTTP 4/.test(m) ? 'Portal recusou o pedido (HTTP 4xx)' : 'Portal com falha interna (HTTP 5xx)'), re: /^HTTP [45]\d\d/i,
    d: 'O portal respondeu com erro HTTP. 4xx: o pedido está errado (CNPJ, período); 5xx: problema do lado do portal.' },
  { cat: 'externo', cause: 'Portal lento: tempo esgotado esperando a tela', re: /TimeoutException|timed out|ERR_|Connection/i,
    d: 'A tela esperada não apareceu a tempo. Portal lento ou fora do ar; tentar de novo mais tarde.' },
  { cat: 'externo', cause: 'Falha em ao menos um dos sites consultados', re: /falhas em pelo menos um site/i,
    d: 'O robô terminou, mas um dos sites falhou. Abrir o log para ver qual.' },
  { cat: 'entrada', cause: 'Nenhuma empresa sincronizada (sem certificado ou erro)', re: /Nenhuma empresa foi sincronizada/i,
    d: 'Todas as empresas da rodada falharam, por falta de certificado ou erro.' },
  { cat: 'entrada', cause: 'Certificado digital vencido', re: /VENCIDO/i,
    d: 'O certificado enviado está vencido. Renovar e enviar de novo.' },
  { cat: 'entrada', cause: 'CNPJ sem certificado digital na pasta', re: /SEM CERTIFICADO|n[aã]o existe certificado/i,
    d: 'Não há certificado desse CNPJ na pasta de certificados (filiais usam o da matriz).' },
  { cat: 'entrada', cause: 'Senha do certificado não abre o arquivo', re: /nenhuma senha abriu/i,
    d: 'O robô testou as senhas conhecidas e nenhuma abriu o certificado.' },
  { cat: 'entrada', cause: 'Nada para processar (lista de empresas vazia)', re: /Nenhuma empresa para processar/i,
    d: 'A execução não recebeu nenhuma empresa para trabalhar.' },
  { cat: 'entrada', cause: 'Empresa já sendo processada por outra execução', re: /j[aá] est[aá] sendo sincronizada por outra execu/i,
    d: 'Duas execuções pediram a mesma empresa ao mesmo tempo; o robô recusa a segunda.' },
  { cat: 'entrada', cause: 'Planilha sem a coluna esperada', re: /precisa ter uma coluna/i,
    d: 'A planilha enviada não tem a coluna que o robô lê. Conferir o modelo de exemplo.' },
  { cat: 'entrada', cause: 'Valor da planilha não é número (conversão de coluna)', re: /Unable to convert column/i,
    d: 'Uma coluna numérica tem texto ou valor fora do padrão. Conferir as células da planilha.' },
  { cat: 'entrada', cause: 'Arquivo fora do formato esperado (balancete)', re: /formatado\(s\)\. Com problema|N[aã]o achei nenhuma conta/i,
    d: 'O arquivo não tem as contas na primeira aba, no formato que o robô espera.' },
  { cat: 'entrada', cause: 'Chaves sem registro no portal (nada baixado)', re: /Nenhuma nota foi baixada|sem registro no portal/i,
    d: 'Nenhuma das chaves enviadas existe no portal. Conferir as chaves.' },
  { cat: 'entrada', cause: 'Tipo de documento não confere com as chaves', re: /Nenhuma chave é compat/i,
    d: 'O tipo escolhido (CF-e ou NFC-e) não bate com as chaves enviadas.' },
  { cat: 'robo', cause: 'Clique bloqueado por outro elemento da tela', re: /ElementClickIntercepted/i,
    d: 'Algo (aviso, pop-up, carregamento) cobriu o botão na hora do clique. Ajustar o robô para esperar ou fechar o aviso.' },
  { cat: 'robo', cause: 'Elemento não encontrado na tela', re: /Could not locate element|NoSuchElement|StaleElement/i,
    d: 'O texto ou botão que o robô procura não apareceu. O portal pode ter mudado de layout.' },
  { cat: 'robo', cause: 'Elemento esperado não existia (valor vazio no código)', re: /AttributeError: 'NoneType'/i,
    d: 'O robô tentou usar algo que não foi encontrado (None). Falta tratar o caso de a tela não carregar.' },
  { cat: 'robo', cause: 'Erro do navegador sem detalhe', re: /Erro inesperado: Message:\s*$/i,
    d: 'O Selenium falhou sem mensagem. Ver o log do robô.' },
  { cat: 'robo', cause: 'Exceção não tratada no robô', re: /AttributeError|KeyError|TypeError|ValueError|IndexError|Traceback|Error:|Exception/i,
    d: 'Erro de programação do robô, sem tratamento específico.' },
  {
    cat: 'sem',
    cause: (_m, x) => (x[1] === '1' ? 'Sem motivo informado (código de saída 1)' : x[1] === '3221225786' ? 'Processo encerrado à força (código 3221225786)' : `Sem motivo informado (código de saída ${x[1]})`),
    re: /Comando finalizado com codigo (-?\d+)/i,
    d: (_m, x) =>
      x[1] === '3221225786'
        ? 'O processo foi interrompido de fora (encerrado à força), não por erro do próprio robô.'
        : `O robô terminou com falha (código ${x[1]}) mas não escreveu o motivo (AH_LOG|error). O robô deveria terminar com uma linha de erro dizendo a causa e o que fazer.`,
  },
  { cat: 'sem', cause: 'Mensagem não reconhecida pelas regras', re: /[\s\S]*/, d: 'Há uma mensagem de erro que as regras ainda não conhecem.' },
];

const LAST_RULE = RULES[RULES.length - 1];

export function classifyError(message: string | null | undefined): ErrorCause {
  const text = String(message ?? '').trim();
  for (const rule of RULES) {
    const match = text.match(rule.re);
    if (match) {
      return {
        category: rule.cat,
        cause: typeof rule.cause === 'function' ? rule.cause(text, match) : rule.cause,
        description: typeof rule.d === 'function' ? rule.d(text, match) : rule.d,
        fallback: rule === LAST_RULE,
      };
    }
  }
  return { category: 'sem', cause: LAST_RULE.cause as string, description: LAST_RULE.d as string, fallback: true };
}
