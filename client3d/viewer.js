/** Close-up model viewer: /viewer.html?detail=2 shows one tank per colour from an orbiting camera. */
import { createRenderer3D } from "/js/renderer3d.js";

const params = new URLSearchParams(location.search);
const detail = Number(params.get("detail")) || 2;
const canvas = document.getElementById("c");
const r = createRenderer3D(canvas, { detail });
const tanks = [
	{ id: "a", x: 380, y: 300, facing: 0, color: "#2f7bff", alive: true, flash: 0, ox: 0, oy: 0 },
	{ id: "b", x: 420, y: 300, facing: Math.PI, color: "#e53935", alive: true, flash: 0, ox: 0, oy: 0 },
	{ id: "c", x: 380, y: 330, facing: 0, color: "#9e9e9e", alive: true, flash: 0, ox: 0, oy: 0 },
	{ id: "d", x: 420, y: 330, facing: Math.PI, color: "#2f7bff", alive: false, flash: 0, ox: 0, oy: 0 },
];
const fixed = params.get("angle");
if (params.get("flash")) tanks[2].flash = Number(params.get("flash"));
function frame(t) {
	const a = fixed !== null ? Number(fixed) : t / 4000;
	const dist = Number(params.get("dist")) || 60;
	const elev = Number(params.get("elev")) || 45;
	r.setCamera(
		[400 + Math.cos(a) * dist, elev, 315 + Math.sin(a) * dist],
		[400, 4, 315],
		40,
	);
	r.update(tanks);
	document.title = JSON.stringify(r.stats());
	requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
