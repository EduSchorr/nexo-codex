'use strict';

const $ = id => document.getElementById(id);
const state = {
  token: '',
  connected: false,
  thread: null,
  threads: [],
  cursor: null,
  seq: 0,
  active: new Map(),
  items: new Map(),
  mode: localStorage.getItem('preferredMode') || 'chat',
  models: [],
  account: null,
  limits: null,
  attachments: [],
  personalFolders: {},
  home: '',
  autonomy: false,
  pendingRequests: [],
  favorites: new Set(JSON.parse(localStorage.getItem('nexoFavorites') || '[]')),
  archived: new Set(JSON.parse(localStorage.getItem('nexoArchived') || '[]')),
  filter: 'all'
};

const welcome = $('welcome').cloneNode(true);

function el(tag, text, cls) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (cls) node.className = cls;
  return node;
}

function fail(error) {
  $('error').textContent = error?.message || String(error);
  $('error').hidden = false;
}

function clearError() {
  $('error').hidden = true;
}

async function api(path, data) {
  const response = await fetch(path, {
    method: data ? 'POST' : 'GET',
    headers: {
      'Content-Type': 'application/json',
      'X-Local-Token': state.token
    },
    ...(data ? {body: JSON.stringify(data)} : {})
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Falha na conexão.');
  return result;
}

const rpc = (method, params = {}) => api('/api/rpc', {method, params});
const threadTitle = t => t?.name || t?.preview || 'Conversa sem título';

function saveCollections() {
  localStorage.setItem('nexoFavorites', JSON.stringify([...state.favorites]));
  localStorage.setItem('nexoArchived', JSON.stringify([...state.archived]));
  renderThreads();
}

function setMode(mode) {
  state.mode = mode;
  localStorage.setItem('preferredMode', mode);
  document.querySelectorAll('[data-compose-mode]').forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.composeMode === mode));
  });
  $('mode-explain').textContent = mode === 'chat'
    ? 'Somente leitura · sem editar arquivos'
    : 'Work · escrita em pastas pessoais autorizadas';
  $('subtitle').textContent = state.thread
    ? (mode === 'chat' ? 'Conversa · somente leitura' : 'Work · espaço de trabalho local')
    : 'Seu assistente, conectado ao computador';
  updateRoutePreview();
}

function setAutonomy(enabled) {
  state.autonomy = enabled;
  $('autonomy').setAttribute('aria-pressed', String(enabled));
  $('autonomy').innerHTML = enabled ? '◆ <span>Autonomia ativa</span>' : '◇ <span>Ativar autonomia</span>';
  $('autonomy-banner').hidden = !enabled;
  handleRequests(state.pendingRequests);
}

function updatePower() {
  $('power').classList.toggle('is-off', !state.connected);
  $('power').classList.toggle('is-on', state.connected);
  $('power').setAttribute('aria-pressed', String(state.connected));
  $('power-label').textContent = state.connected ? 'Nexo ligado' : 'Nexo desligado';
  $('connection').textContent = state.connected ? '● Nexo pronto neste computador' : '○ Nexo desligado';
}

function updateControls() {
  const active = state.thread && state.active.has(state.thread.id);
  $('send').disabled = !state.connected;
  $('stop').hidden = !active;
  $('rename').disabled = !state.thread;
  $('export').disabled = !state.thread;
  $('rename-mobile').disabled = !state.thread;
  $('export-mobile').disabled = !state.thread;
  updatePower();
  setMode(state.mode);
}

const effortLabels = {low:'Leve', medium:'Médio', high:'Alto', xhigh:'Muito alto', max:'Máximo'};

function complexityScore() {
  const text = $('prompt').value.trim();
  const words = text.split(/\s+/).filter(Boolean).length;
  let score = words > 500 ? 3 : words > 180 ? 2 : words > 60 ? 1 : 0;
  if (/\b(arquitetura|refator|debug|auditoria|seguran[cç]a|implemente|migra|otimize|investigue|banco de dados|api)\b/i.test(text)) score += 2;
  else if (/\b(crie|corrija|explique|resuma|revise|c[oó]digo|arquivo|documento)\b/i.test(text)) score += 1;
  if (state.mode === 'work') score += 1;
  score += Math.min(2, state.attachments.length);
  return Math.min(6, score);
}

function modelByHint(hint) {
  const find = name => state.models.find(m => (m.model + ' ' + (m.displayName || '')).toLowerCase().includes(name));
  if (hint === 'economy') return find('luna') || state.models.find(m => m.isDefault) || state.models[0];
  if (hint === 'strong') return find('sol') || find('astra') || state.models.find(m => m.isDefault) || state.models[0];
  return state.models.find(m => m.isDefault) || find('sol') || state.models[0];
}

function routeForMessage() {
  const selected = $('model').value;
  const score = complexityScore();
  let model = selected === 'default' ? null : state.models.find(m => m.model === selected);

  if (selected === 'auto') {
    model = score <= 1 ? modelByHint('economy') : score >= 4 ? modelByHint('strong') : modelByHint('default');
  }

  let effort = $('effort').value;
  if (effort === 'auto') effort = score <= 1 ? 'low' : score <= 3 ? 'medium' : 'high';

  const supported = model?.supportedReasoningEfforts?.map(x => x.reasoningEffort) || [];
  if (supported.length && !supported.includes(effort)) effort = supported.includes('medium') ? 'medium' : supported[0];

  return {model, effort, automatic: selected === 'auto'};
}

function updateRoutePreview() {
  if (!$('route-preview')) return;
  if (!state.connected) {
    $('route-preview').textContent = 'Nexo desligado';
    return;
  }
  const route = routeForMessage();
  const modelLabel = route.model?.displayName || 'Padrão da conta';
  $('route-preview').textContent = (route.automatic ? 'Automático → ' : 'Manual → ') +
    modelLabel + ' · ' + (effortLabels[route.effort] || route.effort || 'padrão');
}

async function loadModels() {
  const result = await rpc('model/list', {limit: 100});
  state.models = (result.data || []).filter(model => !model.hidden);
  const previous = localStorage.getItem('nexoModel') || 'auto';
  $('model').replaceChildren();

  for (const [value, label] of [['auto','Automático · econômico'], ['default','Padrão da conta']]) {
    const option = el('option', label);
    option.value = value;
    $('model').append(option);
  }
  for (const model of state.models) {
    const option = el('option', model.displayName || model.model);
    option.value = model.model;
    $('model').append(option);
  }
  $('model').value = [...$('model').options].some(o => o.value === previous) ? previous : 'auto';
  updateEfforts();
}

function updateEfforts() {
  const selected = $('model').value;
  const model = state.models.find(m => m.model === selected) || state.models.find(m => m.isDefault);
  const previous = localStorage.getItem('nexoEffort') || 'auto';
  $('effort').replaceChildren();

  const automatic = el('option', 'Raciocínio automático');
  automatic.value = 'auto';
  $('effort').append(automatic);

  for (const item of model?.supportedReasoningEfforts || []) {
    const option = el('option', effortLabels[item.reasoningEffort] || item.reasoningEffort);
    option.value = item.reasoningEffort;
    $('effort').append(option);
  }

  if ([...$('effort').options].some(o => o.value === previous)) $('effort').value = previous;
  updateRoutePreview();
}

function itemText(item) {
  return item?.text || (item?.content || []).map(part => part.text || (part.type === 'image' ? '[Imagem]' : '')).join('\n');
}

function addMessage(id, role, text) {
  state.items.set(id, {id, role, text});
  let node = document.querySelector('[data-message-id="' + CSS.escape(id) + '"]');
  if (!node) {
    node = el('article', undefined, 'message ' + role);
    node.dataset.messageId = id;
    const label = el('small', role === 'user' ? 'VOCÊ' : 'NEXO', 'message-label');
    const content = el('div', undefined, 'content');
    node.append(label, content);
    $('messages').append(node);
  }
  node.querySelector('.content').textContent = text;
  $('messages').scrollTop = $('messages').scrollHeight;
}

function renderItem(item) {
  if (!item?.id) return;
  if (item.type === 'userMessage') return addMessage(item.id, 'user', itemText(item));
  if (item.type === 'agentMessage') return addMessage(item.id, 'assistant', itemText(item));

  if (['commandExecution','fileChange','webSearch','plan','mcpToolCall','dynamicToolCall'].includes(item.type)) {
    let node = document.querySelector('[data-work-id="' + CSS.escape(item.id) + '"]');
    if (!node) {
      node = el('details', undefined, 'work-item');
      node.dataset.workId = item.id;
      node.append(el('summary', item.type));
      node.append(el('pre'));
      $('messages').append(node);
    }
    node.querySelector('pre').textContent = item.command || item.text || JSON.stringify(item, null, 2);
  }
}

function renderThread(thread) {
  state.thread = thread;
  state.items.clear();
  $('messages').replaceChildren();
  $('title').textContent = threadTitle(thread);

  for (const turn of thread.turns || []) {
    for (const item of turn.items || []) renderItem(item);
  }

  if (!$('messages').children.length) $('messages').append(welcome.cloneNode(true));
  updateControls();
}

function renderThreads() {
  const q = $('search').value.trim().toLocaleLowerCase('pt-BR');
  let threads = state.threads.filter(t => !q || threadTitle(t).toLocaleLowerCase('pt-BR').includes(q));

  if (state.filter === 'favorites') threads = threads.filter(t => state.favorites.has(t.id));
  if (state.filter === 'archived') threads = threads.filter(t => state.archived.has(t.id));
  if (state.filter === 'all') threads = threads.filter(t => !state.archived.has(t.id));

  $('threads').replaceChildren();

  for (const thread of threads) {
    const row = el('div', undefined, 'thread-row');
    const open = el('button', undefined, 'thread');
    open.append(el('strong', threadTitle(thread)), el('small', thread.updatedAt ? new Date(thread.updatedAt).toLocaleDateString('pt-BR') : ''));
    open.onclick = () => openThread(thread.id).catch(fail);

    const fav = el('button', state.favorites.has(thread.id) ? '★' : '☆', 'thread-icon');
    fav.title = 'Favoritar';
    fav.onclick = () => {
      state.favorites.has(thread.id) ? state.favorites.delete(thread.id) : state.favorites.add(thread.id);
      saveCollections();
    };

    const archive = el('button', state.archived.has(thread.id) ? '↩' : '⌑', 'thread-icon');
    archive.title = state.archived.has(thread.id) ? 'Retirar do arquivo' : 'Arquivar localmente';
    archive.onclick = () => {
      state.archived.has(thread.id) ? state.archived.delete(thread.id) : state.archived.add(thread.id);
      saveCollections();
    };

    row.append(open, fav, archive);
    $('threads').append(row);
  }

  if (!threads.length) $('threads').append(el('p', 'Nenhuma conversa encontrada.', 'empty'));
  $('more').hidden = !state.cursor;
}

async function list(more = false) {
  const result = await rpc('thread/list', {
    limit: 50,
    sortKey: 'updated_at',
    modelProviders: [],
    ...(more && state.cursor ? {cursor: state.cursor} : {})
  });
  state.threads = more ? [...state.threads, ...(result.data || [])] : (result.data || []);
  state.cursor = result.nextCursor || null;
  renderThreads();
}

async function openThread(id) {
  clearError();
  $('activity').textContent = 'Carregando conversa…';
  const result = await rpc('thread/read', {threadId: id, includeTurns: true});
  renderThread(result.thread);
  localStorage.setItem('lastThread', id);
  $('activity').textContent = state.active.has(id) ? 'Nexo trabalhando…' : '';
  document.body.classList.remove('mobile-open');
}

function newThread() {
  state.thread = null;
  state.items.clear();
  $('messages').replaceChildren(welcome.cloneNode(true));
  $('title').textContent = 'Nova conversa';
  $('subtitle').textContent = 'Seu assistente, conectado ao computador';
  $('activity').textContent = '';
  localStorage.removeItem('lastThread');
  updateControls();
  $('prompt').focus();
}

function fileToBase64(file, onProgress) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onprogress = event => {
      if (event.lengthComputable) onProgress(Math.round(event.loaded / event.total * 100));
    };
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.readAsDataURL(file);
  });
}

async function uploadFile(file, record) {
  const data = await fileToBase64(file, progress => {
    record.progress = progress;
    renderAttachments();
  });
  return api('/api/upload', {name: file.name, data});
}

function renderAttachments() {
  $('attachments').replaceChildren();
  for (const file of state.attachments) {
    const card = el('div', undefined, 'attachment');
    if (file.preview) {
      const image = el('img');
      image.src = file.preview;
      image.alt = file.name;
      card.append(image);
    } else {
      card.append(el('span', '▤', 'attachment-icon'));
    }
    const meta = el('span', undefined, 'attachment-info');
    meta.append(el('strong', file.name), el('small', file.uploading ? 'Enviando ' + (file.progress || 0) + '%' : 'Pronto'));
    const remove = el('button', '×');
    remove.type = 'button';
    remove.onclick = () => {
      if (file.preview) URL.revokeObjectURL(file.preview);
      state.attachments = state.attachments.filter(x => x !== file);
      renderAttachments();
      updateRoutePreview();
    };
    card.append(meta, remove);
    $('attachments').append(card);
  }
}

async function send(event) {
  event.preventDefault();
  const text = $('prompt').value.trim();
  if ((!text && !state.attachments.length) || !state.connected || state.attachments.some(x => x.uploading)) return;

  clearError();
  try {
    if (!state.thread) {
      const started = await rpc('thread/start', {
        cwd: $('cwd').value.trim(),
        sandbox: state.mode === 'chat' ? 'read-only' : 'workspace-write',
        approvalPolicy: 'on-request'
      });
      renderThread(started.thread);
      localStorage.setItem('lastThread', started.thread.id);
    } else {
      await rpc('thread/resume', {
        threadId: state.thread.id,
        cwd: $('cwd').value.trim(),
        sandbox: state.mode === 'chat' ? 'read-only' : 'workspace-write',
        approvalPolicy: 'on-request'
      }).catch(() => {});
    }

    const images = state.attachments.filter(file => file.image);
    const textFiles = state.attachments.filter(file => !file.image && typeof file.text === 'string');
    const localFiles = state.attachments.filter(file => !file.image && typeof file.text !== 'string');

    let message = text || 'Analise os arquivos anexados.';
    if (textFiles.length) {
      message += '\n\nConteúdo dos arquivos anexados:\n' +
        textFiles.map(file => '--- ' + file.name + ' ---\n' + file.text + '\n--- Fim ---').join('\n\n');
    }
    if (localFiles.length) {
      message += '\n\nArquivos locais anexados:\n' + localFiles.map(file => '- ' + file.name + ': ' + file.path).join('\n');
    }

    const input = [
      {type:'text', text: message},
      ...images.map(file => ({type:'localImage', path:file.path}))
    ];

    const activeTurn = state.active.get(state.thread.id);
    if (activeTurn) {
      await rpc('turn/steer', {threadId: state.thread.id, expectedTurnId: activeTurn, input});
    } else {
      const route = routeForMessage();
      const params = {
        threadId: state.thread.id,
        input,
        cwd: $('cwd').value.trim(),
        sandboxPolicy: state.mode === 'chat'
          ? {type:'readOnly'}
          : {type:'workspaceWrite', writableRoots:Object.values(state.personalFolders), networkAccess:false},
        approvalPolicy:'on-request'
      };
      if (route.model) params.model = route.model.model;
      if (route.effort) params.effort = route.effort;

      const result = await rpc('turn/start', params);
      if (result.turn?.status === 'inProgress') state.active.set(state.thread.id, result.turn.id);
      for (const item of result.turn?.items || []) renderItem(item);
    }

    $('prompt').value = '';
    for (const file of state.attachments) if (file.preview) URL.revokeObjectURL(file.preview);
    state.attachments = [];
    renderAttachments();
    $('activity').textContent = 'Nexo trabalhando…';
    updateControls();
  } catch (error) {
    fail(error);
  }
}

function handleEvent(message) {
  const p = message.params || {};
  const relevant = p.threadId === state.thread?.id;

  if (message.method === 'turn/started') {
    state.active.set(p.threadId, p.turn.id);
    if (relevant) $('activity').textContent = 'Nexo trabalhando…';
  }

  if (message.method === 'turn/completed') {
    state.active.delete(p.threadId);
    if (relevant) {
      $('activity').textContent = p.turn?.status === 'interrupted' ? 'Resposta interrompida.' : '';
      openThread(p.threadId).catch(fail);
    }
    list().catch(() => {});
  }

  if ((message.method === 'item/started' || message.method === 'item/completed') && relevant) renderItem(p.item);

  if (message.method === 'item/agentMessage/delta' && relevant) {
    const old = state.items.get(p.itemId);
    addMessage(p.itemId, 'assistant', (old?.text || '') + (p.delta || ''));
  }

  if (message.method === 'local/disconnected') state.connected = false;
  updateControls();
}

async function replyRequest(id, result) {
  await api('/api/reply', {id, result});
}

function handleRequests(pending) {
  state.pendingRequests = pending || [];
  $('requests').replaceChildren();

  const auto = new Set([
    'item/commandExecution/requestApproval',
    'item/fileChange/requestApproval',
    'item/permissions/requestApproval'
  ]);

  for (const request of state.pendingRequests) {
    if (state.autonomy && auto.has(request.method)) {
      const result = request.method === 'item/permissions/requestApproval'
        ? {permissions: request.params?.permissions, scope:'turn'}
        : {decision:'accept'};
      replyRequest(request.id, result).catch(fail);
      continue;
    }

    const card = el('section', undefined, 'request');
    card.append(el('strong', 'Solicitação do Nexo'));
    const details = el('details');
    details.append(el('summary', 'Ver detalhes'), el('pre', JSON.stringify(request.params || {}, null, 2)));
    card.append(details);

    const approve = el('button', 'Permitir uma vez');
    approve.type = 'button';
    approve.onclick = () => replyRequest(request.id, {decision:'accept'}).then(() => card.remove()).catch(fail);

    const deny = el('button', 'Recusar');
    deny.type = 'button';
    deny.onclick = () => replyRequest(request.id, {decision:'decline'}).then(() => card.remove()).catch(fail);

    card.append(approve, deny);
    $('requests').append(card);
  }
}

async function poll() {
  try {
    const result = await api('/api/events?after=' + state.seq);
    for (const message of result.events || []) handleEvent(message);
    state.seq = result.cursor || state.seq;
    state.connected = !!result.connected;
    handleRequests(result.requests || []);
    updateControls();
  } catch {
    $('connection').textContent = 'Reconectando…';
  } finally {
    setTimeout(poll, 700);
  }
}

async function loadAccount() {
  const [account, limits] = await Promise.allSettled([
    rpc('account/read', {}),
    rpc('account/rateLimits/read', {})
  ]);
  state.account = account.status === 'fulfilled' ? account.value : null;
  state.limits = limits.status === 'fulfilled' ? limits.value : null;

  const area = $('account-content');
  area.replaceChildren();
  const rawAccount = state.account?.account;
  area.append(el('h3', rawAccount?.email || 'Conta local conectada'));
  area.append(el('p', rawAccount?.planType ? 'Plano: ' + rawAccount.planType : 'Dados retornados pelo serviço local.'));

  const buckets = state.limits?.rateLimitsByLimitId || {};
  for (const [name, bucket] of Object.entries(buckets)) {
    const section = el('section', undefined, 'account-section');
    section.append(el('strong', name));
    for (const window of [bucket.primary, bucket.secondary]) {
      if (!window) continue;
      section.append(el('p', (window.windowDurationMins || '?') + ' min · ' + Math.max(0, 100 - (window.usedPercent || 0)) + '% disponíveis'));
    }
    area.append(section);
  }

  $('account-brief-plan').textContent = rawAccount?.planType || 'Conta conectada';
  $('account-refreshed').textContent = 'Atualizado às ' + new Date().toLocaleTimeString('pt-BR', {hour:'2-digit', minute:'2-digit'});
}

function exportThread() {
  if (!state.thread) return;
  const content = '# ' + threadTitle(state.thread) + '\n\n' +
    [...state.items.values()]
      .filter(item => item.role)
      .map(item => '## ' + (item.role === 'user' ? 'Você' : 'Nexo') + '\n\n' + item.text)
      .join('\n\n');
  const url = URL.createObjectURL(new Blob([content], {type:'text/markdown;charset=utf-8'}));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'nexo-' + state.thread.id + '.md';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function bind() {
  $('composer').onsubmit = send;
  $('new').onclick = newThread;
  $('refresh').onclick = () => list().catch(fail);
  $('more').onclick = () => list(true).catch(fail);

  for (const name of ['all','favorites','archived']) {
    $('filter-' + name).onclick = () => {
      state.filter = name;
      renderThreads();
    };
  }

  $('search').oninput = renderThreads;
  $('attach').onclick = () => $('file-input').click();

  $('file-input').onchange = async event => {
    const files = [...event.target.files];
    event.target.value = '';
    if (state.attachments.length + files.length > 5) return fail(new Error('Anexe até cinco arquivos por mensagem.'));

    for (const file of files) {
      if (file.size > 10_000_000) {
        fail(new Error(file.name + ': limite de 10 MB.'));
        continue;
      }
      const preview = /^image\//.test(file.type) ? URL.createObjectURL(file) : null;
      const record = {name:file.name, size:file.size, preview, uploading:true, progress:0};
      state.attachments.push(record);
      renderAttachments();
      try {
        Object.assign(record, await uploadFile(file, record), {preview, uploading:false, progress:100});
      } catch (error) {
        state.attachments = state.attachments.filter(x => x !== record);
        if (preview) URL.revokeObjectURL(preview);
        fail(error);
      }
      renderAttachments();
    }
    updateRoutePreview();
  };

  $('model').onchange = () => {
    localStorage.setItem('nexoModel', $('model').value);
    updateEfforts();
  };
  $('effort').onchange = () => {
    localStorage.setItem('nexoEffort', $('effort').value);
    updateRoutePreview();
  };

  document.querySelectorAll('[data-compose-mode]').forEach(button => {
    button.onclick = () => setMode(button.dataset.composeMode);
  });

  $('messages').onclick = event => {
    const mode = event.target.closest('[data-mode]');
    if (mode) return setMode(mode.dataset.mode);
    const prompt = event.target.closest('[data-prompt]');
    if (prompt) {
      $('prompt').value = prompt.dataset.prompt;
      $('prompt').focus();
      updateRoutePreview();
    }
  };

  $('prompt').oninput = updateRoutePreview;
  $('prompt').onkeydown = event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      $('composer').requestSubmit();
    }
  };

  $('stop').onclick = () => {
    if (!state.thread) return;
    const turnId = state.active.get(state.thread.id);
    if (turnId) rpc('turn/interrupt', {threadId: state.thread.id, turnId}).catch(fail);
  };

  $('power').onclick = async () => {
    try {
      const action = state.connected ? 'off' : 'on';
      await api('/api/service', {action});
      state.connected = action === 'on';
      if (state.connected) {
        await Promise.allSettled([loadModels(), list(), loadAccount()]);
      }
      updateControls();
    } catch (error) {
      fail(error);
    }
  };

  $('autonomy').onclick = () => setAutonomy(!state.autonomy);
  $('autonomy-off').onclick = () => setAutonomy(false);

  $('account-open').onclick = () => {
    $('account-dialog').showModal();
    loadAccount().catch(fail);
  };
  $('account-header').onclick = $('account-open').onclick;
  $('account-close').onclick = () => $('account-dialog').close();
  $('account-refresh').onclick = () => loadAccount().catch(fail);

  $('rename').onclick = () => {
    if (!state.thread) return;
    $('rename-value').value = threadTitle(state.thread);
    $('rename-dialog').showModal();
  };
  $('rename-dialog').addEventListener('close', async () => {
    if ($('rename-dialog').returnValue !== 'save' || !state.thread) return;
    try {
      const name = $('rename-value').value.trim();
      await rpc('thread/name/set', {threadId:state.thread.id, name});
      state.thread.name = name;
      $('title').textContent = name;
      await list();
    } catch (error) {
      fail(error);
    }
  });

  $('export').onclick = exportThread;
  $('rename-mobile').onclick = () => $('rename').click();
  $('export-mobile').onclick = exportThread;

  $('theme').onclick = () => {
    document.body.classList.toggle('light');
    localStorage.setItem('nexoTheme', document.body.classList.contains('light') ? 'light' : 'dark');
  };
  if (localStorage.getItem('nexoTheme') === 'light') document.body.classList.add('light');

  $('menu').onclick = () => document.body.classList.toggle('mobile-open');

  document.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      newThread();
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      $('search').focus();
    }
  });
}

async function init() {
  bind();
  try {
    const boot = await api('/api/bootstrap');
    state.token = boot.token;
    state.connected = !!boot.connected;
    state.personalFolders = boot.personalFolders || {};
    state.home = boot.home || boot.cwd;
    $('cwd').value = boot.cwd || '';

    const datalist = el('datalist');
    datalist.id = 'personal-folders';
    for (const [name, path] of Object.entries(state.personalFolders)) {
      const option = el('option');
      option.value = path;
      option.label = name;
      datalist.append(option);
    }
    document.body.append(datalist);
    $('cwd').setAttribute('list', datalist.id);

    updateControls();

    if (state.connected) {
      await Promise.allSettled([list(), loadModels(), loadAccount()]);
      const last = localStorage.getItem('lastThread');
      if (last) await openThread(last).catch(() => {});
    }

    const initial = await api('/api/events?after=0');
    state.seq = initial.cursor || 0;
    handleRequests(initial.requests || []);
    poll();
  } catch (error) {
    fail(error);
    $('connection').textContent = 'Falha na conexão';
  }
}

init();
