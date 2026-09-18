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
  const PROJECTILE_RADIUS = 4;
  const ITEM_RADIUS = 10;

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
  const logList = document.getElementById("log-list");
  const canvas = document.getElementById("field");
  const ctx2d = canvas.getContext("2d");

  let ws = null;
  let selfId = null;
  let latestState = { players: [], projectiles: [], items: [] };
  const pressed = new Set();

  function connect(name) {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(proto + "//" + location.host + "/ws?name=" + encodeURIComponent(name));

    ws.addEventListener("open", () => {
      loginScreen.style.display = "none";
      gameScreen.style.display = "flex";
      logList.innerHTML = "";
    });

    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === "welcome") {
        selfId = msg.id;
      } else if (msg.type === "state") {
        latestState = msg;
        render();
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
    } else if (e.key === " " && !e.repeat) {
      send({ type: "fire" });
      e.preventDefault();
    }
  });
  window.addEventListener("keyup", (e) => {
    if (keyDir[e.key]) {
      pressed.delete(e.key);
      updateInput(false);
    }
  });

  function render() {
    const self = latestState.players.find((p) => p.id === selfId);
    if (self) {
      statName.textContent = self.name;
      statHp.textContent = self.hp;
      statAmmo.textContent = self.ammo;
      statScore.textContent = self.score;
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
      ctx2d.arc(p.x, p.y, PROJECTILE_RADIUS, 0, Math.PI * 2);
      ctx2d.fillStyle = p.color;
      ctx2d.fill();
    }

    for (const player of latestState.players) {
      ctx2d.save();
      ctx2d.translate(player.x, player.y);
      ctx2d.rotate(player.facing + Math.PI / 2);
      ctx2d.globalAlpha = player.alive ? 1 : 0.3;
      ctx2d.beginPath();
      ctx2d.moveTo(0, -TANK_RADIUS);
      ctx2d.lineTo(TANK_RADIUS * 0.8, TANK_RADIUS * 0.8);
      ctx2d.lineTo(-TANK_RADIUS * 0.8, TANK_RADIUS * 0.8);
      ctx2d.closePath();
      ctx2d.fillStyle = player.color;
      ctx2d.fill();
      if (player.id === selfId) {
        ctx2d.lineWidth = 2;
        ctx2d.strokeStyle = "#fff";
        ctx2d.stroke();
      }
      ctx2d.restore();

      ctx2d.globalAlpha = 1;
      ctx2d.fillStyle = "#ddd";
      ctx2d.font = "11px sans-serif";
      ctx2d.textAlign = "center";
      ctx2d.fillText(player.name, player.x, player.y - TANK_RADIUS - 6);
    }
  }
})();
</script>
</body>
</html>
`;
