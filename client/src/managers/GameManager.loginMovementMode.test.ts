import { describe, expect, test } from 'bun:test';
import { PROTOCOL_VERSION, ServerOpcode } from '@projectrs/shared';
import { GameManager } from './GameManager';

function makeManager(initialMode: 'walk' | 'run'): { manager: any; handlers: Map<ServerOpcode, Function>; localModes: string[]; sideModes: string[] } {
  const handlers = new Map<ServerOpcode, Function>();
  const localModes: string[] = [];
  const sideModes: string[] = [];
  const manager = Object.create(GameManager.prototype) as any;
  manager.movementMode = initialMode;
  manager._loginReadySeq = 1;
  manager._loginProgress = null;
  manager.network = {
    on: (opcode: ServerOpcode, handler: Function) => { handlers.set(opcode, handler); },
    setLocalPlayerId: () => {},
    close: () => {},
  };
  manager.localPlayer = {
    setPositionXYZ: () => {},
    setMovementMode: (mode: string) => { localModes.push(mode); },
  };
  manager.sidePanel = {
    applyMovementModeFromServer: (mode: string) => { sideModes.push(mode); },
  };
  manager.inputManager = { setPlayerY: () => {} };
  manager.tryResolveLoginReady = () => undefined;
  manager.setupAuthHandlers();
  return { manager, handlers, localModes, sideModes };
}

function loginValues(modeIndex: number): number[] {
  return [42, 1005, 2005, 0, PROTOCOL_VERSION, modeIndex];
}

describe('GameManager login movement mode bootstrap', () => {
  test('LOGIN_OK resets stale local run mode when server starts the session in walk', () => {
    const { manager, handlers, localModes, sideModes } = makeManager('run');

    handlers.get(ServerOpcode.LOGIN_OK)!(ServerOpcode.LOGIN_OK, loginValues(0));

    expect(manager.movementMode).toBe('walk');
    expect(localModes).toEqual(['walk']);
    expect(sideModes).toEqual(['walk']);
  });

  test('LOGIN_OK applies authoritative server run mode before movement resumes', () => {
    const { manager, handlers, localModes, sideModes } = makeManager('walk');

    handlers.get(ServerOpcode.LOGIN_OK)!(ServerOpcode.LOGIN_OK, loginValues(1));

    expect(manager.movementMode).toBe('run');
    expect(localModes).toEqual(['run']);
    expect(sideModes).toEqual(['run']);
  });
});
