function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function snapshotLootTables(npcs) {
  const snapshot = new Map()
  for (const npc of Array.isArray(npcs) ? npcs : []) {
    snapshot.set(npc.id, clone(Array.isArray(npc.lootTable) ? npc.lootTable : []))
  }
  return snapshot
}

function buildItemIndex(items) {
  const rows = Array.isArray(items) ? items : []
  const byId = new Map()
  const displayById = new Map()
  const displayToId = new Map()
  for (const item of rows) {
    byId.set(item.id, item)
    const display = `${item.name || 'Item'} (${item.id})`
    displayById.set(item.id, display)
    displayToId.set(display, item.id)
  }
  return { rows, byId, displayById, displayToId }
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]))
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function formatNumber(value, digits = 1) {
  if (!Number.isFinite(value)) return '0'
  if (Math.abs(value) >= 1000) return Math.round(value).toLocaleString()
  if (Number.isInteger(value)) return String(value)
  return value.toFixed(digits).replace(/\.0+$/, '')
}

function chancePercent(chance) {
  return clamp(Number(chance) || 0, 0, 1) * 100
}

function chanceLabel(chance) {
  const percent = chancePercent(chance)
  if (percent === 100) return 'Always'
  if (percent <= 0) return 'Never'
  if (percent < 1) return `${percent.toFixed(2)}%`
  if (percent < 10) return `${percent.toFixed(1)}%`
  return `${Math.round(percent)}%`
}

function oddsLabel(chance) {
  const p = clamp(Number(chance) || 0, 0, 1)
  if (p >= 1) return 'every kill'
  if (p <= 0) return 'disabled'
  const oneIn = 1 / p
  if (oneIn < 10) return `1 in ${oneIn.toFixed(1)}`
  return `1 in ${Math.round(oneIn).toLocaleString()}`
}

function rarityClass(chance) {
  const p = clamp(Number(chance) || 0, 0, 1)
  if (p >= 1) return 'always'
  if (p >= 0.25) return 'common'
  if (p >= 0.05) return 'uncommon'
  if (p >= 0.01) return 'rare'
  return 'very-rare'
}

function itemValue(item) {
  return Number(item?.value) || 0
}

function itemName(itemId, itemIndex) {
  const item = itemIndex.byId.get(itemId)
  return item ? item.name : `Item ${itemId || '?'}`
}

function itemDisplay(itemId, itemIndex) {
  return itemIndex.displayById.get(itemId) || (itemId > 0 ? String(itemId) : '')
}

function parseItemDisplay(value, itemIndex) {
  const text = String(value || '').trim()
  if (!text) return 0
  const exactId = itemIndex.displayToId.get(text)
  if (exactId) return exactId
  const tail = text.match(/\((\d+)\)\s*$/)
  if (tail) return Number(tail[1]) || 0
  const asId = Number.parseInt(text, 10)
  if (Number.isFinite(asId) && itemIndex.byId.has(asId)) return asId
  const lower = text.toLowerCase()
  const fuzzy = itemIndex.rows.find(item => `${item.name || ''} ${item.id}`.toLowerCase().includes(lower))
  return fuzzy?.id || 0
}

function normalizeDrop(drop) {
  return {
    itemId: Math.max(0, Math.floor(Number(drop?.itemId) || 0)),
    quantity: Math.max(1, Math.floor(Number(drop?.quantity) || 1)),
    chance: clamp(Number(drop?.chance) || 0, 0, 1),
  }
}

function tableStats(npc, itemIndex) {
  const drops = Array.isArray(npc?.lootTable) ? npc.lootTable.map(normalizeDrop) : []
  let guaranteed = 0
  let random = 0
  let itemEv = 0
  let valueEv = 0
  for (const drop of drops) {
    if (drop.chance >= 1) guaranteed++
    else if (drop.chance > 0) random++
    itemEv += drop.quantity * drop.chance
    const item = itemIndex.byId.get(drop.itemId)
    valueEv += itemValue(item) * drop.quantity * drop.chance
  }
  return { drops, guaranteed, random, itemEv, valueEv }
}

function ensureLootTable(npc) {
  if (!npc) return []
  if (!Array.isArray(npc.lootTable)) npc.lootTable = []
  return npc.lootTable
}

export async function openDropTableEditor(options = {}) {
  const existing = document.getElementById('dropTablesModal')
  if (existing) {
    existing.style.display = 'flex'
    if (typeof existing._refreshOptions === 'function') existing._refreshOptions(options)
    else if (typeof existing._selectNpcId === 'function') existing._selectNpcId(options.selectedNpcId)
    return
  }

  let npcs = options.npcDefs || []
  let items = Array.isArray(options.items) ? options.items : []
  let itemIndex = buildItemIndex(items)
  let originalLootTables = snapshotLootTables(npcs)
  let selectedId = options.selectedNpcId || npcs[0]?.id || 0
  let selectedDropIndex = 0
  let search = ''
  let filter = 'all'
  let dirty = false
  let copySourceId = 0

  function setItems(nextItems) {
    items = Array.isArray(nextItems) ? nextItems : []
    itemIndex = buildItemIndex(items)
  }

  const overlay = document.createElement('div')
  overlay.id = 'dropTablesModal'
  overlay.className = 'drop-table-modal'
  overlay.innerHTML = `
    <div class="drop-table-shell">
      <div class="drop-table-head">
        <div class="drop-table-title">Drop Tables</div>
        <button id="dropTablesSave">Save NPC Defs</button>
        <button id="dropTablesRevert">Revert</button>
        <span id="dropTablesStatus"></span>
        <button id="dropTablesClose">Close</button>
      </div>
      <div class="drop-table-body">
        <aside class="drop-table-list-pane">
          <input id="dropTablesSearch" type="text" placeholder="Search NPC name or id" />
          <select id="dropTablesFilter">
            <option value="all">All NPCs</option>
            <option value="with-drops">With drops</option>
            <option value="empty">Empty tables</option>
            <option value="guaranteed">Has guaranteed drop</option>
            <option value="valuable">Highest value</option>
          </select>
          <div id="dropTablesNpcList" class="drop-table-npc-list"></div>
        </aside>
        <main id="dropTablesEditor" class="drop-table-editor-pane"></main>
        <aside id="dropTablesSummary" class="drop-table-summary-pane"></aside>
      </div>
    </div>
  `
  document.body.appendChild(overlay)

  const statusEl = overlay.querySelector('#dropTablesStatus')
  const listEl = overlay.querySelector('#dropTablesNpcList')
  const editorEl = overlay.querySelector('#dropTablesEditor')
  const summaryEl = overlay.querySelector('#dropTablesSummary')

  function selectedNpc() {
    return npcs.find(n => n.id === selectedId) || null
  }

  function selectedDrops() {
    return ensureLootTable(selectedNpc())
  }

  function setStatus(message, color = '#999') {
    statusEl.textContent = message
    statusEl.style.color = color
    if (message) {
      setTimeout(() => {
        if (statusEl.textContent === message) statusEl.textContent = dirty ? 'unsaved' : ''
      }, 3500)
    }
  }

  function markDirty() {
    dirty = true
    statusEl.textContent = 'unsaved'
    statusEl.style.color = '#fc6'
    if (typeof options.onDirty === 'function') options.onDirty()
  }

  function syncItemDatalist() {
    let dl = document.getElementById('dropTableItemDatalist')
    if (!dl) {
      dl = document.createElement('datalist')
      dl.id = 'dropTableItemDatalist'
      document.body.appendChild(dl)
    }
    const signature = itemIndex.rows.map(item => `${item.id}:${item.name || ''}:${item.value || 0}`).join('|')
    if (dl.dataset.signature === signature) return
    dl.innerHTML = [...itemIndex.rows]
      .sort((a, b) => (a.name || '').localeCompare(b.name || '') || a.id - b.id)
      .map(item => `<option value="${esc(itemDisplay(item.id, itemIndex))}"></option>`)
      .join('')
    dl.dataset.signature = signature
  }

  function filteredNpcs() {
    const q = search.trim().toLowerCase()
    let rows = npcs.filter(npc => {
      if (q && !`${npc.name || ''} ${npc.id}`.toLowerCase().includes(q)) return false
      const stats = tableStats(npc, itemIndex)
      if (filter === 'with-drops') return stats.drops.length > 0
      if (filter === 'empty') return stats.drops.length === 0
      if (filter === 'guaranteed') return stats.guaranteed > 0
      return true
    })
    if (filter === 'valuable') {
      rows = rows
        .map(npc => ({ npc, value: tableStats(npc, itemIndex).valueEv }))
        .sort((a, b) => b.value - a.value || (a.npc.name || '').localeCompare(b.npc.name || ''))
        .map(row => row.npc)
    } else {
      rows = rows.sort((a, b) => (a.name || '').localeCompare(b.name || '') || a.id - b.id)
    }
    return rows
  }

  function renderList() {
    const rows = filteredNpcs()
    if (!rows.some(npc => npc.id === selectedId) && rows.length) selectedId = rows[0].id
    listEl.innerHTML = rows.map(npc => {
      const stats = tableStats(npc, itemIndex)
      const active = npc.id === selectedId
      return `<button class="drop-table-npc-row${active ? ' active' : ''}" data-npc-id="${npc.id}">
        <span>${esc(npc.name || 'Unnamed NPC')}</span>
        <small>#${npc.id} - ${stats.drops.length} drop${stats.drops.length === 1 ? '' : 's'} - ${formatNumber(stats.valueEv, 1)} value</small>
      </button>`
    }).join('') || '<div class="drop-table-empty">No matching NPCs.</div>'

    for (const btn of listEl.querySelectorAll('[data-npc-id]')) {
      btn.addEventListener('click', () => {
        selectedId = Number(btn.dataset.npcId)
        render()
      })
    }
  }

  function dropMeta(drop) {
    const item = itemIndex.byId.get(drop.itemId)
    const expected = drop.quantity * drop.chance
    const valueEv = itemValue(item) * expected
    return `${oddsLabel(drop.chance)} - ${formatNumber(expected, 3)} item/kill - ${formatNumber(valueEv, 1)} value/kill`
  }

  function setDrop(index, patch) {
    const npc = selectedNpc()
    if (!npc) return
    const drops = ensureLootTable(npc)
    if (index < 0 || index >= drops.length) return
    selectedDropIndex = clamp(index, 0, Math.max(0, drops.length - 1))
    drops[index] = normalizeDrop({ ...drops[index], ...patch })
    markDirty()
    render()
  }

  function removeDrop(index) {
    const npc = selectedNpc()
    if (!npc) return
    const drops = ensureLootTable(npc)
    if (index < 0 || index >= drops.length) return
    drops.splice(index, 1)
    selectedDropIndex = clamp(index, 0, Math.max(0, drops.length - 1))
    markDirty()
    render()
  }

  function moveDrop(index, direction) {
    const npc = selectedNpc()
    if (!npc) return
    const drops = ensureLootTable(npc)
    const next = index + direction
    if (next < 0 || next >= drops.length) return
    const tmp = drops[index]
    drops[index] = drops[next]
    drops[next] = tmp
    selectedDropIndex = next
    markDirty()
    render()
  }

  function addDrop(chance = 1) {
    const npc = selectedNpc()
    if (!npc) return
    const drops = ensureLootTable(npc)
    drops.push({ itemId: 0, quantity: 1, chance })
    selectedDropIndex = drops.length - 1
    markDirty()
    render()
    setTimeout(() => {
      const input = editorEl.querySelector('.drop-table-entry:last-child input[data-drop-item]')
      input?.focus()
    }, 0)
  }

  function copyFromNpc(sourceId) {
    const npc = selectedNpc()
    const source = npcs.find(n => n.id === Number(sourceId))
    if (!npc || !source || npc === source) return
    npc.lootTable = clone(Array.isArray(source.lootTable) ? source.lootTable : [])
    markDirty()
    render()
  }

  function renderCopyTools(npc) {
    const choices = npcs
      .filter(n => n.id !== npc.id && Array.isArray(n.lootTable) && n.lootTable.length > 0)
      .sort((a, b) => (a.name || '').localeCompare(b.name || '') || a.id - b.id)
    if (!choices.length) return ''
    if (!choices.some(n => n.id === copySourceId)) copySourceId = choices[0].id
    return `
      <div class="drop-table-copy">
        <select id="dropTableCopySource">
          ${choices.map(n => `<option value="${n.id}"${n.id === copySourceId ? ' selected' : ''}>${esc(n.name || 'NPC')} (${n.id}) - ${(n.lootTable || []).length} drops</option>`).join('')}
        </select>
        <button id="dropTableCopyBtn">Copy Table</button>
      </div>
    `
  }

  function renderDropRows(npc) {
    const drops = ensureLootTable(npc)
    if (!drops.length) {
      return '<div class="drop-table-empty large">No drops yet.</div>'
    }
    return drops.map((rawDrop, index) => {
      const drop = normalizeDrop(rawDrop)
      const percent = chancePercent(drop.chance)
      const item = itemIndex.byId.get(drop.itemId)
      return `
        <section class="drop-table-entry" data-drop-index="${index}">
          <div class="drop-table-entry-top">
            <input data-drop-item type="text" list="dropTableItemDatalist" value="${esc(itemDisplay(drop.itemId, itemIndex))}" placeholder="Search item name or id" />
            <button data-drop-up title="Move up"${index === 0 ? ' disabled' : ''}>Up</button>
            <button data-drop-down title="Move down"${index === drops.length - 1 ? ' disabled' : ''}>Down</button>
            <button data-drop-remove title="Remove drop">x</button>
          </div>
          <div class="drop-table-entry-fields">
            <label><span>Qty</span><input data-drop-qty type="number" min="1" step="1" value="${drop.quantity}" /></label>
            <label><span>Chance %</span><input data-drop-chance type="number" min="0" max="100" step="0.01" value="${formatNumber(percent, 2)}" /></label>
            <div class="drop-table-rarity ${rarityClass(drop.chance)}">${chanceLabel(drop.chance)}</div>
          </div>
          <input data-drop-slider type="range" min="0" max="100" step="0.1" value="${percent}" />
          <div class="drop-table-bar"><i class="${rarityClass(drop.chance)}" style="width:${clamp(percent, 0, 100)}%;"></i></div>
          <div class="drop-table-entry-meta">
            <b>${esc(item?.name || (drop.itemId ? `Unknown item ${drop.itemId}` : 'Choose an item'))}</b>
            <span>${esc(dropMeta(drop))}</span>
          </div>
        </section>
      `
    }).join('')
  }

  function renderEditor() {
    const npc = selectedNpc()
    if (!npc) {
      editorEl.innerHTML = '<div class="drop-table-empty large">Select an NPC.</div>'
      return
    }
    const stats = tableStats(npc, itemIndex)
    selectedDropIndex = clamp(selectedDropIndex, 0, Math.max(0, ensureLootTable(npc).length - 1))
    editorEl.innerHTML = `
      <div class="drop-table-editor-head">
        <div>
          <h2>${esc(npc.name || 'Unnamed NPC')}</h2>
          <span>NPC #${npc.id}</span>
        </div>
        <div class="drop-table-actions">
          <button data-add-drop="1">+ Always Drop</button>
          <button data-add-drop="0.25">+ Random Drop</button>
        </div>
      </div>
      <div class="drop-table-stat-strip">
        <div><b>${stats.drops.length}</b><span>entries</span></div>
        <div><b>${stats.guaranteed}</b><span>always</span></div>
        <div><b>${stats.random}</b><span>random</span></div>
        <div><b>${formatNumber(stats.valueEv, 1)}</b><span>value/kill</span></div>
      </div>
      <div class="drop-table-presets">
        <button data-set-selected-chance="1">100%</button>
        <button data-set-selected-chance="0.5">50%</button>
        <button data-set-selected-chance="0.25">25%</button>
        <button data-set-selected-chance="0.05">5%</button>
        <button data-set-selected-chance="0.01">1%</button>
        <button data-set-selected-chance="0.001">0.1%</button>
      </div>
      ${renderCopyTools(npc)}
      <div class="drop-table-entries">${renderDropRows(npc)}</div>
    `

    for (const btn of editorEl.querySelectorAll('[data-add-drop]')) {
      btn.addEventListener('click', () => addDrop(Number(btn.dataset.addDrop)))
    }
    const copySelect = editorEl.querySelector('#dropTableCopySource')
    copySelect?.addEventListener('change', () => { copySourceId = Number(copySelect.value) })
    editorEl.querySelector('#dropTableCopyBtn')?.addEventListener('click', () => copyFromNpc(copySelect?.value))

    for (const btn of editorEl.querySelectorAll('[data-set-selected-chance]')) {
      btn.addEventListener('click', () => {
        const drops = selectedDrops()
        if (!drops.length) {
          setStatus('add a drop first', '#aaa')
          return
        }
        const index = clamp(selectedDropIndex, 0, Math.max(0, drops.length - 1))
        if (Number.isInteger(index)) setDrop(index, { chance: Number(btn.dataset.setSelectedChance) })
      })
    }

    for (const row of editorEl.querySelectorAll('.drop-table-entry')) {
      const index = Number(row.dataset.dropIndex)
      row.addEventListener('focusin', () => { selectedDropIndex = index })
      row.addEventListener('click', () => { selectedDropIndex = index })
      row.querySelector('[data-drop-item]')?.addEventListener('change', event => {
        const id = parseItemDisplay(event.target.value, itemIndex)
        setDrop(index, { itemId: id })
      })
      row.querySelector('[data-drop-qty]')?.addEventListener('change', event => {
        setDrop(index, { quantity: Number(event.target.value) || 1 })
      })
      row.querySelector('[data-drop-chance]')?.addEventListener('change', event => {
        setDrop(index, { chance: (Number(event.target.value) || 0) / 100 })
      })
      row.querySelector('[data-drop-slider]')?.addEventListener('change', event => {
        setDrop(index, { chance: (Number(event.target.value) || 0) / 100 })
      })
      row.querySelector('[data-drop-up]')?.addEventListener('click', () => moveDrop(index, -1))
      row.querySelector('[data-drop-down]')?.addEventListener('click', () => moveDrop(index, 1))
      row.querySelector('[data-drop-remove]')?.addEventListener('click', () => removeDrop(index))
    }
  }

  function renderSummary() {
    const npc = selectedNpc()
    if (!npc) {
      summaryEl.innerHTML = ''
      return
    }
    const stats = tableStats(npc, itemIndex)
    const sorted = [...stats.drops]
      .filter(drop => drop.itemId > 0)
      .sort((a, b) => b.chance - a.chance || itemName(a.itemId, itemIndex).localeCompare(itemName(b.itemId, itemIndex)))
    const bars = sorted.map(drop => {
      const pct = Math.max(2, Math.min(100, chancePercent(drop.chance)))
      return `<div class="drop-table-mix-row" title="${esc(itemName(drop.itemId, itemIndex))}: ${esc(chanceLabel(drop.chance))}">
        <span>${esc(itemName(drop.itemId, itemIndex))}</span>
        <div><i class="${rarityClass(drop.chance)}" style="width:${pct}%;"></i></div>
        <b>${esc(chanceLabel(drop.chance))}</b>
      </div>`
    }).join('')

    const guaranteed = sorted.filter(drop => drop.chance >= 1)
    const random = sorted.filter(drop => drop.chance > 0 && drop.chance < 1)
    summaryEl.innerHTML = `
      <div class="drop-table-section-title">Table Shape</div>
      <div class="drop-table-summary-card">
        <div><span>Guaranteed</span><b>${guaranteed.length}</b></div>
        <div><span>Random rolls</span><b>${random.length}</b></div>
        <div><span>Expected items</span><b>${formatNumber(stats.itemEv, 3)}</b></div>
        <div><span>Expected value</span><b>${formatNumber(stats.valueEv, 1)}</b></div>
      </div>
      <div class="drop-table-section-title">Chance Mix</div>
      <div class="drop-table-mix">${bars || '<div class="drop-table-empty">No item rolls.</div>'}</div>
      <div class="drop-table-section-title">Highest Value Rolls</div>
      <div class="drop-table-value-list">
        ${[...stats.drops]
          .map(drop => {
            const item = itemIndex.byId.get(drop.itemId)
            return { drop, item, value: itemValue(item) * drop.quantity * drop.chance }
          })
          .filter(row => row.drop.itemId > 0)
          .sort((a, b) => b.value - a.value)
          .slice(0, 8)
          .map(row => `<div><span>${esc(itemName(row.drop.itemId, itemIndex))} x${row.drop.quantity}</span><b>${formatNumber(row.value, 2)}</b></div>`)
          .join('') || '<div class="drop-table-empty">No valued drops.</div>'}
      </div>
    `
  }

  function render() {
    syncItemDatalist()
    renderList()
    renderEditor()
    renderSummary()
  }

  overlay._selectNpcId = id => {
    if (id && npcs.some(n => n.id === id)) selectedId = id
    render()
  }

  overlay._refreshOptions = nextOptions => {
    options = { ...options, ...nextOptions }
    if (Array.isArray(options.npcDefs)) npcs = options.npcDefs
    setItems(options.items)
    if (!dirty) originalLootTables = snapshotLootTables(npcs)
    if (options.selectedNpcId && npcs.some(n => n.id === options.selectedNpcId)) selectedId = options.selectedNpcId
    if (!items.length && typeof options.loadItems === 'function') {
      options.loadItems().then(loaded => {
        setItems(loaded)
        render()
      })
    }
    render()
  }

  overlay.querySelector('#dropTablesSearch')?.addEventListener('input', event => {
    search = event.target.value
    render()
  })
  overlay.querySelector('#dropTablesFilter')?.addEventListener('change', event => {
    filter = event.target.value
    render()
  })
  overlay.querySelector('#dropTablesClose')?.addEventListener('click', () => {
    overlay.style.display = 'none'
  })
  overlay.querySelector('#dropTablesRevert')?.addEventListener('click', () => {
    if (dirty && !confirm('Revert drop table edits made since opening this window?')) return
    for (const npc of npcs) {
      npc.lootTable = clone(originalLootTables.get(npc.id) || [])
    }
    dirty = false
    setStatus('reverted', '#aaa')
    render()
  })
  overlay.querySelector('#dropTablesSave')?.addEventListener('click', async () => {
    if (typeof options.onSave !== 'function') return
    try {
      setStatus('saving...', '#fc6')
      await options.onSave(npcs)
      originalLootTables = snapshotLootTables(npcs)
      dirty = false
      setStatus('saved', '#6e6')
    } catch (err) {
      setStatus(`save failed: ${err.message || err}`, '#e66')
    }
  })

  if (!items.length && typeof options.loadItems === 'function') {
    setStatus('loading items...', '#aaa')
    setItems(await options.loadItems())
    setStatus('')
  }
  render()
}
