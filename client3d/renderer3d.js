/**
 * Three.js layer that draws the tanks in 3D underneath the game's 2D canvas
 * (which keeps drawing shields, gauges, names, projectiles and effects).
 *
 * The camera looks straight down from above the middle of the field, with a
 * perspective chosen so the ground plane maps 1:1 to the 800x600 field pixels.
 * Anything drawn on the 2D canvas at ground level therefore lines up exactly,
 * while the tanks' height produces real parallax/shading/shadows.
 *
 * World axes: x = field x, z = field y, y = up.
 */
import {
	ACESFilmicToneMapping,
	AmbientLight,
	Color,
	DirectionalLight,
	Group,
	HemisphereLight,
	Mesh,
	MeshStandardMaterial,
	PCFShadowMap,
	PerspectiveCamera,
	PlaneGeometry,
	Scene,
	ShadowMaterial,
	Vector3,
	WebGLRenderer,
} from "three";
import { MAT_METAL, MAT_TEAM, MAT_TRACK, buildTankGeometry, geometryCounts } from "./tank-model.js";

export const FIELD_WIDTH = 800;
export const FIELD_HEIGHT = 600;
const CAMERA_HEIGHT = 700;

export function createRenderer3D(canvas, options = {}) {
	const detail = options.detail ?? 1;
	const shadows = options.shadows ?? true;

	const renderer = new WebGLRenderer({
		canvas,
		antialias: true,
		alpha: true,
		powerPreference: "high-performance",
	});
	renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
	renderer.setSize(FIELD_WIDTH, FIELD_HEIGHT, false);
	renderer.setClearColor(0x000000, 0);
	renderer.toneMapping = ACESFilmicToneMapping;
	renderer.toneMappingExposure = 1.0;
	renderer.shadowMap.enabled = shadows;
	renderer.shadowMap.type = PCFShadowMap;

	const scene = new Scene();

	// Camera straight above the field centre; fov chosen so the z=0 plane spans
	// exactly FIELD_HEIGHT. "up" is -z so field y grows downward on screen.
	const camera = new PerspectiveCamera(
		(2 * Math.atan(FIELD_HEIGHT / 2 / CAMERA_HEIGHT) * 180) / Math.PI,
		FIELD_WIDTH / FIELD_HEIGHT,
		50,
		1200,
	);
	camera.position.set(FIELD_WIDTH / 2, CAMERA_HEIGHT, FIELD_HEIGHT / 2);
	camera.up.set(0, 0, -1);
	camera.lookAt(new Vector3(FIELD_WIDTH / 2, 0, FIELD_HEIGHT / 2));

	// Lighting: soft sky/ground fill plus a low sun for shading and shadows.
	scene.add(new HemisphereLight(0xcfdcff, 0x3a3d46, 1.1));
	scene.add(new AmbientLight(0xffffff, 0.25));
	const sun = new DirectionalLight(0xfff1d6, 2.6);
	sun.position.set(FIELD_WIDTH / 2 - 260, 420, FIELD_HEIGHT / 2 - 180);
	sun.target.position.set(FIELD_WIDTH / 2, 0, FIELD_HEIGHT / 2);
	sun.castShadow = shadows;
	sun.shadow.mapSize.set(2048, 2048);
	const cam = sun.shadow.camera;
	cam.left = -520;
	cam.right = 520;
	cam.top = 420;
	cam.bottom = -420;
	cam.near = 50;
	cam.far = 1000;
	sun.shadow.bias = -0.0004;
	sun.shadow.normalBias = 0.4;
	scene.add(sun, sun.target);

	// Transparent ground that only shows the tanks' shadows over the CSS background.
	const ground = new Mesh(
		new PlaneGeometry(FIELD_WIDTH, FIELD_HEIGHT),
		new ShadowMaterial({ opacity: 0.5 }),
	);
	ground.rotation.x = -Math.PI / 2;
	ground.position.set(FIELD_WIDTH / 2, -0.05, FIELD_HEIGHT / 2);
	ground.receiveShadow = true;
	scene.add(ground);

	// One shared geometry + fixed materials; the team material is per tank.
	const tankGeometry = buildTankGeometry(detail);
	const counts = geometryCounts(tankGeometry);
	const trackMaterial = new MeshStandardMaterial({ color: 0x2b2e33, roughness: 0.9, metalness: 0.1 });
	const metalMaterial = new MeshStandardMaterial({ color: 0x6d737c, roughness: 0.45, metalness: 0.75 });

	const tanks = new Map(); // id -> { group, team }

	function createTank() {
		const team = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.55, metalness: 0.25 });
		const materials = [];
		materials[MAT_TEAM] = team;
		materials[MAT_TRACK] = trackMaterial;
		materials[MAT_METAL] = metalMaterial;
		const mesh = new Mesh(tankGeometry, materials);
		mesh.castShadow = shadows;
		mesh.receiveShadow = shadows;
		const group = new Group();
		group.add(mesh);
		scene.add(group);
		return { group, team, color: new Color() };
	}

	const charred = new Color(0x222222);
	const flashColor = new Color(0xffffff);

	/**
	 * Syncs the scene with the current tanks and draws a frame.
	 * Each tank: { id, x, y, facing, color (css), alive, flash (0..1), ox/oy (shake offset, px) }.
	 */
	function update(list) {
		const seen = new Set();
		for (const t of list) {
			seen.add(t.id);
			let entry = tanks.get(t.id);
			if (!entry) {
				entry = createTank();
				tanks.set(t.id, entry);
			}
			entry.group.position.set(t.x + (t.ox || 0), 0, t.y + (t.oy || 0));
			// Field facing is measured in the x/y plane; world z is field y, and a
			// rotation about +Y by -facing takes +X to (cos, 0, sin).
			entry.group.rotation.y = -t.facing;

			entry.color.set(t.color);
			if (!t.alive) entry.color.lerp(charred, 0.8);
			entry.team.color.copy(entry.color);
			entry.team.emissive.copy(flashColor).multiplyScalar(t.flash > 0 ? Math.min(1, t.flash) * 0.85 : 0);
		}
		for (const [id, entry] of tanks) {
			if (!seen.has(id)) {
				scene.remove(entry.group);
				entry.team.dispose();
				tanks.delete(id);
			}
		}
		renderer.render(scene, camera);
	}

	return {
		update,
		/** Free camera for the model viewer; the game never calls this. */
		setCamera(position, lookAt, fov) {
			camera.position.set(...position);
			camera.up.set(0, 1, 0);
			camera.near = 1;
			camera.lookAt(new Vector3(...lookAt));
			if (fov) camera.fov = fov;
			camera.updateProjectionMatrix();
		},
		render: () => renderer.render(scene, camera),
		tankCount: () => tanks.size,
		/** Per-tank geometry cost plus whatever the last frame actually submitted. */
		stats: () => ({
			detail,
			tankVertices: counts.vertices,
			tankTriangles: counts.triangles,
			frameTriangles: renderer.info.render.triangles,
			frameDrawCalls: renderer.info.render.calls,
		}),
		gl: renderer.getContext(),
		dispose() {
			for (const entry of tanks.values()) entry.team.dispose();
			tanks.clear();
			tankGeometry.dispose();
			renderer.dispose();
		},
	};
}
