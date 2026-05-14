/**
 * In-game debug panel for adjusting bone rotation offsets in real-time.
 * Toggle with /bonedebug chat command.
 * Lets you visually dial in rotation corrections for specific bones,
 * then copy the values into BONE_ROTATION_OFFSETS.
 */

import { Skeleton } from '@babylonjs/core/Bones/skeleton';
import { Quaternion } from '@babylonjs/core/Maths/math.vector';

const ADJUSTABLE_BONES = [
  'mixamorig:LeftShoulder',
  'mixamorig:RightShoulder',
  'mixamorig:LeftArm',
  'mixamorig:RightArm',
  'mixamorig:LeftForeArm',
  'mixamorig:RightForeArm',
  'mixamorig:LeftHand',
  'mixamorig:RightHand',
  'mixamorig:Spine',
  'mixamorig:Spine1',
  'mixamorig:Spine2',
  'mixamorig:Hips',
];

type SkeletonGetter = () => Skeleton | null;

export class BoneDebugPanel {
  private container: HTMLDivElement;
  private visible = false;
  private getSkeleton: SkeletonGetter = () => null;
  private activeBone = ADJUSTABLE_BONES[0];
  private boneSelect!: HTMLSelectElement;
  private sliders: Map<string, HTMLInputElement> = new Map();
  private numInputs: Map<string, HTMLInputElement> = new Map();
  private offsets: Map<string, { x: number; y: number; z: number }> = new Map();
  private statusLabel!: HTMLSpanElement;
  private applyHandle: number = 0;

  constructor() {
    this.container = this.buildUI();
    document.body.appendChild(this.container);
  }

  get isVisible(): boolean {
    return this.visible;
  }

  setSkeletonGetter(getter: SkeletonGetter): void {
    this.getSkeleton = getter;
  }

  private buildUI(): HTMLDivElement {
    const div = document.createElement('div');
    div.id = 'bone-debug-panel';
    Object.assign(div.style, {
      position: 'fixed', top: '60px', right: '10px', width: '310px',
      background: 'rgba(15,12,8,0.92)', color: '#ddd', fontFamily: 'Arial, Helvetica, sans-serif',
      fontSize: '12px', padding: '12px', borderRadius: '6px', zIndex: '9999',
      display: 'none', userSelect: 'none', border: '1px solid #554a3a',
    });

    // Header
    const header = document.createElement('div');
    Object.assign(header.style, {
      display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px',
    });
    const title = document.createElement('span');
    title.style.cssText = 'font-weight:bold;color:#ff8c00;font-size:13px;';
    title.textContent = 'Bone Offsets';

    this.boneSelect = document.createElement('select');
    Object.assign(this.boneSelect.style, {
      flex: '1', background: '#1a1510', color: '#8cf', border: '1px solid #554a3a',
      borderRadius: '3px', padding: '2px 4px', fontFamily: 'Arial, Helvetica, sans-serif', fontSize: '11px',
    });
    for (const bone of ADJUSTABLE_BONES) {
      const opt = document.createElement('option');
      opt.value = bone;
      opt.textContent = bone.replace('mixamorig:', '');
      this.boneSelect.appendChild(opt);
    }
    this.boneSelect.addEventListener('change', () => {
      this.switchBone(this.boneSelect.value);
    });

    header.appendChild(title);
    header.appendChild(this.boneSelect);
    div.appendChild(header);

    // Rotation sliders
    const axes: { key: string; label: string; color: string }[] = [
      { key: 'x', label: 'Rot X', color: '#f66' },
      { key: 'y', label: 'Rot Y', color: '#6f6' },
      { key: 'z', label: 'Rot Z', color: '#66f' },
    ];

    for (const axis of axes) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;margin-bottom:4px;gap:4px;';

      const label = document.createElement('span');
      label.style.cssText = `width:36px;flex-shrink:0;color:${axis.color};font-size:11px;`;
      label.textContent = axis.label;

      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = '-0.5';
      slider.max = '0.5';
      slider.step = '0.005';
      slider.value = '0';
      slider.style.cssText = 'flex:1;height:14px;cursor:pointer;accent-color:#ff8c00;';

      const numInput = document.createElement('input');
      numInput.type = 'number';
      numInput.min = '-1';
      numInput.max = '1';
      numInput.step = '0.005';
      numInput.value = '0.000';
      Object.assign(numInput.style, {
        width: '58px', flexShrink: '0', background: '#1a1510', color: '#ddd',
        border: '1px solid #3a3530', borderRadius: '2px', padding: '1px 3px',
        fontFamily: 'Arial, Helvetica, sans-serif', fontSize: '11px', textAlign: 'right',
      });

      const resetBtn = document.createElement('button');
      resetBtn.textContent = '↺';
      Object.assign(resetBtn.style, {
        width: '18px', height: '18px', flexShrink: '0', background: 'none',
        color: '#666', border: 'none', cursor: 'pointer', padding: '0',
        fontSize: '12px', lineHeight: '18px',
      });
      resetBtn.addEventListener('mouseenter', () => { resetBtn.style.color = '#ff8c00'; });
      resetBtn.addEventListener('mouseleave', () => { resetBtn.style.color = '#666'; });

      slider.addEventListener('input', () => {
        numInput.value = parseFloat(slider.value).toFixed(3);
        this.storeAndApply();
      });
      numInput.addEventListener('input', () => {
        const v = parseFloat(numInput.value);
        if (!isNaN(v)) {
          slider.value = String(v);
          this.storeAndApply();
        }
      });
      resetBtn.addEventListener('click', () => {
        slider.value = '0';
        numInput.value = '0.000';
        this.storeAndApply();
      });

      row.appendChild(label);
      row.appendChild(slider);
      row.appendChild(numInput);
      row.appendChild(resetBtn);
      div.appendChild(row);

      this.sliders.set(axis.key, slider);
      this.numInputs.set(axis.key, numInput);
    }

    // Mirror button
    const mirrorBtn = document.createElement('button');
    mirrorBtn.textContent = 'Mirror to opposite side';
    Object.assign(mirrorBtn.style, {
      width: '100%', marginTop: '8px', padding: '5px 8px', cursor: 'pointer',
      background: '#2a2a4a', color: '#ddd', border: '1px solid #44a',
      borderRadius: '3px', fontFamily: 'Arial, Helvetica, sans-serif', fontSize: '11px',
    });
    mirrorBtn.addEventListener('click', () => this.mirrorToOpposite());
    div.appendChild(mirrorBtn);

    // Buttons row
    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:6px;margin-top:6px;';

    const copyBtn = document.createElement('button');
    copyBtn.textContent = 'Copy All Code';
    Object.assign(copyBtn.style, {
      flex: '1', padding: '5px 8px', cursor: 'pointer', background: '#2a4a2a',
      color: '#ddd', border: '1px solid #4a4', borderRadius: '3px',
      fontFamily: 'Arial, Helvetica, sans-serif', fontSize: '11px',
    });
    copyBtn.addEventListener('click', () => this.copyAllCode());

    const resetAllBtn = document.createElement('button');
    resetAllBtn.textContent = 'Reset All';
    Object.assign(resetAllBtn.style, {
      flex: '1', padding: '5px 8px', cursor: 'pointer', background: '#4a2a2a',
      color: '#ddd', border: '1px solid #a44', borderRadius: '3px',
      fontFamily: 'Arial, Helvetica, sans-serif', fontSize: '11px',
    });
    resetAllBtn.addEventListener('click', () => {
      this.offsets.clear();
      this.loadBoneValues();
      this.storeAndApply();
      this.flashStatus('Reset all bone offsets');
    });

    btnRow.appendChild(copyBtn);
    btnRow.appendChild(resetAllBtn);
    div.appendChild(btnRow);

    // Status
    this.statusLabel = document.createElement('div');
    this.statusLabel.style.cssText = 'color:#666;font-size:10px;margin-top:6px;text-align:center;height:14px;';
    div.appendChild(this.statusLabel);

    return div;
  }

  toggle(): void {
    this.visible = !this.visible;
    this.container.style.display = this.visible ? 'block' : 'none';
    if (this.visible) {
      this.switchBone(this.activeBone);
      this.startApplyLoop();
    } else {
      this.stopApplyLoop();
    }
  }

  private switchBone(name: string): void {
    this.activeBone = name;
    this.boneSelect.value = name;
    this.loadBoneValues();
  }

  private loadBoneValues(): void {
    const offset = this.offsets.get(this.activeBone) ?? { x: 0, y: 0, z: 0 };
    for (const axis of ['x', 'y', 'z'] as const) {
      const slider = this.sliders.get(axis);
      const num = this.numInputs.get(axis);
      if (slider) slider.value = String(offset[axis]);
      if (num) num.value = offset[axis].toFixed(3);
    }
  }

  private storeAndApply(): void {
    const x = parseFloat(this.numInputs.get('x')?.value ?? '0');
    const y = parseFloat(this.numInputs.get('y')?.value ?? '0');
    const z = parseFloat(this.numInputs.get('z')?.value ?? '0');

    if (x === 0 && y === 0 && z === 0) {
      this.offsets.delete(this.activeBone);
    } else {
      this.offsets.set(this.activeBone, { x, y, z });
    }
  }

  private mirrorToOpposite(): void {
    const name = this.activeBone;
    let opposite: string;
    if (name.includes('Left')) {
      opposite = name.replace('Left', 'Right');
    } else if (name.includes('Right')) {
      opposite = name.replace('Right', 'Left');
    } else {
      this.flashStatus('No opposite side for this bone');
      return;
    }

    const current = this.offsets.get(name);
    if (!current) {
      this.offsets.delete(opposite);
    } else {
      // Mirror: negate Y and Z, keep X (for symmetric left/right bones)
      this.offsets.set(opposite, { x: current.x, y: -current.y, z: -current.z });
    }
    this.flashStatus(`Mirrored to ${opposite.replace('mixamorig:', '')}`);
  }

  private startApplyLoop(): void {
    const skeleton = this.getSkeleton();
    if (!skeleton) return;

    const apply = () => {
      if (!this.visible) return;
      const sk = this.getSkeleton();
      if (sk) this.applyOffsets(sk);
      this.applyHandle = requestAnimationFrame(apply);
    };
    this.applyHandle = requestAnimationFrame(apply);
  }

  private stopApplyLoop(): void {
    cancelAnimationFrame(this.applyHandle);
  }

  private applyOffsets(skeleton: Skeleton): void {
    for (const [boneName, offset] of this.offsets) {
      const bone = skeleton.bones.find(b => b.name === boneName);
      if (!bone) continue;
      const tn = bone.getTransformNode();
      if (!tn || !tn.rotationQuaternion) continue;

      const offsetQuat = Quaternion.FromEulerAngles(offset.x, offset.y, offset.z);
      tn.rotationQuaternion = tn.rotationQuaternion.multiply(offsetQuat);
    }
  }

  private copyAllCode(): void {
    if (this.offsets.size === 0) {
      this.flashStatus('No offsets to copy');
      return;
    }
    const lines: string[] = [];
    for (const [bone, offset] of this.offsets) {
      lines.push(`  '${bone}': { x: ${offset.x}, y: ${offset.y}, z: ${offset.z} },`);
    }
    const code = `const BONE_ROTATION_OFFSETS: Record<string, { x: number; y: number; z: number }> = {\n${lines.join('\n')}\n};`;
    navigator.clipboard.writeText(code).then(() => {
      this.flashStatus('Copied to clipboard');
    }).catch(() => {
      this.flashStatus('Copy failed — see console');
    });
    console.log(`[BoneDebug]\n${code}`);
  }

  private flashStatus(msg: string): void {
    this.statusLabel.textContent = msg;
    this.statusLabel.style.color = '#ff8c00';
    setTimeout(() => {
      this.statusLabel.style.color = '#666';
      this.statusLabel.textContent = '';
    }, 2000);
  }

  dispose(): void {
    this.stopApplyLoop();
    this.container.remove();
  }
}
