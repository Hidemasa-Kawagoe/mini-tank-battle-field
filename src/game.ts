/**
 * Shared game constants and types for phase1 of the mini tank battle game.
 * Used by both the Durable Object (server, authoritative simulation) and the
 * client page (rendering only).
 */

export const FIELD_WIDTH = 800;
export const FIELD_HEIGHT = 600;

export const TANK_RADIUS = 14;
export const PROJECTILE_RADIUS = 4;

// "移動速度: 固定値 毎秒2ユニット" — 1 unit = 20px, so 2 units/sec = 40px/sec.
export const UNIT_PX = 20;
export const MOVE_SPEED_PX_PER_SEC = UNIT_PX * 2;
export const PROJECTILE_SPEED_PX_PER_SEC = 300;

export const INITIAL_HP = 10;
export const INITIAL_AMMO = 10;

export const TICK_MS = 50;

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
	alive: boolean;
	joinedAt: number;
}

export interface Projectile {
	ownerId: string;
	ownerColor: string;
	x: number;
	y: number;
	vx: number;
	vy: number;
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
	alive: boolean;
}

export interface StateProjectile {
	x: number;
	y: number;
	color: string;
}

export type ServerMessage =
	| { type: "welcome"; id: string; color: string }
	| { type: "state"; players: StatePlayer[]; projectiles: StateProjectile[] }
	| { type: "log"; text: string };

export type ClientMessage =
	| { type: "input"; dir: { x: -1 | 0 | 1; y: -1 | 0 | 1 }; face: boolean }
	| { type: "fire" }
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
