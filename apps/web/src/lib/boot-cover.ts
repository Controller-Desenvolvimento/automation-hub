// Cobertura de "Carregando..." criada pelo index.html quando a página abre direto
// num painel (F5 / link). Some assim que o React assume a tela.
export function removeBootCover() {
  document.getElementById('boot-cover')?.remove();
}
