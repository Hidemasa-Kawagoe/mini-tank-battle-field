import { DurableObject } from "cloudflare:workers";
import { CLIENT_HTML } from "./client";
import {
	DEFAULT_ARMOR_RECOVER_AMOUNT,
	DEFAULT_BULLET_RECOVER_AMOUNT,
	DEFAULT_ITEM_SPAWN_INTERVAL_SECONDS,
	FIELD_HEIGHT,
	FIELD_WIDTH,
	INITIAL_AMMO,
	INITIAL_HP,
	ITEM_RADIUS,
	MOVE_SPEED_PX_PER_SEC,
	PROJECTILE_SPEED_PX_PER_SEC,
	TANK_RADIUS,
	PROJECTILE_RADIUS,
	TICK_MS,
	parseIdleTimeoutMs,
	parsePositiveNumber,
	randomColor,
	randomSpawn,
	type ClientMessage,
	type FieldItem,
	type ItemType,
	type PlayerAttachment,
	type Projectile,
	type ServerMessage,
	type StatePlayer,
} from "./game";

/**
 * Battlefield Durable Object — one shared instance holds the whole phase1
 * arena. All connected players see the same authoritative game state.
 *
 * Per-player state lives on each WebSocket's hibernation attachment
 * (survives hibernation). In-flight projectiles live in memory only; the
 * object stays active (via a self-rescheduling alarm) for the whole time
 * any player is connected or a projectile is in flight, so this is fine for
 * phase1's goal of validating shared multiplayer state.
 */
export class Battlefield extends DurableObject<Env> {
	private projectiles: Projectile[] = [];
	private items: FieldItem[] = [];
	private lastTick = Date.now();
	private nextArmorSpawnAt: number | null = null;
	private nextBulletSpawnAt: number | null = null;

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
			ammo: INITIAL_AMMO,
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
				player.ammo -= 1;
				const dirX = Math.cos(player.facing);
				const dirY = Math.sin(player.facing);
				this.projectiles.push({
					ownerId: player.id,
					ownerColor: player.color,
					x: player.x + dirX * (TANK_RADIUS + PROJECTILE_RADIUS + 2),
					y: player.y + dirY * (TANK_RADIUS + PROJECTILE_RADIUS + 2),
					vx: dirX * PROJECTILE_SPEED_PX_PER_SEC,
					vy: dirY * PROJECTILE_SPEED_PX_PER_SEC,
				});
				ws.serializeAttachment(player);
				break;
			}
			case "respawn": {
				if (player.hp > 0) break;
				const spawn = randomSpawn();
				player.hp = INITIAL_HP;
				player.ammo = INITIAL_AMMO;
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
		const sockets: WebSocket[] = [];
		for (const ws of this.ctx.getWebSockets()) {
			const player = ws.deserializeAttachment() as PlayerAttachment | null;
			if (player && now - player.lastActivityAt >= idleTimeoutMs) {
				player.idleKicked = true;
				ws.serializeAttachment(player);
				try {
					ws.close(1000, "idle-timeout");
				} catch {
					// Already closed; nothing to do.
				}
				continue;
			}
			sockets.push(ws);
		}

		this.maybeSpawnItem("armor", now);
		this.maybeSpawnItem("bullet", now);

		// Move tanks according to held-direction input.
		for (const ws of sockets) {
			const player = ws.deserializeAttachment() as PlayerAttachment | null;
			if (!player || !player.alive) continue;

			let dx = player.dirX;
			let dy = player.dirY;
			if (dx !== 0 && dy !== 0) {
				const norm = Math.SQRT1_2;
				dx *= norm;
				dy *= norm;
			}
			player.x = clamp(player.x + dx * MOVE_SPEED_PX_PER_SEC * dt, TANK_RADIUS, FIELD_WIDTH - TANK_RADIUS);
			player.y = clamp(player.y + dy * MOVE_SPEED_PX_PER_SEC * dt, TANK_RADIUS, FIELD_HEIGHT - TANK_RADIUS);
			ws.serializeAttachment(player);
		}

		// Item pickup: an alive tank standing close enough to an item
		// collects it, restoring durability/ammo up to that stat's max.
		this.items = this.items.filter((item) => {
			for (const ws of sockets) {
				const player = ws.deserializeAttachment() as PlayerAttachment | null;
				if (!player || !player.alive) continue;

				const dx = player.x - item.x;
				const dy = player.y - item.y;
				if (Math.sqrt(dx * dx + dy * dy) > TANK_RADIUS + ITEM_RADIUS) continue;

				if (item.type === "armor") {
					const amount = parsePositiveNumber(this.env.ARMOR_RECOVER_AMOUNT, DEFAULT_ARMOR_RECOVER_AMOUNT);
					const before = player.hp;
					player.hp = Math.min(INITIAL_HP, player.hp + amount);
					this.send(ws, { type: "log", text: `耐久値を${player.hp - before}回復した（Armor）` });
				} else {
					const amount = parsePositiveNumber(this.env.BULLET_RECOVER_AMOUNT, DEFAULT_BULLET_RECOVER_AMOUNT);
					const before = player.ammo;
					player.ammo = Math.min(INITIAL_AMMO, player.ammo + amount);
					this.send(ws, { type: "log", text: `残弾数を${player.ammo - before}回復した（Bullet）` });
				}
				ws.serializeAttachment(player);
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

		// Collision detection: projectile vs. other players.
		const remaining: Projectile[] = [];
		for (const projectile of this.projectiles) {
			let hit = false;
			for (const ws of sockets) {
				const target = ws.deserializeAttachment() as PlayerAttachment | null;
				if (!target || !target.alive || target.id === projectile.ownerId) continue;

				const dx = target.x - projectile.x;
				const dy = target.y - projectile.y;
				const distance = Math.sqrt(dx * dx + dy * dy);
				if (distance > TANK_RADIUS + PROJECTILE_RADIUS) continue;

				target.hp -= 1;
				const destroyed = target.hp <= 0;
				if (destroyed) target.alive = false;
				ws.serializeAttachment(target);

				this.sendLogToPlayer(sockets, projectile.ownerId, `${target.name} に命中させた！${destroyed ? "（撃破）" : ""}`);
				this.sendLogToPlayer(sockets, target.id, `${this.findPlayerName(sockets, projectile.ownerId)} の弾が命中した${destroyed ? "（被撃破）" : ""}`);

				if (destroyed) {
					const shooterWs = sockets.find((s) => (s.deserializeAttachment() as PlayerAttachment | null)?.id === projectile.ownerId);
					if (shooterWs) {
						const shooter = shooterWs.deserializeAttachment() as PlayerAttachment;
						shooter.score += 1;
						shooterWs.serializeAttachment(shooter);
					}
				}

				hit = true;
				break;
			}
			if (!hit) remaining.push(projectile);
		}
		this.projectiles = remaining;

		// Broadcast the authoritative snapshot to everyone.
		const players: StatePlayer[] = sockets
			.map((ws) => ws.deserializeAttachment() as PlayerAttachment | null)
			.filter((p): p is PlayerAttachment => p !== null)
			.map((p) => ({
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
		for (const ws of sockets) this.send(ws, state);

		if (sockets.length > 0 || this.projectiles.length > 0) {
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

	private sendLogToPlayer(sockets: WebSocket[], playerId: string, text: string): void {
		const ws = sockets.find((s) => (s.deserializeAttachment() as PlayerAttachment | null)?.id === playerId);
		if (ws) this.send(ws, { type: "log", text });
	}

	private findPlayerName(sockets: WebSocket[], playerId: string): string {
		const ws = sockets.find((s) => (s.deserializeAttachment() as PlayerAttachment | null)?.id === playerId);
		const player = ws?.deserializeAttachment() as PlayerAttachment | undefined;
		return player?.name ?? "誰か";
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
