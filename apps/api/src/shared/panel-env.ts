// Ambiente dos processos dos painéis (o hub os inicia e eles herdam o ambiente dele).

/** Variável do SDK openai-agents: com "1" ele NÃO envia o rastreamento (traces) à OpenAI. */
export const TRACING_ENV = 'OPENAI_AGENTS_DISABLE_TRACING';

/**
 * Ambiente de um painel: o do hub, com o rastreamento da OpenAI desligado — a menos que o painel tenha
 * `aiTracing` ligado nas configurações (aí a variável é retirada e vale o padrão do SDK, que é enviar).
 */
export function panelProcessEnv(aiTracing: boolean | null | undefined, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  // no Windows o nome das variáveis não diferencia maiúsculas de minúsculas
  for (const nome of Object.keys(env)) {
    if (nome.toUpperCase() === TRACING_ENV) delete env[nome];
  }
  if (!aiTracing) env[TRACING_ENV] = '1';
  return env;
}
