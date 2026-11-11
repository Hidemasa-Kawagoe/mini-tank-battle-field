/**
 * Procedural low-poly 3D tank, built once and shared by every tank on screen.
 *
 * Local frame: +X forward, +Y up, Z across (the model is centred on the origin
 * and is TANK_LENGTH x TANK_WIDTH, matching the 2D hit-box). All parts are
 * merged into ONE BufferGeometry split into material groups so a tank costs
 * only a few draw calls regardless of how many parts it has.
 *
 * `detail` multiplies every curved part's segment count. 1 is the shipping
 * level (see DOC/3d-tank-budget.md for how it was chosen); higher values exist
 * so the benchmark page can find where the frame time starts to climb.
 */
import {
	BoxGeometry,
	BufferGeometry,
	CylinderGeometry,
	ExtrudeGeometry,
	Float32BufferAttribute,
	Matrix4,
	Shape,
} from "three";

export const TANK_RADIUS = 14;
export const TANK_LENGTH = TANK_RADIUS * 1.8;
export const TANK_WIDTH = TANK_RADIUS * 1.6;
// The 2D tank's origin sits TANK_RADIUS behind the nose, i.e. this far behind
// the model's centre, so the model is shifted forward by this much to match.
export const MODEL_FORWARD_OFFSET = TANK_RADIUS - TANK_LENGTH / 2;

// Material slots (geometry groups).
export const MAT_TEAM = 0; // hull + turret, tinted per viewer
export const MAT_TRACK = 1; // tracks, hatch
export const MAT_METAL = 2; // wheels, barrel, antenna

const TRACK_WIDTH = 5.6;
const TRACK_HEIGHT = 7;

function seg(base, detail) {
	return Math.max(3, Math.round(base * detail));
}

/** Rotates a Y-axis cylinder so its axis lies along +X (forward). */
const alongX = new Matrix4().makeRotationZ(-Math.PI / 2);
/** ...or along Z (across the tank), for wheels. */
const alongZ = new Matrix4().makeRotationX(Math.PI / 2);

function part(geometry, matrix, material) {
	const g = geometry.index ? geometry.toNonIndexed() : geometry;
	g.applyMatrix4(matrix);
	return { geometry: g, material };
}

function translation(x, y, z) {
	return new Matrix4().makeTranslation(x, y, z);
}

function trackProfile(detail) {
	// Side view of one track: a stadium (rounded ends) lying on y = 0.
	const r = TRACK_HEIGHT / 2;
	const half = TANK_LENGTH / 2;
	const s = new Shape();
	s.moveTo(-half + r, 0);
	s.lineTo(half - r, 0);
	s.absarc(half - r, r, r, -Math.PI / 2, Math.PI / 2, false);
	s.lineTo(-half + r, TRACK_HEIGHT);
	s.absarc(-half + r, r, r, Math.PI / 2, (3 * Math.PI) / 2, false);
	return { shape: s, curveSegments: seg(4, detail) };
}

function buildParts(detail) {
	const parts = [];
	const half = TANK_LENGTH / 2;
	const trackZ = TANK_WIDTH / 2 - TRACK_WIDTH / 2;

	// --- Tracks (extruded stadium) -------------------------------
	const { shape, curveSegments } = trackProfile(detail);
	for (const sign of [-1, 1]) {
		const track = new ExtrudeGeometry(shape, { depth: TRACK_WIDTH, bevelEnabled: false, curveSegments });
		parts.push(part(track, translation(0, 0, sign * trackZ - TRACK_WIDTH / 2), MAT_TRACK));

		// Road wheels peeking out of the outer face, sprocket/idler at the ends.
		const outerZ = sign * (TANK_WIDTH / 2 + 0.25);
		const wheelCount = 5;
		for (let i = 0; i < wheelCount; i++) {
			const isEnd = i === 0 || i === wheelCount - 1;
			const r = isEnd ? 3.0 : 2.4;
			const x = -half + 3.6 + (i * (TANK_LENGTH - 7.2)) / (wheelCount - 1);
			const wheel = new CylinderGeometry(r, r, 0.6, seg(8, detail));
			parts.push(part(wheel, translation(x, TRACK_HEIGHT / 2, outerZ).multiply(alongZ), MAT_METAL));
		}
	}

	// --- Hull: box with a sloped front plate and slightly sloped rear ------
	// Wide enough to overhang the tracks like armoured skirts, so from above
	// (the game's view) most of what you see is the team colour.
	const hullLen = TANK_LENGTH - 2;
	const hullWidth = TANK_WIDTH - 3.8;
	const hullHeight = 5;
	const hull = new BoxGeometry(hullLen, hullHeight, hullWidth);
	const pos = hull.attributes.position;
	for (let i = 0; i < pos.count; i++) {
		const top = pos.getY(i) > 0;
		const x = pos.getX(i);
		if (top && x > 0) pos.setX(i, x - 5.5); // glacis
		if (top && x < 0) pos.setX(i, x + 1.5); // rear slope
	}
	hull.computeVertexNormals();
	parts.push(part(hull, translation(0, 3.4 + hullHeight / 2, 0), MAT_TEAM));

	// --- Turret ------------------------------------------------------------
	const turretY = 3.4 + hullHeight;
	const turretBody = new CylinderGeometry(4.6, 5.8, 3.2, seg(10, detail));
	turretBody.scale(1.3, 1, 1);
	parts.push(part(turretBody, translation(-1.4, turretY + 1.6, 0), MAT_TEAM));
	const mantlet = new BoxGeometry(2.4, 2.6, 4.6);
	parts.push(part(mantlet, translation(3.4, turretY + 1.7, 0), MAT_TEAM));

	// --- Barrel, muzzle brake, hatch, antenna ------------------------------
	const barrelLen = 12;
	const barrel = new CylinderGeometry(0.85, 0.85, barrelLen, seg(8, detail));
	parts.push(part(barrel, translation(4 + barrelLen / 2, turretY + 1.7, 0).multiply(alongX), MAT_METAL));
	const brake = new CylinderGeometry(1.25, 1.25, 1.6, seg(8, detail));
	parts.push(part(brake, translation(4 + barrelLen, turretY + 1.7, 0).multiply(alongX), MAT_METAL));
	const hatch = new CylinderGeometry(1.7, 1.7, 0.7, seg(8, detail));
	parts.push(part(hatch, translation(-2.6, turretY + 3.4, 1.4), MAT_TRACK));
	const antenna = new CylinderGeometry(0.2, 0.2, 9, seg(4, detail));
	parts.push(part(antenna, translation(-7.5, turretY + 4.5, -2.6), MAT_METAL));

	return parts;
}

/** Concatenates parts into one non-indexed geometry with a group per material. */
function mergeParts(parts) {
	const byMaterial = [[], [], []];
	for (const p of parts) byMaterial[p.material].push(p.geometry);

	let vertexCount = 0;
	for (const list of byMaterial) for (const g of list) vertexCount += g.attributes.position.count;

	const position = new Float32Array(vertexCount * 3);
	const normal = new Float32Array(vertexCount * 3);
	const merged = new BufferGeometry();
	let offset = 0;
	for (let m = 0; m < byMaterial.length; m++) {
		const start = offset;
		for (const g of byMaterial[m]) {
			position.set(g.attributes.position.array, offset * 3);
			normal.set(g.attributes.normal.array, offset * 3);
			offset += g.attributes.position.count;
			g.dispose();
		}
		if (offset > start) merged.addGroup(start, offset - start, m);
	}
	merged.setAttribute("position", new Float32BufferAttribute(position, 3));
	merged.setAttribute("normal", new Float32BufferAttribute(normal, 3));
	merged.computeBoundingSphere();
	return merged;
}

export function buildTankGeometry(detail = 1) {
	const geometry = mergeParts(buildParts(detail));
	// Shift forward so the model's origin matches the 2D tank's position.
	geometry.translate(MODEL_FORWARD_OFFSET, 0, 0);
	return geometry;
}

/** Vertex / triangle counts of a built geometry (non-indexed: 3 verts per triangle). */
export function geometryCounts(geometry) {
	const vertices = geometry.attributes.position.count;
	return { vertices, triangles: vertices / 3 };
}
