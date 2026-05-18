import {
  ACC_BASE,
  SKILL_NAMES,
  STANCE_BONUSES,
  calculateHitChance,
  osrsMeleeMaxHit,
} from '@projectrs/shared'

const EQUIP_SLOTS = ['', 'weapon', 'head', 'body', 'legs', 'shield', 'neck', 'ring', 'hands', 'feet', 'cape']
const EQUIP_SKILLS = ['', 'accuracy', 'strength', 'defence', 'goodmagic', 'evilmagic', 'archery', 'hitpoints', 'woodcut', 'fishing', 'cooking', 'mining', 'smithing', 'crafting', 'roguery']
const WEAPON_STYLES = ['', 'stab', 'slash', 'crush', 'bow', 'crossbow']
const TOOL_TYPES = ['', 'axe', 'pickaxe']
const STANCES = ['accurate', 'aggressive', 'defensive', 'controlled']
const TIERS = ['Bronze', 'Iron', 'Steel', 'Mithril', 'Black Bronze']
const TIER_MULTIPLIERS = {
  Bronze: 1,
  Iron: 1.5,
  Steel: 2,
  Mithril: 3,
  'Black Bronze': 4,
}
const DEFAULT_COMPARE_FAMILIES = ['Scimitar', 'Battle Axe', '2-handed Sword']

const NUMBER_FIELDS = [
  'value', 'levelRequired', 'attackSpeed',
  'stabAttack', 'slashAttack', 'crushAttack', 'meleeStrength',
  'stabDefence', 'slashDefence', 'crushDefence', 'rangedDefence', 'magicDefence',
  'rangedAccuracy', 'rangedStrength', 'magicAccuracy',
  'toolLevel', 'toolBonus', 'healAmount',
]

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]))
}

function itemTier(item) {
  return TIERS.find(t => item.name === t || item.name?.startsWith(`${t} `)) || ''
}

function itemFamily(item) {
  const tier = itemTier(item)
  if (!tier) return item.name || ''
  return (item.name || '').slice(tier.length).trim()
}

function itemCategory(item) {
  if (item.toolType) return 'Tools'
  if (item.equippable && item.equipSlot === 'weapon') return 'Weapons'
  if (item.equippable) return 'Armor'
  if (item.healAmount) return 'Consumables'
  if (/(ore|bar|coal|log|fish|meat|hide|leather|bone|arrow)/i.test(item.name || '')) return 'Materials'
  return 'Misc'
}

function displaySkill(skill) {
  return SKILL_NAMES[skill] || skill || 'skill'
}

function attackBonusFor(item) {
  const style = item.weaponStyle || 'slash'
  if (style === 'stab') return item.stabAttack || 0
  if (style === 'crush') return item.crushAttack || 0
  if (style === 'bow' || style === 'crossbow') return item.rangedAccuracy || 0
  return item.slashAttack || 0
}

function weaponDps(item, settings) {
  if (!item?.equippable || item.equipSlot !== 'weapon') return null
  const stance = STANCE_BONUSES[settings.stance] || STANCE_BONUSES.aggressive
  const effAcc = settings.accuracy + stance.accuracy + 8
  const effStr = settings.strength + stance.strength + 8
  const attackRoll = effAcc * (attackBonusFor(item) + ACC_BASE)
  const defenceRoll = (settings.targetDefence + 8) * ACC_BASE
  const hitChance = calculateHitChance(attackRoll, defenceRoll)
  const maxHit = osrsMeleeMaxHit(effStr, item.meleeStrength || 0)
  const averageHit = hitChance * (maxHit / 2)
  const interval = (item.attackSpeed || 4) * 0.6
  return {
    hitChance,
    maxHit,
    averageHit,
    interval,
    dps: averageHit / interval,
    ttk: settings.targetHp > 0 ? settings.targetHp / (averageHit / interval) : 0,
  }
}

function itemLabel(item) {
  return `${item.name || 'Item'} (${item.id})`
}

function groupSort(a, b) {
  const catA = itemCategory(a)
  const catB = itemCategory(b)
  if (catA !== catB) return catA.localeCompare(catB)
  const tierA = TIERS.indexOf(itemTier(a))
  const tierB = TIERS.indexOf(itemTier(b))
  if (tierA !== tierB) return (tierA < 0 ? 999 : tierA) - (tierB < 0 ? 999 : tierB)
  return (a.name || '').localeCompare(b.name || '') || a.id - b.id
}

export async function openItemStatsEditor(options = {}) {
  const existing = document.getElementById('itemStatsModal')
  if (existing) {
    existing.style.display = 'flex'
    return
  }

  let items = []
  let original = []
  let selectedId = null
  let search = ''
  let categoryFilter = 'All'
  let tierFilter = 'All'
  let dirty = false
  let dpsSettings = {
    accuracy: 35,
    strength: 35,
    targetDefence: 35,
    targetHp: 40,
    stance: 'aggressive',
    compareId: 0,
  }
  let curveSettings = {
    family: '2-handed Sword',
    field: 'meleeStrength',
    base: 24,
    round: 'round',
  }

  const overlay = document.createElement('div')
  overlay.id = 'itemStatsModal'
  overlay.className = 'item-stats-modal'
  overlay.innerHTML = `
    <div class="item-stats-shell">
      <div class="item-stats-head">
        <div class="item-stats-title">Item Stats</div>
        <button id="itemStatsSave">Save Items</button>
        <button id="itemStatsRevert">Revert</button>
        <span id="itemStatsStatus"></span>
        <button id="itemStatsClose">Close</button>
      </div>
      <div class="item-stats-body">
        <aside class="item-stats-list-pane">
          <input id="itemStatsSearch" type="text" placeholder="Search item name or id" />
          <div class="item-stats-filters">
            <select id="itemStatsCategory"></select>
            <select id="itemStatsTier"></select>
          </div>
          <div id="itemStatsList" class="item-stats-list"></div>
        </aside>
        <main id="itemStatsEditorPane" class="item-stats-editor-pane"></main>
        <aside id="itemStatsDpsPane" class="item-stats-dps-pane"></aside>
      </div>
    </div>
  `
  document.body.appendChild(overlay)

  const statusEl = overlay.querySelector('#itemStatsStatus')
  const listEl = overlay.querySelector('#itemStatsList')
  const editorEl = overlay.querySelector('#itemStatsEditorPane')
  const dpsEl = overlay.querySelector('#itemStatsDpsPane')

  function setStatus(message, color = '#999') {
    statusEl.textContent = message
    statusEl.style.color = color
    if (message) setTimeout(() => {
      if (statusEl.textContent === message) statusEl.textContent = dirty ? 'unsaved' : ''
    }, 3500)
  }

  function selectedItem() {
    return items.find(i => i.id === selectedId) || null
  }

  function markDirty() {
    dirty = true
    statusEl.textContent = 'unsaved'
    statusEl.style.color = '#fc6'
  }

  function setField(item, field, value) {
    if (NUMBER_FIELDS.includes(field)) {
      if (value === '') delete item[field]
      else item[field] = Number(value)
    } else if (field === 'stackable' || field === 'equippable' || field === 'twoHanded' || field === 'isAmmo') {
      item[field] = !!value
    } else if (value === '') {
      delete item[field]
    } else {
      item[field] = value
    }
    markDirty()
    render()
  }

  function numberInput(item, field, label, step = 1) {
    const value = item[field] ?? ''
    return `
      <label class="item-stat-field">
        <span>${label}</span>
        <input data-field="${field}" type="number" step="${step}" value="${esc(value)}" />
      </label>
    `
  }

  function textInput(item, field, label) {
    return `
      <label class="item-stat-field">
        <span>${label}</span>
        <input data-field="${field}" type="text" value="${esc(item[field] ?? '')}" />
      </label>
    `
  }

  function selectInput(item, field, label, values) {
    const current = item[field] ?? ''
    return `
      <label class="item-stat-field">
        <span>${label}</span>
        <select data-field="${field}">
          ${values.map(v => `<option value="${esc(v)}"${v === current ? ' selected' : ''}>${esc(v || 'none')}</option>`).join('')}
        </select>
      </label>
    `
  }

  function checkboxInput(item, field, label) {
    return `
      <label class="item-stat-check">
        <input data-field="${field}" type="checkbox"${item[field] ? ' checked' : ''} />
        <span>${label}</span>
      </label>
    `
  }

  function renderList() {
    const categories = ['All', ...Array.from(new Set(items.map(itemCategory))).sort()]
    overlay.querySelector('#itemStatsCategory').innerHTML = categories.map(c => `<option value="${esc(c)}"${c === categoryFilter ? ' selected' : ''}>${esc(c)}</option>`).join('')
    overlay.querySelector('#itemStatsTier').innerHTML = ['All', ...TIERS].map(t => `<option value="${esc(t)}"${t === tierFilter ? ' selected' : ''}>${esc(t)}</option>`).join('')

    const filtered = items
      .filter(item => {
        if (categoryFilter !== 'All' && itemCategory(item) !== categoryFilter) return false
        if (tierFilter !== 'All' && itemTier(item) !== tierFilter) return false
        const q = search.trim().toLowerCase()
        if (!q) return true
        return String(item.id).includes(q) || (item.name || '').toLowerCase().includes(q)
      })
      .sort(groupSort)

    let lastCat = ''
    listEl.innerHTML = filtered.map(item => {
      const cat = itemCategory(item)
      const header = cat !== lastCat ? `<div class="item-stats-group">${esc(cat)}</div>` : ''
      lastCat = cat
      return `${header}<button class="item-stats-row${item.id === selectedId ? ' active' : ''}" data-id="${item.id}">
        <span>${esc(item.name)}</span>
        <small>#${item.id}${item.levelRequired ? ` · L${item.levelRequired}` : ''}</small>
      </button>`
    }).join('') || '<div class="item-stats-empty">No matching items.</div>'

    for (const btn of listEl.querySelectorAll('[data-id]')) {
      btn.addEventListener('click', () => {
        selectedId = Number(btn.dataset.id)
        const item = selectedItem()
        if (item?.equipSlot === 'weapon') dpsSettings.compareId ||= item.id
        render()
      })
    }
  }

  function renderEditor() {
    const item = selectedItem()
    if (!item) {
      editorEl.innerHTML = '<div class="item-stats-empty">Select an item to edit.</div>'
      return
    }

    const isWeapon = item.equippable && item.equipSlot === 'weapon'
    const isArmor = item.equippable && item.equipSlot && item.equipSlot !== 'weapon'
    const isTool = !!item.toolType

    editorEl.innerHTML = `
      <div class="item-stats-section-title">General</div>
      <div class="item-stats-grid">
        <label class="item-stat-field"><span>ID</span><input type="number" value="${item.id}" disabled /></label>
        ${textInput(item, 'name', 'Name')}
        ${textInput(item, 'description', 'Description')}
        ${numberInput(item, 'value', 'Value')}
      </div>
      <div class="item-stats-checks">
        ${checkboxInput(item, 'stackable', 'Stackable')}
        ${checkboxInput(item, 'equippable', 'Equippable')}
        ${checkboxInput(item, 'twoHanded', 'Two-handed')}
        ${checkboxInput(item, 'isAmmo', 'Ammo')}
      </div>

      <div class="item-stats-section-title">Equipment</div>
      <div class="item-stats-grid">
        ${selectInput(item, 'equipSlot', 'Equip slot', EQUIP_SLOTS)}
        ${selectInput(item, 'equipSkill', 'Required skill', EQUIP_SKILLS)}
        ${numberInput(item, 'levelRequired', 'Level required')}
        ${selectInput(item, 'weaponStyle', 'Weapon style', WEAPON_STYLES)}
        ${numberInput(item, 'attackSpeed', 'Attack speed')}
        ${selectInput(item, 'toolType', 'Tool type', TOOL_TYPES)}
        ${numberInput(item, 'toolLevel', 'Tool level')}
        ${numberInput(item, 'toolBonus', 'Tool bonus')}
      </div>

      <div class="item-stats-section-title">${isWeapon ? 'Weapon Bonuses' : isArmor ? 'Armor Bonuses' : isTool ? 'Tool / Combat Bonuses' : 'Stats'}</div>
      <div class="item-stats-grid">
        ${numberInput(item, 'stabAttack', 'Stab attack')}
        ${numberInput(item, 'slashAttack', 'Slash attack')}
        ${numberInput(item, 'crushAttack', 'Crush attack')}
        ${numberInput(item, 'meleeStrength', 'Melee strength')}
        ${numberInput(item, 'stabDefence', 'Stab defence')}
        ${numberInput(item, 'slashDefence', 'Slash defence')}
        ${numberInput(item, 'crushDefence', 'Crush defence')}
        ${numberInput(item, 'rangedDefence', 'Ranged defence')}
        ${numberInput(item, 'magicDefence', 'Magic defence')}
        ${numberInput(item, 'rangedAccuracy', 'Ranged accuracy')}
        ${numberInput(item, 'rangedStrength', 'Ranged strength')}
        ${numberInput(item, 'magicAccuracy', 'Magic accuracy')}
        ${numberInput(item, 'healAmount', 'Heal amount')}
      </div>
    `

    for (const input of editorEl.querySelectorAll('[data-field]')) {
      input.addEventListener('change', () => {
        const field = input.dataset.field
        const type = input.getAttribute('type')
        setField(item, field, type === 'checkbox' ? input.checked : input.value)
      })
    }
  }

  function renderDps() {
    const item = selectedItem()
    const weapons = items.filter(i => i.equippable && i.equipSlot === 'weapon').sort(groupSort)
    if (item?.equipSlot === 'weapon' && !dpsSettings.compareId) dpsSettings.compareId = item.id
    const compare = weapons.find(w => w.id === Number(dpsSettings.compareId)) || weapons[0] || null
    const primary = item?.equipSlot === 'weapon' ? item : compare
    const a = weaponDps(primary, dpsSettings)
    const b = compare && primary && compare.id !== primary.id ? weaponDps(compare, dpsSettings) : null

    dpsEl.innerHTML = `
      <div class="item-stats-section-title">DPS Calculator</div>
      <div class="item-stats-grid one-col">
        ${numberSetting('accuracy', 'Accuracy level')}
        ${numberSetting('strength', 'Strength level')}
        ${numberSetting('targetDefence', 'Target defence')}
        ${numberSetting('targetHp', 'Target HP')}
        <label class="item-stat-field"><span>Stance</span><select data-dps="stance">${STANCES.map(s => `<option value="${s}"${s === dpsSettings.stance ? ' selected' : ''}>${s}</option>`).join('')}</select></label>
        <label class="item-stat-field"><span>Compare weapon</span><select data-dps="compareId">${weapons.map(w => `<option value="${w.id}"${w.id === Number(dpsSettings.compareId) ? ' selected' : ''}>${esc(itemLabel(w))}</option>`).join('')}</select></label>
      </div>
      <div class="item-stats-presets">
        <button data-preset="requirement">At requirement</button>
        <button data-preset="tierTarget">Same-tier target</button>
      </div>
      ${dpsSummary(primary, a, 'Selected')}
      ${b ? dpsSummary(compare, b, 'Comparison') : ''}
      ${a && b ? `<div class="item-stats-ratio">${esc(primary.name)} is ${(a.dps / b.dps).toFixed(2)}x ${a.dps >= b.dps ? 'higher' : 'lower'} DPS than ${esc(compare.name)}.</div>` : ''}
      ${renderFamilyCompare()}
      ${renderCurveTool()}
    `

    for (const input of dpsEl.querySelectorAll('[data-dps]')) {
      input.addEventListener('change', () => {
        const key = input.dataset.dps
        dpsSettings[key] = key === 'stance' ? input.value : Number(input.value)
        renderDps()
      })
    }
    for (const btn of dpsEl.querySelectorAll('[data-preset]')) {
      btn.addEventListener('click', () => {
        const current = selectedItem()
        if (btn.dataset.preset === 'requirement' && current) {
          const req = current.levelRequired || 1
          dpsSettings.accuracy = req
          dpsSettings.strength = req
        }
        if (btn.dataset.preset === 'tierTarget' && current) {
          dpsSettings.targetDefence = current.levelRequired || 1
          dpsSettings.targetHp = Math.max(10, (current.levelRequired || 1) + 5)
        }
        renderDps()
      })
    }
    for (const input of dpsEl.querySelectorAll('[data-curve]')) {
      input.addEventListener('change', () => {
        const key = input.dataset.curve
        curveSettings[key] = key === 'base' ? Number(input.value) : input.value
        renderDps()
      })
    }
    dpsEl.querySelector('#itemStatsApplyCurve')?.addEventListener('click', () => {
      const changes = curvePreviewRows().filter(r => r.item && r.next !== r.current)
      if (changes.length === 0) {
        setStatus('no curve changes', '#aaa')
        return
      }
      for (const row of changes) row.item[curveSettings.field] = row.next
      markDirty()
      render()
    })
  }

  function numberSetting(key, label) {
    return `<label class="item-stat-field"><span>${label}</span><input data-dps="${key}" type="number" min="1" step="1" value="${esc(dpsSettings[key])}" /></label>`
  }

  function dpsSummary(item, result, title) {
    if (!item || !result) return '<div class="item-stats-empty">Select a weapon to calculate DPS.</div>'
    return `
      <div class="item-stats-dps-card">
        <div class="item-stats-dps-title">${esc(title)} · ${esc(item.name)}</div>
        <div><span>Style</span><b>${esc(item.weaponStyle || 'slash')}</b></div>
        <div><span>Attack bonus</span><b>${attackBonusFor(item)}</b></div>
        <div><span>Strength</span><b>${item.meleeStrength || 0}</b></div>
        <div><span>Hit chance</span><b>${(result.hitChance * 100).toFixed(1)}%</b></div>
        <div><span>Max hit</span><b>${result.maxHit}</b></div>
        <div><span>Interval</span><b>${result.interval.toFixed(1)}s</b></div>
        <div><span>DPS</span><b>${result.dps.toFixed(3)}</b></div>
        <div><span>TTK</span><b>${result.ttk ? `${result.ttk.toFixed(1)}s` : '-'}</b></div>
      </div>
    `
  }

  function familyWeapon(tier, family) {
    return items.find(i => i.equippable && i.equipSlot === 'weapon' && itemTier(i) === tier && itemFamily(i) === family) || null
  }

  function dpsAtRequirement(item) {
    const req = item?.levelRequired || 1
    return weaponDps(item, {
      accuracy: req,
      strength: req,
      targetDefence: req,
      targetHp: Math.max(10, req + 5),
      stance: dpsSettings.stance,
    })
  }

  function renderFamilyCompare() {
    const families = DEFAULT_COMPARE_FAMILIES.filter(f => TIERS.some(t => familyWeapon(t, f)))
    if (families.length === 0) return ''
    const rows = TIERS.map(tier => {
      const cells = families.map(family => {
        const weapon = familyWeapon(tier, family)
        if (!weapon) return '<td>-</td>'
        const result = dpsAtRequirement(weapon)
        return `<td>
          <b>${result?.dps.toFixed(3) ?? '-'}</b>
          <small>max ${result?.maxHit ?? '-'} · str ${weapon.meleeStrength || 0}</small>
        </td>`
      }).join('')
      return `<tr><th>${esc(tier)}</th>${cells}</tr>`
    }).join('')
    return `
      <div class="item-stats-section-title">Family DPS at Requirement</div>
      <table class="item-stats-compare">
        <thead><tr><th>Tier</th>${families.map(f => `<th>${esc(f)}</th>`).join('')}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `
  }

  function availableFamilies() {
    return Array.from(new Set(items
      .filter(i => i.equippable && i.equipSlot === 'weapon' && itemTier(i))
      .map(itemFamily)))
      .sort()
  }

  function curvePreviewRows() {
    const roundFn = curveSettings.round === 'floor'
      ? Math.floor
      : curveSettings.round === 'ceil'
        ? Math.ceil
        : Math.round
    return TIERS.map(tier => {
      const item = familyWeapon(tier, curveSettings.family)
      const multiplier = TIER_MULTIPLIERS[tier] || 1
      return {
        tier,
        item,
        current: item?.[curveSettings.field] ?? 0,
        next: Math.max(0, roundFn((Number(curveSettings.base) || 0) * multiplier)),
      }
    })
  }

  function renderCurveTool() {
    const families = availableFamilies()
    if (!families.includes(curveSettings.family)) curveSettings.family = families[0] || ''
    const fields = ['meleeStrength', 'slashAttack', 'stabAttack', 'crushAttack']
    const rows = curvePreviewRows().map(row => `
      <tr class="${row.item && row.current !== row.next ? 'changed' : ''}">
        <th>${esc(row.tier)}</th>
        <td>${row.item ? esc(row.item.name) : '-'}</td>
        <td>${row.current}</td>
        <td>${row.item ? row.next : '-'}</td>
      </tr>
    `).join('')
    return `
      <div class="item-stats-section-title">Bulk Curve</div>
      <div class="item-stats-grid one-col">
        <label class="item-stat-field"><span>Weapon family</span><select data-curve="family">${families.map(f => `<option value="${esc(f)}"${f === curveSettings.family ? ' selected' : ''}>${esc(f)}</option>`).join('')}</select></label>
        <label class="item-stat-field"><span>Field</span><select data-curve="field">${fields.map(f => `<option value="${f}"${f === curveSettings.field ? ' selected' : ''}>${f}</option>`).join('')}</select></label>
        <label class="item-stat-field"><span>Bronze/base value</span><input data-curve="base" type="number" min="0" step="1" value="${esc(curveSettings.base)}" /></label>
        <label class="item-stat-field"><span>Rounding</span><select data-curve="round">${['round', 'floor', 'ceil'].map(r => `<option value="${r}"${r === curveSettings.round ? ' selected' : ''}>${r}</option>`).join('')}</select></label>
      </div>
      <table class="item-stats-compare curve">
        <thead><tr><th>Tier</th><th>Item</th><th>Now</th><th>Next</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <button id="itemStatsApplyCurve" class="item-stats-apply-curve">Apply Curve</button>
    `
  }

  function render() {
    renderList()
    renderEditor()
    renderDps()
  }

  overlay.querySelector('#itemStatsClose').addEventListener('click', () => {
    overlay.style.display = 'none'
  })
  overlay.querySelector('#itemStatsRevert').addEventListener('click', () => {
    if (dirty && !confirm('Revert unsaved item stat changes?')) return
    items = clone(original)
    selectedId = items.find(i => i.id === selectedId)?.id ?? items[0]?.id ?? null
    dirty = false
    setStatus('reverted', '#aaa')
    render()
  })
  overlay.querySelector('#itemStatsSave').addEventListener('click', async () => {
    try {
      setStatus('saving...', '#fc6')
      const res = await fetch('/api/editor/items', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok || !body.ok) {
        setStatus(body.error || 'save failed', '#e66')
        return
      }
      original = clone(items)
      dirty = false
      options.onSaved?.(clone(items))
      setStatus('saved ✓', '#6e6')
    } catch (err) {
      setStatus(`save failed: ${err.message}`, '#e66')
    }
  })
  overlay.querySelector('#itemStatsSearch').addEventListener('input', e => {
    search = e.target.value
    renderList()
  })
  overlay.querySelector('#itemStatsCategory').addEventListener('change', e => {
    categoryFilter = e.target.value
    renderList()
  })
  overlay.querySelector('#itemStatsTier').addEventListener('change', e => {
    tierFilter = e.target.value
    renderList()
  })

  try {
    setStatus('loading...', '#aaa')
    const res = await fetch('/api/editor/items')
    const body = await res.json()
    if (!res.ok || !body.ok || !Array.isArray(body.items)) throw new Error(body.error || 'Failed to load items')
    items = body.items
    original = clone(items)
    selectedId = items.find(i => i.equippable && i.equipSlot === 'weapon')?.id ?? items[0]?.id ?? null
    const selected = selectedItem()
    if (selected?.levelRequired) {
      dpsSettings.accuracy = selected.levelRequired
      dpsSettings.strength = selected.levelRequired
      dpsSettings.targetDefence = selected.levelRequired
    }
    setStatus('')
    render()
  } catch (err) {
    setStatus(err.message || 'load failed', '#e66')
    editorEl.innerHTML = '<div class="item-stats-empty">Could not load items.</div>'
  }
}
