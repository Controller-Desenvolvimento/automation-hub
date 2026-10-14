// Mascote do widget de chat: o "João", fixo pra todo mundo (não há mais escolha).
// Os frames ficam em public/mascots/joao/mascot-<modo>-<n>.png (256px de altura), gerados
// de 8 imagens com fundo magenta (uma por animação): o fundo é removido, cada quadro é
// alinhado pelo centro de massa/pés e a corrida pra esquerda é o espelho da direita.
// Modos: waiting (parado), idle (atento, com dica), running (arrastando), jumping (soltou),
// waving (acena), failed (triste e senta, ao ocultar), review (pensando, respondendo) e
// tablet (mexendo no tablet, com painel/BI aberto). As contagens vivem em MASCOT_ANIMATIONS,
// no site-chat-widget.
// A coluna User.mascotSkin do banco ficou sem uso (não vale a migração pra tirar).
// (Esta linha foi o teste do auto deploy do frontend: compilou e trocou a dist sem reiniciar o servidor.)
export type MascotSkinId = 'joao';

export const MASCOT_SKIN: MascotSkinId = 'joao';

// Cor de destaque (bolinha de "mostrar assistente" e balão de dica), tirada do
// amarelo da farda. Escura o bastante pra texto branco (contraste ~5:1).
export const MASCOT_ACCENT = '#b45309';

