// Motivo mostrado na tela quando o robô termina com erro (código de saída diferente de 0).
//
// Antes aparecia só "Comando finalizado com codigo 1", mesmo quando o robô tinha escrito a causa no log
// ("Nenhum certificado do CNPJ ... na pasta"). Agora vale, nesta ordem:
//  1. a última linha de erro que o próprio robô declarou (AH_LOG|error|...): é a explicação que ele quis dar;
//  2. a linha final de uma exceção do Python (ex.: "KeyError: 'empresas'"), que o traceback imprime por último;
//  3. o genérico, só com o código de saída.

const MAX_LENGTH = 400;
const PYTHON_EXCEPTION_LINE = /^[A-Za-z_][\w.]*(?:Error|Exception)(?::|$)/;

export function cleanReason(text: string): string {
  // tira os símbolos de log que alguns robôs põem no começo da linha ("✗ ", "! ", "▶ "): na tela vira "Erro: <motivo>"
  const oneLine = text.replace(/\s+/g, ' ').trim().replace(/^(?:[✗✓▶▸]\s*|!\s+)+/u, '');
  return oneLine.length > MAX_LENGTH ? `${oneLine.slice(0, MAX_LENGTH - 1)}…` : oneLine;
}

/** A linha da saída de erro é o fim de um traceback do Python? */
export function isPythonExceptionLine(line: string): boolean {
  return PYTHON_EXCEPTION_LINE.test(line.trim());
}

export function failureReason(code: number | null, robotError?: string, pythonException?: string): string {
  const own = robotError ? cleanReason(robotError) : '';
  if (own) return own;
  const exception = pythonException ? cleanReason(pythonException) : '';
  if (exception) return exception;
  return `Comando finalizado com codigo ${code ?? 'desconhecido'}`;
}
