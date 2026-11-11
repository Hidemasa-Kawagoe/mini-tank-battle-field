/**
 * Benchmark for the 3D tank renderer: draws N animated tanks at several model
 * detail levels through the SAME renderer the game uses (shadows included) and
 * reports ms/frame. Open /bench.html. Results are also left in window.__bench.
 */
import { createRenderer3D } from "/js/renderer3d.js";

const out = document.getElementById("out");
const params = new URLSearchParams(location.search);
const TANKS = Number(params.get("n")) || 30;
const FRAMES = Number(params.get("frames")) || 90;
const DETAILS = (params.get("details") || "1,2,4,8,16").split(",").map(Number);
const COLORS = ["#2f7bff", "#e53935", "#9e9e9e"];

function log(line) {
	out.textContent += line + "\n";
}

function makeTanks(n) {
	const tanks = [];
	for (let i = 0; i < n; i++) {
		tanks.push({
			id: "t" + i,
			x: 60 + Math.random() * 680,
			y: 60 + Math.random() * 480,
			facing: Math.random() * Math.PI * 2,
			color: COLORS[i % 3],
			alive: true,
			flash: 0,
			ox: 0,
			oy: 0,
			vx: (Math.random() - 0.5) * 2,
			vy: (Math.random() - 0.5) * 2,
		});
	}
	return tanks;
}

function step(tanks) {
	for (const t of tanks) {
		t.x += t.vx;
		t.y += t.vy;
		if (t.x < 30 || t.x > 770) t.vx = -t.vx;
		if (t.y < 30 || t.y > 570) t.vy = -t.vy;
		t.facing = Math.atan2(t.vy, t.vx);
	}
}

async function runCase(detail, shadows) {
	const canvas = document.createElement("canvas");
	canvas.width = 800;
	canvas.height = 600;
	canvas.style.display = "none";
	document.body.appendChild(canvas);
	const r = createRenderer3D(canvas, { detail, shadows });
	const tanks = makeTanks(TANKS);
	const px = new Uint8Array(4);
	const sync = () => r.gl.readPixels(0, 0, 1, 1, r.gl.RGBA, r.gl.UNSIGNED_BYTE, px); // forces the GPU to finish
	for (let i = 0; i < 10; i++) {
		step(tanks);
		r.update(tanks);
	}
	sync();
	const t0 = performance.now();
	for (let i = 0; i < FRAMES; i++) {
		step(tanks);
		r.update(tanks);
		sync();
	}
	const ms = (performance.now() - t0) / FRAMES;
	const s = r.stats();
	const result = {
		detail,
		shadows,
		tanks: TANKS,
		trianglesPerTank: s.tankTriangles,
		verticesPerTank: s.tankVertices,
		frameTriangles: s.frameTriangles,
		frameDrawCalls: s.frameDrawCalls,
		msPerFrame: Number(ms.toFixed(2)),
	};
	r.dispose();
	r.gl.getExtension("WEBGL_lose_context")?.loseContext();
	canvas.remove();
	await new Promise((res) => setTimeout(res, 50));
	return result;
}

async function main() {
	const probe = document.createElement("canvas").getContext("webgl2");
	const dbg = probe && probe.getExtension("WEBGL_debug_renderer_info");
	const gpu = dbg ? probe.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : "unknown";
	log("GPU: " + gpu);
	log("tanks=" + TANKS + " frames=" + FRAMES + " dpr=" + window.devicePixelRatio);
	log("");
	const results = [];
	const cases = DETAILS.map((d) => [d, true]);
	cases.push([DETAILS[0], false]);
	for (const [detail, shadows] of cases) {
		const r = await runCase(detail, shadows);
		results.push(r);
		log(
			"detail " + String(r.detail).padStart(2) + (r.shadows ? " shadow  " : " noshadow") +
				" | tri/tank " + String(r.trianglesPerTank).padStart(6) +
				" | vert/tank " + String(r.verticesPerTank).padStart(6) +
				" | frame tris " + String(r.frameTriangles).padStart(7) +
				" | calls " + String(r.frameDrawCalls).padStart(3) +
				" | " + r.msPerFrame + " ms/frame",
		);
	}
	window.__bench = { gpu, results };
	log("\ndone");
}

main().catch((e) => log("ERROR: " + e.stack));
