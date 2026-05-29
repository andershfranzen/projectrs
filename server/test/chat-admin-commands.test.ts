import { describe, expect, test } from 'bun:test';
import { handleChatSocketMessage } from '../src/network/ChatSocket';

function makePlayer(
  id: number,
  name: string,
  map: string,
  x: number,
  z: number,
  floor: number = 0,
  y: number = 0,
): any {
  return {
    id,
    name,
    currentMapLevel: map,
    currentFloor: floor,
    position: { x, y: z },
    effectiveY: y,
    openInterface: null,
    openShopNpcId: null,
    openShopNpcEntityId: null,
    pendingInteraction: null,
  };
}

function makeAdminSocket(username: string): { ws: any; messages: string[] } {
  const messages: string[] = [];
  return {
    messages,
    ws: {
      data: { type: 'chat', accountId: 1, username, isAdmin: true },
      send(message: string) {
        messages.push(JSON.parse(message).message);
      },
    },
  };
}

describe('admin chat teleport commands', () => {
  test('/tpto teleports the admin to another player across maps', () => {
    const admin = makePlayer(1, 'Admin', 'kcmap', 5.5, 6.5);
    const target = makePlayer(2, 'Target', 'mine', 12.5, 34.5, 2, 3.25);
    const transitions: any[] = [];
    const teleports: any[] = [];
    const world: any = {
      players: new Map([[admin.id, admin], [target.id, target]]),
      abortTrade() {},
      closeDialogueForPlayer() {},
      teleportPlayer(...args: any[]) { teleports.push(args); },
      handleMapTransition(player: any, transition: any) { transitions.push({ player, transition }); },
    };
    const { ws, messages } = makeAdminSocket('Admin');

    handleChatSocketMessage(ws, JSON.stringify({ type: 'local', message: '/tpto Target' }), world);

    expect(teleports).toHaveLength(0);
    expect(transitions).toEqual([{
      player: admin,
      transition: {
        targetMap: 'mine',
        targetX: 12.5,
        targetZ: 34.5,
        targetFloor: 2,
        targetY: 3.25,
      },
    }]);
    expect(messages).toContain('Teleported to Target.');
  });

  test('/summon teleports the target to the admin and closes target trade state', () => {
    const admin = makePlayer(1, 'Admin', 'kcmap', 5.5, 6.5, 1, 2.75);
    const target = makePlayer(2, 'Target', 'kcmap', 12.5, 34.5);
    target.openInterface = 'trade';
    const aborts: any[] = [];
    const teleports: any[] = [];
    const world: any = {
      players: new Map([[admin.id, admin], [target.id, target]]),
      abortTrade(playerId: number, reason: number) { aborts.push({ playerId, reason }); },
      closeDialogueForPlayer() {},
      teleportPlayer(...args: any[]) { teleports.push(args); },
      handleMapTransition() {},
    };
    const { ws, messages } = makeAdminSocket('Admin');

    handleChatSocketMessage(ws, JSON.stringify({ type: 'local', message: '/summon Target' }), world);

    expect(aborts).toEqual([{ playerId: target.id, reason: 2 }]);
    expect(target.openInterface).toBe(null);
    expect(teleports).toEqual([[target, 5.5, 6.5, 2.75, 1]]);
    expect(messages).toContain('Summoned Target.');
  });
});
