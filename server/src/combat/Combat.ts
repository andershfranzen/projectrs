import type { Player } from '../entity/Player';
import type { Npc } from '../entity/Npc';
import {
  addXp, STANCE_BONUSES, STANCE_XP, ACC_BASE,
  osrsMeleeMaxHit, rollHit, npcCombatLevel,
  relicDropPoolForCombatLevel,
  type ItemDef,
} from '@projectrs/shared';

/** Item-id pools for the combat-level-gated bonus relic drop. Tier 1 covers
 *  sub-30 mobs, tier 2 covers 30–60. RELIC_DROP_CHANCE applies once per kill;
 *  on a hit, one variant is picked uniformly from the tier pool. */
const RELIC_DROP_CHANCE = 1 / 30;

export interface CombatHit {
  attackerId: number;
  targetId: number;
  damage: number;
  targetHealth: number;
  targetMaxHealth: number;
}

export interface XpDrop {
  skill: string;
  amount: number;
}

function addCombatHitpointsXp(
  player: Player,
  actualDamage: number,
  oldHpXp: number,
  oldHpLevel: number,
  xpDrops: XpDrop[],
  levelUps: { skill: string; level: number }[]
): void {
  const expectedHpXp = Math.floor((actualDamage * 4) / 3);
  const autoHpXp = player.skills.hitpoints.xp - oldHpXp;
  const missingHpXp = expectedHpXp - autoHpXp;
  if (missingHpXp > 0) addXp(player.skills, 'hitpoints', missingHpXp);

  const gainedHpXp = player.skills.hitpoints.xp - oldHpXp;
  if (gainedHpXp > 0) xpDrops.push({ skill: 'hitpoints', amount: gainedHpXp });
  if (player.skills.hitpoints.level > oldHpLevel) {
    levelUps.push({ skill: 'hitpoints', level: player.skills.hitpoints.level });
  }
}

/**
 * 2004Scape-style melee combat: player attacks NPC.
 * - Dual random roll hit check (not percentage)
 * - Max hit = floor((effStr * (strBonus + 64) + 320) / 640)
 * - Damage = random(0..maxHit) inclusive (0 = hit but no damage)
 * - XP awarded on capped damage (no overkill XP)
 * - Flinch: NPC retaliates at half attack speed on first hit
 */
export function processPlayerCombat(
  player: Player,
  npc: Npc,
  itemDefs: Map<number, ItemDef>
): { hit: CombatHit; xpDrops: XpDrop[]; levelUps: { skill: string; level: number }[] } | null {
  if (npc.dead || !player.alive) return null;

  // Melee must be from the NPC's cardinal interaction surface, not diagonal.
  const playerTileX = Math.floor(player.position.x);
  const playerTileZ = Math.floor(player.position.y);
  if (!npc.isInteractionTile(playerTileX, playerTileZ)) return null;

  // Cooldown gate. The decrement is global (World.tickPlayerCooldowns) so the
  // timer keeps ticking even while you walk to the target — re-engaging a
  // mob doesn't make you re-wait the full attack speed.
  if (player.attackCooldown > 0) return null;
  player.attackCooldown = player.getAttackSpeed(itemDefs);

  // Compute equipment bonuses
  const bonuses = player.computeBonuses(itemDefs);
  const stance = STANCE_BONUSES[player.stance];

  // Effective levels (stat + stance bonus + 8)
  const effAcc = player.skills.accuracy.currentLevel + stance.accuracy + 8;
  const effStr = player.skills.strength.currentLevel + stance.strength + 8;

  // Weapon style determines which attack bonus to use
  const weaponStyle = player.getWeaponStyle(itemDefs);
  let attackBonus = 0;
  if (weaponStyle === 'stab') attackBonus = bonuses.stabAttack;
  else if (weaponStyle === 'slash') attackBonus = bonuses.slashAttack;
  else attackBonus = bonuses.crushAttack;

  // Attack roll = effective_attack * (equipment_bonus + 64)
  const attackRoll = effAcc * (attackBonus + ACC_BASE);

  // NPC defence roll (NPCs use flat defence stat, no equipment)
  const npcDefLevel = npc.defence + 8;
  const npcDefRoll = npcDefLevel * ACC_BASE;

  // Max hit = floor((effStr * (strBonus + 64) + 320) / 640)
  const maxHit = osrsMeleeMaxHit(effStr, bonuses.meleeStrength);

  // 2004Scape hit check: random(0..atkRoll) > random(0..defRoll)
  let damage = 0;
  if (rollHit(attackRoll, npcDefRoll)) {
    // Damage = random(0..maxHit) inclusive
    damage = Math.floor(Math.random() * (maxHit + 1));
  }

  const actual = npc.takeDamage(damage);

  // NPC retaliates with flinch (half attack speed for first counter-attack)
  if (npc.alive) {
    const wasInCombat = npc.combatTarget != null;
    npc.combatTarget = player;
    if (!wasInCombat) {
      // Flinch: first retaliation at half attack speed
      npc.attackCooldown = Math.floor(npc.attackSpeed / 2);
    }
  }

  // Award XP based on stance — only on capped damage (no overkill XP)
  const xpDrops: XpDrop[] = [];
  const levelUps: { skill: string; level: number }[] = [];

  if (actual > 0) {
    // Snapshot HP level BEFORE addXp calls — addXp auto-awards 1/3 HP XP for
    // combat skills, so the level may bump during these calls. Capturing
    // after would always read the post-mutation level and never detect
    // level-up.
    const oldHpXp = player.skills.hitpoints.xp;
    const oldHpLevel = player.skills.hitpoints.level;
    const stanceXp = STANCE_XP[player.stance];
    if (stanceXp.accuracy > 0) {
      const amt = actual * stanceXp.accuracy;
      const r = addXp(player.skills, 'accuracy', amt);
      xpDrops.push({ skill: 'accuracy', amount: Math.floor(amt) });
      if (r.leveled) levelUps.push({ skill: 'accuracy', level: r.newLevel });
    }
    if (stanceXp.strength > 0) {
      const amt = actual * stanceXp.strength;
      const r = addXp(player.skills, 'strength', amt);
      xpDrops.push({ skill: 'strength', amount: Math.floor(amt) });
      if (r.leveled) levelUps.push({ skill: 'strength', level: r.newLevel });
    }
    if (stanceXp.defence > 0) {
      const amt = actual * stanceXp.defence;
      const r = addXp(player.skills, 'defence', amt);
      xpDrops.push({ skill: 'defence', amount: Math.floor(amt) });
      if (r.leveled) levelUps.push({ skill: 'defence', level: r.newLevel });
    }
    addCombatHitpointsXp(player, actual, oldHpXp, oldHpLevel, xpDrops, levelUps);

    // Track hero points for kill credit
    npc.addHeroPoints(player.id, actual);

    // Sync health from skills (HP level may have changed)
    player.syncHealthFromSkills();
  }

  return {
    hit: {
      attackerId: player.id,
      targetId: npc.id,
      damage: actual,
      targetHealth: npc.health,
      targetMaxHealth: npc.maxHealth,
    },
    xpDrops,
    levelUps,
  };
}

/** Maximum range for ranged attacks in tiles */
export const RANGED_ATTACK_DISTANCE = 7;

/**
 * Ranged combat: player attacks NPC with a bow + arrows.
 * Same dual-roll hit check as melee but uses archery/ranged stats.
 * Arrow rangedStrength is passed in separately since arrows aren't equipped.
 */
export function processPlayerRangedCombat(
  player: Player,
  npc: Npc,
  itemDefs: Map<number, ItemDef>,
  arrowStrength: number,
): { hit: CombatHit; xpDrops: XpDrop[]; levelUps: { skill: string; level: number }[]; isRanged: true } | null {
  if (npc.dead || !player.alive) return null;

  // Check distance — must be within ranged distance
  const dx = Math.abs(player.position.x - npc.position.x);
  const dz = Math.abs(player.position.y - npc.position.y);
  if (dx > RANGED_ATTACK_DISTANCE || dz > RANGED_ATTACK_DISTANCE) return null;

  // Cooldown gate. Decrement is global; see processPlayerCombat for rationale.
  if (player.attackCooldown > 0) return null;
  player.attackCooldown = player.getAttackSpeed(itemDefs);

  // Compute equipment bonuses
  const bonuses = player.computeBonuses(itemDefs);

  // Effective ranged level (archery skill + 8, no stance bonus for v1)
  const effRanged = player.skills.archery.currentLevel + 8;

  // Attack roll uses ranged accuracy
  const attackRoll = effRanged * (bonuses.rangedAccuracy + ACC_BASE);

  // NPC defence roll
  const npcDefLevel = npc.defence + 8;
  const npcDefRoll = npcDefLevel * ACC_BASE;

  // Max hit — bow rangedStrength + arrow rangedStrength
  const totalRangedStr = bonuses.rangedStrength + arrowStrength;
  const maxHit = osrsMeleeMaxHit(effRanged, totalRangedStr);

  let damage = 0;
  if (rollHit(attackRoll, npcDefRoll)) {
    damage = Math.floor(Math.random() * (maxHit + 1));
  }

  const actual = npc.takeDamage(damage);

  // NPC retaliates — tries to chase the player
  if (npc.alive) {
    const wasInCombat = npc.combatTarget != null;
    npc.combatTarget = player;
    if (!wasInCombat) {
      npc.attackCooldown = Math.floor(npc.attackSpeed / 2);
    }
  }

  // Award archery XP (4 XP per damage dealt)
  const xpDrops: XpDrop[] = [];
  const levelUps: { skill: string; level: number }[] = [];

  if (actual > 0) {
    // Snapshot HP level BEFORE addXp — addXp auto-awards 1/3 HP XP for combat
    // skills, so capturing after would never detect a level-up.
    const oldHpXp = player.skills.hitpoints.xp;
    const oldHpLevel = player.skills.hitpoints.level;
    const amt = actual * 4;
    const r = addXp(player.skills, 'archery', amt);
    xpDrops.push({ skill: 'archery', amount: Math.floor(amt) });
    if (r.leveled) levelUps.push({ skill: 'archery', level: r.newLevel });
    addCombatHitpointsXp(player, actual, oldHpXp, oldHpLevel, xpDrops, levelUps);

    npc.addHeroPoints(player.id, actual);
    player.syncHealthFromSkills();
  }

  return {
    hit: {
      attackerId: player.id,
      targetId: npc.id,
      damage: actual,
      targetHealth: npc.health,
      targetMaxHealth: npc.maxHealth,
    },
    xpDrops,
    levelUps,
    isRanged: true,
  };
}

/**
 * NPC attacks player — 2004Scape style.
 */
export function processNpcCombat(
  npc: Npc,
  target: Player,
  itemDefs: Map<number, ItemDef>
): CombatHit | null {
  if (npc.dead || !target.alive) {
    npc.combatTarget = null;
    return null;
  }

  // Check distance — must be adjacent to attack (chasing handled by AI)
  const dx = Math.abs(npc.position.x - target.position.x);
  const dz = Math.abs(npc.position.y - target.position.y);
  if (dx > 1.5 || dz > 1.5) {
    return null;
  }

  // Check cooldown
  npc.attackCooldown--;
  if (npc.attackCooldown > 0) return null;
  npc.attackCooldown = npc.attackSpeed;

  // NPC attack roll
  const npcEffAcc = npc.attack + 8;
  const npcAttackRoll = npcEffAcc * ACC_BASE;

  // Player defence roll
  const bonuses = target.computeBonuses(itemDefs);
  const stance = STANCE_BONUSES[target.stance];
  const effDef = target.skills.defence.currentLevel + stance.defence + 8;

  // Use average of stab/slash/crush defence (NPC attack style unspecified)
  const avgDef = Math.floor((bonuses.stabDefence + bonuses.slashDefence + bonuses.crushDefence) / 3);
  const playerDefRoll = effDef * (avgDef + ACC_BASE);

  // NPC max hit
  const npcMaxHit = osrsMeleeMaxHit(npc.strength + 8, 0);

  // 2004Scape hit check
  let damage = 0;
  if (rollHit(npcAttackRoll, playerDefRoll)) {
    damage = Math.floor(Math.random() * (npcMaxHit + 1));
  }

  const actual = target.takeDamage(damage);
  target.skills.hitpoints.currentLevel = target.health;

  return {
    attackerId: npc.id,
    targetId: target.id,
    damage: actual,
    targetHealth: target.health,
    targetMaxHealth: target.maxHealth,
  };
}

/**
 * Roll loot — drops go to the player with the most hero points (kill credit).
 * Adds a combat-level-gated relic drop on top of the def's loot table:
 *   lvl  < 30 → 1/30 chance of a random tier-1 relic
 *   lvl 30–60 → 1/30 chance of a random tier-2 relic
 *   lvl >  60 → no bonus relic (reserved for future higher tiers)
 */
export function rollLoot(npc: Npc): { itemId: number; quantity: number }[] {
  const drops: { itemId: number; quantity: number }[] = [];
  for (const drop of npc.def.lootTable) {
    if (Math.random() <= drop.chance) {
      drops.push({ itemId: drop.itemId, quantity: drop.quantity });
    }
  }

  if (Math.random() < RELIC_DROP_CHANCE) {
    const level = npcCombatLevel(npc.def);
    const pool = relicDropPoolForCombatLevel(level);
    if (pool) {
      drops.push({ itemId: pool[Math.floor(Math.random() * pool.length)], quantity: 1 });
    }
  }

  return drops;
}
