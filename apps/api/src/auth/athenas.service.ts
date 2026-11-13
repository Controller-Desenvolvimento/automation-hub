import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ATHENAS_NAME_SELECT, describeRawName, readAthenasName } from '../shared/athenas-identity';

// node-firebird is a CJS module without bundled types
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Firebird = require('node-firebird') as {
  attach: (options: Record<string, unknown>, cb: (err: Error | null, db: FirebirdDb) => void) => void;
};

interface FirebirdDb {
  query: (sql: string, params: unknown[], cb: (err: Error | null, rows: Record<string, unknown>[]) => void) => void;
  detach: () => void;
}

@Injectable()
export class AthenasService {
  private readonly logger = new Logger(AthenasService.name);

  private readonly enabled: boolean;
  private readonly options: Record<string, unknown>;
  private readonly userTable: string;
  private readonly loginCol: string;
  private readonly senhaCol: string;
  private readonly inativoCol: string;
  private readonly senhaFmt: string;

  constructor() {
    this.enabled =
      (process.env.ATHENAS_AUTH ?? 'off').trim().toLowerCase() === 'on';

    this.options = {
      host: process.env.ATHENAS_HOST ?? '10.100.1.15',
      port: Number(process.env.ATHENAS_PORT ?? '3050'),
      database: process.env.ATHENAS_DATABASE ?? '',
      user: process.env.ATHENAS_USER ?? 'SYSDBA',
      password: process.env.ATHENAS_PASSWORD ?? '',
      lowercase_keys: false,
      role: null,
      pageSize: 4096,
      charset: process.env.ATHENAS_CHARSET ?? 'WIN1252',
    };

    this.userTable =
      process.env.ATHENAS_USER_TABLE ?? 'TABCADUSUARIOS';
    this.loginCol =
      process.env.ATHENAS_USER_LOGIN_COL ?? 'NOMEACESSO';
    this.senhaCol =
      process.env.ATHENAS_USER_SENHA_COL ?? 'SENHA';
    this.inativoCol =
      process.env.ATHENAS_USER_INATIVO_COL ?? 'INATIVO';
    this.senhaFmt = (
      process.env.ATHENAS_SENHA_FORMATO ?? 'texto'
    )
      .trim()
      .toLowerCase();

    if (this.enabled) {
      this.logger.log(
        `Athenas auth habilitado → ${this.options.host as string}:${this.options.port as number} ${this.options.database as string}`,
      );
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Autentica um login contra o Athenas (Firebird).
   * Retorna true somente se credenciais corretas e usuário ativo.
   * Nunca lança exceção — falha vira false (Athenas down = sem acesso, não bypass).
   */
  /**
   * Autentica login contra o Athenas e retorna nome real do usuário.
   * Nunca lança exceção — falha vira { ok: false }.
   */
  async authenticate(login: string, password: string): Promise<{ ok: boolean; nome?: string }> {
    if (!this.enabled) return { ok: false };

    const normalizedLogin = login.trim().toUpperCase();

    return new Promise((resolve) => {
      Firebird.attach(this.options, (connErr, db) => {
        if (connErr) {
          this.logger.warn(`Athenas: falha de conexão — ${connErr.message}`);
          resolve({ ok: false });
          return;
        }

        const nomeCol = 'NOME';
        const cols = [this.senhaCol, ATHENAS_NAME_SELECT, ...(this.inativoCol ? [this.inativoCol] : [])].join(', ');
        const sql = `SELECT ${cols} FROM ${this.userTable} WHERE UPPER(TRIM(${this.loginCol})) = ?`;

        db.query(sql, [normalizedLogin], (qErr, rows) => {
          db.detach();

          if (qErr) {
            this.logger.error(
              `Athenas: falha na consulta (${this.userTable}.${this.loginCol}) — ${qErr.message}. ` +
              `Ajuste ATHENAS_USER_TABLE / ATHENAS_USER_*_COL conforme o schema real.`,
            );
            resolve({ ok: false });
            return;
          }

          const row = rows?.[0];
          if (!row) { resolve({ ok: false }); return; }

          if (this.inativoCol) {
            const inativo = String(row[this.inativoCol] ?? '').trim().toUpperCase();
            if (['1', 'S', 'SIM', 'T', 'TRUE', 'Y'].includes(inativo)) {
              resolve({ ok: false });
              return;
            }
          }

          const stored = String(row[this.senhaCol] ?? '').trim();
          if (!this.checkPassword(password, stored)) { resolve({ ok: false }); return; }

          const rawNome = row[nomeCol];
          const nome = readAthenasName(rawNome);
          if (nome?.includes('�')) {
            // Diagnóstico da causa (só os caracteres/bytes fora do ASCII, nunca o nome inteiro).
            this.logger.warn(
              `Athenas: nome de ${normalizedLogin} chegou com U+FFFD. Recebido como ${describeRawName(rawNome)}.`,
            );
          }
          resolve({ ok: true, nome });
        });
      });
    });
  }

  /**
   * Consulta somente o nome de um usuário ativo. Não valida senha, não cria
   * sessão e não concede qualquer permissão no HUB.
   */
  async findActiveUserName(login: string): Promise<string | undefined> {
    if (!this.enabled) return undefined;

    const normalizedLogin = login.trim().toUpperCase();
    if (!normalizedLogin) return undefined;

    return new Promise((resolve) => {
      Firebird.attach(this.options, (connErr, db) => {
        if (connErr) {
          this.logger.warn(`Athenas: falha de conexão — ${connErr.message}`);
          resolve(undefined);
          return;
        }

        const nomeCol = 'NOME';
        const cols = [ATHENAS_NAME_SELECT, ...(this.inativoCol ? [this.inativoCol] : [])].join(', ');
        const sql = `SELECT ${cols} FROM ${this.userTable} WHERE UPPER(TRIM(${this.loginCol})) = ?`;

        db.query(sql, [normalizedLogin], (qErr, rows) => {
          db.detach();

          if (qErr) {
            this.logger.error(
              `Athenas: falha ao consultar nome (${this.userTable}.${this.loginCol}) — ${qErr.message}.`,
            );
            resolve(undefined);
            return;
          }

          const row = rows?.[0];
          if (!row || isInactiveAthenasUser(row, this.inativoCol)) {
            resolve(undefined);
            return;
          }

          resolve(readAthenasName(row[nomeCol]));
        });
      });
    });
  }

  private checkPassword(given: string, stored: string): boolean {
    if (['md5', 'sha1', 'sha256'].includes(this.senhaFmt)) {
      const calc = createHash(this.senhaFmt)
        .update(given, 'utf8')
        .digest('hex');
      return calc.toLowerCase() === stored.toLowerCase();
    }
    // 'texto': comparação direta (padrão Athenas3000)
    return given === stored;
  }
}

function isInactiveAthenasUser(row: Record<string, unknown>, inactiveColumn: string) {
  if (!inactiveColumn) return false;
  const value = String(row[inactiveColumn] ?? '').trim().toUpperCase();
  return ['1', 'S', 'SIM', 'T', 'TRUE', 'Y'].includes(value);
}
