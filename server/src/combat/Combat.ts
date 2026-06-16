import type { Player } from '../entity/Player';
import type { Npc } from '../entity/Npc';
import {
  ACC_BASE,
  DEFAULT_RANGED_ATTACK_DISTANCE,
  MAGIC_STANCE_XP,
  MAGIC_STANCE_BONUSES,
  SPELL_CAST_DISTANCE,
  STANCE_BONUSES,
  STANCE_XP,
  addXp,
  averageMeleeDefenceBonus,
  bowAttackRollMultiplierForStance,
  combatRangeIncludesOffset,
  magicMaxHit,
  meleeAttackBonusForStyle,
  meleeDefenceBonusForStyle,
  npcMagicDefenceRoll,
  npcMeleeAttackRoll,
  npcMeleeDefenceRoll,
  npcMeleeMaxHit,
  osrsMeleeMaxHit,
  rollHitDamage,
  type CombatRangeMode,
  type ItemDef,
  type MagicStance,
  type RareDropTableDef,
  type SkillId,
} from '@projectrs/shared';
import { rollRareDropTable, type RolledLootDrop } from './RareDropTable';

const NO_LOOT_NPC_IDS = new Set<number>([18]);
const TOTAL_COMBAT_XP_PER_DAMAGE = 4;

/** Combat ranges in tiles. */
export const MELEE_ATTACK_DISTANCE = 1.5;
export const RANGED_ATTACK_DISTANCE = DEFAULT_RANGED_ATTACK_DISTANCE;
export const MAGIC_ATTACK_DISTANCE = SPELL_CAST_DISTANCE;
export const MAGIC_ATTACK_RANGE_MODE: CombatRangeMode = 'chebyshev';
export const MAGIC_ATTACK_COOLDOWN_TICKS = 5;
export const ARROW_BREAK_CHANCE = 0.2;

export interface XpDrop {
  skill: SkillId;
  amount: number;
}

export interface LevelUp {
  skill: SkillId;
  level: number;
}

export interface CombatXpResult {
  xpDrops: XpDrop[];
  levelUps: LevelUp[];
}

export interface CombatHit {
  attackerId: number;
  targetId: number;
  damage: number;
  targetHealth: number;
  targetMaxHealth: number;
}

export type NpcPostHitReaction = 'dead' | 'flee' | 'retaliate' | 'retreat' | 'none';

export interface PlayerNpcCombatResult {
  hit: CombatHit;
  xpDrops: XpDrop[];
  levelUps: LevelUp[];
  npcReaction: NpcPostHitReaction;
  isRanged?: true;
  isMagic?: true;
}

export interface CombatRollOptions {
  rng?: () => number;
}

export interface PlayerNpcCombatOptions extends CombatRollOptions {
  queueNpcRetaliation?: boolean;
}

export interface NpcCombatOptions extends CombatRollOptions {
  tickCooldown?: boolean;
}

export interface LootRollOptions extends CombatRollOptions {
  rareDropTables?: ReadonlyMap<string, RareDropTableDef>;
}

function hit(attackerId: number, targetId: number, damage: number, targetHealth: number, targetMaxHealth: number): CombatHit {
  return { attackerId, targetId, damage, targetHealth, targetMaxHealth };
}

function cloneEmptyCombatXp(): CombatXpResult {
  return { xpDrops: [], levelUps: [] };
}

function normalizedCombatXpDrops(damage: number, drops: XpDrop[]): XpDrop[] {
  const positive = drops.filter(drop => drop.amount > 0);
  if (damage <= 0 || positive.length === 0) return [];

  const expectedTotal = damage * TOTAL_COMBAT_XP_PER_DAMAGE;
  const normalized = positive.map((drop, index) => {
    const raw = drop.amount;
    const amount = Math.floor(raw);
    return { ...drop, amount, remainder: raw - amount, index };
  });

  let missing = expectedTotal - normalized.reduce((total, drop) => total + drop.amount, 0);
  normalized.sort((a, b) => (b.remainder - a.remainder) || (a.index - b.index));
  for (let i = 0; missing > 0 && normalized.length > 0; i = (i + 1) % normalized.length) {
    normalized[i].amount++;
    missing--;
  }
  normalized.sort((a, b) => a.index - b.index);

  return normalized
    .filter(drop => drop.amount > 0)
    .map(({ skill, amount }) => ({ skill, amount }));
}

function grantCombatXpDrops(
  player: Player,
  damage: number,
  drops: XpDrop[],
): CombatXpResult {
  const xpDrops = normalizedCombatXpDrops(damage, drops);
  if (xpDrops.length === 0) return cloneEmptyCombatXp();

  const result = cloneEmptyCombatXp();
  const oldHpXp = player.skills.hitpoints.xp;
  const oldHpLevel = player.skills.hitpoints.level;

  for (const drop of xpDrops) {
    const levelResult = addXp(player.skills, drop.skill, drop.amount);
    result.xpDrops.push(drop);
    if (levelResult.leveled) {
      result.levelUps.push({ skill: drop.skill, level: levelResult.newLevel });
    }
  }

  // Combat always grants 4 XP per capped damage, plus 1/3 of that to HP.
  // addXp() auto-awards HP per individual combat skill, so top up any rounding
  // gap caused by split styles.
  const expectedHpXp = Math.floor((damage * TOTAL_COMBAT_XP_PER_DAMAGE) / 3);
  const autoHpXp = player.skills.hitpoints.xp - oldHpXp;
  const missingHpXp = expectedHpXp - autoHpXp;
  if (missingHpXp > 0) addXp(player.skills, 'hitpoints', missingHpXp);

  const gainedHpXp = player.skills.hitpoints.xp - oldHpXp;
  if (gainedHpXp > 0) {
    result.xpDrops.push({ skill: 'hitpoints', amount: gainedHpXp });
  }
  if (player.skills.hitpoints.level > oldHpLevel) {
    result.levelUps.push({ skill: 'hitpoints', level: player.skills.hitpoints.level });
  }

  player.syncHealthFromSkills();
  return result;
}

export function grantMeleeCombatXp(player: Player, damage: number): CombatXpResult {
  if (damage <= 0) return cloneEmptyCombatXp();
  const stanceXp = STANCE_XP[player.stance];
  return grantCombatXpDrops(player, damage, [
    { skill: 'weaponry', amount: damage * stanceXp.weaponry },
    { skill: 'strength', amount: damage * stanceXp.strength },
    { skill: 'defence', amount: damage * stanceXp.defence },
  ]);
}

export function grantRangedCombatXp(player: Player, damage: number): CombatXpResult {
  if (damage <= 0) return cloneEmptyCombatXp();
  return grantCombatXpDrops(player, damage, [{ skill: 'archery', amount: damage * TOTAL_COMBAT_XP_PER_DAMAGE }]);
}

export function grantMagicCombatXp(
  player: Player,
  xpSkill: SkillId,
  damage: number,
  stance: MagicStance,
): CombatXpResult {
  if (damage <= 0) return cloneEmptyCombatXp();
  const xpStyle = MAGIC_STANCE_XP[stance] ?? MAGIC_STANCE_XP.accurate;
  return grantCombatXpDrops(player, damage, [
    { skill: xpSkill, amount: damage * xpStyle.magic },
    { skill: 'defence', amount: damage * xpStyle.defence },
  ]);
}

export function isPointInNpcRangedAttackRange(npc: Npc, x: number, z: number, range: number = RANGED_ATTACK_DISTANCE): boolean {
  if (isPointInsideNpcFootprint(npc, x, z)) return false;
  const fp = npc.distToFootprint(x, z);
  return combatRangeIncludesOffset(fp.dx, fp.dz, range, 'chebyshev');
}

export function isPointInNpcMeleeAttackRange(npc: Npc, x: number, z: number): boolean {
  if (isPointInsideNpcFootprint(npc, x, z)) return false;
  const fp = npc.distToFootprint(x, z);
  return combatRangeIncludesOffset(fp.dx, fp.dz, MELEE_ATTACK_DISTANCE, 'euclidean');
}

export function isPointInNpcMagicAttackRange(npc: Npc, x: number, z: number): boolean {
  if (isPointInsideNpcFootprint(npc, x, z)) return false;
  const fp = npc.distToFootprint(x, z);
  return combatRangeIncludesOffset(fp.dx, fp.dz, MAGIC_ATTACK_DISTANCE, MAGIC_ATTACK_RANGE_MODE);
}

export function isPointInsideNpcFootprint(npc: Npc, x: number, z: number): boolean {
  return npc.isFootprintTile(Math.floor(x), Math.floor(z));
}

export function shouldConsumeAmmoOnShot(ammo: { itemDef: Pick<ItemDef, 'ammoType'> }, rng: () => number = Math.random): boolean {
  if (ammo.itemDef.ammoType !== 'arrow') return true;
  return rng() < ARROW_BREAK_CHANCE;
}

export function armNpcRetaliation(npc: Npc, player: Player): void {
  const wasInCombat = npc.combatTarget != null;
  npc.setCombatTarget(player);
  if (!wasInCombat) {
    npc.attackCooldown = Math.floor(npc.attackSpeed / 2);
  }
}

export function applyNpcReactionToPlayerHit(npc: Npc, player: Player, options: { queueRetaliation?: boolean } = {}): NpcPostHitReaction {
  if (!npc.alive) return 'dead';
  if (npc.shouldFleeFromCombat()) {
    npc.startRetreatFromTarget(player);
    return 'flee';
  }
  if (!npc.shouldDisengageFromTarget(player.position.x, player.position.y)) {
    npc.clearRetreat();
    if (!options.queueRetaliation) armNpcRetaliation(npc, player);
    return 'retaliate';
  }
  npc.startRetreatFromTarget(player);
  return 'retreat';
}

export function rollPlayerMeleeDamageAgainstNpc(
  player: Player,
  npc: Npc,
  itemDefs: Map<number, ItemDef>,
  rng: () => number = Math.random,
): number {
  const bonuses = player.computeBonuses(itemDefs);
  const stance = STANCE_BONUSES[player.stance];
  const effAcc = player.skills.weaponry.currentLevel + stance.accuracy + 8;
  const effStr = player.skills.strength.currentLevel + stance.strength + 8;
  const attackBonus = meleeAttackBonusForStyle(bonuses, player.getWeaponStyle(itemDefs));
  const attackRoll = effAcc * (attackBonus + ACC_BASE);
  const npcDefRoll = npcMeleeDefenceRoll(npc.combatStats, player.getWeaponStyle(itemDefs));
  const maxHit = osrsMeleeMaxHit(effStr, bonuses.meleeStrength);
  return rollHitDamage(attackRoll, npcDefRoll, maxHit, rng);
}

export function rollPlayerRangedDamageAgainstNpc(
  player: Player,
  npc: Npc,
  itemDefs: Map<number, ItemDef>,
  rng: () => number = Math.random,
): number {
  const bonuses = player.computeBonuses(itemDefs);
  const effRanged = player.skills.archery.currentLevel + 8;
  const attackRollMultiplier = player.getWeaponStyle(itemDefs) === 'bow'
    ? bowAttackRollMultiplierForStance(player.stance)
    : 1.0;
  const attackRoll = Math.floor(effRanged * (bonuses.rangedAccuracy + ACC_BASE) * attackRollMultiplier);
  const npcDefRoll = npcMeleeDefenceRoll(npc.combatStats, 'bow');
  const maxHit = osrsMeleeMaxHit(effRanged, bonuses.rangedStrength);
  return rollHitDamage(attackRoll, npcDefRoll, maxHit, rng);
}

export function rollNpcMeleeDamageAgainstPlayer(
  npc: Npc,
  target: Player,
  itemDefs: Map<number, ItemDef>,
  rng: () => number = Math.random,
): number {
  const npcAttackRoll = npcMeleeAttackRoll(npc.combatStats);
  const bonuses = target.computeBonuses(itemDefs);
  const stance = STANCE_BONUSES[target.stance];
  const effDef = target.skills.defence.currentLevel + stance.defence + 8;
  const authoredAttackStyle = npc.def.attackStyle !== undefined || npc.statsOverride?.attackStyle !== undefined;
  const defenceBonus = authoredAttackStyle
    ? meleeDefenceBonusForStyle(bonuses, npc.attackStyle)
    : averageMeleeDefenceBonus(bonuses);
  const playerDefRoll = effDef * (defenceBonus + ACC_BASE);
  const npcMaxHit = npcMeleeMaxHit(npc.combatStats);
  return rollHitDamage(npcAttackRoll, playerDefRoll, npcMaxHit, rng);
}

export function rollPlayerMeleeDamageAgainstPlayer(
  attacker: Player,
  defender: Player,
  itemDefs: Map<number, ItemDef>,
  rng: () => number = Math.random,
): number {
  const attackBonuses = attacker.computeBonuses(itemDefs);
  const defenceBonuses = defender.computeBonuses(itemDefs);
  const attackStance = STANCE_BONUSES[attacker.stance];
  const defenceStance = STANCE_BONUSES[defender.stance];
  const effAcc = attacker.skills.weaponry.currentLevel + attackStance.accuracy + 8;
  const effStr = attacker.skills.strength.currentLevel + attackStance.strength + 8;
  const weaponStyle = attacker.getWeaponStyle(itemDefs);
  const attackBonus = meleeAttackBonusForStyle(attackBonuses, weaponStyle);
  const defenceBonus = meleeDefenceBonusForStyle(defenceBonuses, weaponStyle);
  const attackRoll = effAcc * (attackBonus + ACC_BASE);
  const defRoll = (defender.skills.defence.currentLevel + defenceStance.defence + 8) * (defenceBonus + ACC_BASE);
  const maxHit = osrsMeleeMaxHit(effStr, attackBonuses.meleeStrength);
  return rollHitDamage(attackRoll, defRoll, maxHit, rng);
}

export function rollPlayerRangedDamageAgainstPlayer(
  attacker: Player,
  defender: Player,
  itemDefs: Map<number, ItemDef>,
  rng: () => number = Math.random,
): number {
  const attackBonuses = attacker.computeBonuses(itemDefs);
  const defenceBonuses = defender.computeBonuses(itemDefs);
  const defenceStance = STANCE_BONUSES[defender.stance];
  const effRanged = attacker.skills.archery.currentLevel + 8;
  const attackRollMultiplier = attacker.getWeaponStyle(itemDefs) === 'bow'
    ? bowAttackRollMultiplierForStance(attacker.stance)
    : 1.0;
  const attackRoll = Math.floor(effRanged * (attackBonuses.rangedAccuracy + ACC_BASE) * attackRollMultiplier);
  const defRoll = (defender.skills.defence.currentLevel + defenceStance.defence + 8) * (defenceBonuses.rangedDefence + ACC_BASE);
  const maxHit = osrsMeleeMaxHit(effRanged, attackBonuses.rangedStrength);
  return rollHitDamage(attackRoll, defRoll, maxHit, rng);
}

export function rollPlayerMagicDamageAgainstNpc(
  player: Player,
  npc: Npc,
  itemDefs: Map<number, ItemDef>,
  magicLevel: number,
  spellTier: number,
  stance: MagicStance,
  rng: () => number = Math.random,
): number {
  const stanceBonus = MAGIC_STANCE_BONUSES[stance];
  const bonuses = player.computeBonuses(itemDefs);
  const attackRoll = (magicLevel + stanceBonus.accuracy + 8) * (bonuses.magicAccuracy + ACC_BASE);
  const defRoll = npcMagicDefenceRoll(npc.combatStats);
  const maxHit = Math.max(1, magicMaxHit(magicLevel, spellTier) + stanceBonus.maxHit);
  return rollHitDamage(attackRoll, defRoll, maxHit, rng);
}

export function rollPlayerMagicDamageAgainstPlayer(
  attacker: Player,
  defender: Player,
  itemDefs: Map<number, ItemDef>,
  magicLevel: number,
  spellTier: number,
  stance: MagicStance,
  rng: () => number = Math.random,
): number {
  const stanceBonus = MAGIC_STANCE_BONUSES[stance];
  const attackBonuses = attacker.computeBonuses(itemDefs);
  const defenceBonuses = defender.computeBonuses(itemDefs);
  const attackRoll = (magicLevel + stanceBonus.accuracy + 8) * (attackBonuses.magicAccuracy + ACC_BASE);
  const defRoll = (defender.skills.defence.currentLevel + 8) * (defenceBonuses.magicDefence + ACC_BASE);
  const maxHit = Math.max(1, magicMaxHit(magicLevel, spellTier) + stanceBonus.maxHit);
  return rollHitDamage(attackRoll, defRoll, maxHit, rng);
}

/**
 * 2004Scape-style melee combat: player attacks NPC.
 * - Dual random roll hit check (not percentage)
 * - Damage = random(0..maxHit) inclusive (0 = hit but no damage)
 * - XP awarded on capped damage (no overkill XP)
 * - NPC reaction/flee/retaliation resolved centrally here
 */
export function processPlayerCombat(
  player: Player,
  npc: Npc,
  itemDefs: Map<number, ItemDef>,
  options: PlayerNpcCombatOptions = {},
): PlayerNpcCombatResult | null {
  if (npc.dead || !player.alive) return null;

  if (!isPointInNpcMeleeAttackRange(npc, player.position.x, player.position.y)) return null;

  if (player.attackCooldown > 0) return null;
  player.attackCooldown = player.getAttackSpeed(itemDefs);

  const damage = rollPlayerMeleeDamageAgainstNpc(player, npc, itemDefs, options.rng);
  const actual = npc.takeDamage(damage);
  const xp = grantMeleeCombatXp(player, actual);
  if (actual > 0) npc.addHeroPoints(player.id, actual);
  const npcReaction = applyNpcReactionToPlayerHit(npc, player, { queueRetaliation: options.queueNpcRetaliation });

  return {
    hit: hit(player.id, npc.id, actual, npc.health, npc.maxHealth),
    xpDrops: xp.xpDrops,
    levelUps: xp.levelUps,
    npcReaction,
  };
}

/**
 * Ranged combat: player attacks NPC with equipped ranged gear/ammo.
 * Equipment bonuses include equipped ammo, so no separate ammo strength
 * argument is accepted here.
 */
export function processPlayerRangedCombat(
  player: Player,
  npc: Npc,
  itemDefs: Map<number, ItemDef>,
  options: PlayerNpcCombatOptions = {},
): PlayerNpcCombatResult | null {
  if (npc.dead || !player.alive) return null;

  if (!isPointInNpcRangedAttackRange(npc, player.position.x, player.position.y, player.getRangedAttackRange(itemDefs))) return null;

  if (player.attackCooldown > 0) return null;
  player.attackCooldown = player.getAttackSpeed(itemDefs);

  const damage = rollPlayerRangedDamageAgainstNpc(player, npc, itemDefs, options.rng);
  const actual = npc.takeDamage(damage);
  const xp = grantRangedCombatXp(player, actual);
  if (actual > 0) npc.addHeroPoints(player.id, actual);
  const npcReaction = applyNpcReactionToPlayerHit(npc, player, { queueRetaliation: options.queueNpcRetaliation });

  return {
    hit: hit(player.id, npc.id, actual, npc.health, npc.maxHealth),
    xpDrops: xp.xpDrops,
    levelUps: xp.levelUps,
    npcReaction,
    isRanged: true,
  };
}

export function applyPlayerMagicImpactToNpc(
  player: Player,
  npc: Npc,
  damage: number,
  xpSkill: SkillId,
  stance: MagicStance,
  options: PlayerNpcCombatOptions = {},
): PlayerNpcCombatResult {
  const actual = npc.takeDamage(damage);
  const xp = grantMagicCombatXp(player, xpSkill, actual, stance);
  if (actual > 0) npc.addHeroPoints(player.id, actual);
  const npcReaction = applyNpcReactionToPlayerHit(npc, player, { queueRetaliation: options.queueNpcRetaliation });
  return {
    hit: hit(player.id, npc.id, actual, npc.health, npc.maxHealth),
    xpDrops: xp.xpDrops,
    levelUps: xp.levelUps,
    npcReaction,
    isMagic: true,
  };
}

/**
 * NPC attacks player — 2004Scape style.
 */
export function processNpcCombat(
  npc: Npc,
  target: Player,
  itemDefs: Map<number, ItemDef>,
  options: NpcCombatOptions = {},
): CombatHit | null {
  if (npc.dead || !target.alive) {
    npc.setCombatTarget(null);
    return null;
  }

  if (options.tickCooldown !== false && npc.attackCooldown > 0) npc.attackCooldown--;

  if (!npc.isInteractionTile(Math.floor(target.position.x), Math.floor(target.position.y))) return null;

  if (npc.attackCooldown > 0) return null;
  npc.attackCooldown = npc.attackSpeed;

  const damage = rollNpcMeleeDamageAgainstPlayer(npc, target, itemDefs, options.rng);
  const actual = target.takeDamage(damage);
  target.skills.hitpoints.currentLevel = target.health;

  return hit(npc.id, target.id, actual, target.health, target.maxHealth);
}

/**
 * Roll loot — drops go to the player with the most hero points (kill credit).
 * Relic drops are authored directly in npc loot tables so designers can see
 * and tune the exact per-mob chance in the editor.
 */
export function rollLoot(npc: Npc, options: LootRollOptions = {}): RolledLootDrop[] {
  if (NO_LOOT_NPC_IDS.has(npc.def.id)) return [];

  const rng = options.rng ?? Math.random;
  const drops: RolledLootDrop[] = [];
  for (const drop of npc.def.lootTable) {
    if (rng() <= drop.chance) {
      drops.push({ itemId: drop.itemId, quantity: drop.quantity, dropChance: drop.chance });
    }
  }

  if (options.rareDropTables) {
    for (const access of npc.def.rareDropTables ?? []) {
      if (!Number.isFinite(access.chance) || access.chance <= 0) continue;
      const authoredRolls = Math.floor(access.rolls ?? 1);
      const rolls = Number.isFinite(authoredRolls) && authoredRolls > 0 ? authoredRolls : 1;
      for (let i = 0; i < rolls; i++) {
        if (rng() > access.chance) continue;
        const rareDrop = rollRareDropTable(access.tableId, options.rareDropTables, rng);
        if (rareDrop) {
          drops.push({
            ...rareDrop,
            rare: true,
            source: 'rare_drop_table',
            rareAccessTableId: access.tableId,
          });
        }
      }
    }
  }

  return drops;
}
