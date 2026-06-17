import { describe, expect, test } from 'bun:test';
import { broadcastPlayerInfo, handleChatSocketClose, handleChatSocketMessage, handleChatSocketOpen } from '../src/network/ChatSocket';

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

function makeCollectingSocket(username: string, accountId: number, isAdmin: boolean = false, isModerator: boolean = false): { ws: any; payloads: any[] } {
  const payloads: any[] = [];
  return {
    payloads,
    ws: {
      data: { type: 'chat', accountId, username, isAdmin, isModerator },
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
  test('/ipban account-bans known accounts and kicks every online player from that IP', () => {
    const admin = makeAdminSocket('Admin');
    const calls: string[] = [];
    const world = makeSocialWorld({
      getAccountIdByUsername(name: string) {
        calls.push(`lookup:${name}`);
        return name === 'Target' ? 2 : null;
      },
      getLatestIpForAccount(accountId: number) {
        calls.push(`latest:${accountId}`);
        return accountId === 2 ? '203.0.113.9' : null;
      },
      banIp(ip: string, reason: string, by: string) {
        calls.push(`ban-ip:${ip}:${reason}:${by}`);
      },
      banAccountsForIp(ip: string, reason: string, by: string) {
        calls.push(`ban-accounts:${ip}:${reason}:${by}`);
        return [2, 3];
      },
    });
    world.kickPlayersFromIp = (ip: string) => {
      calls.push(`kick-ip:${ip}`);
      return 2;
    };
    world.kickAccountIfOnline = (accountId: number) => {
      calls.push(`kick-account:${accountId}`);
    };

    handleChatSocketMessage(admin.ws, JSON.stringify({ type: 'local', message: '/ipban Target botting' }), world);

    expect(calls).toEqual([
      'lookup:Target',
      'latest:2',
      'ban-ip:203.0.113.9:botting:Admin',
      'ban-accounts:203.0.113.9:botting:Admin',
      'kick-account:2',
      'kick-account:3',
      'kick-ip:203.0.113.9',
    ]);
    expect(admin.messages.at(-1)).toBe('IP-banned Target (203.0.113.9); banned 2 known accounts and kicked 2 — botting.');
  });

  test('player info hides staff players from normal chat clients', () => {
    const observer = makeCollectingSocket('Observer', 50);
    const adminObserver = makeCollectingSocket('AdminObserver', 51, true);
    const staff = makePlayer(900, 'Staff', 'kcmap', 10, 10);
    staff.isAdmin = true;
    staff.isModerator = true;
    const adventurer = makePlayer(901, 'Adventurer', 'kcmap', 11, 10);
    const world = makeSocialWorld();
    world.players = new Map([[staff.id, staff], [adventurer.id, adventurer]]);

    try {
      handleChatSocketOpen(observer.ws, world);
      handleChatSocketOpen(adminObserver.ws, world);

      expect(observer.payloads.find(payload => payload.type === 'player_info' && payload.entityId === staff.id)).toBeUndefined();
      expect(observer.payloads.find(payload => payload.type === 'player_info' && payload.entityId === adventurer.id))
        .toEqual({ type: 'player_info', entityId: adventurer.id, name: 'Adventurer' });
      expect(adminObserver.payloads.find(payload => payload.type === 'player_info' && payload.entityId === staff.id))
        .toEqual({ type: 'player_info', entityId: staff.id, name: 'Staff' });
    } finally {
      handleChatSocketClose(observer.ws, world);
      handleChatSocketClose(adminObserver.ws, world);
    }
  });

  test('player info for a new normal player is sent after chat identify', () => {
    const observer = makeCollectingSocket('Observer2', 52);
    const newcomerSocket = makeCollectingSocket('Newcomer', 53);
    const newcomer = makePlayer(902, 'Newcomer', 'kcmap', 12, 10);
    const world = makeSocialWorld();

    try {
      handleChatSocketOpen(observer.ws, world);
      observer.payloads.length = 0;

      world.players = new Map([[newcomer.id, newcomer]]);
      broadcastPlayerInfo(newcomer.id, newcomer.name);
      expect(observer.payloads.find(payload => payload.type === 'player_info' && payload.entityId === newcomer.id)).toBeUndefined();

      handleChatSocketOpen(newcomerSocket.ws, world);
      handleChatSocketMessage(newcomerSocket.ws, JSON.stringify({ type: 'identify' }), world);
      expect(observer.payloads.find(payload => payload.type === 'player_info' && payload.entityId === newcomer.id))
        .toEqual({ type: 'player_info', entityId: newcomer.id, name: 'Newcomer' });
    } finally {
      handleChatSocketClose(observer.ws, world);
      handleChatSocketClose(newcomerSocket.ws, world);
    }
  });

  test('global social presence hides staff account events from normal chat clients', () => {
    const observer = makeCollectingSocket('PresenceObserver', 54);
    const adminObserver = makeCollectingSocket('PresenceAdmin', 55, true);
    const staff = makeCollectingSocket('PresenceStaff', 56, true);
    const world = makeSocialWorld();
    let staffOpen = false;

    try {
      handleChatSocketOpen(observer.ws, world);
      handleChatSocketOpen(adminObserver.ws, world);
      observer.payloads.length = 0;
      adminObserver.payloads.length = 0;

      handleChatSocketOpen(staff.ws, world);
      staffOpen = true;
      expect(observer.payloads.find(payload => payload.type === 'social_presence' && payload.accountId === 56)).toBeUndefined();
      expect(adminObserver.payloads.find(payload => payload.type === 'social_presence' && payload.accountId === 56))
        .toEqual({ type: 'social_presence', accountId: 56, username: 'PresenceStaff', online: true });

      handleChatSocketClose(staff.ws, world);
      staffOpen = false;
      expect(observer.payloads.find(payload => payload.type === 'social_presence' && payload.accountId === 56)).toBeUndefined();
      expect(adminObserver.payloads.find(payload => payload.type === 'social_presence' && payload.accountId === 56 && payload.online === false))
        .toEqual({ type: 'social_presence', accountId: 56, username: 'PresenceStaff', online: false });
    } finally {
      if (staffOpen) handleChatSocketClose(staff.ws, world);
      handleChatSocketClose(observer.ws, world);
      handleChatSocketClose(adminObserver.ws, world);
    }
  });

  test('/players hides staff names from normal players but not staff', () => {
    const observer = makeCollectingSocket('PlayerListObserver', 57);
    const adminObserver = makeCollectingSocket('PlayerListAdmin', 58, true);
    const adventurer = makePlayer(903, 'Adventurer', 'kcmap', 10, 11);
    const staff = makePlayer(904, 'Staff', 'kcmap', 11, 11);
    staff.isAdmin = true;
    const world = makeSocialWorld();
    world.players = new Map([[adventurer.id, adventurer], [staff.id, staff]]);

    handleChatSocketMessage(observer.ws, JSON.stringify({ type: 'local', message: '/players' }), world);
    handleChatSocketMessage(adminObserver.ws, JSON.stringify({ type: 'local', message: '/players' }), world);

    expect(observer.payloads.find(payload => payload.type === 'system')?.message)
      .toBe('1 player(s) online: Adventurer');
    expect(adminObserver.payloads.find(payload => payload.type === 'system')?.message)
      .toBe('2 player(s) online: Adventurer, Staff');
  });

  test('muted local chat echoes normally to sender and scrambles for others', () => {
    const sender = makeCollectingSocket('Muted', 42);
    const senderOtherTab = makeCollectingSocket('Muted', 42);
    const other = makeCollectingSocket('Other', 43);
    const world = makeSocialWorld({
      isAccountMuted(accountId: number) {
        return accountId === 42 ? { reason: 'spam', mutedAt: 1000, expiresAt: null } : null;
      },
      listForumDiscordEmojis() {
        return [
          { name: 'relicdance', available: true },
          { name: 'banknote', available: true },
        ];
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
      expect(otherLocal?.message).toMatch(/:(relicdance|banknote):/);
      expect(otherLocal?.message).toMatch(/relic|bank|mithril|bronze|monk|sultan|altar|anvil|goblin|carpet|knife|fishing|ladder|mine/i);
      expect(otherLocal?.message.split(/\s+/).length).toBeGreaterThanOrEqual(3);
    } finally {
      handleChatSocketClose(sender.ws, world);
      handleChatSocketClose(senderOtherTab.ws, world);
      handleChatSocketClose(other.ws, world);
    }
  });

  test('listed slurs shadow-scramble local chat without muting the account', () => {
    const sender = makeCollectingSocket('Speaker', 52);
    const other = makeCollectingSocket('Other', 53);
    const muteCalls: any[] = [];
    const blockedMessage = `you are a ${'ni'}${'gger'}`;
    const world = makeSocialWorld({
      isAccountMuted() {
        return null;
      },
      muteAccount(...args: any[]) {
        muteCalls.push(args);
      },
      listForumDiscordEmojis() {
        return [{ name: 'banknote', available: true }];
      },
    });

    try {
      handleChatSocketOpen(sender.ws, world);
      handleChatSocketOpen(other.ws, world);
      sender.payloads.length = 0;
      other.payloads.length = 0;

      handleChatSocketMessage(sender.ws, JSON.stringify({ type: 'local', message: blockedMessage }), world);

      const senderLocal = sender.payloads.find(payload => payload.type === 'local');
      const otherLocal = other.payloads.find(payload => payload.type === 'local');
      expect(senderLocal).toMatchObject({ type: 'local', from: 'Speaker', message: blockedMessage });
      expect(otherLocal?.type).toBe('local');
      expect(otherLocal?.message).not.toBe(blockedMessage);
      expect(otherLocal?.message).toContain(':banknote:');
      expect(otherLocal?.message).toMatch(/relic|bank|mithril|bronze|monk|sultan|altar|anvil|goblin|carpet|knife|fishing|ladder|mine/i);
      expect(muteCalls).toHaveLength(0);
    } finally {
      handleChatSocketClose(sender.ws, world);
      handleChatSocketClose(other.ws, world);
    }
  });

  test('listed slurs shadow-scramble private chat after normal target validation', () => {
    const sender = makeCollectingSocket('Speaker', 62);
    const target = makeCollectingSocket('Target', 63);
    const muteCalls: any[] = [];
    const blockedMessage = `what a ${'fa'}${'ggot'}`;
    const world = makeSocialWorld({
      isAccountMuted() {
        return null;
      },
      muteAccount(...args: any[]) {
        muteCalls.push(args);
      },
      getAccountIdByUsername(username: string) {
        return username.toLowerCase() === 'target' ? 63 : null;
      },
      getUsernameByAccountId(accountId: number) {
        return accountId === 63 ? 'Target' : null;
      },
      isIgnoring() {
        return false;
      },
      listForumDiscordEmojis() {
        return [{ name: 'relicdance', available: true }];
      },
    });

    try {
      handleChatSocketOpen(sender.ws, world);
      handleChatSocketOpen(target.ws, world);
      sender.payloads.length = 0;
      target.payloads.length = 0;

      handleChatSocketMessage(sender.ws, JSON.stringify({ type: 'private', to: 'Target', message: blockedMessage }), world);

      const senderPrivate = sender.payloads.find(payload => payload.type === 'private_sent');
      const targetPrivate = target.payloads.find(payload => payload.type === 'private');
      expect(senderPrivate).toMatchObject({ type: 'private_sent', to: 'Target', message: blockedMessage });
      expect(targetPrivate?.type).toBe('private');
      expect(targetPrivate?.message).not.toBe(blockedMessage);
      expect(targetPrivate?.message).toContain(':relicdance:');
      expect(muteCalls).toHaveLength(0);
    } finally {
      handleChatSocketClose(sender.ws, world);
      handleChatSocketClose(target.ws, world);
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
