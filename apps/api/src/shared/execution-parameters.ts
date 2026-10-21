import type { User } from '@prisma/client';
import { isAdmin } from './access';

// Parâmetros que o usuário digitou ao rodar a automação (empresa, tipo, CPF, senha...), guardados em Execution.inputJson.
//
// Regras de exibição:
// - O DETALHE da execução mostra todos os parâmetros, inclusive senhas, para quem executou e para administradores
//   (é o que permite achar "a senha estava errada" sem ligar para o suporte).
// - Outros usuários que conseguem abrir a execução (gestor do departamento, destinatário de execução agendada) veem os
//   parâmetros SEM os campos de senha.
// - Listas (histórico, resultados, tela inicial) nunca levam parâmetros: não usam e eram um vazamento à toa.
// O valor completo continua no banco: "rodar novamente" precisa dele.

const SECRET_NAME_RE = /senha|password|passwd|secret|segredo|token/i;

type SchemaLike = { fields?: Array<{ name?: unknown; type?: unknown } | null> } | null | undefined;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Nomes dos parâmetros que são segredo: campos "password" do formulário do robô ou nome que lembra senha/token. */
export function secretParameterNames(schema: unknown, parameters: Record<string, unknown>): string[] {
  const fields = Array.isArray((schema as SchemaLike)?.fields) ? ((schema as SchemaLike)!.fields ?? []) : [];
  const declared = new Set(
    fields.filter((f) => f && f.type === 'password' && typeof f.name === 'string').map((f) => f!.name as string),
  );
  return Object.keys(parameters).filter((name) => declared.has(name) || SECRET_NAME_RE.test(name));
}

/** Quem executou ou administrador (inclui o time de Inovação) vê as senhas. */
export function canSeeSecretParameters(
  viewer: Pick<User, 'id' | 'role' | 'departments'>,
  execution: { userId: string | null },
) {
  return isAdmin(viewer) || (!!execution.userId && execution.userId === viewer.id);
}

/** Parâmetros no formato em que `viewer` pode vê-los, e a lista dos que foram escondidos dele. */
export function parametersForViewer(
  execution: { userId: string | null; inputJson: unknown; robot?: { schema?: unknown } | null },
  viewer: Pick<User, 'id' | 'role' | 'departments'>,
): { inputJson: Record<string, unknown>; hiddenParameters: string[] } {
  const parameters = asRecord(execution.inputJson);
  if (canSeeSecretParameters(viewer, execution)) {
    return { inputJson: parameters, hiddenParameters: [] };
  }
  const hidden = secretParameterNames(execution.robot?.schema, parameters);
  const visible = Object.fromEntries(Object.entries(parameters).filter(([name]) => !hidden.includes(name)));
  return { inputJson: visible, hiddenParameters: hidden };
}

/** Linha de execução sem os parâmetros — para listas e respostas que não precisam deles. */
export function withoutParameters<T extends { inputJson?: unknown }>(row: T): Omit<T, 'inputJson'> {
  const { inputJson: _omitted, ...rest } = row;
  return rest;
}
