import { describe, expect, test } from 'bun:test';
import { handleChatSocketClose, handleChatSocketMessage, handleChatSocketOpen } from '../src/network/ChatSocket';

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

function makeCollectingSocket(username: string, accountId: number, isAdmin: boolean = false): { ws: any; payloads: any[] } {
  const payloads: any[] = [];
  return {
    payloads,
    ws: {
      data: { type: 'chat', accountId, username, isAdmin, isModerator: false },
      send(message: string) {
        payloads.push(JSON.parse(message));
      },
      getBufferedAmount() {
        return 0;
      },
      close() {},
    },
  };
}

function makeSocialWorld(extra: Record<string, unknown> = {}): any {
  return {
    players: new Map(),
    db: {
      listSocialRelations() {
        return { friends: [], ignore: [] };
      },
      ...extra,
    },
  };
}

describe('admin chat teleport commands', () => {
  test('muted local chat echoes normally to sender and scrambles for others', () => {
    const sender = makeCollectingSocket('Muted', 42);
    const senderOtherTab = makeCollectingSocket('Muted', 42);
    const other = makeCollectingSocket('Other', 43);
    const world = makeSocialWorld({
      isAccountMuted(accountId: number) {
        return accountId === 42 ? { reason: 'spam', mutedAt: 1000, expiresAt: null } : null;
      },
    });

    try {
      handleChatSocketOpen(sender.ws, world);
      handleChatSocketOpen(senderOtherTab.ws, world);
      handleChatSocketOpen(other.ws, world);
      sender.payloads.length = 0;
      senderOtherTab.payloads.length = 0;
      other.payloads.length = 0;

      handleChatSocketMessage(sender.ws, JSON.stringify({ type: 'local', message: 'meet me at bank' }), world);

      const senderLocal = sender.payloads.find(payload => payload.type === 'local');
      const senderOtherTabLocal = senderOtherTab.payloads.find(payload => payload.type === 'local');
      const otherLocal = other.payloads.find(payload => payload.type === 'local');
      expect(senderLocal).toMatchObject({ type: 'local', from: 'Muted', message: 'meet me at bank' });
      expect(senderOtherTabLocal).toMatchObject({ type: 'local', from: 'Muted', message: 'meet me at bank' });
      expect(otherLocal?.type).toBe('local');
      expect(otherLocal?.from).toBe('Muted');
      expect(otherLocal?.message).not.toBe('meet me at bank');
      expect(otherLocal?.message).toMatch(/^[a-z ]+$/);
      expect(otherLocal?.message.split(/\s+/).length).toBeGreaterThanOrEqual(3);
    } finally {
      handleChatSocketClose(sender.ws, world);
      handleChatSocketClose(senderOtherTab.ws, world);
      handleChatSocketClose(other.ws, world);
    }
  });

  test('/mute stores a temporary account mute for admins', () => {
    const muteCalls: any[] = [];
    const world: any = {
      players: new Map(),
      db: {
        getAccountIdByUsername(username: string) {
          return username.toLowerCase() === 'target' ? 2 : null;
        },
        getAccountModerationInfo(accountId: number) {
          return accountId === 2 ? { accountId, username: 'Target', isAdmin: false, isModerator: false } : null;
        },
        muteAccount(accountId: number, reason: string, mutedBy: string, expiresAt: number | null) {
          muteCalls.push({ accountId, reason, mutedBy, expiresAt });
        },
      },
    };
    const { ws, messages } = makeAdminSocket('Admin');

    handleChatSocketMessage(ws, JSON.stringify({ type: 'local', message: '/mute Target 30m spamming chat' }), world);

    expect(muteCalls).toHaveLength(1);
    expect(muteCalls[0].accountId).toBe(2);
    expect(muteCalls[0].reason).toBe('spamming chat');
    expect(muteCalls[0].mutedBy).toBe('Admin');
    expect(muteCalls[0].expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(messages[0]).toContain('Muted Target');
  });

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

  test('/spawn defaults to the kcmap spawn even when admin is inside a dungeon', () => {
    const admin = makePlayer(1, 'Admin', 'the_sultans_mine', 32.5, 32.5);
    const transitions: any[] = [];
    const teleports: any[] = [];
    const world: any = {
      players: new Map([[admin.id, admin]]),
      getMap(mapId: string) {
        if (mapId === 'kcmap') return { meta: { spawnPoint: { x: 192.5, z: 128.5 } } };
        if (mapId === 'the_sultans_mine') return { meta: { spawnPoint: { x: 32.5, z: 32.5 } } };
        return null;
      },
      abortTrade() {},
      closeDialogueForPlayer() {},
      teleportPlayer(...args: any[]) { teleports.push(args); },
      handleMapTransition(player: any, transition: any) { transitions.push({ player, transition }); },
    };
    const { ws, messages } = makeAdminSocket('Admin');

    handleChatSocketMessage(ws, JSON.stringify({ type: 'local', message: '/spawn' }), world);

    expect(teleports).toHaveLength(0);
    expect(transitions).toEqual([{
      player: admin,
      transition: {
        targetMap: 'kcmap',
        targetX: 192.5,
        targetZ: 128.5,
        targetFloor: 0,
      },
    }]);
    expect(messages).toContain('Teleported to kcmap spawn');
  });

  test('/spawn here keeps the old current-map spawn behavior', () => {
    const admin = makePlayer(1, 'Admin', 'the_sultans_mine', 44.5, 44.5);
    const transitions: any[] = [];
    const teleports: any[] = [];
    const world: any = {
      players: new Map([[admin.id, admin]]),
      getMap(mapId: string) {
        if (mapId === 'the_sultans_mine') return { meta: { spawnPoint: { x: 32.5, z: 32.5 } } };
        return null;
      },
      abortTrade() {},
      closeDialogueForPlayer() {},
      teleportPlayer(...args: any[]) { teleports.push(args); },
      handleMapTransition(player: any, transition: any) { transitions.push({ player, transition }); },
    };
    const { ws, messages } = makeAdminSocket('Admin');

    handleChatSocketMessage(ws, JSON.stringify({ type: 'local', message: '/spawn here' }), world);

    expect(transitions).toHaveLength(0);
    expect(teleports).toEqual([[admin, 32.5, 32.5, undefined, 0]]);
    expect(messages).toContain('Teleported to the_sultans_mine spawn');
  });

  test('/rename changes an account name through the database and active world state', () => {
    const admin = makePlayer(1, 'Admin', 'kcmap', 5.5, 6.5);
    admin.accountId = 1;
    const target = makePlayer(2, 'Target', 'kcmap', 12.5, 34.5);
    target.accountId = 2;
    const renameActiveCalls: any[] = [];
    const world: any = {
      players: new Map([[admin.id, admin], [target.id, target]]),
      renameActiveAccount(accountId: number, username: string) {
        renameActiveCalls.push({ accountId, username });
        target.name = username;
        return true;
      },
      db: {
        getAccountIdByUsername(username: string) {
          return username.toLowerCase() === 'target' ? 2 : null;
        },
        renameAccount(accountId: number, username: string) {
          return { ok: true, accountId, oldUsername: 'Target', username };
        },
      },
    };
    const { ws, messages } = makeAdminSocket('Admin');

    handleChatSocketMessage(ws, JSON.stringify({ type: 'local', message: '/rename Target NewName' }), world);

    expect(renameActiveCalls).toEqual([{ accountId: 2, username: 'NewName' }]);
    expect(target.name).toBe('NewName');
    expect(messages).toContain('Renamed Target to NewName.');
  });
});
