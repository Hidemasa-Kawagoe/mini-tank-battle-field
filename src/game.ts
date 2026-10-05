/**
 * Shared game constants and types for phase1 of the mini tank battle game.
 * Used by both the Durable Object (server, authoritative simulation) and the
 * client page (rendering only).
 */

export const FIELD_WIDTH = 800;
export const FIELD_HEIGHT = 600;

export const TANK_RADIUS = 14;
export const PROJECTILE_RADIUS = 4;

// Tank levels: start at 0, +1 per kill, back to 0 when hit. Effects stack.
export const MAX_LEVEL = 4;
// Level 1+: projectiles are as large as a tank (easier to land).
export const BIG_PROJECTILE_MIN_LEVEL = 1;
// Level 2+: attack +1, so a hit costs the target 2 durability instead of 1.
export const BONUS_DAMAGE_MIN_LEVEL = 2;
// Reaching level 3 equips a shield on each side (durability 1); reaching
// level 4 equips one at the rear (durability 5). Once equipped, shields are
// independent of the level: they survive it dropping back to 0 and only go
// away when shot down (or on respawn).
export const SIDE_SHIELD_LEVEL = 3;
export const REAR_SHIELD_LEVEL = 4;
export const SIDE_SHIELD_HP = 1;
export const REAR_SHIELD_HP = 5;

// Tank body dimensions (the tank is drawn as an isosceles triangle).
export const TANK_LENGTH = TANK_RADIUS * 1.8; // nose to rear
export const TANK_WIDTH = TANK_RADIUS * 1.6; // across the rear
// Shields sit this far outside the body and are this thick.
export const SHIELD_GAP = 4;
export const SHIELD_THICKNESS = 4;

export interface Segment {
	x1: number;
	y1: number;
	x2: number;
	y2: number;
}

export type ShieldSide = "left" | "right" | "rear";

/**
 * World-space segments for a tank's three possible shield slots. Side
 * shields run the tank's full length alongside it; the rear shield spans its
 * full width behind it. "Right" is the tank's right as seen on screen
 * (y points down) when facing `facing`.
 */
export function shieldSegments(x: number, y: number, facing: number): Record<ShieldSide, Segment> {
	const fx = Math.cos(facing);
	const fy = Math.sin(facing);
	const rx = -fy; // right of forward
	const ry = fx;
	// The tank's position is its drawing origin, which sits TANK_RADIUS behind
	// the nose, so the nose-to-rear midpoint is a little ahead of it.
	const midAhead = TANK_RADIUS - TANK_LENGTH / 2;
	const sideOffset = TANK_WIDTH / 2 + SHIELD_GAP;
	const sideCx = x + fx * midAhead;
	const sideCy = y + fy * midAhead;
	const halfLen = TANK_LENGTH / 2;
	const rearDist = TANK_LENGTH - TANK_RADIUS + SHIELD_GAP; // behind the tank's centre
	const rearCx = x - fx * rearDist;
	const rearCy = y - fy * rearDist;
	const halfWidth = TANK_WIDTH / 2;
	const side = (sign: number): Segment => ({
		x1: sideCx + sign * rx * sideOffset + fx * halfLen,
		y1: sideCy + sign * ry * sideOffset + fy * halfLen,
		x2: sideCx + sign * rx * sideOffset - fx * halfLen,
		y2: sideCy + sign * ry * sideOffset - fy * halfLen,
	});
	return {
		left: side(-1),
		right: side(1),
		rear: {
			x1: rearCx + rx * halfWidth,
			y1: rearCy + ry * halfWidth,
			x2: rearCx - rx * halfWidth,
			y2: rearCy - ry * halfWidth,
		},
	};
}

function pointSegmentDistance(px: number, py: number, s: Segment): number {
	const dx = s.x2 - s.x1;
	const dy = s.y2 - s.y1;
	const lenSq = dx * dx + dy * dy;
	const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - s.x1) * dx + (py - s.y1) * dy) / lenSq));
	return Math.hypot(px - (s.x1 + t * dx), py - (s.y1 + t * dy));
}

function segmentsIntersect(a: Segment, b: Segment): boolean {
	const d = (a.x2 - a.x1) * (b.y2 - b.y1) - (a.y2 - a.y1) * (b.x2 - b.x1);
	if (d === 0) return false; // parallel (collinear overlap is caught by the endpoint distances)
	const t = ((b.x1 - a.x1) * (b.y2 - b.y1) - (b.y1 - a.y1) * (b.x2 - b.x1)) / d;
	const u = ((b.x1 - a.x1) * (a.y2 - a.y1) - (b.y1 - a.y1) * (a.x2 - a.x1)) / d;
	return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

/** Shortest distance between two segments (0 if they cross). A moving
 * projectile's path is a segment, so this avoids tunnelling through thin
 * shields between ticks. */
export function segmentDistance(a: Segment, b: Segment): number {
	if (segmentsIntersect(a, b)) return 0;
	return Math.min(
		pointSegmentDistance(a.x1, a.y1, b),
		pointSegmentDistance(a.x2, a.y2, b),
		pointSegmentDistance(b.x1, b.y1, a),
		pointSegmentDistance(b.x2, b.y2, a),
	);
}

export function projectileRadiusForLevel(level: number): number {
	return level >= BIG_PROJECTILE_MIN_LEVEL ? TANK_RADIUS : PROJECTILE_RADIUS;
}

export function projectileDamageForLevel(level: number): number {
	return level >= BONUS_DAMAGE_MIN_LEVEL ? 2 : 1;
}

// "移動速度: 固定値 毎秒2ユニット" — 1 unit = 20px, so 2 units/sec = 40px/sec.
export const UNIT_PX = 20;
export const MOVE_SPEED_PX_PER_SEC = UNIT_PX * 2;
export const PROJECTILE_SPEED_PX_PER_SEC = 300;

// Starting durability (also the cap for Armor pickups) differs between users and NPCs.
export const PLAYER_INITIAL_HP = 10;
export const NPC_INITIAL_HP = 5;
// Starting ammo (also the cap for Bullet pickups) differs between users and NPCs.
export const PLAYER_INITIAL_AMMO = 100;
export const NPC_INITIAL_AMMO = 10;

export const TICK_MS = 50;

// Holding fire charges one shot's worth every CHARGE_INTERVAL_MS, up to
// CHARGE_MAX_SHOTS (and never more than the ammo left). Releasing fires a
// single projectile that spends that many rounds and hits that much harder.
export const CHARGE_INTERVAL_MS = 500;
export const CHARGE_MAX_SHOTS = 5;

export const ITEM_RADIUS = 10;

// Defaults for the environment variables (wrangler.jsonc "vars"), used
// whenever the corresponding var is unset or not a valid positive number.
export const DEFAULT_IDLE_TIMEOUT_SECONDS = 180;
export const DEFAULT_ARMOR_RECOVER_AMOUNT = 5;
export const DEFAULT_BULLET_RECOVER_AMOUNT = 5;
export const DEFAULT_ITEM_SPAWN_INTERVAL_SECONDS = 60;
export const DEFAULT_NPC_MAX_COUNT = 5;
export const DEFAULT_NPC_SPAWN_INTERVAL_SECONDS = 3;

// NPC tank behavior tuning.
export const NPC_COLOR = "#9e9e9e";
export const NPC_THINK_MIN_MS = 500;
export const NPC_THINK_MAX_MS = 1500;
export const NPC_MOVE_TIMEOUT_MS = 30_000;
// An NPC counts as having reached its destination when it's this close
// (per axis); the same value is the per-axis dead zone while steering.
export const NPC_ARRIVE_TOLERANCE_PX = 3;
// "耐久値が低い" threshold below which an NPC heads for an Armor item.
export const NPC_LOW_HP_THRESHOLD = 3;
export const NPC_TURN_TOWARD_USER_CHANCE = 0.5;
export const NPC_FIRE_CHANCE_ON_LINE = 0.5;
export const NPC_FIRE_CHANCE_NEAR_LINE = 0.2;
// Perpendicular distance from the line of fire within which a tank counts as
// "around" it (a tank within the shooter's projectile hit width is "on" it).
export const NPC_NEAR_LINE_WIDTH_PX = 60;

export const PLAYER_COLORS = [
	"#e6194b",
	"#3cb44b",
	"#4363d8",
	"#f58231",
	"#911eb4",
	"#46f0f0",
	"#f032e6",
	"#bcf60c",
	"#fabebe",
	"#008080",
	"#e6beff",
	"#9a6324",
];

export interface PlayerAttachment {
	id: string;
	name: string;
	color: string;
	x: number;
	y: number;
	dirX: number;
	dirY: number;
	facing: number; // radians, last non-zero movement direction
	hp: number;
	ammo: number;
	score: number;
	level: number;
	alive: boolean;
	// When the fire key was pressed, while it's held; null when not charging.
	chargeStartAt: number | null;
	// Remaining durability of each shield; 0 = not equipped / destroyed.
	shieldLeft: number;
	shieldRight: number;
	shieldRear: number;
	joinedAt: number;
	lastActivityAt: number;
	idleKicked: boolean;
}

/** Autonomous-behavior state for an NPC tank. */
export interface NpcAi {
	target: { x: number; y: number; item: ItemType | null } | null;
	moveDeadline: number;
	nextThinkAt: number;
}

export interface Projectile {
	ownerId: string;
	ownerColor: string;
	x: number;
	y: number;
	// Where it was last tick, so collisions can sweep the path it travelled.
	prevX: number;
	prevY: number;
	vx: number;
	vy: number;
	// Fixed at fire time from the shooter's level then.
	radius: number;
	damage: number;
}

export interface StatePlayer {
	id: string;
	name: string;
	color: string;
	x: number;
	y: number;
	facing: number;
	hp: number;
	ammo: number;
	score: number;
	level: number;
	// Current charge in shots' worth (0..CHARGE_MAX_SHOTS, fractional).
	charge: number;
	shieldLeft: number;
	shieldRight: number;
	shieldRear: number;
	alive: boolean;
}

export interface StateProjectile {
	x: number;
	y: number;
	color: string;
	radius: number;
}

export type ItemType = "armor" | "bullet";

export interface FieldItem {
	type: ItemType;
	x: number;
	y: number;
}

/** One-off things that happened this tick, for the client to play effects. */
export type GameEvent =
	| { type: "hit"; id: string; x: number; y: number; damage: number } // x,y = impact point
	| { type: "shieldHit"; id: string; x: number; y: number; broken: boolean }
	| { type: "destroyed"; id: string; x: number; y: number; color: string };

export type ServerMessage =
	| { type: "welcome"; id: string; color: string }
	| {
			type: "state";
			players: StatePlayer[];
			projectiles: StateProjectile[];
			items: FieldItem[];
			events: GameEvent[];
	  }
	| { type: "log"; text: string };

export type ClientMessage =
	| { type: "input"; dir: { x: -1 | 0 | 1; y: -1 | 0 | 1 }; face: boolean }
	| { type: "charge" } // fire key pressed: start charging
	| { type: "fire" } // fire key released: fire what's been charged
	| { type: "cancelCharge" } // e.g. the window lost focus mid-charge
	| { type: "respawn" };

export function randomColor(): string {
	return PLAYER_COLORS[Math.floor(Math.random() * PLAYER_COLORS.length)];
}

export function randomSpawn(): { x: number; y: number } {
	return {
		x: TANK_RADIUS + Math.random() * (FIELD_WIDTH - TANK_RADIUS * 2),
		y: TANK_RADIUS + Math.random() * (FIELD_HEIGHT - TANK_RADIUS * 2),
	};
}

/** Parses a numeric env var, falling back to `defaultValue` for anything
 * unset, non-numeric, or non-positive. */
export function parsePositiveNumber(value: string | undefined, defaultValue: number): number {
	const n = Number(value);
	return value && Number.isFinite(n) && n > 0 ? n : defaultValue;
}

/** Like parsePositiveNumber, but allows 0 and rounds down to an integer. */
export function parseNonNegativeInt(value: string | undefined, defaultValue: number): number {
	const n = Number(value);
	return value && Number.isFinite(n) && n >= 0 ? Math.floor(n) : defaultValue;
}

/** Parses the IDLE_TIMEOUT_SECONDS env var into milliseconds. */
export function parseIdleTimeoutMs(value: string | undefined): number {
	return parsePositiveNumber(value, DEFAULT_IDLE_TIMEOUT_SECONDS) * 1000;
}
