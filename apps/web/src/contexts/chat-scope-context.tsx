import { createContext, useContext, useMemo, useState, type PropsWithChildren } from 'react';
import type { PanelScreenContext } from '../lib/panel-screen-context';

// O que está aberto em tela cheia ("Ver") e tem chat de IA próprio: enquanto
// isso vale, o chat do hub manda as perguntas pro chat de IA do painel. Fora
// disso (null) o chat é o normal do hub.
//  - BI vinculado a um painel: `siteId`.
//  - Painel aberto direto: `dashboardId` (+ `getScreenContext`, pra ler os filtros da tela).
export type BiScope = {
  siteId?: string;
  dashboardId?: string;
  name: string;
  getScreenContext?: () => PanelScreenContext | null;
  // Qual conversa mostrar: cada painel tem a sua ("dash:<id do painel>"),
  // separada do chat do hub ("hub", quando não há escopo).
  conversationScope: string;
};

type ChatScopeValue = {
  biScope: BiScope | null;
  setBiScope: (scope: BiScope | null) => void;
};

const noop: ChatScopeValue = { biScope: null, setBiScope: () => undefined };
const ChatScopeContext = createContext<ChatScopeValue>(noop);

export function ChatScopeProvider({ children }: PropsWithChildren) {
  const [biScope, setBiScope] = useState<BiScope | null>(null);
  const value = useMemo(() => ({ biScope, setBiScope }), [biScope]);
  return <ChatScopeContext.Provider value={value}>{children}</ChatScopeContext.Provider>;
}

export function useChatScope() {
  return useContext(ChatScopeContext);
}
