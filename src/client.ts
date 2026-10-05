/**
 * Single-page client for phase1: login screen + canvas battlefield.
 * Served as a static HTML document by the Worker; no build step needed.
 */
export const CLIENT_HTML = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>ミニタンク対戦</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Kaku Gothic ProN", sans-serif;
    background: #1a1c22;
    color: #eee;
    height: 100vh;
    overflow: hidden;
  }

  #login-screen {
    height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-direction: column;
    gap: 16px;
  }
  #login-screen h1 { margin: 0 0 8px; font-size: 24px; }
  #login-screen input {
    font-size: 16px;
    padding: 8px 12px;
    border-radius: 6px;
    border: 1px solid #444;
    background: #2a2d36;
    color: #eee;
    width: 240px;
  }
  #login-screen button, .topbar button {
    font-size: 15px;
    padding: 8px 16px;
    border-radius: 6px;
    border: none;
    background: #3f7fd8;
    color: #fff;
    cursor: pointer;
  }
  #login-screen button:hover, .topbar button:not(:disabled):hover { background: #558fe0; }
  .topbar button:disabled { background: #444; color: #888; cursor: not-allowed; }
  #login-error { color: #ff6b6b; min-height: 18px; font-size: 13px; }

  #game-screen { display: none; height: 100vh; flex-direction: column; }
  .topbar {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 16px;
    background: #22252d;
    border-bottom: 1px solid #333;
  }
  .topbar .spacer { flex: 1; }
  .topbar .title { font-weight: 600; }

  .main {
    flex: 1;
    display: flex;
    min-height: 0;
  }

  #stats {
    width: 180px;
    padding: 16px;
    background: #22252d;
    border-right: 1px solid #333;
    flex-shrink: 0;
  }
  #stats h2 { font-size: 16px; margin: 0 0 12px; word-break: break-all; }
  #stats .stat { margin-bottom: 10px; font-size: 14px; }
  #stats .stat .label { color: #999; font-size: 12px; display: block; }
  #stats .stat .value { font-size: 20px; font-weight: 600; }

  #field-wrap {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #10121a;
    min-width: 0;
    overflow: auto;
  }
  canvas { background: #1e2230; border: 1px solid #333; }

  #log-panel {
    width: 260px;
    flex-shrink: 0;
    background: #22252d;
    border-left: 1px solid #333;
    display: flex;
    flex-direction: column;
  }
  #log-panel h2 { font-size: 14px; margin: 12px 16px 8px; color: #aaa; }
  #log-list {
    flex: 1;
    overflow-y: auto;
    padding: 0 12px 12px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  #log-list .entry {
    font-size: 12.5px;
    line-height: 1.4;
    padding: 6px 8px;
    background: #2a2d36;
    border-radius: 4px;
    word-break: break-word;
  }
</style>
</head>
<body>

<div id="login-screen">
  <h1>ミニタンク対戦 - phase1</h1>
  <input id="name-input" type="text" placeholder="プレイヤー名" maxlength="16" autocomplete="off" />
  <button id="join-button">入場</button>
  <div id="login-error"></div>
</div>

<div id="game-screen">
  <div class="topbar">
    <span class="title">ミニタンク対戦</span>
    <div class="spacer"></div>
    <button id="respawn-button" disabled>再入場</button>
    <button id="exit-button">退場</button>
  </div>
  <div class="main">
    <div id="stats">
      <h2 id="stat-name">-</h2>
      <div class="stat"><span class="label">耐久値</span><span class="value" id="stat-hp">-</span></div>
      <div class="stat"><span class="label">残弾数</span><span class="value" id="stat-ammo">-</span></div>
      <div class="stat"><span class="label">撃破数</span><span class="value" id="stat-score">-</span></div>
      <div class="stat"><span class="label">レベル</span><span class="value" id="stat-level">-</span></div>
      <div class="stat"><span class="label">シールド</span><span class="value" id="stat-shield" style="font-size:14px">-</span></div>
    </div>
    <div id="field-wrap">
      <canvas id="field" width="800" height="600"></canvas>
    </div>
    <div id="log-panel">
      <h2>イベントログ</h2>
      <div id="log-list"></div>
    </div>
  </div>
</div>

<script>
(function () {
  const TANK_RADIUS = 14;
  const ITEM_RADIUS = 10;
  const CHARGE_MAX_SHOTS = 5;
  const SHIELD_GAP = 4;
  const SHIELD_THICKNESS = 4;
  const SIDE_SHIELD_HP = 1;
  const REAR_SHIELD_HP = 5;

  const loginScreen = document.getElementById("login-screen");
  const gameScreen = document.getElementById("game-screen");
  const nameInput = document.getElementById("name-input");
  const joinButton = document.getElementById("join-button");
  const loginError = document.getElementById("login-error");
  const exitButton = document.getElementById("exit-button");
  const respawnButton = document.getElementById("respawn-button");
  const statName = document.getElementById("stat-name");
  const statHp = document.getElementById("stat-hp");
  const statAmmo = document.getElementById("stat-ammo");
  const statScore = document.getElementById("stat-score");
  const statLevel = document.getElementById("stat-level");
  const statShield = document.getElementById("stat-shield");
  const logList = document.getElementById("log-list");
  const canvas = document.getElementById("field");
  const ctx2d = canvas.getContext("2d");

  let ws = null;
  let selfId = null;
  let latestState = { players: [], projectiles: [], items: [] };
  const pressed = new Set();

  // Visual effects (hit sparks, explosions, ...). Times are performance.now() ms.
  const effects = [];
  const flashUntil = {}; // tank id -> when its hit flash ends
  const shieldFlashUntil = {}; // tank id -> when its shield hit flash ends
  let selfHitFlashUntil = 0;

  function rand(min, max) {
    return min + Math.random() * (max - min);
  }

  function addParticles(x, y, count, speedMin, speedMax, lifeMin, lifeMax, sizeMin, sizeMax, colors, now) {
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = rand(speedMin, speedMax);
      effects.push({
        kind: "particle",
        x, y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        size: rand(sizeMin, sizeMax),
        color: colors[i % colors.length],
        born: now,
        life: rand(lifeMin, lifeMax),
      });
    }
  }

  // A tank was hit: flash/shake it, throw sparks from the impact point and
  // float the damage taken above it. Being hit yourself also tints the screen.
  function playHit(ev, now) {
    flashUntil[ev.id] = now + 220;
    addParticles(ev.x, ev.y, 9, 50, 150, 220, 400, 1.5, 3, ["#ffffff", "#fff59d", "#ffcc80"], now);
    effects.push({ kind: "ring", x: ev.x, y: ev.y, r0: 3, r1: 20, width: 2, rgb: "255,255,255", born: now, life: 260 });
    effects.push({
      kind: "text", x: ev.x, y: ev.y - TANK_RADIUS, text: "-" + ev.damage,
      size: 12 + Math.min(ev.damage, 5) * 2, rgb: "255,90,90", born: now, life: 750,
    });
    if (ev.id === selfId) selfHitFlashUntil = now + 300;
  }

  // A tank was destroyed: a flash, expanding shockwaves and a burst of fire
  // and debris in the tank's own colour.
  function playDestroyed(ev, now) {
    effects.push({ kind: "flash", x: ev.x, y: ev.y, r: 34, born: now, life: 200 });
    effects.push({ kind: "ring", x: ev.x, y: ev.y, r0: 6, r1: 62, width: 5, rgb: "255,150,50", born: now, life: 650 });
    effects.push({ kind: "ring", x: ev.x, y: ev.y, r0: 2, r1: 38, width: 2, rgb: "255,255,255", born: now, life: 450 });
    addParticles(ev.x, ev.y, 26, 40, 210, 450, 900, 2, 5.5, ["#ff5722", "#ff9800", "#ffeb3b", ev.color], now);
    addParticles(ev.x, ev.y, 10, 20, 90, 700, 1100, 2, 4, ["#555555", "#888888"], now);
    effects.push({
      kind: "text", x: ev.x, y: ev.y - TANK_RADIUS - 8, text: "撃破!",
      size: 18, rgb: "255,190,70", born: now, life: 1000,
    });
  }

  // A shield absorbed a shot: the shield flashes and throws cyan sparks; if
  // that finished it off, it shatters.
  function playShieldHit(ev, now) {
    shieldFlashUntil[ev.id] = now + 200;
    addParticles(ev.x, ev.y, 8, 40, 130, 220, 380, 1.5, 3, ["#4fc3f7", "#b3e5fc", "#ffffff"], now);
    effects.push({ kind: "ring", x: ev.x, y: ev.y, r0: 3, r1: 18, width: 2, rgb: "79,195,247", born: now, life: 260 });
    if (ev.broken) {
      addParticles(ev.x, ev.y, 14, 40, 160, 400, 750, 1.5, 3.5, ["#4fc3f7", "#e1f5fe"], now);
      effects.push({
        kind: "text", x: ev.x, y: ev.y - TANK_RADIUS, text: "シールド破壊",
        size: 12, rgb: "130,210,255", born: now, life: 800,
      });
    }
  }

  function playEvent(ev) {
    const now = performance.now();
    if (ev.type === "hit") playHit(ev, now);
    else if (ev.type === "shieldHit") playShieldHit(ev, now);
    else if (ev.type === "destroyed") playDestroyed(ev, now);
  }

  function drawEffects(now) {
    for (let i = effects.length - 1; i >= 0; i--) {
      const e = effects[i];
      const age = now - e.born;
      const t = age / e.life;
      if (t >= 1) {
        effects.splice(i, 1);
        continue;
      }
      ctx2d.save();
      if (e.kind === "particle") {
        ctx2d.globalAlpha = 1 - t;
        ctx2d.fillStyle = e.color;
        const size = e.size * (1 - t * 0.5);
        ctx2d.beginPath();
        ctx2d.arc(e.x + (e.vx * age) / 1000, e.y + (e.vy * age) / 1000, size, 0, Math.PI * 2);
        ctx2d.fill();
      } else if (e.kind === "ring") {
        ctx2d.strokeStyle = "rgba(" + e.rgb + "," + (1 - t) + ")";
        ctx2d.lineWidth = e.width * (1 - t * 0.6);
        ctx2d.beginPath();
        ctx2d.arc(e.x, e.y, e.r0 + (e.r1 - e.r0) * t, 0, Math.PI * 2);
        ctx2d.stroke();
      } else if (e.kind === "flash") {
        const g = ctx2d.createRadialGradient(e.x, e.y, 0, e.x, e.y, e.r * (0.6 + t * 0.6));
        g.addColorStop(0, "rgba(255,255,255," + 0.95 * (1 - t) + ")");
        g.addColorStop(1, "rgba(255,200,80,0)");
        ctx2d.fillStyle = g;
        ctx2d.beginPath();
        ctx2d.arc(e.x, e.y, e.r * 1.2, 0, Math.PI * 2);
        ctx2d.fill();
      } else if (e.kind === "text") {
        ctx2d.globalAlpha = Math.min(1, (1 - t) * 1.6);
        ctx2d.font = "bold " + e.size + "px sans-serif";
        ctx2d.textAlign = "center";
        ctx2d.lineWidth = 3;
        ctx2d.strokeStyle = "rgba(0,0,0,0.7)";
        ctx2d.fillStyle = "rgb(" + e.rgb + ")";
        const y = e.y - 26 * t;
        ctx2d.strokeText(e.text, e.x, y);
        ctx2d.fillText(e.text, e.x, y);
      }
      ctx2d.restore();
    }
  }

  function connect(name) {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(proto + "//" + location.host + "/ws?name=" + encodeURIComponent(name));

    ws.addEventListener("open", () => {
      loginScreen.style.display = "none";
      gameScreen.style.display = "flex";
      logList.innerHTML = "";
      effects.length = 0;
    });

    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === "welcome") {
        selfId = msg.id;
      } else if (msg.type === "state") {
        latestState = msg;
        for (const ev of msg.events || []) playEvent(ev);
      } else if (msg.type === "log") {
        appendLog(msg.text);
      }
    });

    ws.addEventListener("close", () => {
      gameScreen.style.display = "none";
      loginScreen.style.display = "flex";
      selfId = null;
      ws = null;
    });

    ws.addEventListener("error", () => {
      loginError.textContent = "接続エラーが発生しました。";
    });
  }

  function appendLog(text) {
    const div = document.createElement("div");
    div.className = "entry";
    div.textContent = text;
    logList.appendChild(div);
    logList.scrollTop = logList.scrollHeight;
  }

  function send(message) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  joinButton.addEventListener("click", () => {
    const name = nameInput.value.trim();
    if (!name) {
      loginError.textContent = "プレイヤー名を入力してください。";
      return;
    }
    loginError.textContent = "";
    connect(name);
  });
  nameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") joinButton.click();
  });

  exitButton.addEventListener("click", () => {
    if (ws) ws.close();
  });

  respawnButton.addEventListener("click", () => {
    send({ type: "respawn" });
  });

  const keyDir = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
  let lastDir = { x: 0, y: 0 };
  let charging = false;

  // face is true only when this update was triggered by pressing a new
  // direction key. A key release still updates movement (dir), but must not
  // re-aim the tank: releasing one of two diagonal keys — which almost
  // always happens a moment before the other — would otherwise snap the
  // facing to the remaining single axis, both mid-movement (breaking
  // diagonal fire) and on a full stop (losing the diagonal facing).
  function updateInput(face) {
    let x = 0, y = 0;
    if (pressed.has("ArrowLeft")) x -= 1;
    if (pressed.has("ArrowRight")) x += 1;
    if (pressed.has("ArrowUp")) y -= 1;
    if (pressed.has("ArrowDown")) y += 1;
    if (x !== lastDir.x || y !== lastDir.y) {
      lastDir = { x, y };
      send({ type: "input", dir: { x, y }, face });
    }
  }

  window.addEventListener("keydown", (e) => {
    if (gameScreen.style.display !== "flex") return;
    if (keyDir[e.key]) {
      pressed.add(e.key);
      updateInput(true);
      e.preventDefault();
    } else if (e.key === " ") {
      // Holding fire charges the shot; it's released (fired) on keyup.
      if (!e.repeat) {
        charging = true;
        send({ type: "charge" });
      }
      e.preventDefault();
    }
  });
  window.addEventListener("keyup", (e) => {
    if (keyDir[e.key]) {
      pressed.delete(e.key);
      updateInput(false);
    } else if (e.key === " " && charging) {
      charging = false;
      send({ type: "fire" });
    }
  });
  // Losing focus mid-charge would swallow the keyup, so drop the charge.
  window.addEventListener("blur", () => {
    if (charging) {
      charging = false;
      send({ type: "cancelCharge" });
    }
  });

  function render() {
    const self = latestState.players.find((p) => p.id === selfId);
    if (self) {
      statName.textContent = self.name;
      statHp.textContent = self.hp;
      statAmmo.textContent = self.ammo;
      statScore.textContent = self.score;
      statLevel.textContent = self.level;
      const shields = [];
      if (self.shieldLeft > 0) shields.push("左" + self.shieldLeft);
      if (self.shieldRight > 0) shields.push("右" + self.shieldRight);
      if (self.shieldRear > 0) shields.push("後" + self.shieldRear);
      statShield.textContent = shields.length ? shields.join(" ") : "なし";
      respawnButton.disabled = self.hp > 0;
    }

    ctx2d.clearRect(0, 0, canvas.width, canvas.height);

    for (const item of latestState.items || []) {
      ctx2d.save();
      const isArmor = item.type === "armor";
      ctx2d.fillStyle = isArmor ? "#4caf50" : "#ffc107";
      ctx2d.fillRect(item.x - ITEM_RADIUS, item.y - ITEM_RADIUS, ITEM_RADIUS * 2, ITEM_RADIUS * 2);
      ctx2d.strokeStyle = "#111";
      ctx2d.lineWidth = 1.5;
      ctx2d.strokeRect(item.x - ITEM_RADIUS, item.y - ITEM_RADIUS, ITEM_RADIUS * 2, ITEM_RADIUS * 2);
      ctx2d.fillStyle = "#111";
      ctx2d.font = "bold 11px sans-serif";
      ctx2d.textAlign = "center";
      ctx2d.textBaseline = "middle";
      ctx2d.fillText(isArmor ? "H" : "B", item.x, item.y + 1);
      ctx2d.restore();

      ctx2d.fillStyle = "#ddd";
      ctx2d.font = "10px sans-serif";
      ctx2d.textAlign = "center";
      ctx2d.fillText(isArmor ? "Armor" : "Bullet", item.x, item.y - ITEM_RADIUS - 4);
    }

    for (const p of latestState.projectiles) {
      ctx2d.beginPath();
      ctx2d.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
      ctx2d.fillStyle = p.color;
      ctx2d.fill();
    }

    const now = performance.now();
    for (const player of latestState.players) {
      // A freshly hit tank shakes and flashes white.
      const flashLeft = (flashUntil[player.id] || 0) - now;
      if (flashLeft <= 0) delete flashUntil[player.id];
      const shake = flashLeft > 0 ? 2 : 0;

      ctx2d.save();
      ctx2d.translate(player.x + rand(-shake, shake), player.y + rand(-shake, shake));
      ctx2d.rotate(player.facing + Math.PI / 2);
      ctx2d.globalAlpha = player.alive ? 1 : 0.3;
      ctx2d.beginPath();
      ctx2d.moveTo(0, -TANK_RADIUS);
      ctx2d.lineTo(TANK_RADIUS * 0.8, TANK_RADIUS * 0.8);
      ctx2d.lineTo(-TANK_RADIUS * 0.8, TANK_RADIUS * 0.8);
      ctx2d.closePath();
      ctx2d.fillStyle = player.color;
      ctx2d.fill();
      if (flashLeft > 0) {
        ctx2d.fillStyle = "rgba(255, 255, 255, " + Math.min(1, flashLeft / 160) * 0.85 + ")";
        ctx2d.fill();
      }
      if (player.id === selfId) {
        ctx2d.lineWidth = 2;
        ctx2d.strokeStyle = "#fff";
        ctx2d.stroke();
      }

      // Shields, in the tank's frame (forward is -y): side ones run its full
      // length just outside each flank, the rear one its full width behind it.
      const shieldFlash = (shieldFlashUntil[player.id] || 0) > now;
      if (!shieldFlash) delete shieldFlashUntil[player.id];
      const sideX = TANK_RADIUS * 0.8 + SHIELD_GAP;
      const rearY = TANK_RADIUS * 0.8 + SHIELD_GAP;
      ctx2d.lineWidth = SHIELD_THICKNESS;
      ctx2d.lineCap = "butt";
      const drawShield = (x1, y1, x2, y2, hp, maxHp) => {
        if (hp <= 0) return;
        ctx2d.strokeStyle = shieldFlash ? "#ffffff" : "rgba(79, 195, 247, " + (0.45 + 0.55 * (hp / maxHp)) + ")";
        ctx2d.beginPath();
        ctx2d.moveTo(x1, y1);
        ctx2d.lineTo(x2, y2);
        ctx2d.stroke();
      };
      drawShield(-sideX, -TANK_RADIUS, -sideX, TANK_RADIUS * 0.8, player.shieldLeft, SIDE_SHIELD_HP);
      drawShield(sideX, -TANK_RADIUS, sideX, TANK_RADIUS * 0.8, player.shieldRight, SIDE_SHIELD_HP);
      drawShield(-TANK_RADIUS * 0.8, rearY, TANK_RADIUS * 0.8, rearY, player.shieldRear, REAR_SHIELD_HP);
      ctx2d.restore();

      // Charge gauge: a pie inside the tank, full at CHARGE_MAX_SHOTS.
      if (player.charge > 0) {
        const frac = Math.min(1, player.charge / CHARGE_MAX_SHOTS);
        ctx2d.beginPath();
        ctx2d.arc(player.x, player.y, 7, 0, Math.PI * 2);
        ctx2d.fillStyle = "rgba(0, 0, 0, 0.55)";
        ctx2d.fill();
        ctx2d.beginPath();
        ctx2d.moveTo(player.x, player.y);
        ctx2d.arc(player.x, player.y, 7, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * frac);
        ctx2d.closePath();
        ctx2d.fillStyle = "#fff";
        ctx2d.fill();
      }

      ctx2d.globalAlpha = 1;
      ctx2d.fillStyle = "#ddd";
      ctx2d.font = "11px sans-serif";
      ctx2d.textAlign = "center";
      ctx2d.fillText(player.level > 0 ? player.name + " Lv" + player.level : player.name, player.x, player.y - TANK_RADIUS - 6);
    }

    drawEffects(now);

    // Taking a hit yourself briefly tints the whole field red.
    const selfFlashLeft = selfHitFlashUntil - now;
    if (selfFlashLeft > 0) {
      ctx2d.fillStyle = "rgba(255, 40, 40, " + (selfFlashLeft / 300) * 0.28 + ")";
      ctx2d.fillRect(0, 0, canvas.width, canvas.height);
    }
  }

  // Redraw every frame (not just on state updates) so effects animate smoothly.
  function frame() {
    render();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
</script>
</body>
</html>
`;
