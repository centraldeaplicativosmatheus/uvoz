/**
 * Servidor simulado para ver o widget funcionando sem o UVoz por trás.
 * Só é carregado quando frame.html recebe ?demo=<cenário>:
 *   1         conversa vazia (boas-vindas)
 *   conversa  conversa em andamento
 *   resposta  conversa em andamento e uma resposta nova chegando com o chat fechado
 *   offline   equipe fora do horário
 */
window.UVozDemoTransport = function demoTransport(_config, scenario) {
  'use strict';
  const handlers = new Map();
  const fire = (event, payload) => (handlers.get(event) || []).forEach((fn) => fn(payload));
  const agent = { name: 'Ana' };
  const files = new Map();
  let nextId = 100;
  let replyIndex = 0;

  const minutesAgo = (n) => Date.now() - n * 60 * 1000;
  const history = [
    { id: 1, from: 'contact', author: null, text: 'Bom dia! Fiz um saque ontem à tarde e ele ainda não caiu na minha conta.', ts: minutesAgo(1500), attachments: [] },
    { id: 2, from: 'agent', author: agent, text: 'Bom dia! Vou verificar agora mesmo.', ts: minutesAgo(1497), attachments: [] },
    { id: 3, from: 'agent', author: agent, text: 'O saque foi aprovado e segue para o banco no próximo lote, hoje às 14h.', ts: minutesAgo(1496), attachments: [] },
    { id: 4, from: 'contact', author: null, text: 'Perfeito, obrigado!', ts: minutesAgo(1490), attachments: [] },
    { id: 5, from: 'system', author: null, text: 'Atendimento encerrado', ts: minutesAgo(1480), attachments: [] },
    { id: 6, from: 'contact', author: null, text: 'Oi, consigo alterar a conta bancária que recebe os saques?', ts: minutesAgo(6), attachments: [] },
    { id: 7, from: 'agent', author: agent, text: 'Consegue, sim. A troca é feita em Configurações > Dados bancários.', ts: minutesAgo(4), attachments: [] },
    { id: 8, from: 'agent', author: agent, text: 'A nova conta precisa estar no mesmo CNPJ do cadastro. Passo a passo: https://ajuda.exemplo.com/dados-bancarios', ts: minutesAgo(4), attachments: [] },
    { id: 9, from: 'contact', author: null, text: 'Entendi. E quanto tempo leva para valer?', ts: minutesAgo(2), attachments: [] },
  ];
  const replies = [
    'A alteração vale para os saques pedidos a partir do dia seguinte.',
    'Posso ajudar em mais alguma coisa?',
    'Certo! Qualquer dúvida, é só escrever por aqui.',
  ];

  function agentReply(text, delay) {
    setTimeout(() => fire('typing', { name: agent.name }), delay);
    setTimeout(() => fire('message:new', {
      id: nextId++, from: 'agent', author: agent, text, ts: Date.now(), attachments: [],
    }), delay + 1800);
  }

  return {
    on(event, fn) { handlers.set(event, [...(handlers.get(event) || []), fn]); },

    start() {
      const online = scenario !== 'offline';
      const withHistory = scenario === 'conversa' || scenario === 'resposta';
      setTimeout(() => {
        fire('status', { connected: true });
        fire('init', {
          contact: { name: 'Marina Souza' },
          team: { name: 'Suporte Unicopag', online, hours: online ? null : 'Respondemos de segunda a sexta, das 9h às 18h' },
          topics: ['Saques', 'Vendas e cobranças', 'Minha conta', 'Outro assunto'],
          features: { attachments: true },
          messages: withHistory ? history : [],
          hasMore: false,
          lastReadId: withHistory ? 9 : 0,
        });
        if (scenario === 'resposta') agentReply(replies[replyIndex++], 600);
      }, 250);
    },

    setToken() {},

    request(event, payload) {
      return new Promise((resolve) => {
        if (event !== 'message:send') return resolve({ messages: [], hasMore: false });
        setTimeout(() => {
          resolve({
            message: {
              id: nextId++, from: 'contact', author: null, text: payload.text, ts: Date.now(), clientId: payload.clientId,
              attachments: payload.attachmentIds.map((id) => ({ id, ...files.get(id).meta })),
            },
          });
          if (scenario === 'offline') {
            setTimeout(() => fire('message:new', {
              id: nextId++, from: 'system', author: null, ts: Date.now(), attachments: [],
              text: 'Recebemos sua mensagem. Respondemos no próximo dia útil, a partir das 9h.',
            }), 500);
          } else {
            agentReply(replies[replyIndex++ % replies.length], 900);
          }
        }, 350);
      });
    },

    notify() {},

    upload(file) {
      const id = `demo-${nextId++}`;
      files.set(id, { blob: file, meta: { name: file.name, size: file.size, type: file.type } });
      return new Promise((resolve) => setTimeout(() => resolve({ id, name: file.name, size: file.size, type: file.type }), 300));
    },

    fileBlob(attachment) {
      const stored = files.get(attachment.id);
      return stored ? Promise.resolve(stored.blob) : Promise.reject(new Error('Arquivo indisponível.'));
    },
  };
};
