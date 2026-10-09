// Mascotes disponíveis pro widget de chat (sprite sheets em apps/web/public/mascots/<id>/).
// Lista espelhada no frontend (lib/mascot-skins.ts) — só pra validar o valor
// recebido do cliente antes de gravar no banco.
export const MASCOT_SKIN_IDS = [
  'midas',
  'clankers-bubble',
  'clankers-chef',
  'clankers-glitch',
  'clankers-patch',
  'clankers-sprocket',
  'clankers-tank',
  'clankers-titan',
  'clankers-wisp',
  'clankers-zippy',
] as const;

export type MascotSkinId = (typeof MASCOT_SKIN_IDS)[number];

export function isValidMascotSkin(value: unknown): value is MascotSkinId {
  return typeof value === 'string' && (MASCOT_SKIN_IDS as readonly string[]).includes(value);
}
