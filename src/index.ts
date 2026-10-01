import { DurableObject } from "cloudflare:workers";
import { CLIENT_HTML } from "./client";
import {
	DEFAULT_ARMOR_RECOVER_AMOUNT,
	DEFAULT_BULLET_RECOVER_AMOUNT,
	DEFAULT_ITEM_SPAWN_INTERVAL_SECONDS,
	DEFAULT_NPC_MAX_COUNT,
	DEFAULT_NPC_SPAWN_INTERVAL_SECONDS,
	FIELD_HEIGHT,
	FIELD_WIDTH,
	INITIAL_HP,
	ITEM_RADIUS,
	MOVE_SPEED_PX_PER_SEC,
	NPC_ARRIVE_TOLERANCE_PX,
	NPC_COLOR,
	NPC_FIRE_CHANCE_NEAR_LINE,
	NPC_FIRE_CHANCE_ON_LINE,
	NPC_INITIAL_AMMO,
	NPC_LOW_HP_THRESHOLD,
	NPC_MOVE_TIMEOUT_MS,
	NPC_NEAR_LINE_WIDTH_PX,
	NPC_THINK_MAX_MS,
	NPC_THINK_MIN_MS,
	NPC_TURN_TOWARD_USER_CHANCE,
	PLAYER_INITIAL_AMMO,
	PROJECTILE_SPEED_PX_PER_SEC,
	TANK_RADIUS,
	PROJECTILE_RADIUS,
	TICK_MS,
	parseIdleTimeoutMs,
	parseNonNegativeInt,
	parsePositiveNumber,
	randomColor,
	randomSpawn,
	type ClientMessage,
	type FieldItem,
	type ItemType,
	type NpcAi,
	type PlayerAttachment,
	type Projectile,
	type ServerMessage,
	type StatePlayer,
} from "./game";

/**
 * A tank taking part in one tick's simulation: either a human player
 * (state lives on the WebSocket attachment, `ws` set) or an NPC (state lives
 * in memory, `ai` set).
 */
interface Tank {
	data: PlayerAttachment;
	ws: WebSocket | null;
	ai: NpcAi | null;
}

const FACING_STEP = Math.PI / 4;

/**
 * Battlefield Durable Object — one shared instance holds the whole phase1
 * arena. All connected players see the same authoritative game state.
 *
 * Per-player state lives on each WebSocket's hibernation attachment
 * (survives hibernation). In-flight projectiles, field items and NPC tanks
 * live in memory only; the object stays active (via a self-rescheduling
 * alarm) for the whole time any player is connected or a projectile is in
 * flight, so this is fine for phase1's goal of validating shared multiplayer
 * state.
 */
export class Battlefield extends DurableObject<Env> {
	private projectiles: Projectile[] = [];
	private items: FieldItem[] = [];
	private npcs: Tank[] = [];
	private npcCounter = 0;
	private lastTick = Date.now();
	private nextArmorSpawnAt: number | null = null;
	private nextBulletSpawnAt: number | null = null;
	private nextNpcSpawnAt: number | null = null;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
	}

	async fetch(request: Request): Promise<Response> {
		if (request.headers.get("Upgrade") !== "websocket") {
			return new Response("Expected websocket", { status: 426 });
		}

		const url = new URL(request.url);
		const rawName = url.searchParams.get("name") ?? "";
		const name = rawName.trim().slice(0, 16) || "名無し";

		const pair = new WebSocketPair();
		const [client, server] = Object.values(pair);

		this.ctx.acceptWebSocket(server);

		const spawn = randomSpawn();
		const player: PlayerAttachment = {
			id: crypto.randomUUID(),
			name,
			color: randomColor(),
			x: spawn.x,
			y: spawn.y,
			dirX: 0,
			dirY: 0,
			facing: -Math.PI / 2,
			hp: INITIAL_HP,
			ammo: PLAYER_INITIAL_AMMO,
			score: 0,
			alive: true,
			joinedAt: Date.now(),
			lastActivityAt: Date.now(),
			idleKicked: false,
		};
		server.serializeAttachment(player);

		this.send(server, { type: "welcome", id: player.id, color: player.color });
		this.broadcastLog(`${player.name} が入場しました`);
		await this.ensureTicking();

		return new Response(null, { status: 101, webSocket: client });
	}

	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
		if (typeof message !== "string") return;

		let msg: ClientMessage;
		try {
			msg = JSON.parse(message);
		} catch {
			return;
		}

		const player = ws.deserializeAttachment() as PlayerAttachment | null;
		if (!player) return;

		// Any real client message counts as activity, resetting the idle
		// timer. Persist it up front so it's not lost if a case below
		// returns early (e.g. firing with no ammo) without its own save.
		player.lastActivityAt = Date.now();
		ws.serializeAttachment(player);

		switch (msg.type) {
			case "input": {
				player.dirX = msg.dir.x;
				player.dirY = msg.dir.y;
				// Only re-aim on a key press (a direction being added), never on a
				// key release. Otherwise releasing one of two diagonal keys — which
				// almost always happens a moment before the other — would snap
				// facing to the remaining single axis, both mid-movement (breaking
				// diagonal fire) and on a full stop (losing the diagonal facing).
				if (msg.face && (msg.dir.x !== 0 || msg.dir.y !== 0)) {
					player.facing = Math.atan2(msg.dir.y, msg.dir.x);
				}
				ws.serializeAttachment(player);
				break;
			}
			case "fire": {
				if (!player.alive || player.ammo <= 0) break;
				this.fireProjectile(player);
				ws.serializeAttachment(player);
				break;
			}
			case "respawn": {
				if (player.hp > 0) break;
				const spawn = randomSpawn();
				player.hp = INITIAL_HP;
				player.ammo = PLAYER_INITIAL_AMMO;
				player.alive = true;
				player.x = spawn.x;
				player.y = spawn.y;
				player.dirX = 0;
				player.dirY = 0;
				ws.serializeAttachment(player);
				break;
			}
		}

		await this.ensureTicking();
	}

	async webSocketClose(ws: WebSocket): Promise<void> {
		const player = ws.deserializeAttachment() as PlayerAttachment | null;
		if (player) {
			this.broadcastLog(player.idleKicked ? `${player.name} が無操作のため退場しました` : `${player.name} が退場しました`);
		}
		// The Hibernation API requires the Durable Object to close its own
		// end explicitly, or the client's WebSocket never reaches CLOSED.
		// The incoming code/reason may be a reserved value (e.g. 1005) that
		// can't legally be echoed back, so close with a fixed, valid code.
		try {
			ws.close(1000, "leave");
		} catch {
			// Already closed; nothing to do.
		}
	}

	async webSocketError(): Promise<void> {
		// Connection dropped unexpectedly; nothing to clean up beyond what
		// the runtime already does for the closed WebSocket.
	}

	async alarm(): Promise<void> {
		const now = Date.now();
		const dt = Math.min((now - this.lastTick) / 1000, 0.5);
		this.lastTick = now;

		// Kick anyone idle past the configured timeout before simulating this
		// tick, so they're excluded from movement/collisions/the broadcast.
		const idleTimeoutMs = parseIdleTimeoutMs(this.env.IDLE_TIMEOUT_SECONDS);
		const humans: Tank[] = [];
		for (const ws of this.ctx.getWebSockets()) {
			const player = ws.deserializeAttachment() as PlayerAttachment | null;
			if (!player) continue;
			if (now - player.lastActivityAt >= idleTimeoutMs) {
				player.idleKicked = true;
				ws.serializeAttachment(player);
				try {
					ws.close(1000, "idle-timeout");
				} catch {
					// Already closed; nothing to do.
				}
				continue;
			}
			humans.push({ data: player, ws, ai: null });
		}

		this.maybeSpawnItem("armor", now);
		this.maybeSpawnItem("bullet", now);
		this.maybeSpawnNpc(humans.length, now);

		// Everything below works on this tick's working copies of each tank's
		// state; human attachments are written back once, after the sim.
		const tanks: Tank[] = [...humans, ...this.npcs];

		for (const npc of this.npcs) this.runNpcAi(npc, tanks, humans, now);

		// Move tanks according to held-direction input / NPC steering.
		for (const { data } of tanks) {
			if (!data.alive) continue;

			let dx = data.dirX;
			let dy = data.dirY;
			if (dx !== 0 && dy !== 0) {
				const norm = Math.SQRT1_2;
				dx *= norm;
				dy *= norm;
			}
			data.x = clamp(data.x + dx * MOVE_SPEED_PX_PER_SEC * dt, TANK_RADIUS, FIELD_WIDTH - TANK_RADIUS);
			data.y = clamp(data.y + dy * MOVE_SPEED_PX_PER_SEC * dt, TANK_RADIUS, FIELD_HEIGHT - TANK_RADIUS);
		}

		// Item pickup: an alive tank standing close enough to an item
		// collects it, restoring durability/ammo up to that stat's max.
		this.items = this.items.filter((item) => {
			for (const tank of tanks) {
				const { data } = tank;
				if (!data.alive) continue;

				const dx = data.x - item.x;
				const dy = data.y - item.y;
				if (Math.sqrt(dx * dx + dy * dy) > TANK_RADIUS + ITEM_RADIUS) continue;

				if (item.type === "armor") {
					const amount = parsePositiveNumber(this.env.ARMOR_RECOVER_AMOUNT, DEFAULT_ARMOR_RECOVER_AMOUNT);
					const before = data.hp;
					data.hp = Math.min(INITIAL_HP, data.hp + amount);
					if (tank.ws) this.send(tank.ws, { type: "log", text: `耐久値を${data.hp - before}回復した（Armor）` });
				} else {
					const amount = parsePositiveNumber(this.env.BULLET_RECOVER_AMOUNT, DEFAULT_BULLET_RECOVER_AMOUNT);
					const before = data.ammo;
					const maxAmmo = tank.ai ? NPC_INITIAL_AMMO : PLAYER_INITIAL_AMMO;
					data.ammo = Math.min(maxAmmo, data.ammo + amount);
					if (tank.ws) this.send(tank.ws, { type: "log", text: `残弾数を${data.ammo - before}回復した（Bullet）` });
				}
				return false;
			}
			return true;
		});

		// Move projectiles and drop ones that left the field.
		this.projectiles = this.projectiles.filter((p) => {
			p.x += p.vx * dt;
			p.y += p.vy * dt;
			return p.x >= 0 && p.x <= FIELD_WIDTH && p.y >= 0 && p.y <= FIELD_HEIGHT;
		});

		// Collision detection: projectile vs. other tanks (humans and NPCs).
		const remaining: Projectile[] = [];
		for (const projectile of this.projectiles) {
			let hit = false;
			for (const tank of tanks) {
				const target = tank.data;
				if (!target.alive || target.id === projectile.ownerId) continue;

				const dx = target.x - projectile.x;
				const dy = target.y - projectile.y;
				const distance = Math.sqrt(dx * dx + dy * dy);
				if (distance > TANK_RADIUS + PROJECTILE_RADIUS) continue;

				target.hp -= 1;
				const destroyed = target.hp <= 0;
				if (destroyed) target.alive = false;

				this.sendLogToTank(tanks, projectile.ownerId, `${target.name} に命中させた！${destroyed ? "（撃破）" : ""}`);
				this.sendLogToTank(tanks, target.id, `${this.findTankName(tanks, projectile.ownerId)} の弾が命中した${destroyed ? "（被撃破）" : ""}`);

				if (destroyed) {
					const shooter = tanks.find((t) => t.data.id === projectile.ownerId);
					if (shooter) shooter.data.score += 1;
				}

				hit = true;
				break;
			}
			if (!hit) remaining.push(projectile);
		}
		this.projectiles = remaining;

		// Destroyed NPCs leave the field (freeing a slot for the next spawn)
		// and drop a random Armor or Bullet item where they died. Drops are
		// extra: they ignore the one-per-type limit that governs periodic
		// spawns. Human attachments are persisted.
		for (const npc of this.npcs) {
			if (npc.data.alive) continue;
			this.items.push({ type: Math.random() < 0.5 ? "armor" : "bullet", x: npc.data.x, y: npc.data.y });
		}
		this.npcs = this.npcs.filter((npc) => npc.data.alive);
		for (const human of humans) human.ws?.serializeAttachment(human.data);

		// Broadcast the authoritative snapshot to every human.
		const players: StatePlayer[] = [...humans, ...this.npcs].map(({ data: p }) => ({
			id: p.id,
			name: p.name,
			color: p.color,
			x: p.x,
			y: p.y,
			facing: p.facing,
			hp: p.hp,
			ammo: p.ammo,
			score: p.score,
			alive: p.alive,
		}));

		const state: ServerMessage = {
			type: "state",
			players,
			projectiles: this.projectiles.map((p) => ({ x: p.x, y: p.y, color: p.ownerColor })),
			items: this.items,
		};
		for (const human of humans) if (human.ws) this.send(human.ws, state);

		if (humans.length > 0 || this.projectiles.length > 0) {
			await this.ctx.storage.setAlarm(Date.now() + TICK_MS);
		}
	}

	// Every ARMOR_SPAWN_INTERVAL_SECONDS / BULLET_SPAWN_INTERVAL_SECONDS,
	// spawn one item of that type at a random field position — but only if
	// one isn't already out there. The schedule advances on a fixed cadence
	// regardless of whether a spawn actually happened, so a type that's
	// stuck occupied is simply re-checked next interval, not spawned in a
	// burst the moment it's freed up.
	private maybeSpawnItem(type: ItemType, now: number): void {
		const intervalMs =
			parsePositiveNumber(
				type === "armor" ? this.env.ARMOR_SPAWN_INTERVAL_SECONDS : this.env.BULLET_SPAWN_INTERVAL_SECONDS,
				DEFAULT_ITEM_SPAWN_INTERVAL_SECONDS,
			) * 1000;

		let nextAt = type === "armor" ? this.nextArmorSpawnAt : this.nextBulletSpawnAt;
		if (nextAt === null) {
			nextAt = now + intervalMs;
		} else if (now >= nextAt) {
			if (!this.items.some((item) => item.type === type)) {
				const spawn = randomSpawn();
				this.items.push({ type, x: spawn.x, y: spawn.y });
			}
			nextAt = now + intervalMs;
		}

		if (type === "armor") this.nextArmorSpawnAt = nextAt;
		else this.nextBulletSpawnAt = nextAt;
	}

	// NPCs only exist while at least one human is logged in: they spawn one
	// per NPC_SPAWN_INTERVAL_SECONDS up to NPC_MAX_COUNT, and are all removed
	// once the last human leaves.
	private maybeSpawnNpc(humanCount: number, now: number): void {
		if (humanCount === 0) {
			this.npcs = [];
			this.nextNpcSpawnAt = null;
			return;
		}

		const intervalMs = parsePositiveNumber(this.env.NPC_SPAWN_INTERVAL_SECONDS, DEFAULT_NPC_SPAWN_INTERVAL_SECONDS) * 1000;
		if (this.nextNpcSpawnAt === null) {
			this.nextNpcSpawnAt = now + intervalMs;
			return;
		}
		if (now < this.nextNpcSpawnAt) return;
		this.nextNpcSpawnAt = now + intervalMs;

		if (this.npcs.length >= parseNonNegativeInt(this.env.NPC_MAX_COUNT, DEFAULT_NPC_MAX_COUNT)) return;

		const n = ++this.npcCounter;
		const spawn = randomSpawn();
		this.npcs.push({
			data: {
				id: `npc-${n}`,
				name: `NPC-${n}`,
				color: NPC_COLOR,
				x: spawn.x,
				y: spawn.y,
				dirX: 0,
				dirY: 0,
				facing: Math.floor(Math.random() * 8) * FACING_STEP,
				hp: INITIAL_HP,
				ammo: NPC_INITIAL_AMMO,
				score: 0,
				alive: true,
				joinedAt: now,
				lastActivityAt: now,
				idleKicked: false,
			},
			ws: null,
			ai: { target: null, moveDeadline: 0, nextThinkAt: now + this.randomThinkDelayMs() },
		});
	}

	// One NPC's autonomous behavior for this tick. It steers toward its
	// current destination every tick, and every "think" interval picks one of
	// fire / move / turn.
	private runNpcAi(npc: Tank, tanks: Tank[], humans: Tank[], now: number): void {
		const { data, ai } = npc;
		if (!ai || !data.alive) return;

		if (ai.target) {
			const t = ai.target;
			const dx = t.x - data.x;
			const dy = t.y - data.y;
			const itemGone = t.item !== null && !this.items.some((i) => i.type === t.item && i.x === t.x && i.y === t.y);
			const arrived = Math.abs(dx) <= NPC_ARRIVE_TOLERANCE_PX && Math.abs(dy) <= NPC_ARRIVE_TOLERANCE_PX;
			if (itemGone || arrived || now > ai.moveDeadline) {
				ai.target = null;
				data.dirX = 0;
				data.dirY = 0;
			} else {
				// Steer in the same 8 directions a human can, with a dead zone
				// so it doesn't jitter on an axis it has already lined up.
				data.dirX = Math.abs(dx) > NPC_ARRIVE_TOLERANCE_PX ? Math.sign(dx) : 0;
				data.dirY = Math.abs(dy) > NPC_ARRIVE_TOLERANCE_PX ? Math.sign(dy) : 0;
				data.facing = Math.atan2(data.dirY, data.dirX);
			}
		}

		if (now < ai.nextThinkAt) return;
		ai.nextThinkAt = now + this.randomThinkDelayMs();

		// Fire: 50% with a tank on the line of fire, 20% with one around it.
		if (data.ammo > 0 && Math.random() < this.fireChance(data, tanks)) {
			this.fireProjectile(data);
			return;
		}

		// Move: out of ammo / low on durability and the matching item is on
		// the field -> head for it. Otherwise pick a random destination.
		const supply = this.pickSupplyTarget(data);
		if (supply) {
			if (ai.target?.item !== supply.item) this.startNpcMove(ai, supply, now);
			return;
		}
		if (ai.target) return;

		if (Math.random() < 0.5) {
			this.startNpcMove(ai, { ...randomSpawn(), item: null }, now);
		} else {
			this.turnNpc(data, humans);
		}
	}

	private startNpcMove(ai: NpcAi, target: NonNullable<NpcAi["target"]>, now: number): void {
		ai.target = target;
		ai.moveDeadline = now + NPC_MOVE_TIMEOUT_MS;
	}

	// "耐久値が低い" stands in for the spec's "耐久値が０" — a tank at 0 is
	// destroyed and can't act, so a low-durability threshold is used instead.
	private pickSupplyTarget(data: PlayerAttachment): NonNullable<NpcAi["target"]> | null {
		if (data.ammo <= 0) {
			const item = this.items.find((i) => i.type === "bullet");
			if (item) return { x: item.x, y: item.y, item: "bullet" };
		}
		if (data.hp <= NPC_LOW_HP_THRESHOLD) {
			const item = this.items.find((i) => i.type === "armor");
			if (item) return { x: item.x, y: item.y, item: "armor" };
		}
		return null;
	}

	// Turn to a random 8-way direction, or (50%) the 8-way direction closest
	// to the nearest user's position.
	private turnNpc(data: PlayerAttachment, humans: Tank[]): void {
		const alive = humans.filter((h) => h.data.alive);
		const pool = alive.length > 0 ? alive : humans;

		let angle = Math.random() * Math.PI * 2;
		if (pool.length > 0 && Math.random() < NPC_TURN_TOWARD_USER_CHANCE) {
			let nearest = pool[0].data;
			let best = Infinity;
			for (const { data: h } of pool) {
				const d = (h.x - data.x) ** 2 + (h.y - data.y) ** 2;
				if (d < best) {
					best = d;
					nearest = h;
				}
			}
			angle = Math.atan2(nearest.y - data.y, nearest.x - data.x);
		}

		data.facing = Math.round(angle / FACING_STEP) * FACING_STEP;
		data.dirX = 0;
		data.dirY = 0;
	}

	// Probability that an NPC facing where it's facing should fire: tanks in
	// front of it, within a tank's hit width of the line of fire, are "on"
	// the line; ones within NPC_NEAR_LINE_WIDTH_PX are "around" it.
	private fireChance(data: PlayerAttachment, tanks: Tank[]): number {
		const fx = Math.cos(data.facing);
		const fy = Math.sin(data.facing);
		let chance = 0;
		for (const { data: other } of tanks) {
			if (other.id === data.id || !other.alive) continue;

			const vx = other.x - data.x;
			const vy = other.y - data.y;
			if (vx * fx + vy * fy <= 0) continue;

			const offLine = Math.abs(vx * fy - vy * fx);
			if (offLine <= TANK_RADIUS + PROJECTILE_RADIUS) return NPC_FIRE_CHANCE_ON_LINE;
			if (offLine <= NPC_NEAR_LINE_WIDTH_PX) chance = NPC_FIRE_CHANCE_NEAR_LINE;
		}
		return chance;
	}

	private fireProjectile(shooter: PlayerAttachment): void {
		shooter.ammo -= 1;
		const dirX = Math.cos(shooter.facing);
		const dirY = Math.sin(shooter.facing);
		this.projectiles.push({
			ownerId: shooter.id,
			ownerColor: shooter.color,
			x: shooter.x + dirX * (TANK_RADIUS + PROJECTILE_RADIUS + 2),
			y: shooter.y + dirY * (TANK_RADIUS + PROJECTILE_RADIUS + 2),
			vx: dirX * PROJECTILE_SPEED_PX_PER_SEC,
			vy: dirY * PROJECTILE_SPEED_PX_PER_SEC,
		});
	}

	private randomThinkDelayMs(): number {
		return NPC_THINK_MIN_MS + Math.random() * (NPC_THINK_MAX_MS - NPC_THINK_MIN_MS);
	}

	private async ensureTicking(): Promise<void> {
		const existing = await this.ctx.storage.getAlarm();
		if (existing === null) {
			this.lastTick = Date.now();
			await this.ctx.storage.setAlarm(Date.now() + TICK_MS);
		}
	}

	private send(ws: WebSocket, message: ServerMessage): void {
		try {
			ws.send(JSON.stringify(message));
		} catch {
			// Socket may have just closed; ignore.
		}
	}

	private broadcastLog(text: string): void {
		const message: ServerMessage = { type: "log", text };
		for (const ws of this.ctx.getWebSockets()) this.send(ws, message);
	}

	// NPCs have no socket, so logs addressed to them are simply dropped.
	private sendLogToTank(tanks: Tank[], id: string, text: string): void {
		const ws = tanks.find((t) => t.data.id === id)?.ws;
		if (ws) this.send(ws, { type: "log", text });
	}

	private findTankName(tanks: Tank[], id: string): string {
		return tanks.find((t) => t.data.id === id)?.data.name ?? "誰か";
	}
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/ws") {
			const stub = env.BATTLEFIELD.getByName("battlefield");
			return stub.fetch(request);
		}

		if (url.pathname === "/") {
			return new Response(CLIENT_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
		}

		return new Response("Not found", { status: 404 });
	},
} satisfies ExportedHandler<Env>;
