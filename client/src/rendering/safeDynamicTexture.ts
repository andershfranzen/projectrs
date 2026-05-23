import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture';

type DynamicTextureUpdate = DynamicTexture['update'];

const PATCH_FLAG = '__projectrsSafeDynamicTextureUpdate';

export function installSafeDynamicTextureUpdate(): void {
  const proto = DynamicTexture.prototype as DynamicTexture & Record<string, unknown>;
  if (proto[PATCH_FLAG]) return;

  const originalUpdate = proto.update as DynamicTextureUpdate;
  proto.update = function safeUpdate(this: DynamicTexture, ...args: Parameters<DynamicTextureUpdate>): ReturnType<DynamicTextureUpdate> {
    try {
      if (!this.getInternalTexture()) return undefined as ReturnType<DynamicTextureUpdate>;
      return originalUpdate.apply(this, args);
    } catch (error) {
      if (error instanceof TypeError && String(error.message).includes('updateDynamicTexture')) {
        return undefined as ReturnType<DynamicTextureUpdate>;
      }
      throw error;
    }
  } as DynamicTextureUpdate;

  proto[PATCH_FLAG] = true;
}
