// No Windows, todo processo de console que o hub inicia (robôs, painéis, taskkill...) abre uma janela de prompt (cmd) na
// sessão do servidor — dez painéis rodando = dez janelas na tela de quem está usando a máquina. `windowsHide` pede ao
// Windows para não criar a janela; o processo e os filhos dele (python, chromedriver...) rodam normalmente, só que sem
// aparecer. Janelas de aplicativos de verdade (o Chrome de um robô com "mostrar navegador", o Excel) NÃO são afetadas.
//
// Para ver as janelas de novo (depurar um robô que precise de console), defina HUB_SHOW_CONSOLES=true no .env da API e
// reinicie o hub.
export const WINDOWS_HIDE = process.env.HUB_SHOW_CONSOLES !== 'true';
