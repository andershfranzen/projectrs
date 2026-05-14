import { Scene } from '@babylonjs/core/scene';
import { SceneLoader } from '@babylonjs/core/Loading/sceneLoader';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { Skeleton } from '@babylonjs/core/Bones/skeleton';
import { getThumbnail } from '../rendering/ThumbnailRenderer';

interface ManifestItem {
  file: string;
  name: string;
}

type Manifest = Record<string, ManifestItem[]>;

interface ParsedArmorSet {
  setId: string;
  tiers: Map<string, ManifestItem>;
}

interface ParsedCategory {
  sets: ParsedArmorSet[];
  bases: { type: string; item: ManifestItem }[];
}

type EquipCallback = (category: string, item: ManifestItem, root: TransformNode, skeleton: Skeleton | null) => void;
type UnequipCallback = (category: string) => void;

const CATEGORIES = ['weapons', 'body', 'boots', 'cape', 'gauntlets', 'helmet', 'legs'] as const;
const ARMOR_CATEGORIES = ['body', 'boots', 'cape', 'gauntlets', 'helmet', 'legs'] as const;

const CAT_LABELS: Record<string, string> = {
  weapons: 'Weapons', body: 'Body', boots: 'Boots',
  cape: 'Cape', gauntlets: 'Gauntlets', helmet: 'Helmet', legs: 'Legs',
};

const CAT_SHORT: Record<string, string> = {
  weapons: 'W', body: 'Bo', boots: 'Bt',
  cape: 'Ca', gauntlets: 'Ga', helmet: 'He', legs: 'Le',
};

const CAT_COLORS: Record<string, string> = {
  weapons: '#f66', body: '#6cf', boots: '#c96',
  cape: '#c6f', gauntlets: '#6f6', helmet: '#ff6', legs: '#6ff',
};

const THUMB_SIZE = 56;

export class ArmorBrowserPanel {
  private container: HTMLDivElement;
  private visible = false;
  private manifest: Manifest = {};
  private parsed: Map<string, ParsedCategory> = new Map();
  private scene: Scene | null = null;
  private activeCategory: string = 'weapons';
  private tabRow!: HTMLDivElement;
  private summaryRow!: HTMLDivElement;
  private contentArea!: HTMLDivElement;
  private statusLabel!: HTMLDivElement;
  private equipped: Map<string, { name: string; item: ManifestItem }> = new Map();
  private onEquip: EquipCallback = () => {};
  private onUnequip: UnequipCallback = () => {};
  private loadingItems: Set<string> = new Set();
  private thumbCache: Map<string, string> = new Map();

  // Drag state
  private dragOffsetX = 0;
  private dragOffsetY = 0;
  private isDragging = false;

  constructor() {
    this.container = this.buildUI();
    document.body.appendChild(this.container);
  }

  get isVisible(): boolean { return this.visible; }
  setScene(scene: Scene): void { this.scene = scene; }
  setEquipCallback(cb: EquipCallback): void { this.onEquip = cb; }
  setUnequipCallback(cb: UnequipCallback): void { this.onUnequip = cb; }

  async loadManifest(): Promise<void> {
    try {
      const resp = await fetch('/assets/equipment/polytope/manifest.json');
      this.manifest = await resp.json();
      this.parseManifest();
      this.render();
    } catch (e) {
      console.warn('[ArmorBrowser] Failed to load manifest:', e);
    }
  }

  private parseManifest(): void {
    for (const cat of ARMOR_CATEGORIES) {
      const items = this.manifest[cat] || [];
      const setMap = new Map<string, Map<string, ManifestItem>>();
      const bases: { type: string; item: ManifestItem }[] = [];

      for (const item of items) {
        const setTier = item.file.match(/Armor_(\d+)_([ABC])_/);
        if (setTier) {
          const [, setId, tier] = setTier;
          if (!setMap.has(setId)) setMap.set(setId, new Map());
          setMap.get(setId)!.set(tier, item);
          continue;
        }
        const base = item.file.match(/Armor_(cloth|leather|naked|plate)_/);
        if (base) {
          bases.push({ type: base[1], item });
        }
      }

      const sets: ParsedArmorSet[] = [...setMap.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([setId, tiers]) => ({ setId, tiers }));

      this.parsed.set(cat, { sets, bases });
    }
  }

  private buildUI(): HTMLDivElement {
    const div = document.createElement('div');
    div.id = 'armor-browser-panel';
    Object.assign(div.style, {
      position: 'fixed', top: '60px', right: '10px',
      width: '520px', maxHeight: '80vh',
      background: 'rgba(12,10,6,0.96)', color: '#ddd', fontFamily: 'Arial, Helvetica, sans-serif',
      fontSize: '12px', borderRadius: '6px', zIndex: '9999',
      display: 'none', userSelect: 'none', border: '1px solid #554a3a',
      boxShadow: '0 4px 20px rgba(0,0,0,0.6)',
      overflow: 'hidden',
    });

    // Draggable title bar
    const titleBar = document.createElement('div');
    Object.assign(titleBar.style, {
      padding: '10px 14px', cursor: 'move',
      background: 'rgba(20,16,10,0.98)',
      borderBottom: '1px solid #3a3020',
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    });
    const title = document.createElement('span');
    title.style.cssText = 'font-weight:bold;color:#d8372b;font-size:13px;letter-spacing:1px;';
    title.textContent = 'ARMOR BROWSER';
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '×';
    Object.assign(closeBtn.style, {
      background: 'none', border: 'none', color: '#666', fontSize: '18px',
      cursor: 'pointer', padding: '0 4px', lineHeight: '1',
    });
    closeBtn.addEventListener('mouseenter', () => { closeBtn.style.color = '#f66'; });
    closeBtn.addEventListener('mouseleave', () => { closeBtn.style.color = '#666'; });
    closeBtn.addEventListener('click', () => this.toggle());
    titleBar.appendChild(title);
    titleBar.appendChild(closeBtn);
    div.appendChild(titleBar);

    // Drag handlers
    titleBar.addEventListener('mousedown', (e) => {
      this.isDragging = true;
      this.dragOffsetX = e.clientX - div.offsetLeft;
      this.dragOffsetY = e.clientY - div.offsetTop;
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!this.isDragging) return;
      div.style.left = `${e.clientX - this.dragOffsetX}px`;
      div.style.top = `${e.clientY - this.dragOffsetY}px`;
      div.style.right = 'auto';
      div.style.transform = 'none';
    });
    document.addEventListener('mouseup', () => { this.isDragging = false; });

    // Body (padded content)
    const body = document.createElement('div');
    body.style.cssText = 'padding:10px 14px 14px;';

    // Category tabs
    this.tabRow = document.createElement('div');
    this.tabRow.style.cssText = 'display:flex;gap:2px;margin-bottom:8px;';
    body.appendChild(this.tabRow);

    // Equipped summary
    this.summaryRow = document.createElement('div');
    this.summaryRow.style.cssText = 'display:flex;gap:3px;margin-bottom:10px;padding:6px 4px;background:#0e0c08;border-radius:4px;border:1px solid #1a1510;';
    body.appendChild(this.summaryRow);

    // Content area
    this.contentArea = document.createElement('div');
    Object.assign(this.contentArea.style, {
      maxHeight: 'calc(80vh - 200px)', overflowY: 'auto', overflowX: 'hidden',
    });
    body.appendChild(this.contentArea);

    // Bottom buttons
    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:6px;margin-top:10px;';
    const unequipSlotBtn = this.makeBtn('Unequip Slot', '#3a2020', '#844', () => this.unequipCategory(this.activeCategory));
    const unequipAllBtn = this.makeBtn('Unequip All', '#4a2a2a', '#a44', () => this.unequipAll());
    unequipSlotBtn.style.flex = '1';
    unequipAllBtn.style.flex = '1';
    btnRow.appendChild(unequipSlotBtn);
    btnRow.appendChild(unequipAllBtn);
    body.appendChild(btnRow);

    // Status
    this.statusLabel = document.createElement('div');
    this.statusLabel.style.cssText = 'color:#555;font-size:10px;margin-top:6px;text-align:center;height:14px;';
    body.appendChild(this.statusLabel);

    div.appendChild(body);
    return div;
  }

  private render(): void {
    this.renderTabs();
    this.renderSummary();
    if (this.activeCategory === 'weapons') {
      this.renderWeaponGrid();
    } else {
      this.renderArmorGrid(this.activeCategory);
    }
  }

  private renderTabs(): void {
    this.tabRow.innerHTML = '';
    for (const cat of CATEGORIES) {
      if (!this.manifest[cat] || this.manifest[cat].length === 0) continue;
      const btn = document.createElement('button');
      const isActive = cat === this.activeCategory;
      const color = CAT_COLORS[cat] || '#888';
      const hasEquipped = this.equipped.has(cat);
      btn.textContent = CAT_LABELS[cat];
      Object.assign(btn.style, {
        flex: '1', padding: '5px 2px', cursor: 'pointer',
        background: isActive ? '#2a2518' : '#12100c',
        color: isActive ? color : hasEquipped ? color : '#555',
        border: 'none',
        borderBottom: isActive ? `2px solid ${color}` : hasEquipped ? `2px solid ${color}44` : '2px solid transparent',
        borderRadius: '3px 3px 0 0',
        fontFamily: 'Arial, Helvetica, sans-serif', fontSize: '10px', fontWeight: isActive ? 'bold' : 'normal',
      });
      btn.addEventListener('click', () => { this.activeCategory = cat; this.render(); });
      this.tabRow.appendChild(btn);
    }
  }

  private renderSummary(): void {
    this.summaryRow.innerHTML = '';
    for (const cat of CATEGORIES) {
      const eq = this.equipped.get(cat);
      const color = CAT_COLORS[cat] || '#888';
      const badge = document.createElement('div');
      Object.assign(badge.style, {
        flex: '1', textAlign: 'center', padding: '3px 2px',
        borderRadius: '3px', cursor: 'pointer', fontSize: '9px',
        background: eq ? `${color}15` : 'transparent',
        border: eq ? `1px solid ${color}44` : '1px solid transparent',
        color: eq ? color : '#333',
      });
      const label = CAT_SHORT[cat];
      if (eq) {
        const m = eq.item.file.match(/Armor_(\d+)_([ABC])_/) || eq.item.file.match(/Armor_(cloth|leather|naked|plate)_/);
        const short = m ? (m[2] ? `${m[1]}${m[2]}` : m[1].slice(0, 3)) : eq.name.split(' ')[0].slice(0, 5);
        badge.textContent = `${label}:${short}`;
      } else {
        badge.textContent = label;
      }
      badge.addEventListener('click', () => { this.activeCategory = cat; this.render(); });
      this.summaryRow.appendChild(badge);
    }
  }

  private renderArmorGrid(category: string): void {
    this.contentArea.innerHTML = '';
    const parsed = this.parsed.get(category);
    if (!parsed) return;
    const color = CAT_COLORS[category] || '#888';
    const equippedItem = this.equipped.get(category);

    // Header
    const header = document.createElement('div');
    header.style.cssText = 'display:grid;grid-template-columns:50px 1fr 1fr 1fr 44px;gap:4px;margin-bottom:4px;';
    header.appendChild(this.makeLabel(''));
    for (const tier of ['Tier A', 'Tier B', 'Tier C']) {
      const h = document.createElement('div');
      h.style.cssText = 'text-align:center;color:#666;font-size:10px;font-weight:bold;padding:2px;';
      h.textContent = tier;
      header.appendChild(h);
    }
    header.appendChild(this.makeLabel(''));
    this.contentArea.appendChild(header);

    // Set rows
    for (const set of parsed.sets) {
      const row = document.createElement('div');
      row.style.cssText = 'display:grid;grid-template-columns:50px 1fr 1fr 1fr 44px;gap:4px;margin-bottom:4px;';

      const setLabel = document.createElement('div');
      setLabel.style.cssText = 'display:flex;align-items:center;color:#888;font-size:11px;font-weight:bold;';
      setLabel.textContent = `Set ${set.setId}`;
      row.appendChild(setLabel);

      for (const tier of ['A', 'B', 'C']) {
        const item = set.tiers.get(tier);
        row.appendChild(this.makeThumbCell(item, equippedItem, color, category));
      }

      const equipSetBtn = document.createElement('button');
      equipSetBtn.textContent = 'ALL';
      Object.assign(equipSetBtn.style, {
        padding: '4px 2px', cursor: 'pointer', fontSize: '9px', fontWeight: 'bold',
        background: '#1a1a2a', color: '#88f', border: '1px solid #44a',
        borderRadius: '3px', fontFamily: 'Arial, Helvetica, sans-serif', alignSelf: 'center',
      });
      equipSetBtn.title = `Equip Set ${set.setId} across all armor slots`;
      equipSetBtn.addEventListener('click', () => this.equipFullSet(set.setId, this.getSelectedTier()));
      row.appendChild(equipSetBtn);

      this.contentArea.appendChild(row);
    }

    // Tier selector for ALL buttons
    if (parsed.sets.length > 0) {
      const tierRow = document.createElement('div');
      tierRow.id = 'armor-tier-selector';
      tierRow.style.cssText = 'display:flex;gap:4px;margin:6px 0 4px;justify-content:flex-end;align-items:center;';
      const tierLabel = document.createElement('span');
      tierLabel.style.cssText = 'color:#555;font-size:10px;';
      tierLabel.textContent = 'ALL uses tier:';
      tierRow.appendChild(tierLabel);
      for (const tier of ['A', 'B', 'C']) {
        const tb = document.createElement('button');
        tb.textContent = tier;
        tb.dataset.tier = tier;
        const isDefault = tier === 'A';
        Object.assign(tb.style, {
          padding: '2px 8px', cursor: 'pointer', fontSize: '10px',
          background: isDefault ? '#2a2a3a' : '#12100c',
          color: isDefault ? '#aaf' : '#555',
          border: `1px solid ${isDefault ? '#66a' : '#2a2520'}`,
          borderRadius: '3px', fontFamily: 'Arial, Helvetica, sans-serif',
        });
        tb.addEventListener('click', () => {
          tierRow.querySelectorAll('button').forEach((b: any) => {
            const active = b.dataset.tier === tier;
            b.style.background = active ? '#2a2a3a' : '#12100c';
            b.style.color = active ? '#aaf' : '#555';
            b.style.border = `1px solid ${active ? '#66a' : '#2a2520'}`;
          });
        });
        tierRow.appendChild(tb);
      }
      this.contentArea.appendChild(tierRow);
    }

    // Base types
    if (parsed.bases.length > 0) {
      const sep = document.createElement('div');
      sep.style.cssText = 'border-top:1px solid #2a2520;margin:10px 0 8px;';
      this.contentArea.appendChild(sep);

      const baseLabel = document.createElement('div');
      baseLabel.style.cssText = 'color:#777;font-size:10px;font-weight:bold;margin-bottom:6px;';
      baseLabel.textContent = 'BASE TYPES';
      this.contentArea.appendChild(baseLabel);

      const baseRow = document.createElement('div');
      baseRow.style.cssText = 'display:grid;grid-template-columns:repeat(4,1fr);gap:4px;';
      for (const base of parsed.bases) {
        baseRow.appendChild(this.makeThumbCell(base.item, equippedItem, color, category, base.type));
      }
      this.contentArea.appendChild(baseRow);
    }
  }

  private renderWeaponGrid(): void {
    this.contentArea.innerHTML = '';
    const items = this.manifest['weapons'] || [];
    const color = CAT_COLORS['weapons'];
    const equippedItem = this.equipped.get('weapons');

    const grid = document.createElement('div');
    grid.style.cssText = `display:grid;grid-template-columns:repeat(4,1fr);gap:4px;`;

    for (const item of items) {
      grid.appendChild(this.makeThumbCell(item, equippedItem, color, 'weapons'));
    }
    this.contentArea.appendChild(grid);
  }

  private makeThumbCell(
    item: ManifestItem | undefined,
    equippedItem: { name: string; item: ManifestItem } | undefined,
    color: string,
    category: string,
    labelOverride?: string,
  ): HTMLElement {
    const cell = document.createElement('div');

    if (!item) {
      Object.assign(cell.style, {
        height: `${THUMB_SIZE + 20}px`, background: '#0a0a08',
        border: '1px dashed #1a1510', borderRadius: '4px',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: '#222', fontSize: '16px',
      });
      cell.textContent = '—';
      return cell;
    }

    const isEquipped = equippedItem?.item.file === item.file;
    const isLoading = this.loadingItems.has(item.file);
    const tierMatch = item.file.match(/_([ABC])_/);
    const label = labelOverride || (tierMatch ? `Tier ${tierMatch[1]}` : item.name);

    Object.assign(cell.style, {
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      padding: '4px', cursor: isLoading ? 'wait' : 'pointer',
      background: isEquipped ? `${color}18` : '#1a1510',
      border: `1px solid ${isEquipped ? color : '#2a2520'}`,
      borderRadius: '4px', transition: 'all 0.1s',
      position: 'relative',
    });
    if (isEquipped) cell.style.boxShadow = `0 0 8px ${color}22`;

    // Thumbnail container
    const thumbEl = document.createElement('div');
    Object.assign(thumbEl.style, {
      width: `${THUMB_SIZE}px`, height: `${THUMB_SIZE}px`,
      background: '#0e0c08', borderRadius: '3px',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      overflow: 'hidden',
    });

    // Check cache or render thumbnail
    const cached = this.thumbCache.get(item.file);
    if (cached) {
      const img = document.createElement('img');
      img.src = cached;
      img.style.cssText = `width:${THUMB_SIZE}px;height:${THUMB_SIZE}px;object-fit:contain;`;
      thumbEl.appendChild(img);
    } else {
      const placeholder = document.createElement('div');
      placeholder.style.cssText = 'color:#333;font-size:9px;text-align:center;';
      placeholder.textContent = '...';
      thumbEl.appendChild(placeholder);
      this.loadThumb(item.file, thumbEl);
    }
    cell.appendChild(thumbEl);

    // Label
    const labelEl = document.createElement('div');
    Object.assign(labelEl.style, {
      color: isEquipped ? color : '#999', fontSize: '9px',
      fontWeight: isEquipped ? 'bold' : 'normal',
      marginTop: '3px', textAlign: 'center',
      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      width: '100%', textTransform: 'capitalize',
    });
    labelEl.textContent = label;
    cell.appendChild(labelEl);

    if (!isLoading) {
      cell.addEventListener('click', () => {
        if (isEquipped) this.unequipCategory(category);
        else this.equipItem(category, item);
      });
      cell.addEventListener('mouseenter', () => {
        if (!isEquipped) { cell.style.background = '#252015'; cell.style.borderColor = '#3a3520'; }
      });
      cell.addEventListener('mouseleave', () => {
        if (!isEquipped) { cell.style.background = '#1a1510'; cell.style.borderColor = '#2a2520'; }
      });
    }

    cell.title = item.name;
    return cell;
  }

  private async loadThumb(file: string, container: HTMLElement): Promise<void> {
    const url = await getThumbnail(file);
    if (url) {
      this.thumbCache.set(file, url);
      container.innerHTML = '';
      const img = document.createElement('img');
      img.src = url;
      img.style.cssText = `width:${THUMB_SIZE}px;height:${THUMB_SIZE}px;object-fit:contain;`;
      container.appendChild(img);
    } else {
      container.innerHTML = '<div style="color:#444;font-size:9px;">no preview</div>';
    }
  }

  private getSelectedTier(): string {
    const selector = this.contentArea.querySelector('#armor-tier-selector');
    if (!selector) return 'A';
    const active = selector.querySelector('button[style*="aaf"]') as HTMLElement | null;
    return active?.dataset?.tier || 'A';
  }

  private makeLabel(text: string): HTMLElement {
    const el = document.createElement('div');
    el.textContent = text;
    el.style.cssText = 'display:flex;align-items:center;color:#555;font-size:10px;';
    return el;
  }

  private makeBtn(text: string, bg: string, borderColor: string, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.textContent = text;
    Object.assign(btn.style, {
      padding: '6px 8px', cursor: 'pointer', background: bg, color: '#ddd',
      border: `1px solid ${borderColor}`, borderRadius: '3px',
      fontFamily: 'Arial, Helvetica, sans-serif', fontSize: '11px',
    });
    btn.addEventListener('click', onClick);
    return btn;
  }

  private async equipItem(category: string, item: ManifestItem): Promise<void> {
    if (!this.scene || this.loadingItems.has(item.file)) return;
    this.unequipCategory(category);
    this.loadingItems.add(item.file);
    this.render();

    try {
      const lastSlash = item.file.lastIndexOf('/');
      const dir = item.file.substring(0, lastSlash + 1);
      const file = item.file.substring(lastSlash + 1);

      const result = await SceneLoader.ImportMeshAsync('', dir, file, this.scene);
      const root = new TransformNode(`polytope_${category}_preview`, this.scene);
      const loaderRoot = result.meshes.find(m => m.name === '__root__');
      for (const mesh of result.meshes) {
        if (!mesh.parent || mesh.parent.name === '__root__') {
          mesh.parent = root;
        }
      }
      if (loaderRoot) {
        for (const child of loaderRoot.getChildren()) {
          (child as TransformNode).parent = root;
        }
      }
      const skeleton = result.skeletons.length > 0 ? result.skeletons[0] : null;

      this.equipped.set(category, { name: item.name, item });
      this.onEquip(category, item, root, skeleton);
    } catch (e) {
      console.warn(`[ArmorBrowser] Failed to load ${item.file}:`, e);
      this.flashStatus(`Failed to load ${item.name}`);
    } finally {
      this.loadingItems.delete(item.file);
      this.render();
    }
  }

  private async equipFullSet(setId: string, tier: string): Promise<void> {
    this.flashStatus(`Equipping Set ${setId} Tier ${tier}...`);
    for (const cat of ARMOR_CATEGORIES) {
      const parsed = this.parsed.get(cat);
      if (!parsed) continue;
      const set = parsed.sets.find(s => s.setId === setId);
      const item = set?.tiers.get(tier);
      if (item) await this.equipItem(cat, item);
    }
    this.flashStatus(`Set ${setId} Tier ${tier} equipped`);
  }

  private unequipCategory(category: string): void {
    if (this.equipped.has(category)) {
      this.equipped.delete(category);
      this.onUnequip(category);
      this.render();
    }
  }

  private unequipAll(): void {
    for (const cat of [...this.equipped.keys()]) {
      this.equipped.delete(cat);
      this.onUnequip(cat);
    }
    this.render();
  }

  private flashStatus(msg: string): void {
    this.statusLabel.textContent = msg;
    this.statusLabel.style.color = '#d8372b';
    setTimeout(() => { this.statusLabel.style.color = '#555'; this.statusLabel.textContent = ''; }, 2500);
  }

  toggle(): void {
    this.visible = !this.visible;
    this.container.style.display = this.visible ? 'block' : 'none';
    if (this.visible && Object.keys(this.manifest).length === 0) {
      this.loadManifest();
    }
  }

  dispose(): void {
    this.container.remove();
  }
}
