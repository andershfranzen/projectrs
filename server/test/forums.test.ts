import { describe, expect, test } from 'bun:test';
import { GameDatabase } from '../src/Database';

describe('forums persistence', () => {
  test('seeds categories and supports thread/reply visibility', async () => {
    const db = new GameDatabase(':memory:');
    const created = db.loginFallbackAccount('forumtester', 'device-forums');

    const categories = db.listForumCategories();
    expect(categories.map((category) => category.slug)).toContain('general');
    const general = categories.find((category) => category.slug === 'general');
    expect(general).toBeTruthy();
    if (!general) return;

    const threadResult = db.createForumThread(created.accountId, general.id, 'Hello forums', 'This is **Markdown** with :fire:.');
    expect(threadResult.ok).toBe(true);
    if (!threadResult.ok) return;

    const replyResult = db.createForumReply(created.accountId, threadResult.thread.id, 'First reply.');
    expect(replyResult.ok).toBe(true);
    if (!replyResult.ok) return;

    const publicThread = db.getForumThread('general', threadResult.thread.slug, created.accountId, false);
    expect(publicThread?.posts).toHaveLength(2);

    expect(db.moderateForumPost(replyResult.post.id, 'hide', 'test').ok).toBe(true);
    expect(db.getForumThread('general', threadResult.thread.slug, created.accountId, false)?.posts).toHaveLength(1);
    expect(db.getForumThread('general', threadResult.thread.slug, created.accountId, true)?.posts).toHaveLength(2);
    db.close();
  });

  test('profiles combine forum and account data', async () => {
    const db = new GameDatabase(':memory:');
    const created = db.loginFallbackAccount('profiletester', 'device-profile');

    db.updateForumProfile(created.accountId, { title: 'Miner', bio: 'Mostly underground.' });
    const profile = db.getForumProfile('profiletester');
    expect(profile?.username).toBe('profiletester');
    expect(profile?.title).toBe('Miner');
    expect(profile?.bio).toBe('Mostly underground.');
    expect(profile?.isAdmin).toBe(false);
    db.close();
  });

  test('avatar bake targets include players without saved appearance', async () => {
    const db = new GameDatabase(':memory:');
    const created = db.loginFallbackAccount('defaultavatar', 'device-default-avatar');

    const targets = db.listForumAvatarBakeTargets();
    const target = targets.find((entry) => entry.accountId === created.accountId);
    expect(target?.username).toBe('defaultavatar');
    expect(target?.url).toContain(`/forum-avatars/${created.accountId}-`);
    db.close();
  });

  test('avatar bake targets read visible gear from saved equipment slots', async () => {
    const db = new GameDatabase(':memory:');
    const created = db.loginFallbackAccount('numericgearavatar', 'device-numeric-gear-avatar');
    (db as any).db.query('UPDATE player_state SET equipment = ? WHERE account_id = ?')
      .run(JSON.stringify({ '2': 65, body: 71, '9': 237 }), created.accountId);

    const target = db.listForumAvatarBakeTargets().find((entry) => entry.accountId === created.accountId);
    expect(target?.headItemId).toBe(65);
    expect(target?.bodyItemId).toBe(71);
    expect(target?.capeItemId).toBe(237);
    expect(target?.equipment).toEqual({ head: 65, body: 71, cape: 237 });
    db.close();
  });

  test('forum presence lists only recently active users', async () => {
    const db = new GameDatabase(':memory:');
    const recent = db.loginFallbackAccount('recentforumuser', 'device-recent-presence');
    const stale = db.loginFallbackAccount('staleforumuser', 'device-stale-presence');

    db.touchForumPresence(recent.accountId, 1_000);
    db.touchForumPresence(stale.accountId, 600);

    const online = db.listForumOnlineUsers(1_000, 180);
    expect(online.map((user) => user.username)).toContain('recentforumuser');
    expect(online.map((user) => user.username)).not.toContain('staleforumuser');
    db.close();
  });

  test('Discord emoji cache replaces stale guild emoji rows', () => {
    const db = new GameDatabase(':memory:');
    const guildId = '1504534632799010816';

    expect(db.replaceForumDiscordEmojis(guildId, [
      { id: '1508123662153289948', name: 'evilquest', animated: false, available: true, url: 'https://cdn.discordapp.com/emojis/1508123662153289948.webp' },
      { id: '1508123662153289949', name: 'hidden', animated: false, available: false, url: 'https://cdn.discordapp.com/emojis/1508123662153289949.webp' },
    ])).toBe(2);
    expect(db.listForumDiscordEmojis().map((emoji) => emoji.name)).toEqual(['evilquest']);

    expect(db.replaceForumDiscordEmojis(guildId, [
      { id: '1508123662153289950', name: 'camel_cape', animated: true, available: true, url: 'https://cdn.discordapp.com/emojis/1508123662153289950.webp?animated=true' },
    ])).toBe(1);

    const emojis = db.listForumDiscordEmojis();
    expect(emojis).toHaveLength(1);
    expect(emojis[0]).toMatchObject({ name: 'camel_cape', animated: true, available: true });
    db.close();
  });

  test('threads paginate posts and create quote notifications', async () => {
    const db = new GameDatabase(':memory:');
    const alice = db.loginFallbackAccount('aliceforum', 'device-alice-forum');
    const bob = db.loginFallbackAccount('bobforum', 'device-bob-forum');
    const general = db.listForumCategories().find((category) => category.slug === 'general');
    expect(general).toBeTruthy();
    if (!general) return;

    const threadResult = db.createForumThread(alice.accountId, general.id, 'Long hello', 'Opening post.');
    expect(threadResult.ok).toBe(true);
    if (!threadResult.ok) return;

    let firstBobPostId = 0;
    for (let i = 0; i < 25; i++) {
      const result = db.createForumReply(bob.accountId, threadResult.thread.id, `Reply ${i}`);
      expect(result.ok).toBe(true);
      if (result.ok && i === 0) firstBobPostId = result.post.id;
    }
    const pageTwo = db.getForumThread('general', threadResult.thread.slug, alice.accountId, false, 2, 20);
    expect(pageTwo?.page).toBe(2);
    expect(pageTwo?.totalPages).toBe(2);
    expect(pageTwo?.posts.length).toBeGreaterThan(0);

    const quote = db.createForumReply(alice.accountId, threadResult.thread.id, 'Replying inline.', firstBobPostId);
    expect(quote.ok).toBe(true);
    if (!quote.ok) return;
    expect(quote.post.replyTo?.id).toBe(firstBobPostId);

    const bobNotifications = db.listForumNotifications(bob.accountId);
    expect(bobNotifications.unreadCount).toBe(1);
    expect(bobNotifications.notifications[0]?.type).toBe('quote_reply');
    expect(bobNotifications.notifications[0]?.postPage).toBeGreaterThan(1);

    expect(db.markForumNotificationsRead(bob.accountId).ok).toBe(true);
    expect(db.listForumNotifications(bob.accountId).unreadCount).toBe(0);
    db.close();
  });

  test('post reactions include latest five reactor names and an others count', async () => {
    const db = new GameDatabase(':memory:');
    const author = db.loginFallbackAccount('reactionauthor', 'device-reaction-author');
    const general = db.listForumCategories().find((category) => category.slug === 'general');
    expect(general).toBeTruthy();
    if (!general) return;

    const thread = db.createForumThread(author.accountId, general.id, 'Reaction hover', 'React to this.');
    expect(thread.ok).toBe(true);
    if (!thread.ok) return;
    const firstPost = db.getForumThread('general', thread.thread.slug, author.accountId, false)?.posts[0];
    expect(firstPost).toBeTruthy();
    if (!firstPost) return;

    for (let i = 0; i < 7; i++) {
      const reactor = db.loginFallbackAccount(`reactor${i}`, `device-reactor-${i}`);
      expect(db.reactToForumPost(reactor.accountId, firstPost.id, 'heart').ok).toBe(true);
      (db as any).db.query('UPDATE forum_reactions SET created_at = ? WHERE post_id = ? AND account_id = ?')
        .run(100 + i, firstPost.id, reactor.accountId);
    }

    const post = db.getForumThread('general', thread.thread.slug, author.accountId, false)?.posts[0];
    expect(post?.reactions.heart).toBe(7);
    expect(post?.reactionUsers.heart.names).toEqual(['reactor6', 'reactor5', 'reactor4', 'reactor3', 'reactor2']);
    expect(post?.reactionUsers.heart.others).toBe(2);
    db.close();
  });

  test('post reactions support laughing emoji', async () => {
    const db = new GameDatabase(':memory:');
    const author = db.loginFallbackAccount('laughauthor', 'device-laugh-author');
    const reactor = db.loginFallbackAccount('laughreactor', 'device-laugh-reactor');
    const general = db.listForumCategories().find((category) => category.slug === 'general');
    expect(general).toBeTruthy();
    if (!general) return;

    const thread = db.createForumThread(author.accountId, general.id, 'Laugh reaction', 'This deserves a laugh.');
    expect(thread.ok).toBe(true);
    if (!thread.ok) return;
    const firstPost = db.getForumThread('general', thread.thread.slug, reactor.accountId, false)?.posts[0];
    expect(firstPost).toBeTruthy();
    if (!firstPost) return;

    const result = db.reactToForumPost(reactor.accountId, firstPost.id, 'laughing');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.reactions.laughing).toBe(1);
      expect(result.myReaction).toBe('laughing');
    }
    db.close();
  });
});

describe('forum spam and security hardening', () => {
  function seedThread(db: GameDatabase, accountId: number) {
    const general = db.listForumCategories().find((category) => category.slug === 'general');
    if (!general) throw new Error('general category missing');
    const thread = db.createForumThread(accountId, general.id, 'Seed thread', 'Opening body.');
    if (!thread.ok) throw new Error('seed thread failed');
    return { general, thread: thread.thread };
  }

  test('rejects assigning forum media owned by another account', () => {
    const db = new GameDatabase(':memory:');
    const owner = db.loginFallbackAccount('mediaowner', 'device-media-owner');
    const attacker = db.loginFallbackAccount('mediaattacker', 'device-media-attacker');
    const media = db.saveForumMedia(owner.accountId, '/tmp/x.png', '/forum-media/1/x.png', 'image', 'image/png', 'x.png', 100);

    const result = db.updateForumProfile(attacker.accountId, { avatarMediaId: media.id });
    expect(result.ok).toBe(false);
    db.close();
  });

  test('allows assigning forum media you own', () => {
    const db = new GameDatabase(':memory:');
    const owner = db.loginFallbackAccount('mediaowner2', 'device-media-owner2');
    const media = db.saveForumMedia(owner.accountId, '/tmp/y.png', '/forum-media/1/y.png', 'image', 'image/png', 'y.png', 100);

    const result = db.updateForumProfile(owner.accountId, { avatarMediaId: media.id });
    expect(result.ok).toBe(true);
    db.close();
  });

  test('moderateForumThread move rejects a nonexistent target category', () => {
    const db = new GameDatabase(':memory:');
    const author = db.loginFallbackAccount('moveauthor', 'device-move-author');
    const { thread } = seedThread(db, author.accountId);

    const result = db.moderateForumThread(thread.id, 'move', 999999);
    expect(result.ok).toBe(false);
    db.close();
  });

  test('moderateForumThread move rejects a hidden target category', () => {
    const db = new GameDatabase(':memory:');
    const author = db.loginFallbackAccount('moveauthor2', 'device-move-author2');
    const { thread } = seedThread(db, author.accountId);
    const hidden = db.upsertForumCategory({ name: 'Hidden Cat', description: '', sortOrder: 0, isHidden: true, isLocked: false, staffOnlyWrite: false });
    expect(hidden.ok).toBe(true);
    if (!hidden.ok) return;

    const result = db.moderateForumThread(thread.id, 'move', hidden.category.id);
    expect(result.ok).toBe(false);
    db.close();
  });

  test('rejects a reply identical to the author\'s previous reply in the thread', () => {
    const db = new GameDatabase(':memory:');
    const author = db.loginFallbackAccount('dupauthor', 'device-dup-author');
    const { thread } = seedThread(db, author.accountId);

    expect(db.createForumReply(author.accountId, thread.id, 'Buy gold at example.com').ok).toBe(true);
    const dup = db.createForumReply(author.accountId, thread.id, 'Buy gold at example.com');
    expect(dup.ok).toBe(false);
    expect(db.createForumReply(author.accountId, thread.id, 'A different reply.').ok).toBe(true);
    db.close();
  });

  test('auto-hides a post after three distinct reporters', () => {
    const db = new GameDatabase(':memory:');
    const author = db.loginFallbackAccount('reportauthor', 'device-report-author');
    const { thread } = seedThread(db, author.accountId);
    const reply = db.createForumReply(author.accountId, thread.id, 'Spam content here.');
    expect(reply.ok).toBe(true);
    if (!reply.ok) return;

    const r1 = db.loginFallbackAccount('reporter1', 'device-reporter1');
    const r2 = db.loginFallbackAccount('reporter2', 'device-reporter2');
    const r3 = db.loginFallbackAccount('reporter3', 'device-reporter3');
    db.reportForumPost(r1.accountId, reply.post.id, 'spam please remove');
    db.reportForumPost(r2.accountId, reply.post.id, 'spam please remove');
    expect(db.getForumThread('general', thread.slug, author.accountId, false)?.posts).toHaveLength(2);
    db.reportForumPost(r3.accountId, reply.post.id, 'spam please remove');

    const publicPosts = db.getForumThread('general', thread.slug, author.accountId, false)?.posts;
    expect(publicPosts).toHaveLength(1);
    db.close();
  });

  test('sumForumMediaBytes totals an account\'s stored media', () => {
    const db = new GameDatabase(':memory:');
    const owner = db.loginFallbackAccount('quotauser', 'device-quota-user');
    db.saveForumMedia(owner.accountId, '/tmp/a', '/forum-media/1/a', 'image', 'image/png', 'a', 100);
    db.saveForumMedia(owner.accountId, '/tmp/b', '/forum-media/1/b', 'image', 'image/png', 'b', 250);

    expect(db.sumForumMediaBytes(owner.accountId)).toBe(350);
    db.close();
  });

  test('rejects a thread title with no alphanumeric characters', () => {
    const db = new GameDatabase(':memory:');
    const author = db.loginFallbackAccount('slugauthor', 'device-slug-author');
    const general = db.listForumCategories().find((category) => category.slug === 'general');
    if (!general) throw new Error('general missing');

    const result = db.createForumThread(author.accountId, general.id, '!!! ???', 'Body here.');
    expect(result.ok).toBe(false);
    db.close();
  });

  test('getAccountCreatedAt returns the account creation time', () => {
    const db = new GameDatabase(':memory:');
    const account = db.loginFallbackAccount('ageduser', 'device-aged-user');
    const createdAt = db.getAccountCreatedAt(account.accountId);
    expect(typeof createdAt).toBe('number');
    expect(createdAt as number).toBeGreaterThan(0);
    db.close();
  });

  test('cleanupOldForumNotifications removes read notifications but keeps unread ones', () => {
    const db = new GameDatabase(':memory:');
    const alice = db.loginFallbackAccount('cleanalice', 'device-clean-alice');
    const bob = db.loginFallbackAccount('cleanbob', 'device-clean-bob');
    const { thread } = seedThread(db, alice.accountId);
    const bobReply = db.createForumReply(bob.accountId, thread.id, 'Bob original reply.');
    expect(bobReply.ok).toBe(true);
    if (!bobReply.ok) return;
    // Alice quotes Bob -> Bob gets a notification.
    expect(db.createForumReply(alice.accountId, thread.id, 'Quoting you, Bob.', bobReply.post.id).ok).toBe(true);
    expect(db.listForumNotifications(bob.accountId).unreadCount).toBe(1);

    const future = Math.floor(Date.now() / 1000) + 100000;
    // Unread notifications must survive cleanup.
    expect(db.cleanupOldForumNotifications(future)).toBe(0);
    expect(db.listForumNotifications(bob.accountId).notifications.length).toBe(1);

    db.markForumNotificationsRead(bob.accountId);
    expect(db.cleanupOldForumNotifications(future)).toBe(1);
    expect(db.listForumNotifications(bob.accountId).notifications.length).toBe(0);
    db.close();
  });
});
