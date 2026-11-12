// Mensagem gravada numa execucao que estava rodando quando o Hub reiniciou (ver ExecutionRunnerService).
// O verificador por tempo reconhece esse prefixo para refazer UMA vez a execucao agendada interrompida.
export const INTERRUPTED_PREFIX = 'Execução interrompida: o servidor do Hub foi reiniciado';
export const INTERRUPTED_BY_RESTART_MESSAGE =
  `${INTERRUPTED_PREFIX} enquanto esta automação rodava. Se o robô salva progresso incrementalmente, os arquivos de saída já gerados foram recuperados — confira antes de reiniciar do zero.`;
