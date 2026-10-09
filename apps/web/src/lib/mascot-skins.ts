// Mascotes disponíveis pro widget de chat. Os frames de cada um ficam em
// public/mascots/<id>/mascot-<modo>-<n>.png (extraídos das spritesheets
// originais — ver scripts usados na sessão em que foram adicionados).
// "idleFrames" varia por mascote (6 ou 7, dependendo da versão da
// spritesheet de origem) — todos os outros modos têm sempre a mesma
// contagem de frames entre mascotes.
export type MascotSkinId =
  | 'midas'
  | 'clankers-bubble'
  | 'clankers-chef'
  | 'clankers-glitch'
  | 'clankers-patch'
  | 'clankers-sprocket'
  | 'clankers-tank'
  | 'clankers-titan'
  | 'clankers-wisp'
  | 'clankers-zippy';

export interface MascotSkin {
  id: MascotSkinId;
  label: string;
  idleFrames: number;
  // Cor de destaque (bolinha de "mostrar assistente" e balão de dica), tirada
  // da cor dominante do mascote. Todas escuras o bastante pra texto branco.
  accent: string;
}

export const MASCOT_SKINS: MascotSkin[] = [
  { id: 'midas', label: 'Midas', idleFrames: 6, accent: '#f97316' },
  { id: 'clankers-bubble', label: 'Bubble', idleFrames: 7, accent: '#cc5875' },
  { id: 'clankers-chef', label: 'Chef', idleFrames: 6, accent: '#bd2d23' },
  { id: 'clankers-glitch', label: 'Glitch', idleFrames: 7, accent: '#532e98' },
  { id: 'clankers-patch', label: 'Patch', idleFrames: 6, accent: '#40997b' },
  { id: 'clankers-sprocket', label: 'Sprocket', idleFrames: 7, accent: '#52773b' },
  { id: 'clankers-tank', label: 'Tank', idleFrames: 6, accent: '#1961b7' },
  { id: 'clankers-titan', label: 'Titan', idleFrames: 7, accent: '#a82c1f' },
  { id: 'clankers-wisp', label: 'Wisp', idleFrames: 6, accent: '#9756c2' },
  { id: 'clankers-zippy', label: 'Zippy', idleFrames: 7, accent: '#c92e23' },
];

const SKIN_IDS = new Set<string>(MASCOT_SKINS.map((s) => s.id));

export function isMascotSkinId(value: string | null | undefined): value is MascotSkinId {
  return !!value && SKIN_IDS.has(value);
}

export function mascotSkinOrDefault(value: string | null | undefined): MascotSkinId {
  return isMascotSkinId(value) ? value : 'midas';
}

export function mascotIdleFrames(skin: MascotSkinId): number {
  return MASCOT_SKINS.find((s) => s.id === skin)?.idleFrames ?? 6;
}

export function mascotAccent(skin: MascotSkinId): string {
  return MASCOT_SKINS.find((s) => s.id === skin)?.accent ?? '#f97316';
}
