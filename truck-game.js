/*
  Trailer Trouble 3000
  A tiny 3D truck game. Everything is drawn with plain canvas 2D polygons --
  no WebGL and no libraries, so it still runs when the internet is down.
*/
(() => {
  "use strict";

  const canvas = document.getElementById("truck-canvas");
  if (!canvas) {
    return;
  }
  const ctx = canvas.getContext("2d");
  let W = canvas.width;
  let H = canvas.height;

  const modal = document.getElementById("truck-modal");
  const launchButton = document.getElementById("truck-launch");
  const scoreLabel = document.getElementById("truck-score");
  const statusLabel = document.getElementById("truck-status");
  const unhookButton = document.getElementById("truck-unhook");
  const closeTargets = modal.querySelectorAll("[data-close-truck]");

  /* ---------------------------------------------------------------- math */

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const smoothstep = (a, b, x) => {
    const t = clamp((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  };
  const wrapAngle = (a) => {
    while (a > Math.PI) a -= Math.PI * 2;
    while (a < -Math.PI) a += Math.PI * 2;
    return a;
  };

  // Seeded RNG so a run has a stable layout, but each new run is different.
  let seed = 1;
  const setSeed = (value) => {
    seed = value >>> 0 || 1;
  };
  const random = () => {
    seed += 0x6d2b79f5;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const range = (lo, hi) => lo + random() * (hi - lo);

  const rotate = (x, y, z, yaw, pitch, roll) => {
    if (roll) {
      const c = Math.cos(roll);
      const s = Math.sin(roll);
      const nx = x * c - y * s;
      y = x * s + y * c;
      x = nx;
    }
    if (pitch) {
      const c = Math.cos(pitch);
      const s = Math.sin(pitch);
      const ny = y * c - z * s;
      z = y * s + z * c;
      y = ny;
    }
    if (yaw) {
      const c = Math.cos(yaw);
      const s = Math.sin(yaw);
      const nx = x * c + z * s;
      z = -x * s + z * c;
      x = nx;
    }
    return [x, y, z];
  };

  /* ------------------------------------------------------------ renderer */

  const FOV = 1.02;
  let FOCAL = H / 2 / Math.tan(FOV / 2);

  // Phones get a smaller render target: every polygon is filled in software,
  // so pixels are the thing that costs.
  const fitCanvas = () => {
    const small = Math.min(window.innerWidth, window.innerHeight) < 700;
    const width = small ? 560 : 880;
    const height = small ? 340 : 520;
    if (canvas.width !== width) {
      canvas.width = width;
      canvas.height = height;
    }
    W = canvas.width;
    H = canvas.height;
    FOCAL = H / 2 / Math.tan(FOV / 2);
  };
  const NEAR = 0.4;
  // The world reaches a lot further than the fenced field does, so the fog has
  // to open up: mountains 300 units out still need to read as mountains.
  const FOG_NEAR = 70;
  const FOG_FAR = 340;
  const FOG_COLOR = [168, 208, 240];
  const SKY_TOP = "#4ea3e8";
  const SKY_LOW = "#a8d0f0";
  const LIGHT = (() => {
    const v = [0.4, 0.85, 0.35];
    const m = Math.hypot(v[0], v[1], v[2]);
    return [v[0] / m, v[1] / m, v[2] / m];
  })();

  const cam = { x: 0, y: 5, z: -12, yaw: 0, pitch: 0.3 };
  let camRight = [1, 0, 0];
  let camUp = [0, 1, 0];
  let camFwd = [0, 0, 1];
  // Heading flattened onto the ground, plus the horizontal half-FOV, so the
  // terrain mesh can throw away cells behind and beside the camera before
  // paying to transform them.
  let camFlat = [0, 1];
  let hfovTan = 1;

  const updateCamBasis = () => {
    const cp = Math.cos(cam.pitch);
    const sp = Math.sin(cam.pitch);
    const cy = Math.cos(cam.yaw);
    const sy = Math.sin(cam.yaw);
    camFwd = [sy * cp, -sp, cy * cp];
    camRight = [cy, 0, -sy];
    camUp = [sy * sp, cp, cy * sp];
    camFlat = [sy, cy];
    hfovTan = W / 2 / FOCAL;
  };

  const horizonY = () => H / 2 - FOCAL * Math.tan(cam.pitch);

  let polys = [];

  // Clip a camera-space polygon against the near plane.
  const clipNear = (pts) => {
    const out = [];
    for (let i = 0; i < pts.length; i += 1) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      const aIn = a[2] > NEAR;
      const bIn = b[2] > NEAR;
      if (aIn) {
        out.push(a);
      }
      if (aIn !== bIn) {
        const t = (NEAR - a[2]) / (b[2] - a[2]);
        out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, NEAR]);
      }
    }
    return out;
  };

  /*
    verts: array of world-space [x, y, z], in order around the face.
    color: [r, g, b].
    ref:   a point inside the solid, used to aim the normal outward. Without
           it the normal is simply aimed at the camera (flat things).
    cull:  drop the face when its outward normal points away from the camera.
           Sorting alone cannot draw the inside of a hole -- the near wall of a
           trench sits closer to the camera than its floor, so it would paint
           over the very thing you are trying to look into. Culling it is what
           makes an open tunnel readable.
    bias:  shaves the sort depth so a face wins against something it is
           lying flat on top of (road markings on the ground).
  */
  const pushPoly = (verts, color, ref, cull, bias) => {
    const n = verts.length;
    let nx = 0;
    let ny = 0;
    let nz = 0;
    let mx = 0;
    let my = 0;
    let mz = 0;
    for (let i = 0; i < n; i += 1) {
      const a = verts[i];
      const b = verts[(i + 1) % n];
      nx += (a[1] - b[1]) * (a[2] + b[2]);
      ny += (a[2] - b[2]) * (a[0] + b[0]);
      nz += (a[0] - b[0]) * (a[1] + b[1]);
      mx += a[0];
      my += a[1];
      mz += a[2];
    }
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;
    mx /= n;
    my /= n;
    mz /= n;

    if (ref) {
      if (nx * (mx - ref[0]) + ny * (my - ref[1]) + nz * (mz - ref[2]) < 0) {
        nx = -nx;
        ny = -ny;
        nz = -nz;
      }
    } else if (
      nx * (mx - cam.x) + ny * (my - cam.y) + nz * (mz - cam.z) >
      0
    ) {
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }

    if (cull && nx * (cam.x - mx) + ny * (cam.y - my) + nz * (cam.z - mz) <= 0) {
      return;
    }

    // Camera space + near clip.
    const camPts = [];
    let anyFront = false;
    for (let i = 0; i < n; i += 1) {
      const dx = verts[i][0] - cam.x;
      const dy = verts[i][1] - cam.y;
      const dz = verts[i][2] - cam.z;
      const z = dx * camFwd[0] + dy * camFwd[1] + dz * camFwd[2];
      if (z > NEAR) {
        anyFront = true;
      }
      camPts.push([
        dx * camRight[0] + dy * camRight[1] + dz * camRight[2],
        dx * camUp[0] + dy * camUp[1] + dz * camUp[2],
        z,
      ]);
    }
    if (!anyFront) {
      return;
    }
    const clipped = clipNear(camPts);
    if (clipped.length < 3) {
      return;
    }

    const screen = new Array(clipped.length);
    let depth = 0;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < clipped.length; i += 1) {
      const p = clipped[i];
      const sx = W / 2 + (p[0] * FOCAL) / p[2];
      const sy = H / 2 - (p[1] * FOCAL) / p[2];
      screen[i] = sx;
      screen[i + clipped.length] = sy;
      depth += p[2];
      if (sx < minX) minX = sx;
      if (sx > maxX) maxX = sx;
      if (sy < minY) minY = sy;
      if (sy > maxY) maxY = sy;
    }
    if (maxX < -8 || minX > W + 8 || maxY < -8 || minY > H + 8) {
      return;
    }
    depth /= clipped.length;

    const shade = 0.44 + 0.56 * Math.max(0, nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2]);
    const fog = clamp((depth - FOG_NEAR) / (FOG_FAR - FOG_NEAR), 0, 1) * 0.9;
    const r = Math.round(lerp(clamp(color[0] * shade, 0, 255), FOG_COLOR[0], fog));
    const g = Math.round(lerp(clamp(color[1] * shade, 0, 255), FOG_COLOR[1], fog));
    const b = Math.round(lerp(clamp(color[2] * shade, 0, 255), FOG_COLOR[2], fog));

    polys.push({
      pts: screen,
      count: clipped.length,
      depth: bias ? depth - bias : depth,
      fill: `rgb(${r},${g},${b})`,
    });
  };

  const flushPolys = () => {
    polys.sort((a, b) => b.depth - a.depth);
    for (let i = 0; i < polys.length; i += 1) {
      const poly = polys[i];
      const { pts, count } = poly;
      ctx.beginPath();
      ctx.moveTo(pts[0], pts[count]);
      for (let j = 1; j < count; j += 1) {
        ctx.lineTo(pts[j], pts[j + count]);
      }
      ctx.closePath();
      ctx.fillStyle = poly.fill;
      ctx.strokeStyle = poly.fill;
      ctx.fill();
      ctx.stroke();
    }
    polys.length = 0;
  };

  /* --------------------------------------------------------------- shapes */

  const BOX_FACES = [
    [0, 2, 6, 4],
    [1, 5, 7, 3],
    [0, 4, 5, 1],
    [2, 3, 7, 6],
    [0, 1, 3, 2],
    [4, 6, 7, 5],
  ];

  const addBox = (cx, cy, cz, hx, hy, hz, color, yaw = 0, pitch = 0, roll = 0, cull = false) => {
    const corners = new Array(8);
    for (let i = 0; i < 8; i += 1) {
      const p = rotate(
        i & 1 ? hx : -hx,
        i & 2 ? hy : -hy,
        i & 4 ? hz : -hz,
        yaw,
        pitch,
        roll
      );
      corners[i] = [p[0] + cx, p[1] + cy, p[2] + cz];
    }
    const ref = [cx, cy, cz];
    for (let f = 0; f < 6; f += 1) {
      const face = BOX_FACES[f];
      pushPoly(
        [corners[face[0]], corners[face[1]], corners[face[2]], corners[face[3]]],
        color,
        ref,
        cull
      );
    }
  };

  const addCylinder = (cx, baseY, cz, radius, height, color, sides = 8, capColor) => {
    const ref = [cx, baseY + height / 2, cz];
    const top = baseY + height;
    const ring = [];
    for (let i = 0; i < sides; i += 1) {
      const a = (i / sides) * Math.PI * 2;
      ring.push([cx + Math.cos(a) * radius, cz + Math.sin(a) * radius]);
    }
    for (let i = 0; i < sides; i += 1) {
      const p = ring[i];
      const q = ring[(i + 1) % sides];
      pushPoly(
        [
          [p[0], baseY, p[1]],
          [q[0], baseY, q[1]],
          [q[0], top, q[1]],
          [p[0], top, p[1]],
        ],
        color,
        ref
      );
    }
    const cap = ring.map((p) => [p[0], top, p[1]]);
    pushPoly(cap, capColor || color, ref);
  };

  const addPyramid = (cx, baseY, cz, radius, height, color, sides = 4, yaw = 0) => {
    const ref = [cx, baseY + height / 3, cz];
    const apex = [cx, baseY + height, cz];
    const ring = [];
    for (let i = 0; i < sides; i += 1) {
      const a = (i / sides) * Math.PI * 2 + yaw;
      ring.push([cx + Math.cos(a) * radius, baseY, cz + Math.sin(a) * radius]);
    }
    for (let i = 0; i < sides; i += 1) {
      pushPoly([ring[i], ring[(i + 1) % sides], apex], color, ref);
    }
  };

  // A coin standing on edge, face perpendicular to `yaw` -- spinning yaw
  // over time gives the classic "spinning coin" look in true 3D.
  const addCoin = (cx, cy, cz, radius, thickness, yaw, faceColor, rimColor) => {
    const sides = 10;
    const ref = [cx, cy, cz];
    const ring0 = new Array(sides);
    const ring1 = new Array(sides);
    for (let i = 0; i < sides; i += 1) {
      const a = (i / sides) * Math.PI * 2;
      const lx = Math.cos(a) * radius;
      const ly = Math.sin(a) * radius;
      const p0 = rotate(lx, ly, -thickness / 2, yaw, 0, 0);
      const p1 = rotate(lx, ly, thickness / 2, yaw, 0, 0);
      ring0[i] = [cx + p0[0], cy + p0[1], cz + p0[2]];
      ring1[i] = [cx + p1[0], cy + p1[1], cz + p1[2]];
    }
    pushPoly(ring0, faceColor, ref);
    pushPoly(ring1.slice().reverse(), faceColor, ref);
    for (let i = 0; i < sides; i += 1) {
      const j = (i + 1) % sides;
      pushPoly([ring0[i], ring0[j], ring1[j], ring1[i]], rimColor || faceColor, ref);
    }
  };

  /* -------------------------------------------------------------- terrain */

  /*
    The fenced field is a lie. It is a dead-flat disc sitting in the middle of
    a landscape that runs out to the fog, and the only reason the field feels
    like the whole game is that the fence stops you at 78 units.

    Everything inside FLAT_R is exactly height 0, which keeps the original
    field pixel-for-pixel what it was and gives the fence and the tunnel flat
    ground to sit on. Past that the land eases up into rolling hills, and past
    RELIEF_R the hills grow into mountains you can actually drive up.
  */
  const FLAT_R = 118;
  const RELIEF_R = 210;

  // Hand-placed launch ramps. Seeded per run in buildWorld -- the sine hills
  // alone give gentle whoops, and a kid wants something to properly jump off.
  let bumps = [];

  const surfaceHeight = (x, z) => {
    const r = Math.hypot(x, z);
    let h = 0;
    if (r > FLAT_R) {
      const ease = smoothstep(FLAT_R, RELIEF_R, r);
      // Rolling ground. The short-wavelength terms are tuned so that crossing
      // a crest near top speed actually throws the truck into the air.
      let land =
        6.5 * Math.sin(x * 0.0295 + 0.6) * Math.cos(z * 0.0262 - 0.4) +
        3.4 * Math.sin(x * 0.0613 - 1.2) * Math.cos(z * 0.0578 + 1.1) +
        2.6 * Math.sin(x * 0.121 + 2.4) * Math.cos(z * 0.1131 - 2.0) +
        1.1 * Math.sin(x * 0.241 - 0.9) * Math.cos(z * 0.2337 + 0.3) +
        5;
      // Mountains: two long ridges that only wake up a long way out, so the
      // land reads as plain -> hills -> real peaks as you drive away. They
      // have to be at full size well inside FOG_FAR, or the best thing out
      // here would be permanently hidden in the haze.
      const grow = smoothstep(150, 400, r);
      if (grow > 0) {
        const ridge =
          0.55 * Math.sin(x * 0.0121 - 0.7) * Math.cos(z * 0.0109 + 1.9) +
          0.45 * Math.sin(x * 0.0064 + 2.2) * Math.cos(z * 0.0071 - 0.5);
        land += grow * 82 * Math.pow(0.5 + 0.5 * ridge, 1.6);
      }
      h = land * ease;
    }
    for (let i = 0; i < bumps.length; i += 1) {
      const b = bumps[i];
      const dx = x - b.x;
      const dz = z - b.z;
      const d2 = (dx * dx + dz * dz) / (b.r * b.r);
      if (d2 < 1) {
        const k = 1 - d2;
        h += b.h * k * k;
      }
    }
    return h;
  };

  /* --------------------------------------------------------------- tunnel */

  /*
    A cut in the ground running straight out from the middle of the field,
    passing under the fence and ramping back up outside it. Most of it is an
    open trench; only the stretch that crosses the fence line is roofed, which
    is the bit that sells it as a tunnel. Under a painter's-algorithm renderer
    a hole is the hard case, so the trench is drawn as culled single-sided
    quads laid over the flat ground rather than punched through it.
  */
  const tunnel = {
    angle: 0,
    ux: 0,
    uz: 1,
    vx: 1,
    vz: 0,
    hw: 5.2, // half width
    depth: 3.8,
    sMouth: 50, // where the ground starts dropping
    sRamp: 59, // floor reaches full depth
    sLid0: 73, // roofed stretch begins
    sLid1: 90, // ... and ends (the fence sits at 81)
    sRise: 95, // exit ramp starts climbing
    sEnd: 108, // back out at ground level, outside the fence
    open: false,
  };

  const setTunnelAngle = (angle) => {
    tunnel.angle = angle;
    tunnel.ux = Math.sin(angle);
    tunnel.uz = Math.cos(angle);
    tunnel.vx = Math.cos(angle);
    tunnel.vz = -Math.sin(angle);
  };

  // (s, t) = (distance out along the tunnel, sideways offset from its centre).
  const tunnelS = (x, z) => x * tunnel.ux + z * tunnel.uz;
  const tunnelT = (x, z) => x * tunnel.vx + z * tunnel.vz;
  const tunnelXZ = (s, t) => [
    tunnel.ux * s + tunnel.vx * t,
    tunnel.uz * s + tunnel.vz * t,
  ];

  const trenchFloor = (s) => {
    if (s <= tunnel.sMouth || s >= tunnel.sEnd) {
      return 0;
    }
    if (s < tunnel.sRamp) {
      return -tunnel.depth * smoothstep(tunnel.sMouth, tunnel.sRamp, s);
    }
    if (s <= tunnel.sRise) {
      return -tunnel.depth;
    }
    return -tunnel.depth * (1 - smoothstep(tunnel.sRise, tunnel.sEnd, s));
  };

  // True while a point is over the open trench, i.e. standing on its floor
  // rather than on the field.
  const inTrench = (x, z) => {
    if (!tunnel.open) {
      return false;
    }
    const s = tunnelS(x, z);
    return (
      s > tunnel.sMouth &&
      s < tunnel.sEnd &&
      Math.abs(tunnelT(x, z)) < tunnel.hw
    );
  };

  // The surface you actually drive on: the trench floor where there is one,
  // the landscape everywhere else. The terrain mesh deliberately keeps using
  // surfaceHeight, so the ground stays flat under the trench and the trench
  // geometry paints over it.
  const groundHeight = (x, z) =>
    inTrench(x, z) ? trenchFloor(tunnelS(x, z)) : surfaceHeight(x, z);

  const LID_CLEAR = 3.0; // headroom under the roofed stretch

  // Underside of the roof above a point, or null out in the open.
  const lidCeiling = (x, z) => {
    if (!tunnel.open) {
      return null;
    }
    const s = tunnelS(x, z);
    if (s < tunnel.sLid0 || s > tunnel.sLid1) {
      return null;
    }
    return Math.abs(tunnelT(x, z)) < tunnel.hw ? -tunnel.depth + LID_CLEAR : null;
  };

  /* ---------------------------------------------------------------- world */

  const ARENA = 78;
  const KINDS = {
    barrel: { radius: 0.9, points: 10, label: "Barrel", chunks: 5, heavy: false },
    crate: { radius: 1.0, points: 10, label: "Crate", chunks: 6, heavy: false },
    cone: { radius: 0.6, points: 5, label: "Cone", chunks: 3, heavy: false },
    tires: { radius: 1.1, points: 15, label: "Tire stack", chunks: 5, heavy: false },
    hay: { radius: 1.2, points: 15, label: "Hay bale", chunks: 6, heavy: false },
    tree: { radius: 1.2, points: 25, label: "Tree", chunks: 8, heavy: true },
    fence: { radius: 1.7, points: 5, label: "Fence", chunks: 5, heavy: false },
    gate: { radius: 3.4, points: 50, label: "GATE", chunks: 12, heavy: true },
    rock: { radius: 1.0, points: 10, label: "Rock", chunks: 5, heavy: false },
    boulder: { radius: 2.0, points: 30, label: "Boulder", chunks: 9, heavy: true },
    pine: { radius: 1.2, points: 25, label: "Pine", chunks: 8, heavy: true },
    sign: { radius: 0.9, points: 15, label: "Signpost", chunks: 4, heavy: false },
  };

  let props = [];
  let debris = [];
  let coins = [];
  let tnt = [];

  // The crate that is hiding the way out. Not a normal prop: it has to survive
  // a gentle nudge and only give up its secret when you really mean it.
  const crate = { x: 0, z: 0, yaw: 0, alive: true, shake: 0 };
  const CRATE_RADIUS = 4.2;
  const CRATE_SPEED = 11; // how hard you have to hit it

  const truck = {
    x: 0,
    y: 0,
    z: 0,
    vy: 0,
    yaw: 0,
    speed: 0,
    steerAngle: 0,
    bodyPitch: 0,
    bodyRoll: 0,
    groundPitch: 0,
    groundRoll: 0,
    cargoLoad: 0,
    airborne: false,
    airTime: 0,
    outside: false,
    lastGround: 0,
  };
  const trailer = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, hooked: false };

  let smashed = 0;
  let points = 0;
  let coinsCollected = 0;
  let hookedOnce = false;
  let messageTimer = 0;
  let hookArmed = true;
  let respawnTimer = 0;
  let state = "playing"; // "playing" | "exploding"
  let explosionTimer = 0;
  let escaped = false; // has the player made it out past the fence yet
  let hintTimer = 0;
  let bestAir = 0;

  const GRAVITY = 26;
  let deathTint = [255, 120, 40];

  const COIN_POINTS = 20;
  // Each coin riding in the trailer nudges this toward 1: less accel, lower
  // top speed, and mushier steering, so a full trailer actually feels heavy.
  const cargoLoadFor = (count) => clamp(count * 0.045, 0, 0.75);

  const HITCH_BACK = 2.5; // hitch point, behind the truck's center
  const TONGUE = 3.4; // trailer center -> coupling distance

  const hitchPoint = () => [
    truck.x - Math.sin(truck.yaw) * HITCH_BACK,
    truck.z - Math.cos(truck.yaw) * HITCH_BACK,
  ];
  const couplingPoint = () => [
    trailer.x + Math.sin(trailer.yaw) * TONGUE,
    trailer.z + Math.cos(trailer.yaw) * TONGUE,
  ];

  const placeProp = (kind, x, z, yaw) => {
    props.push({ kind, x, y: surfaceHeight(x, z), z, yaw, alive: true, tilt: 0 });
  };
  const placeCoin = (x, z) => {
    coins.push({
      x,
      y: surfaceHeight(x, z),
      z,
      alive: true,
      phase: range(0, Math.PI * 2),
    });
  };
  const placeTnt = (x, z, yaw) => {
    tnt.push({ x, y: surfaceHeight(x, z), z, yaw });
  };

  // How far a point sits from the tunnel's line, so nothing gets built on top
  // of the one route out.
  const clearOfTunnel = (x, z, margin) => {
    const s = tunnelS(x, z);
    if (s < tunnel.sMouth - margin || s > tunnel.sEnd + margin) {
      return true;
    }
    return Math.abs(tunnelT(x, z)) > tunnel.hw + margin;
  };

  const buildWorld = () => {
    props = [];
    debris = [];
    coins = [];
    tnt = [];
    bumps = [];

    // Pick which way out of the field the tunnel runs, then park the crate on
    // top of the entrance.
    setTunnelAngle(range(0, Math.PI * 2));
    tunnel.open = false;
    const mouth = tunnelXZ(54, 0);
    crate.x = mouth[0];
    crate.z = mouth[1];
    crate.yaw = tunnel.angle;
    crate.alive = true;
    crate.shake = 0;

    // Launch ramps out on the plain. Kept off the tunnel line and away from
    // the exit so you always land somewhere sane coming out.
    for (let i = 0; i < 14; i += 1) {
      const a = range(0, Math.PI * 2);
      const d = range(126, 320);
      const bx = Math.sin(a) * d;
      const bz = Math.cos(a) * d;
      if (!clearOfTunnel(bx, bz, 30)) {
        continue;
      }
      bumps.push({ x: bx, z: bz, r: range(17, 28), h: range(6, 11) });
    }

    // A ring of gates to charge through.
    for (let i = 0; i < 6; i += 1) {
      const a = (i / 6) * Math.PI * 2 + range(-0.2, 0.2);
      const d = range(24, 62);
      placeProp("gate", Math.sin(a) * d, Math.cos(a) * d, a + Math.PI / 2);
    }

    // Fence runs.
    for (let i = 0; i < 7; i += 1) {
      const a = range(0, Math.PI * 2);
      const d = range(18, 65);
      const x = Math.sin(a) * d;
      const z = Math.cos(a) * d;
      const dir = range(0, Math.PI * 2);
      const count = Math.round(range(3, 7));
      for (let j = 0; j < count; j += 1) {
        placeProp("fence", x + Math.sin(dir) * j * 3.4, z + Math.cos(dir) * j * 3.4, dir);
      }
    }

    // Barrel pyramids, crate piles, cones, tires, hay, trees.
    const scatter = (kind, count, clusterMin, clusterMax) => {
      for (let i = 0; i < count; i += 1) {
        const a = range(0, Math.PI * 2);
        const d = range(12, ARENA - 8);
        const cx = Math.sin(a) * d;
        const cz = Math.cos(a) * d;
        const n = Math.round(range(clusterMin, clusterMax));
        for (let j = 0; j < n; j += 1) {
          placeProp(
            kind,
            cx + range(-3.2, 3.2),
            cz + range(-3.2, 3.2),
            range(0, Math.PI * 2)
          );
        }
      }
    };
    scatter("barrel", 12, 3, 7);
    scatter("crate", 8, 2, 5);
    scatter("cone", 10, 4, 8);
    scatter("tires", 6, 1, 3);
    scatter("hay", 6, 2, 4);
    scatter("tree", 10, 1, 3);

    // Coins to collect -- but only once the trailer is hooked up.
    for (let i = 0; i < 26; i += 1) {
      const a = range(0, Math.PI * 2);
      const d = range(10, ARENA - 6);
      placeCoin(Math.sin(a) * d, Math.cos(a) * d);
    }

    // TNT -- hit it and you blow up and start over.
    for (let i = 0; i < 12; i += 1) {
      const a = range(0, Math.PI * 2);
      const d = range(14, ARENA - 6);
      placeTnt(Math.sin(a) * d, Math.cos(a) * d, range(0, Math.PI * 2));
    }

    /*
      Everything past here is the part the fence is hiding. It is generated up
      front and simply sits there: the field looks like the whole game right up
      until the moment the crate goes off.
    */

    // Woods and rockfields climbing away from the plain into the mountains.
    for (let i = 0; i < 60; i += 1) {
      const a = range(0, Math.PI * 2);
      const d = range(124, 420);
      const cx = Math.sin(a) * d;
      const cz = Math.cos(a) * d;
      const high = surfaceHeight(cx, cz) > 46;
      const n = Math.round(range(2, 6));
      for (let j = 0; j < n; j += 1) {
        const px = cx + range(-9, 9);
        const pz = cz + range(-9, 9);
        if (!clearOfTunnel(px, pz, 14)) {
          continue;
        }
        let kind;
        if (high) {
          kind = random() > 0.4 ? "rock" : "boulder";
        } else if (random() > 0.75) {
          kind = random() > 0.5 ? "rock" : "boulder";
        } else {
          kind = "pine";
        }
        placeProp(kind, px, pz, range(0, Math.PI * 2));
      }
    }

    // A reward for getting out, and more of it the further you push.
    for (let i = 0; i < 46; i += 1) {
      const a = range(0, Math.PI * 2);
      const d = range(122, 400);
      const cxx = Math.sin(a) * d;
      const czz = Math.cos(a) * d;
      if (clearOfTunnel(cxx, czz, 12)) {
        placeCoin(cxx, czz);
      }
    }
    // Coins strung up the sides of the ramps, to point at the jumps.
    for (let i = 0; i < bumps.length; i += 1) {
      const b = bumps[i];
      const dir = range(0, Math.PI * 2);
      for (let j = -1; j <= 3; j += 1) {
        placeCoin(b.x + Math.sin(dir) * j * 9, b.z + Math.cos(dir) * j * 9);
      }
    }

    // A signpost on the far side of the tunnel, so the first thing you see out
    // there is somebody admitting the field was never the whole world.
    const exit = tunnelXZ(tunnel.sEnd + 9, 0);
    placeProp("sign", exit[0], exit[1], tunnel.angle + Math.PI);

    // Clear a little space around the spawn point, the crate and the tunnel.
    props = props.filter(
      (p) =>
        Math.hypot(p.x, p.z) > 9 &&
        Math.hypot(p.x - crate.x, p.z - crate.z) > 11 &&
        (p.kind === "sign" || clearOfTunnel(p.x, p.z, 9))
    );
    coins = coins.filter((c) => Math.hypot(c.x, c.z) > 9);
    tnt = tnt.filter(
      (t) =>
        Math.hypot(t.x, t.z) > 12 &&
        Math.hypot(t.x - crate.x, t.z - crate.z) > 14 &&
        clearOfTunnel(t.x, t.z, 12)
    );

    const a = range(0, Math.PI * 2);
    const d = range(24, 34);
    trailer.x = Math.sin(a) * d;
    trailer.z = Math.cos(a) * d;
    trailer.yaw = range(0, Math.PI * 2);
    trailer.y = 0;
    trailer.pitch = 0;
    trailer.hooked = false;
  };

  /* ------------------------------------------------------------- drawing */

  const GRASS = [96, 156, 84];
  const GRASS_DARK = [84, 140, 74];

  const drawSky = () => {
    const hy = horizonY();
    const sky = ctx.createLinearGradient(0, 0, 0, Math.max(hy, 1));
    sky.addColorStop(0, SKY_TOP);
    sky.addColorStop(1, SKY_LOW);
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, Math.max(hy, 0));
    ctx.fillStyle = `rgb(${FOG_COLOR[0]},${FOG_COLOR[1]},${FOG_COLOR[2]})`;
    ctx.fillRect(0, Math.max(hy, 0) - 1, W, H);

    // Parallax hills sitting on the horizon.
    ctx.fillStyle = "#7fa9c6";
    for (let i = 0; i < 22; i += 1) {
      const a = (i / 22) * Math.PI * 2;
      const delta = wrapAngle(a - cam.yaw);
      if (Math.abs(delta) > 1.0) {
        continue;
      }
      const x = W / 2 + Math.tan(delta) * FOCAL;
      const w = 150 + ((i * 37) % 90);
      const h = 40 + ((i * 53) % 46);
      ctx.beginPath();
      ctx.moveTo(x - w / 2, hy + 2);
      ctx.lineTo(x, hy - h);
      ctx.lineTo(x + w / 2, hy + 2);
      ctx.closePath();
      ctx.fill();
    }
  };

  /*
    Ground is a camera-centred clipmap: three square rings of quads, each one
    three times coarser than the one inside it. Fine detail follows you around
    and the far hills cost almost nothing.

    Two rules keep it honest. Ring boundaries land on the coarser ring's grid
    and the fine ring's outer vertices are snapped onto the coarse edge, so
    there are no cracks. And every quad is one-sided: from below, ground is
    culled, which is what lets you sit in the trench and see sky overhead
    instead of the underside of the field.
  */
  const RINGS = [
    { cell: 8, half: 48 },
    { cell: 24, half: 144 },
    { cell: 72, half: 360 },
  ];

  const ringCenter = (idx) => {
    const snap = idx + 1 < RINGS.length ? RINGS[idx + 1].cell : RINGS[idx].cell;
    return [Math.round(cam.x / snap) * snap, Math.round(cam.z / snap) * snap];
  };

  // Height of one mesh vertex. On the ring's outer edge it is pulled onto the
  // straight line the coarser ring will draw there, which is what removes the
  // cracks between levels.
  const meshHeight = (x, z, cx, cz, half, parent) => {
    if (!parent) {
      return surfaceHeight(x, z);
    }
    const onX = x === cx - half || x === cx + half;
    const onZ = z === cz - half || z === cz + half;
    if (onX === onZ) {
      return surfaceHeight(x, z);
    }
    if (onX) {
      const t0 = Math.floor(z / parent) * parent;
      const f = (z - t0) / parent;
      return f === 0
        ? surfaceHeight(x, z)
        : lerp(surfaceHeight(x, t0), surfaceHeight(x, t0 + parent), f);
    }
    const t0 = Math.floor(x / parent) * parent;
    const f = (x - t0) / parent;
    return f === 0
      ? surfaceHeight(x, z)
      : lerp(surfaceHeight(t0, z), surfaceHeight(t0 + parent, z), f);
  };

  const TERRAIN_STOPS = [
    [0, [96, 156, 84]],
    [16, [104, 152, 84]],
    [34, [124, 146, 96]],
    [52, [142, 132, 110]],
    [70, [152, 150, 154]],
    [92, [236, 240, 246]],
  ];
  const ROCK = [132, 126, 122];
  const colorScratch = [0, 0, 0];
  // Aimed at from far below, so every ground quad's normal ends up pointing up.
  const FLAT_REF = [0, -4000, 0];

  const terrainColor = (h, x, z, slope) => {
    let i = 0;
    while (i < TERRAIN_STOPS.length - 2 && h > TERRAIN_STOPS[i + 1][0]) {
      i += 1;
    }
    const a = TERRAIN_STOPS[i];
    const b = TERRAIN_STOPS[i + 1];
    const t = clamp((h - a[0]) / (b[0] - a[0]), 0, 1);
    const rock = clamp((slope - 0.5) * 1.6, 0, 0.75);
    // Colour variation has to die out as the ground flattens: at height zero
    // these quads butt straight up against the one big flat field quad, and
    // any tint at all shows up as a hard wedge across the grass.
    const vary = clamp(Math.abs(h) / 12, 0, 1);
    const mottle =
      1 + 0.045 * vary * Math.sin(x * 0.047 + 1.3) * Math.cos(z * 0.041 - 0.8);
    for (let k = 0; k < 3; k += 1) {
      colorScratch[k] = lerp(lerp(a[1][k], b[1][k], t), ROCK[k], rock) * mottle;
    }
    return colorScratch;
  };

  /*
    Cheap proof that a cell is part of the flat field: its furthest corner is
    still inside FLAT_R and no launch ramp reaches it. Flat cells are already
    covered by the single big ground quad, so proving it lets the mesh skip
    them without ever evaluating the terrain there -- which is what keeps the
    field itself costing exactly what it cost before there were mountains.
  */
  const cellIsFlat = (x0, z0, cell) => {
    const fx = Math.max(Math.abs(x0), Math.abs(x0 + cell));
    const fz = Math.max(Math.abs(z0), Math.abs(z0 + cell));
    if (fx * fx + fz * fz > FLAT_R * FLAT_R) {
      return false;
    }
    for (let i = 0; i < bumps.length; i += 1) {
      const b = bumps[i];
      if (
        b.x > x0 - b.r &&
        b.x < x0 + cell + b.r &&
        b.z > z0 - b.r &&
        b.z < z0 + cell + b.r
      ) {
        return false;
      }
    }
    return true;
  };

  // Quads with any relief are held back for the main pass so hills can occlude
  // props and the truck. The flat field never occludes anything, so it goes out
  // early as one quad and lets the painted-on field lines sit over it.
  const reliefPool = [];
  let reliefCount = 0;

  const queueRelief = (verts, color) => {
    let slot = reliefPool[reliefCount];
    if (!slot) {
      slot = { verts: null, color: [0, 0, 0] };
      reliefPool[reliefCount] = slot;
    }
    slot.verts = verts;
    slot.color[0] = color[0];
    slot.color[1] = color[1];
    slot.color[2] = color[2];
    reliefCount += 1;
  };

  const drawTerrainRing = (idx) => {
    const { cell, half } = RINGS[idx];
    const parent = idx + 1 < RINGS.length ? RINGS[idx + 1].cell : 0;
    const center = ringCenter(idx);
    const cx = center[0];
    const cz = center[1];
    let hx0 = 0;
    let hx1 = 0;
    let hz0 = 0;
    let hz1 = 0;
    let hole = false;
    if (idx > 0) {
      const prev = ringCenter(idx - 1);
      const ph = RINGS[idx - 1].half;
      hx0 = prev[0] - ph;
      hx1 = prev[0] + ph;
      hz0 = prev[1] - ph;
      hz1 = prev[1] + ph;
      hole = true;
    }
    const n = (half * 2) / cell;
    const pad = cell * 0.75;
    // Past FOG_FAR a quad is pure fog and indistinguishable from the sky it
    // would be drawn against, so there is nothing to gain by drawing it.
    const maxD = FOG_FAR;
    for (let i = 0; i < n; i += 1) {
      const x0 = cx - half + i * cell;
      const x1 = x0 + cell;
      for (let j = 0; j < n; j += 1) {
        const z0 = cz - half + j * cell;
        const z1 = z0 + cell;
        if (hole && x0 >= hx0 && x1 <= hx1 && z0 >= hz0 && z1 <= hz1) {
          continue;
        }
        if (cellIsFlat(x0, z0, cell)) {
          continue;
        }
        const dx = x0 + cell / 2 - cam.x;
        const dz = z0 + cell / 2 - cam.z;
        if (dx * dx + dz * dz > maxD * maxD) {
          continue;
        }
        const fwd = dx * camFlat[0] + dz * camFlat[1];
        if (fwd < -pad) {
          continue;
        }
        const side = dx * camFlat[1] - dz * camFlat[0];
        if (Math.abs(side) > Math.abs(fwd) * hfovTan * 1.12 + pad * 1.6) {
          continue;
        }

        const h00 = meshHeight(x0, z0, cx, cz, half, parent);
        const h10 = meshHeight(x1, z0, cx, cz, half, parent);
        const h11 = meshHeight(x1, z1, cx, cz, half, parent);
        const h01 = meshHeight(x0, z1, cx, cz, half, parent);
        const verts = [
          [x0, h00, z0],
          [x1, h10, z0],
          [x1, h11, z1],
          [x0, h01, z1],
        ];
        const lo = Math.min(h00, h10, h11, h01);
        const hi = Math.max(h00, h10, h11, h01);
        const color = terrainColor(
          (h00 + h10 + h11 + h01) / 4,
          x0,
          z0,
          (hi - lo) / cell
        );
        queueRelief(verts, color);
      }
    }
  };

  const drawGround = () => {
    // One quad for the whole flat world, exactly as before the mountains
    // existed. Everything with relief is drawn over the top of it later, so
    // this only ever shows through where the ground really is flat.
    const R = 190;
    pushPoly(
      [
        [cam.x - R, 0, cam.z - R],
        [cam.x + R, 0, cam.z - R],
        [cam.x + R, 0, cam.z + R],
        [cam.x - R, 0, cam.z + R],
      ],
      GRASS,
      FLAT_REF,
      true
    );

    reliefCount = 0;
    for (let i = 0; i < RINGS.length; i += 1) {
      drawTerrainRing(i);
    }
    flushPolys();

    // The painted lines on the field. Kept exactly as they were -- they are
    // the speed cue inside the fence -- but clipped to the field so they do
    // not go running off across the hills.
    if (Math.hypot(cam.x, cam.z) < 150 && cam.y > 0) {
      const R = ARENA + 2;
      const step = 8;
      const start = Math.ceil((-R) / step) * step;
      for (let v = start; v < R; v += step) {
        const halfSpan = Math.sqrt(Math.max(0, R * R - v * v));
        if (halfSpan < 0.5) {
          continue;
        }
        pushPoly(
          [
            [v - 0.13, 0.02, -halfSpan],
            [v + 0.13, 0.02, -halfSpan],
            [v + 0.13, 0.02, halfSpan],
            [v - 0.13, 0.02, halfSpan],
          ],
          GRASS_DARK,
          FLAT_REF,
          true
        );
        pushPoly(
          [
            [-halfSpan, 0.02, v - 0.13],
            [-halfSpan, 0.02, v + 0.13],
            [halfSpan, 0.02, v + 0.13],
            [halfSpan, 0.02, v - 0.13],
          ],
          GRASS_DARK,
          FLAT_REF,
          true
        );
      }
      flushPolys();
    }
  };

  // Emitted into the main pass so hills sort against props and the truck.
  const drawTerrainRelief = () => {
    for (let i = 0; i < reliefCount; i += 1) {
      const slot = reliefPool[i];
      pushPoly(slot.verts, slot.color, FLAT_REF, true);
    }
  };

  /* -------------------------------------------------------- trench pieces */

  const TRENCH_FLOOR_C = [128, 104, 78];
  const TRENCH_WALL_C = [152, 126, 96];
  const TRENCH_RIM_C = [110, 88, 66];
  const TRENCH_DARK_C = [26, 22, 20];

  const drawTrench = () => {
    if (!tunnel.open) {
      return;
    }
    const hw = tunnel.hw;
    const STEP = 3.4;
    // Underground the roofed stretch is a real corridor; from up top it has to
    // stay a solid piece of field with a black hole punched in each end.
    const inside = cam.y < 0.2;
    const n = Math.ceil((tunnel.sEnd - tunnel.sMouth) / STEP);

    for (let i = 0; i < n; i += 1) {
      const s0 = tunnel.sMouth + i * STEP;
      const s1 = Math.min(tunnel.sEnd, s0 + STEP);
      const roofed = s1 > tunnel.sLid0 && s0 < tunnel.sLid1;
      if (roofed && !inside) {
        continue;
      }
      const mid = tunnelXZ((s0 + s1) / 2, 0);
      if (Math.hypot(mid[0] - cam.x, mid[1] - cam.z) > 210) {
        continue;
      }
      const y0 = trenchFloor(s0);
      const y1 = trenchFloor(s1);
      const a = tunnelXZ(s0, -hw);
      const b = tunnelXZ(s1, -hw);
      const c = tunnelXZ(s1, hw);
      const d = tunnelXZ(s0, hw);

      pushPoly(
        [
          [a[0], y0, a[1]],
          [b[0], y1, b[1]],
          [c[0], y1, c[1]],
          [d[0], y0, d[1]],
        ],
        TRENCH_FLOOR_C,
        [mid[0], -400, mid[1]],
        true
      );

      // Each wall is a single quad facing into the cut. Culling is doing the
      // real work here: the wall on your side of the trench is dropped, so it
      // cannot paint over the hole you are trying to look down into.
      const outA = tunnelXZ((s0 + s1) / 2, -hw - 40);
      pushPoly(
        [
          [a[0], y0, a[1]],
          [b[0], y1, b[1]],
          [b[0], 0, b[1]],
          [a[0], 0, a[1]],
        ],
        TRENCH_WALL_C,
        [outA[0], -1, outA[1]],
        true
      );
      const outB = tunnelXZ((s0 + s1) / 2, hw + 40);
      pushPoly(
        [
          [d[0], y0, d[1]],
          [c[0], y1, c[1]],
          [c[0], 0, c[1]],
          [d[0], 0, d[1]],
        ],
        TRENCH_WALL_C,
        [outB[0], -1, outB[1]],
        true
      );

      if (roofed) {
        const ceil = -tunnel.depth + LID_CLEAR;
        pushPoly(
          [
            [a[0], ceil, a[1]],
            [b[0], ceil, b[1]],
            [c[0], ceil, c[1]],
            [d[0], ceil, d[1]],
          ],
          TRENCH_RIM_C,
          [mid[0], 400, mid[1]],
          true
        );
      }
    }

    // The two portals. From outside they are flat black -- you cannot see what
    // is in there, which is the whole point of a secret tunnel.
    const ceil = -tunnel.depth + LID_CLEAR;
    for (const end of [
      { s: tunnel.sLid0, away: 40 },
      { s: tunnel.sLid1, away: -40 },
    ]) {
      const p = tunnelXZ(end.s, -hw);
      const q = tunnelXZ(end.s, hw);
      const look = tunnelXZ(end.s + end.away, 0);
      // Lintel: the strip of ground above the opening.
      pushPoly(
        [
          [p[0], ceil, p[1]],
          [q[0], ceil, q[1]],
          [q[0], 0, q[1]],
          [p[0], 0, p[1]],
        ],
        TRENCH_RIM_C,
        [look[0], (ceil + 0) / 2, look[1]],
        true
      );
      if (!inside) {
        // Black curtain just inside the mouth, so the portal does not show
        // daylight straight through the hill.
        const cp = tunnelXZ(end.s - Math.sign(end.away) * 0.35, -hw);
        const cq = tunnelXZ(end.s - Math.sign(end.away) * 0.35, hw);
        pushPoly(
          [
            [cp[0], -tunnel.depth, cp[1]],
            [cq[0], -tunnel.depth, cq[1]],
            [cq[0], ceil, cq[1]],
            [cp[0], ceil, cp[1]],
          ],
          TRENCH_DARK_C,
          [look[0], ceil - 1, look[1]],
          true
        );
      }
    }
  };

  const drawBoundary = () => {
    const posts = 72;
    for (let i = 0; i < posts; i += 1) {
      const a = (i / posts) * Math.PI * 2;
      const x = Math.sin(a) * (ARENA + 3);
      const z = Math.cos(a) * (ARENA + 3);
      if (Math.hypot(x - cam.x, z - cam.z) > 120) {
        continue;
      }
      addBox(x, 1.1, z, 0.22, 1.1, 0.22, [176, 132, 84], a);
      const b = ((i + 1) / posts) * Math.PI * 2;
      const nx = Math.sin(b) * (ARENA + 3);
      const nz = Math.cos(b) * (ARENA + 3);
      const mx = (x + nx) / 2;
      const mz = (z + nz) / 2;
      const half = Math.hypot(nx - x, nz - z) / 2;
      const yaw = Math.atan2(nx - x, nz - z);
      addBox(mx, 1.55, mz, 0.1, 0.16, half, [206, 164, 112], yaw);
      addBox(mx, 0.9, mz, 0.1, 0.16, half, [206, 164, 112], yaw);
    }
  };

  /*
    The field only ever held a few dozen props, all of them close. The
    mountains hold hundreds, most of them a long way off, and a pine is 22
    polygons -- so past FAR_PROP the outdoor kinds collapse to a handful of
    polygons each. At that range it is a green blob either way.
  */
  const FAR_PROP = 85;

  const drawPropFar = (p) => {
    const b = p.y;
    switch (p.kind) {
      case "pine":
        addPyramid(p.x, b + 0.6, p.z, 1.6, 6.6, [56, 116, 68], 4, p.yaw);
        break;
      case "rock":
        addPyramid(p.x, b - 0.3, p.z, 1.05, 1.5, [138, 134, 132], 4, p.yaw);
        break;
      case "boulder":
        addPyramid(p.x, b - 0.6, p.z, 1.9, 3.4, [124, 120, 120], 4, p.yaw);
        break;
      default:
        drawProp(p);
        break;
    }
  };

  const drawProp = (p) => {
    const b = p.y;
    switch (p.kind) {
      case "barrel":
        addCylinder(p.x, b, p.z, 0.55, 0.5, [206, 62, 52], 8);
        addCylinder(p.x, b + 0.5, p.z, 0.55, 0.4, [238, 238, 234], 8);
        addCylinder(p.x, b + 0.9, p.z, 0.55, 0.5, [206, 62, 52], 8, [178, 52, 44]);
        break;
      case "crate":
        addBox(p.x, b + 0.6, p.z, 0.6, 0.6, 0.6, [186, 138, 82], p.yaw);
        addBox(p.x, b + 0.6, p.z, 0.66, 0.12, 0.66, [148, 104, 60], p.yaw);
        break;
      case "cone":
        addBox(p.x, b + 0.06, p.z, 0.42, 0.06, 0.42, [42, 42, 46], p.yaw);
        addPyramid(p.x, b + 0.1, p.z, 0.32, 0.85, [232, 108, 40], 4, p.yaw);
        break;
      case "tires":
        for (let i = 0; i < 3; i += 1) {
          addCylinder(p.x, b + i * 0.36, p.z, 0.62 - i * 0.04, 0.32, [46, 46, 50], 10, [64, 64, 68]);
        }
        break;
      case "hay":
        addCylinder(p.x, b, p.z, 0.85, 1.1, [214, 182, 96], 9, [232, 204, 124]);
        break;
      case "tree":
        addCylinder(p.x, b, p.z, 0.3, 1.6, [124, 88, 56], 6);
        addPyramid(p.x, b + 1.4, p.z, 1.5, 2.0, [72, 138, 68], 5, p.yaw);
        addPyramid(p.x, b + 2.6, p.z, 1.1, 1.8, [86, 156, 78], 5, p.yaw + 0.4);
        break;
      // Taller and darker than the field trees, so the woods outside read as
      // a different place rather than more of the same.
      case "pine":
        addCylinder(p.x, b, p.z, 0.34, 2.2, [98, 72, 48], 6);
        addPyramid(p.x, b + 1.7, p.z, 1.7, 2.6, [48, 104, 62], 5, p.yaw);
        addPyramid(p.x, b + 3.4, p.z, 1.3, 2.4, [58, 122, 70], 5, p.yaw + 0.5);
        addPyramid(p.x, b + 5.0, p.z, 0.85, 2.0, [70, 138, 80], 5, p.yaw + 1.0);
        break;
      case "rock":
        addPyramid(p.x, b - 0.3, p.z, 1.05, 1.5, [138, 134, 132], 5, p.yaw);
        break;
      case "boulder":
        addPyramid(p.x, b - 0.6, p.z, 1.9, 2.7, [122, 118, 118], 6, p.yaw);
        addPyramid(p.x, b + 1.2, p.z, 0.9, 1.1, [148, 144, 142], 5, p.yaw + 0.7);
        break;
      case "sign":
        addBox(p.x, b + 1.1, p.z, 0.11, 1.1, 0.11, [128, 94, 60], p.yaw);
        addBox(p.x, b + 2.3, p.z, 1.9, 0.6, 0.1, [244, 226, 168], p.yaw);
        addBox(p.x, b + 2.3, p.z, 1.6, 0.16, 0.14, [196, 74, 58], p.yaw);
        break;
      case "fence":
        addBox(p.x, b + 0.75, p.z, 0.14, 0.75, 0.14, [190, 176, 152], p.yaw);
        addBox(p.x + Math.sin(p.yaw) * 1.6, b + 1.1, p.z + Math.cos(p.yaw) * 1.6, 0.09, 0.14, 1.6, [222, 214, 196], p.yaw);
        addBox(p.x + Math.sin(p.yaw) * 1.6, b + 0.6, p.z + Math.cos(p.yaw) * 1.6, 0.09, 0.14, 1.6, [222, 214, 196], p.yaw);
        break;
      case "gate": {
        const sx = Math.sin(p.yaw);
        const sz = Math.cos(p.yaw);
        addBox(p.x - sx * 3, b + 1.6, p.z - sz * 3, 0.32, 1.6, 0.32, [232, 232, 236], p.yaw);
        addBox(p.x + sx * 3, b + 1.6, p.z + sz * 3, 0.32, 1.6, 0.32, [232, 232, 236], p.yaw);
        addBox(p.x, b + 3.4, p.z, 0.28, 0.36, 3.3, [216, 72, 60], p.yaw);
        for (let i = -2; i <= 2; i += 1) {
          addBox(p.x + sx * i * 1.2, b + 1.5, p.z + sz * i * 1.2, 0.12, 1.4, 0.5, [244, 196, 72], p.yaw);
        }
        break;
      }
      default:
        break;
    }
  };

  // The one crate in the field that is worth ramming. Deliberately oversized
  // and hazard-striped: it should read as "this is not scenery".
  const drawCrate = () => {
    if (!crate.alive) {
      return;
    }
    const wob = crate.shake > 0 ? Math.sin(performance.now() / 28) * crate.shake : 0;
    const x = crate.x + wob * 0.3;
    const z = crate.z;
    addBox(x, 3.0, z, 3.0, 3.0, 3.0, [156, 112, 62], crate.yaw, 0, wob * 0.05);
    // Bands of hazard stripe around the middle.
    for (let i = -1; i <= 1; i += 1) {
      addBox(x, 3.0 + i * 1.5, z, 3.08, 0.34, 3.08, i === 0 ? [232, 176, 40] : [40, 38, 40], crate.yaw, 0, wob * 0.05);
    }
    addBox(x, 6.05, z, 3.1, 0.16, 3.1, [122, 86, 48], crate.yaw, 0, wob * 0.05);
    // A big warning triangle on each end.
    for (const side of [1, -1]) {
      const fx = x + Math.sin(crate.yaw) * side * 3.06;
      const fz = z + Math.cos(crate.yaw) * side * 3.06;
      addPyramid(fx, 1.9, fz, 1.5, 2.2, [236, 190, 44], 3, crate.yaw);
    }
  };

  const drawCoin = (c) => {
    const bob = 0.55 + Math.sin(performance.now() / 300 + c.phase) * 0.08;
    const spin = performance.now() / 450 + c.phase;
    addCoin(c.x, c.y + bob, c.z, 0.42, 0.12, spin, [255, 214, 64], [210, 160, 40]);
  };

  const drawTnt = (t) => {
    const sx = Math.sin(t.yaw + Math.PI / 2);
    const sz = Math.cos(t.yaw + Math.PI / 2);
    const b = t.y;
    for (let i = -1; i <= 1; i += 1) {
      addCylinder(t.x + sx * i * 0.32, b, t.z + sz * i * 0.32, 0.22, 0.7, [196, 40, 36], 8, [222, 64, 56]);
    }
    addBox(t.x, b + 0.5, t.z, 0.62, 0.06, 0.62, [246, 238, 210], t.yaw);
    addCylinder(t.x, b + 0.7, t.z, 0.04, 0.32, [70, 60, 50], 5);
    const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 120);
    addCylinder(t.x, b + 1.0, t.z, 0.05 + pulse * 0.03, 0.1, [255, 120 + pulse * 100, 40], 6);
  };

  /* ---------------------------------------------------------------- giant */

  /*
    A 200-foot six-year-old stomping around the field, barefoot and filthy.
    World units are roughly metres (the truck is about 5 long), so 200 feet is
    ~61 units from heel to hair. He is built in a local frame -- x across, y
    up, z forward -- and rotated onto the field by gp(), so every part swings
    together. The whole thing is one entity, so the detail is affordable.
  */
  const G_HIP_X = 3.6;
  const G_HIP_Y = 28.5;
  const G_THIGH = 13;
  const G_SHIN = 13;
  const G_ANKLE = 2.6;
  const G_STRIDE = 12; // metres between footfalls, half in front, half behind
  const G_LIFT = 7;
  const G_SPEED = 8.5; // slower than the truck, so he is dodgeable
  const G_TURN = 0.55;
  const G_TORSO_Y0 = 29.5;
  const G_TORSO_Y1 = 47.5;
  const G_TORSO_HX = 6.3;
  const G_TORSO_HZ = 3.9;
  const G_SHOULDER_X = 6.8;
  const G_SHOULDER_Y = 46.0;
  const G_UPPER = 11;
  const G_FORE = 9.5;
  // A six-year-old's head is about a sixth of him, which is most of why he
  // reads as a small child and not a tall man.
  const G_HEAD_Y = 55.6;
  const G_HEAD_HX = 5.3;
  const G_HEAD_HY = 6.0;
  const G_HEAD_HZ = 5.0;
  const G_KICK_TIME = 1.5;
  const G_KICK_RANGE = 21;
  const G_FOOT_KILL = 5.6;

  const SKIN = [240, 205, 176];
  const SKIN_DARK = [212, 172, 142];
  const SHIRT = [178, 208, 152];
  const SHIRT_DARK = [148, 178, 122];
  const STEG = [64, 102, 64];
  const SHORTS = [42, 42, 48];
  const SHORTS_DARK = [30, 30, 36];
  const HAIR = [236, 202, 104];
  const HAIR_DARK = [204, 166, 72];
  const GRIME = [168, 140, 104];
  const FLY_COLOR = [58, 54, 52];

  const giant = {
    x: 0,
    z: 0,
    yaw: 0,
    speed: 0,
    phase: 0,
    targetX: 0,
    targetZ: 0,
    pauseTimer: 0,
    kickTimer: 0,
    kickLeg: 0,
    kickCooldown: 10,
    lastQ: [0, 0.5],
    pose: null,
    flies: [],
  };

  // Extra camera work the giant needs: a crane so you can look up at him, and
  // a shudder every time a foot lands.
  let crane = 0;
  let shake = 0;

  // Local (across, up, forward) -> world. Matches the yaw convention addBox
  // uses, so a box placed here lines up with a box rotated by giant.yaw.
  const gp = (lx, ly, lz) => {
    const c = Math.cos(giant.yaw);
    const s = Math.sin(giant.yaw);
    return [giant.x + lx * c + lz * s, ly, giant.z + lz * c - lx * s];
  };

  // A limb segment: a box stretched from (y0, z0) to (y1, z1) at a fixed x.
  const addLimb = (lx, y0, z0, y1, z1, hw, hd, color) => {
    const dy = y1 - y0;
    const dz = z1 - z0;
    const len = Math.hypot(dy, dz) || 0.001;
    const w = gp(lx, (y0 + y1) / 2, (z0 + z1) / 2);
    addBox(w[0], w[1], w[2], hw, len / 2 + hw * 0.3, hd, color, giant.yaw, Math.atan2(dz, dy));
  };

  // Flat decals painted on a plane of the body (clothes prints, face, dirt).
  const gQuad = (x0, y0, x1, y1, z, color) => {
    pushPoly([gp(x0, y0, z), gp(x1, y0, z), gp(x1, y1, z), gp(x0, y1, z)], color);
  };
  const gTri = (x0, y0, x1, y1, x2, y2, z, color) => {
    pushPoly([gp(x0, y0, z), gp(x1, y1, z), gp(x2, y2, z)], color);
  };

  // A camera-facing square -- cheap enough for specks like flies.
  const addBillboard = (x, y, z, size, color) => {
    const rx = camRight[0] * size;
    const ry = camRight[1] * size;
    const rz = camRight[2] * size;
    const ux = camUp[0] * size;
    const uy = camUp[1] * size;
    const uz = camUp[2] * size;
    pushPoly(
      [
        [x - rx - ux, y - ry - uy, z - rz - uz],
        [x + rx - ux, y + ry - uy, z + rz - uz],
        [x + rx + ux, y + ry + uy, z + rz + uz],
        [x - rx + ux, y - ry + uy, z - rz + uz],
      ],
      color
    );
  };

  const pickGiantTarget = () => {
    for (let i = 0; i < 8; i += 1) {
      const a = range(0, Math.PI * 2);
      const d = range(8, ARENA - 14);
      const x = Math.sin(a) * d;
      const z = Math.cos(a) * d;
      if (Math.hypot(x - giant.x, z - giant.z) > 30) {
        giant.targetX = x;
        giant.targetZ = z;
        return;
      }
    }
    giant.targetX = -giant.x;
    giant.targetZ = -giant.z;
  };

  /*
    Where each foot is this frame. Walking is one cosine: the foot is behind
    at q = 0, swings forward through q = 0.5 (lifted the whole way), then
    stays planted while the body walks over it. Phase advances with distance
    covered, not with time, so the planted foot really does stay put.
  */
  const legPose = (i) => {
    const side = i === 0 ? -1 : 1;
    if (giant.kickTimer > 0) {
      if (i !== giant.kickLeg) {
        return { side, az: 0, ay: 0, q: 0.5 };
      }
      const t = 1 - giant.kickTimer / G_KICK_TIME;
      if (t < 0.42) {
        const k = t / 0.42;
        return { side, az: lerp(0, -9, k), ay: lerp(0, 7, k), q: 0.5 };
      }
      if (t < 0.68) {
        const k = (t - 0.42) / 0.26;
        const e = k * k * (3 - 2 * k);
        return { side, az: lerp(-9, 11, e), ay: lerp(7, 2, e), q: 0.5 };
      }
      const k = (t - 0.68) / 0.32;
      return { side, az: lerp(11, 0, k), ay: lerp(2, 0, k), q: 0.5 };
    }
    const q = (giant.phase + i * 0.5) % 1;
    const gait = clamp(giant.speed / 3, 0, 1);
    return {
      side,
      az: -Math.cos(q * Math.PI * 2) * (G_STRIDE / 2) * gait,
      ay: Math.max(0, Math.sin(q * Math.PI * 2)) * G_LIFT * gait,
      q,
    };
  };

  // Two-bone IK for the knee, solved in the leg's own forward/up plane so the
  // knee always bends the way a knee bends.
  const legGeom = (i) => {
    const p = legPose(i);
    let ankleY = G_ANKLE + p.ay;
    let az = p.az;
    let dy = ankleY - G_HIP_Y;
    let dz = az;
    let d = Math.hypot(dy, dz) || 0.001;
    const maxReach = G_THIGH + G_SHIN - 0.6;
    if (d > maxReach) {
      const s = maxReach / d;
      dy *= s;
      dz *= s;
      ankleY = G_HIP_Y + dy;
      az = dz;
      d = maxReach;
    }
    const uy = dy / d;
    const uz = dz / d;
    const a = (d * d + G_THIGH * G_THIGH - G_SHIN * G_SHIN) / (2 * d);
    const h = Math.sqrt(Math.max(0, G_THIGH * G_THIGH - a * a));
    return {
      side: p.side,
      q: p.q,
      az,
      ankleY,
      lift: Math.max(0, ankleY - G_ANKLE),
      kneeY: G_HIP_Y + uy * a + uz * h,
      kneeZ: uz * a - uy * h,
      wx: 0,
      wz: 0,
    };
  };

  const updateGiantPose = () => {
    giant.pose = [legGeom(0), legGeom(1)];
    for (let i = 0; i < 2; i += 1) {
      const leg = giant.pose[i];
      const w = gp(leg.side * G_HIP_X, 0, leg.az + 1.9);
      leg.wx = w[0];
      leg.wz = w[2];
    }
  };

  // A footfall shakes the camera, kicks up dust, and flattens whatever was
  // standing there.
  const footfall = (wx, wz) => {
    const d = Math.hypot(wx - truck.x, wz - truck.z);
    if (d < 90) {
      shake = Math.max(shake, 0.3 + (1 - d / 90) * 0.9);
    }
    for (let i = 0; i < 12; i += 1) {
      if (debris.length > 220) {
        break;
      }
      const a = range(0, Math.PI * 2);
      const s = range(3, 11);
      debris.push({
        x: wx + range(-4, 4),
        y: range(0.2, 1.2),
        z: wz + range(-4, 4),
        vx: Math.cos(a) * s,
        vy: range(2, 7),
        vz: Math.sin(a) * s,
        yaw: range(0, 6.3),
        pitch: range(0, 6.3),
        roll: range(0, 6.3),
        spinY: range(-5, 5),
        spinX: range(-5, 5),
        spinZ: range(-5, 5),
        size: range(0.3, 0.9),
        color: [152, 142, 118],
        life: range(0.7, 1.5),
      });
    }
    for (let i = 0; i < props.length; i += 1) {
      const p = props[i];
      if (p.alive && Math.hypot(p.x - wx, p.z - wz) < 6.5) {
        p.alive = false;
        burst(p, 0, 0, 1.5);
      }
    }
  };

  // Anything of yours under a foot that is at truck height gets flattened.
  const giantHit = () => {
    // Down in the cut you are under his feet, not under his heel. Getting
    // below ground is the one place he cannot reach.
    if (truck.y < -1.2) {
      return null;
    }
    const bodies = hitBodies();
    for (let i = 0; i < 2; i += 1) {
      const leg = giant.pose[i];
      const kicking = giant.kickTimer > 0 && i === giant.kickLeg;
      const ceiling = kicking ? 6.5 : 2.6;
      if (leg.lift > ceiling) {
        continue;
      }
      const reach = kicking ? 7.5 : G_FOOT_KILL;
      for (let b = 0; b < bodies.length; b += 1) {
        const body = bodies[b];
        const dx = leg.wx - body[0];
        const dz = leg.wz - body[1];
        const r = reach + body[2];
        if (dx * dx + dz * dz < r * r) {
          return [leg.wx, leg.wz, kicking];
        }
      }
    }
    return null;
  };

  const updateGiant = (dt) => {
    const playing = state === "playing";

    if (giant.kickTimer > 0) {
      giant.kickTimer -= dt;
      giant.speed = 0;
      const want = Math.atan2(truck.x - giant.x, truck.z - giant.z);
      giant.yaw = wrapAngle(
        giant.yaw + clamp(wrapAngle(want - giant.yaw), -1.6 * dt, 1.6 * dt)
      );
      if (giant.kickTimer <= 0) {
        giant.kickTimer = 0;
        giant.kickCooldown = range(8, 15);
        giant.pauseTimer = range(0.4, 1.2);
      }
    } else {
      giant.kickCooldown -= dt;
      const dx = truck.x - giant.x;
      const dz = truck.z - giant.z;
      const toTruck = Math.hypot(dx, dz);
      const facing = Math.abs(wrapAngle(Math.atan2(dx, dz) - giant.yaw));
      if (playing && giant.kickCooldown <= 0 && toTruck < G_KICK_RANGE && facing < 1.2) {
        giant.kickTimer = G_KICK_TIME;
        giant.kickLeg = wrapAngle(Math.atan2(dx, dz) - giant.yaw) > 0 ? 1 : 0;
        setMessage("The giant is winding up a kick -- MOVE!", 1.6);
      } else if (giant.pauseTimer > 0) {
        giant.pauseTimer -= dt;
        giant.speed = lerp(giant.speed, 0, 1 - Math.pow(0.02, dt));
        if (giant.pauseTimer <= 0) {
          pickGiantTarget();
        }
      } else {
        const tx = giant.targetX - giant.x;
        const tz = giant.targetZ - giant.z;
        if (Math.hypot(tx, tz) < 9) {
          giant.pauseTimer = range(1.2, 3.6);
        } else {
          const want = Math.atan2(tx, tz);
          giant.yaw = wrapAngle(
            giant.yaw + clamp(wrapAngle(want - giant.yaw), -G_TURN * dt, G_TURN * dt)
          );
          giant.speed = lerp(giant.speed, G_SPEED, 1 - Math.pow(0.25, dt));
          giant.x += Math.sin(giant.yaw) * giant.speed * dt;
          giant.z += Math.cos(giant.yaw) * giant.speed * dt;
        }
      }
      // Phase follows distance walked: a stride covers half the gait cycle.
      giant.phase = (giant.phase + (giant.speed * dt) / (2 * G_STRIDE)) % 1;
    }

    updateGiantPose();

    for (let i = 0; i < 2; i += 1) {
      const leg = giant.pose[i];
      const prev = giant.lastQ[i];
      if (giant.kickTimer <= 0 && prev < 0.5 && leg.q >= 0.5 && giant.speed > 0.5) {
        footfall(leg.wx, leg.wz);
      }
      giant.lastQ[i] = leg.q;
    }

    if (playing) {
      const hit = giantHit();
      if (hit) {
        squashTruck(hit[0], hit[1], hit[2]);
      }
    }

    const now = performance.now() / 1000;
    for (let i = 0; i < giant.flies.length; i += 1) {
      const f = giant.flies[i];
      f.a += f.spin * dt;
      f.y += Math.sin(now * f.drift + f.bob) * 6 * dt;
      f.y = clamp(f.y, 24, 62);
    }
  };

  const resetGiant = () => {
    const a = range(0, Math.PI * 2);
    const d = range(46, ARENA - 14);
    giant.x = Math.sin(a) * d;
    giant.z = Math.cos(a) * d;
    giant.yaw = wrapAngle(a + Math.PI);
    giant.speed = 0;
    giant.phase = 0;
    giant.pauseTimer = range(0.6, 2.2);
    giant.kickTimer = 0;
    giant.kickLeg = 0;
    giant.kickCooldown = range(9, 16);
    giant.lastQ = [0, 0.5];
    pickGiantTarget();
    giant.flies = [];
    for (let i = 0; i < 7; i += 1) {
      giant.flies.push({
        a: range(0, Math.PI * 2),
        r: range(7, 15),
        y: range(28, 58),
        spin: range(0.9, 2.6) * (random() > 0.5 ? 1 : -1),
        bob: range(0, Math.PI * 2),
        drift: range(0.6, 1.8),
      });
    }
    updateGiantPose();
    crane = 0;
    shake = 0;
  };

  // One stegosaurus, printed flat on the shirt: body, neck, tail, legs, and
  // the row of plates that makes it a stegosaurus and not a lump.
  const addSteg = (px, py, s, z, color) => {
    gQuad(px - 2.0 * s, py - 0.35 * s, px + 1.2 * s, py + 0.55 * s, z, color);
    gQuad(px - 3.1 * s, py + 0.15 * s, px - 1.8 * s, py + 0.75 * s, z, color);
    gTri(px + 1.1 * s, py + 0.5 * s, px + 3.2 * s, py + 1.0 * s, px + 1.1 * s, py - 0.1 * s, z, color);
    gQuad(px - 1.6 * s, py - 1.15 * s, px - 1.0 * s, py - 0.3 * s, z, color);
    gQuad(px + 0.2 * s, py - 1.15 * s, px + 0.8 * s, py - 0.3 * s, z, color);
    for (let i = 0; i < 3; i += 1) {
      const bx = px - 1.3 * s + i * 1.1 * s;
      gTri(bx - 0.45 * s, py + 0.5 * s, bx + 0.45 * s, py + 0.5 * s, bx, py + 1.6 * s, z, color);
    }
  };

  const drawGiant = () => {
    const legs = giant.pose;
    if (!legs) {
      return;
    }
    const dist = Math.hypot(giant.x - cam.x, giant.z - cam.z);
    const detail = dist < 115;
    const zF = G_TORSO_HZ + 0.75; // decal plane just off the front of the shirt
    const zB = -(G_TORSO_HZ + 0.75);
    const zH = G_HEAD_HZ + 0.12; // decal plane on the face

    // Shadow pools: the only warning that a foot is on its way down.
    for (let i = 0; i < 2; i += 1) {
      const leg = legs[i];
      const r = 5.2 + leg.lift * 0.14;
      const ring = [];
      for (let k = 0; k < 8; k += 1) {
        const a = (k / 8) * Math.PI * 2;
        ring.push(
          gp(
            leg.side * G_HIP_X + Math.cos(a) * r * 0.6,
            0.06,
            leg.az + 1.9 + Math.sin(a) * r
          )
        );
      }
      pushPoly(ring, [56, 92, 54]);
    }

    /* ----- legs and bare feet */
    for (let i = 0; i < 2; i += 1) {
      const leg = legs[i];
      const lx = leg.side * G_HIP_X;
      addLimb(lx, G_HIP_Y, 0, leg.kneeY, leg.kneeZ, 2.7, 2.7, SKIN);
      addLimb(lx, leg.kneeY, leg.kneeZ, leg.ankleY, leg.az, 2.1, 2.1, SKIN);

      const footPitch = clamp(leg.lift * 0.05, 0, 0.34);
      const footY = leg.lift + 1.25;
      const footZ = leg.az + 1.9;
      const fw = gp(lx, footY, footZ);
      addBox(fw[0], fw[1], fw[2], 2.4, 1.25, 4.5, SKIN, giant.yaw, footPitch);

      if (detail) {
        // Scabbed-up knee, because he is six.
        const kw = gp(lx, leg.kneeY + 0.3, leg.kneeZ + 2.3);
        addBox(kw[0], kw[1], kw[2], 1.4, 1.1, 0.6, SKIN_DARK, giant.yaw);
        const scab = gp(lx + 0.4, leg.kneeY + 0.5, leg.kneeZ + 2.7);
        addBox(scab[0], scab[1], scab[2], 0.7, 0.5, 0.35, [172, 100, 88], giant.yaw);
        // Grubby shin.
        const mud = gp(lx, (leg.kneeY + leg.ankleY) / 2, (leg.kneeZ + leg.az) / 2 + 2.2);
        addBox(mud[0], mud[1], mud[2], 1.6, 2.2, 0.3, GRIME, giant.yaw);
        for (let t = 0; t < 4; t += 1) {
          const off = rotate(-1.6 + t * 1.05, -0.3, 4.6, 0, footPitch, 0);
          const tw = gp(lx + off[0], footY + off[1], footZ + off[2]);
          addBox(tw[0], tw[1], tw[2], 0.44, 0.72, 0.62, SKIN, giant.yaw, footPitch);
        }
      }
    }

    /* ----- shorts: black, and coming apart at the hems */
    const shortsW = gp(0, 26.9, 0);
    addBox(
      shortsW[0],
      shortsW[1],
      shortsW[2],
      G_TORSO_HX + 0.35,
      4.2,
      G_TORSO_HZ + 0.5,
      SHORTS,
      giant.yaw
    );
    for (let i = 0; i < 2; i += 1) {
      const leg = legs[i];
      const lx = leg.side * G_HIP_X;
      const cy = lerp(G_HIP_Y, leg.kneeY, 0.45);
      const cz = lerp(0, leg.kneeZ, 0.45);
      addLimb(lx, G_HIP_Y + 1, 0, cy, cz, 3.3, 3.3, SHORTS);
      for (let k = 0; k < 3; k += 1) {
        const x0 = lx - 3.2 + k * 2.1;
        const x1 = x0 + 2.1;
        const dip = 1.0 + ((k + i) % 3) * 1.1;
        gTri(x0, cy + 0.3, x1, cy + 0.3, (x0 + x1) / 2, cy - dip, cz + 3.4, SHORTS);
        gTri(x0, cy + 0.3, x1, cy + 0.3, (x0 + x1) / 2, cy - dip, cz - 3.4, SHORTS_DARK);
      }
    }

    /* ----- torso and the pale green tank top */
    const torsoW = gp(0, (G_TORSO_Y0 + G_TORSO_Y1) / 2, 0);
    addBox(
      torsoW[0],
      torsoW[1],
      torsoW[2],
      G_TORSO_HX,
      (G_TORSO_Y1 - G_TORSO_Y0) / 2,
      G_TORSO_HZ,
      SKIN,
      giant.yaw
    );

    const shirtY0 = 31.8;
    const shirtY1 = 45.4;
    const shirtW = gp(0, (shirtY0 + shirtY1) / 2, 0);
    addBox(
      shirtW[0],
      shirtW[1],
      shirtW[2],
      G_TORSO_HX + 0.55,
      (shirtY1 - shirtY0) / 2,
      G_TORSO_HZ + 0.55,
      SHIRT,
      giant.yaw
    );
    for (const side of [-1, 1]) {
      const strap = gp(side * 4.4, 46.4, 0);
      addBox(strap[0], strap[1], strap[2], 1.4, 1.9, 1.7, SHIRT_DARK, giant.yaw);
    }
    // Ragged hem.
    for (let i = 0; i < 6; i += 1) {
      const w = (G_TORSO_HX + 0.5) * 2 / 6;
      const x0 = -(G_TORSO_HX + 0.5) + i * w;
      const x1 = x0 + w;
      const dip = 1.1 + ((i * 5) % 3) * 1.0;
      gTri(x0, shirtY0 + 0.3, x1, shirtY0 + 0.3, (x0 + x1) / 2, shirtY0 - dip, zF - 0.35, SHIRT);
      gTri(x0, shirtY0 + 0.3, x1, shirtY0 + 0.3, (x0 + x1) / 2, shirtY0 - dip, zB + 0.35, SHIRT_DARK);
    }

    if (detail) {
      // Stegosaurus print, front and back.
      addSteg(-3.4, 41.8, 0.8, zF, STEG);
      addSteg(3.2, 43.4, 0.72, zF, STEG);
      addSteg(-2.6, 35.4, 0.74, zF, STEG);
      addSteg(3.6, 36.8, 0.82, zF, STEG);
      addSteg(-2.2, 40.2, 0.76, zB, STEG);
      addSteg(3.0, 34.8, 0.7, zB, STEG);
      // A tear in the shirt, and the dirt of a bath long overdue. Smudges are
      // ragged triangles -- a rectangle of dirt reads as a floating box.
      gTri(-5.6, 38.6, -3.6, 37.2, -5.8, 34.8, zF - 0.3, SKIN_DARK);
      gTri(-1.4, 32.6, 2.4, 33.8, 0.6, 35.6, zF - 0.3, GRIME);
      gTri(-1.4, 32.6, 2.4, 33.8, 1.8, 31.9, zF - 0.3, GRIME);
      gTri(3.8, 38.2, 5.9, 39.0, 4.2, 40.8, zF - 0.3, GRIME);
    }

    /* ----- arms */
    const gait = clamp(giant.speed / 3, 0, 1);
    for (let i = 0; i < 2; i += 1) {
      const leg = legs[i];
      const lx = leg.side * G_SHOULDER_X;
      const swing =
        giant.kickTimer > 0
          ? leg.side * -0.35
          : Math.cos(leg.q * Math.PI * 2) * 0.5 * gait;
      const elbowY = G_SHOULDER_Y - Math.cos(swing) * G_UPPER;
      const elbowZ = Math.sin(swing) * G_UPPER;
      const bend = swing * 0.6 + 0.3;
      const wristY = elbowY - Math.cos(bend) * G_FORE;
      const wristZ = elbowZ + Math.sin(bend) * G_FORE;
      const shoulder = gp(lx, G_SHOULDER_Y, 0);
      addBox(shoulder[0], shoulder[1], shoulder[2], 2.4, 2.2, 2.4, SKIN, giant.yaw);
      addLimb(lx, G_SHOULDER_Y, 0, elbowY, elbowZ, 2.1, 2.1, SKIN);
      addLimb(lx, elbowY, elbowZ, wristY, wristZ, 1.8, 1.8, SKIN);
      const hand = gp(lx, wristY - 1.6, wristZ + 0.4);
      addBox(hand[0], hand[1], hand[2], 1.8, 2.0, 1.6, SKIN, giant.yaw);
      if (detail) {
        const dirt = gp(lx, wristY - 2.2, wristZ + 2.0);
        addBox(dirt[0], dirt[1], dirt[2], 1.5, 1.2, 0.25, GRIME, giant.yaw);
      }
    }

    /* ----- neck and head */
    const neck = gp(0, 48.6, 0);
    addBox(neck[0], neck[1], neck[2], 2.4, 1.8, 2.2, SKIN_DARK, giant.yaw);
    const head = gp(0, G_HEAD_Y, 0);
    addBox(head[0], head[1], head[2], G_HEAD_HX, G_HEAD_HY, G_HEAD_HZ, SKIN, giant.yaw);
    for (const side of [-1, 1]) {
      const ear = gp(side * (G_HEAD_HX + 0.5), G_HEAD_Y + 0.2, -0.4);
      addBox(ear[0], ear[1], ear[2], 0.6, 1.5, 1.3, SKIN_DARK, giant.yaw);
    }
    const nose = gp(0, G_HEAD_Y - 0.8, G_HEAD_HZ + 0.55);
    addBox(nose[0], nose[1], nose[2], 0.9, 1.0, 0.7, SKIN, giant.yaw);

    if (detail) {
      for (const side of [-1, 1]) {
        gQuad(side * 2.9 - 1.0, G_HEAD_Y + 0.6, side * 2.9 + 1.0, G_HEAD_Y + 2.0, zH, [246, 244, 238]);
        gQuad(side * 2.9 - 0.4, G_HEAD_Y + 0.9, side * 2.9 + 0.4, G_HEAD_Y + 1.6, zH + 0.05, [58, 84, 118]);
        gQuad(side * 2.9 - 1.1, G_HEAD_Y + 2.3, side * 2.9 + 1.1, G_HEAD_Y + 2.7, zH, HAIR_DARK);
      }
      // A wide-open, delighted six-year-old grin.
      gQuad(-2.2, G_HEAD_Y - 3.4, 2.2, G_HEAD_Y - 1.9, zH, [122, 56, 52]);
      gQuad(-2.2, G_HEAD_Y - 2.2, 2.2, G_HEAD_Y - 1.9, zH + 0.05, [248, 246, 238]);
      // Freckles and a cheek smeared with whatever he last fell in.
      for (let i = 0; i < 6; i += 1) {
        const fx = (i % 3) * 0.9 + (i < 3 ? -3.4 : 1.8);
        gQuad(fx, G_HEAD_Y - 1.2, fx + 0.4, G_HEAD_Y - 0.8, zH, SKIN_DARK);
      }
      gQuad(-4.4, G_HEAD_Y - 2.6, -2.6, G_HEAD_Y - 1.4, zH, GRIME);
    }

    /* ----- blonde hair, a mop that has not met a comb */
    const capTop = G_HEAD_Y + G_HEAD_HY;
    const cap = gp(0, capTop - 1.2, 0);
    addBox(cap[0], cap[1], cap[2], G_HEAD_HX + 0.45, 2.4, G_HEAD_HZ + 0.45, HAIR, giant.yaw);
    const backHair = gp(0, G_HEAD_Y + 1.6, -(G_HEAD_HZ + 0.3));
    addBox(backHair[0], backHair[1], backHair[2], G_HEAD_HX + 0.45, 4.6, 0.8, HAIR_DARK, giant.yaw);
    for (const side of [-1, 1]) {
      const sideburn = gp(side * (G_HEAD_HX + 0.3), G_HEAD_Y + 2.2, -0.6);
      addBox(sideburn[0], sideburn[1], sideburn[2], 0.5, 3.6, G_HEAD_HZ - 0.2, HAIR_DARK, giant.yaw);
    }
    // Bangs, hanging to just above the eyes and cut by nobody in particular.
    gQuad(-G_HEAD_HX, G_HEAD_Y + 2.6, G_HEAD_HX, capTop, zH + 0.1, HAIR);
    for (let i = 0; i < 6; i += 1) {
      const w = (G_HEAD_HX * 2) / 6;
      const x0 = -G_HEAD_HX + i * w;
      gTri(
        x0,
        G_HEAD_Y + 2.7,
        x0 + w,
        G_HEAD_Y + 2.7,
        x0 + w / 2,
        G_HEAD_Y + 1.2 - (i % 2) * 0.7,
        zH + 0.1,
        HAIR
      );
    }
    const tufts = [
      [-2.8, -1.6, 2.4, 4.0],
      [1.9, 0.7, 2.8, 5.2],
      [-0.4, 2.6, 2.1, 3.4],
      [3.4, -2.4, 1.9, 3.0],
      [-3.6, 1.7, 1.7, 2.6],
      [0.8, -3.0, 1.6, 2.4],
    ];
    for (let i = 0; i < tufts.length; i += 1) {
      const t = tufts[i];
      const w = gp(t[0], capTop + 0.6, t[1]);
      addPyramid(w[0], w[1], w[2], t[2], t[3], i % 2 ? HAIR : HAIR_DARK, 4, giant.yaw + i);
    }

    /* ----- flies, because of the bath he has not had */
    if (detail) {
      const t = performance.now() / 1000;
      for (let i = 0; i < giant.flies.length; i += 1) {
        const f = giant.flies[i];
        const w = gp(
          Math.cos(f.a) * f.r + Math.sin(t * 9 + f.bob) * 0.9,
          f.y + Math.sin(t * 13 + f.bob) * 0.7,
          Math.sin(f.a) * f.r + Math.cos(t * 11 + f.bob) * 0.9
        );
        addBillboard(w[0], w[1], w[2], 0.38, FLY_COLOR);
      }
    }
  };

  const WHEEL = [38, 38, 42];

  const drawTruck = () => {
    const { x, z, yaw } = truck;
    // Suspension lean plus whatever the ground underneath is doing.
    const pitch = truck.bodyPitch + truck.groundPitch;
    const roll = truck.bodyRoll + truck.groundRoll;
    // Local offsets rotated into the world, so the whole truck leans together.
    const at = (lx, ly, lz) => {
      const p = rotate(lx, ly, lz, yaw, pitch, roll);
      return [x + p[0], truck.y + 0.62 + p[1], z + p[2]];
    };

    const chassis = at(0, 0.18, 0);
    addBox(chassis[0], chassis[1], chassis[2], 1.05, 0.22, 2.5, [64, 66, 74], yaw, pitch, roll);

    const cab = at(0, 1.0, 0.45);
    addBox(cab[0], cab[1], cab[2], 1.02, 0.62, 1.15, [222, 70, 58], yaw, pitch, roll);

    const roof = at(0, 1.66, 0.4);
    addBox(roof[0], roof[1], roof[2], 0.92, 0.06, 0.98, [248, 118, 96], yaw, pitch, roll);

    const glass = at(0, 1.05, 1.62);
    addBox(glass[0], glass[1], glass[2], 0.86, 0.42, 0.06, [126, 190, 226], yaw, pitch, roll);

    const hood = at(0, 0.62, 1.9);
    addBox(hood[0], hood[1], hood[2], 1.0, 0.3, 0.65, [200, 56, 46], yaw, pitch, roll);

    const bed = at(0, 0.62, -1.35);
    addBox(bed[0], bed[1], bed[2], 1.0, 0.24, 1.2, [58, 60, 66], yaw, pitch, roll);

    // Tailgate and tail lights, so the back of the truck reads from the
    // chase camera instead of being one dark lump.
    const gate = at(0, 0.7, -2.5);
    addBox(gate[0], gate[1], gate[2], 1.0, 0.34, 0.08, [200, 56, 46], yaw, pitch, roll);
    for (const side of [-1, 1]) {
      const tail = at(side * 0.7, 0.7, -2.58);
      addBox(tail[0], tail[1], tail[2], 0.22, 0.14, 0.06, [255, 96, 70], yaw, pitch, roll);
    }

    const hitch = at(0, 0.34, -2.5);
    addBox(hitch[0], hitch[1], hitch[2], 0.16, 0.12, 0.5, [90, 92, 98], yaw, pitch, roll);
    addCylinder(hitch[0], hitch[1] + 0.1, hitch[2], 0.16, 0.22, [232, 196, 72], 6);

    for (const side of [-1, 1]) {
      const front = at(side * 1.05, -0.08, 1.55);
      addBox(front[0], front[1], front[2], 0.22, 0.52, 0.52, WHEEL, yaw + truck.steerAngle, pitch, roll);
      const rear = at(side * 1.05, -0.08, -1.35);
      addBox(rear[0], rear[1], rear[2], 0.22, 0.52, 0.52, WHEEL, yaw, pitch, roll);
    }

    for (const side of [-1, 1]) {
      const lamp = at(side * 0.62, 0.66, 2.55);
      addBox(lamp[0], lamp[1], lamp[2], 0.2, 0.16, 0.06, [255, 242, 190], yaw, pitch, roll);
    }
  };

  const drawTrailer = () => {
    const { x, z, yaw } = trailer;
    const ty = trailer.y;
    const tp = trailer.pitch;
    // Trailer parts only need placing on the ground plane, so this maps a
    // local (sideways, forward) offset onto the world.
    const at = (lx, lz) => [
      x + lx * Math.cos(yaw) + lz * Math.sin(yaw),
      z + lz * Math.cos(yaw) - lx * Math.sin(yaw),
    ];
    // A loaded trailer visibly sags on its axle -- another cue that the
    // coins riding along have real weight.
    const sag = trailer.hooked ? clamp(coinsCollected * 0.006, 0, 0.12) : 0;

    // Kept low on purpose: a tall box trailer would hide the whole world.
    addBox(x, ty + 0.78 - sag, z, 1.15, 0.14, 2.5, [72, 76, 86], yaw, tp);
    addBox(x, ty + 1.28 - sag, z, 1.12, 0.42, 2.45, [236, 198, 80], yaw, tp);
    addBox(x, ty + 1.74 - sag, z, 1.18, 0.06, 2.55, [252, 226, 130], yaw, tp);

    const tongue = at(0, TONGUE - 0.4);
    addBox(tongue[0], ty + 0.6 - Math.sin(tp) * (TONGUE - 0.4), tongue[1], 0.14, 0.12, 0.9, [92, 96, 104], yaw, tp);
    const ring = at(0, TONGUE);
    addCylinder(ring[0], ty + 0.52 - Math.sin(tp) * TONGUE, ring[1], 0.2, 0.24, [232, 196, 72], 6);

    for (const side of [-1, 1]) {
      for (const along of [-1.5, -0.5]) {
        const wheel = at(side * 1.18, along);
        addBox(wheel[0], ty + 0.45 - Math.sin(tp) * along, wheel[1], 0.18, 0.45, 0.45, WHEEL, yaw);
      }
    }

    // Collected coins pile up in the bed, growing in visible layers.
    if (trailer.hooked && coinsCollected > 0) {
      const shown = Math.min(coinsCollected, 20);
      for (let i = 0; i < shown; i += 1) {
        const col = i % 8;
        const layer = Math.floor(i / 8);
        const lx = -0.75 + (col % 4) * 0.5;
        const lz = -1.7 + Math.floor(col / 4) * 1.2;
        const p = at(lx, lz);
        addCoin(
          p[0],
          ty + 1.0 - sag + layer * 0.15 - Math.sin(tp) * lz,
          p[1],
          0.22,
          0.06,
          performance.now() / 500 + i,
          [252, 210, 60],
          [214, 168, 40]
        );
      }
    }

    if (!trailer.hooked) {
      const bob = ty + 4.4 + Math.sin(performance.now() / 260) * 0.35;
      addBox(x, bob + 0.8, z, 0.18, 0.6, 0.18, [252, 220, 70]);
      addPyramid(x, bob + 0.8, z, 0.6, -0.8, [252, 220, 70], 4, Math.PI / 4);
    }
  };

  const drawDebris = () => {
    for (let i = 0; i < debris.length; i += 1) {
      const d = debris[i];
      addBox(d.x, d.y, d.z, d.size, d.size * 0.8, d.size, d.color, d.yaw, d.pitch, d.roll);
    }
  };

  /* ------------------------------------------------------------- physics */

  const DEBRIS_COLORS = {
    barrel: [206, 62, 52],
    crate: [186, 138, 82],
    cone: [232, 108, 40],
    tires: [46, 46, 50],
    hay: [214, 182, 96],
    tree: [78, 142, 70],
    fence: [222, 214, 196],
    gate: [244, 196, 72],
  };

  const burst = (p, impactX, impactZ, force) => {
    const kind = KINDS[p.kind];
    const color = DEBRIS_COLORS[p.kind] || [200, 200, 200];
    for (let i = 0; i < kind.chunks; i += 1) {
      if (debris.length > 220) {
        break;
      }
      const spread = range(-2.6, 2.6);
      debris.push({
        x: p.x + range(-0.5, 0.5),
        y: range(0.3, 1.8),
        z: p.z + range(-0.5, 0.5),
        vx: impactX * force * range(0.5, 1.2) + spread,
        vy: range(3, 9),
        vz: impactZ * force * range(0.5, 1.2) + spread,
        yaw: range(0, 6.3),
        pitch: range(0, 6.3),
        roll: range(0, 6.3),
        spinY: range(-7, 7),
        spinX: range(-7, 7),
        spinZ: range(-7, 7),
        size: range(0.16, 0.4),
        color,
        life: 5,
      });
    }
  };

  const setMessage = (text, hold = 1.8) => {
    statusLabel.textContent = text;
    messageTimer = hold;
  };

  const updateScoreLabel = () => {
    scoreLabel.textContent = `Smashed: ${smashed}  ·  Coins: ${coinsCollected}  ·  ${points} pts`;
  };

  const smash = (p) => {
    const kind = KINDS[p.kind];
    p.alive = false;
    smashed += 1;
    points += kind.points;
    updateScoreLabel();
    const dirX = Math.sin(truck.yaw) * Math.sign(truck.speed || 1);
    const dirZ = Math.cos(truck.yaw) * Math.sign(truck.speed || 1);
    burst(p, dirX, dirZ, Math.min(3, Math.abs(truck.speed) * 0.25 + 0.6));
    if (p.kind === "gate") {
      setMessage(`Through the gate! +${kind.points}`);
    } else {
      setMessage(`${kind.label}! +${kind.points}`);
    }
    truck.speed *= kind.heavy ? 0.86 : 0.97;
  };

  const collectCoin = (c) => {
    c.alive = false;
    coinsCollected += 1;
    points += COIN_POINTS;
    updateScoreLabel();
    setMessage(`Coin loaded! ${coinsCollected} aboard`, 1.2);
    for (let i = 0; i < 8; i += 1) {
      debris.push({
        x: c.x,
        y: 0.6,
        z: c.z,
        vx: range(-2.2, 2.2),
        vy: range(4, 7.5),
        vz: range(-2.2, 2.2),
        yaw: range(0, 6.3),
        pitch: range(0, 6.3),
        roll: range(0, 6.3),
        spinY: range(-10, 10),
        spinX: range(-10, 10),
        spinZ: range(-10, 10),
        size: range(0.08, 0.16),
        color: [255, 214, 64],
        life: 0.6,
      });
    }
  };

  // Every way of losing the truck ends the same: scatter it, shake the
  // camera, hold a message, and start over. Only the colours differ.
  const wreckTruck = (x, z, message, palette, tint, lift) => {
    if (state !== "playing") {
      return;
    }
    state = "exploding";
    explosionTimer = 1.7;
    deathTint = tint;
    truck.speed = 0;
    input.dragging = false;
    keys.clear();
    setMessage(message, 999);
    for (let i = 0; i < 46; i += 1) {
      const ang = range(0, Math.PI * 2);
      const spd = range(4, 15);
      debris.push({
        x,
        y: groundHeight(x, z) + range(0.3, 1.4),
        z,
        vx: Math.cos(ang) * spd,
        vy: range(6, 15) * lift,
        vz: Math.sin(ang) * spd,
        yaw: range(0, 6.3),
        pitch: range(0, 6.3),
        roll: range(0, 6.3),
        spinY: range(-12, 12),
        spinX: range(-12, 12),
        spinZ: range(-12, 12),
        size: range(0.16, 0.5),
        color: palette[Math.floor(random() * palette.length)],
        life: range(0.9, 1.6),
      });
    }
  };

  const explodeTruck = (x, z) =>
    wreckTruck(
      x,
      z,
      "BOOM! You hit TNT -- starting over.",
      [[250, 140, 40], [60, 58, 56]],
      [255, 120, 40],
      1
    );

  // Squashed pieces stay low and dusty instead of blowing skyward.
  const squashTruck = (x, z, kicked) =>
    wreckTruck(
      x,
      z,
      kicked
        ? "PUNT! The giant kicked you into next week."
        : "SPLAT! The giant stepped on you.",
      [[222, 70, 58], [64, 66, 74], [152, 142, 118]],
      [140, 122, 96],
      kicked ? 1.3 : 0.35
    );

  const hitBodies = () => {
    // A few circles along the truck (and trailer) approximate their footprint.
    const bodies = [];
    const s = Math.sin(truck.yaw);
    const c = Math.cos(truck.yaw);
    bodies.push([truck.x + s * 1.6, truck.z + c * 1.6, 1.4]);
    bodies.push([truck.x, truck.z, 1.4]);
    bodies.push([truck.x - s * 1.6, truck.z - c * 1.6, 1.4]);
    if (trailer.hooked) {
      const ts = Math.sin(trailer.yaw);
      const tc = Math.cos(trailer.yaw);
      bodies.push([trailer.x + ts * 1.8, trailer.z + tc * 1.8, 1.5]);
      bodies.push([trailer.x, trailer.z, 1.5]);
      bodies.push([trailer.x - ts * 1.8, trailer.z - tc * 1.8, 1.5]);
    }
    return bodies;
  };

  const updateCollisions = () => {
    const bodies = hitBodies();
    for (let i = 0; i < props.length; i += 1) {
      const p = props[i];
      if (!p.alive) {
        continue;
      }
      // Out in the hills things can be well above or below you without being
      // anywhere near you.
      if (Math.abs(p.y - truck.y) > 4) {
        continue;
      }
      const reach = KINDS[p.kind].radius;
      for (let b = 0; b < bodies.length; b += 1) {
        const body = bodies[b];
        const dx = p.x - body[0];
        const dz = p.z - body[1];
        if (dx * dx + dz * dz < (reach + body[2]) * (reach + body[2])) {
          smash(p);
          break;
        }
      }
    }
  };

  /*
    The crate is the whole trick. It shrugs off a gentle bump -- which is what
    makes people back up and try again -- and only when you hit it properly
    does it come apart and leave a hole in the ground where it was standing.
  */
  const openTunnel = () => {
    crate.alive = false;
    tunnel.open = true;
    points += 200;
    updateScoreLabel();
    setMessage("The crate was sitting on a HOLE. Drive in!", 5);
    for (let i = 0; i < 60; i += 1) {
      const ang = range(0, Math.PI * 2);
      const spd = range(3, 14);
      debris.push({
        x: crate.x + range(-2, 2),
        y: range(0.4, 6),
        z: crate.z + range(-2, 2),
        vx: Math.cos(ang) * spd,
        vy: range(5, 16),
        vz: Math.sin(ang) * spd,
        yaw: range(0, 6.3),
        pitch: range(0, 6.3),
        roll: range(0, 6.3),
        spinY: range(-12, 12),
        spinX: range(-12, 12),
        spinZ: range(-12, 12),
        size: range(0.18, 0.55),
        color: random() > 0.62 ? [250, 150, 45] : [156, 112, 62],
        life: range(1.1, 2.2),
      });
    }
  };

  const updateCrate = (dt) => {
    if (crate.shake > 0) {
      crate.shake = Math.max(0, crate.shake - dt * 2.2);
    }
    if (!crate.alive) {
      return;
    }
    const bodies = hitBodies();
    for (let b = 0; b < bodies.length; b += 1) {
      const body = bodies[b];
      const dx = crate.x - body[0];
      const dz = crate.z - body[1];
      const reach = CRATE_RADIUS + body[2];
      if (dx * dx + dz * dz >= reach * reach) {
        continue;
      }
      if (Math.abs(truck.speed) >= CRATE_SPEED) {
        openTunnel();
      } else {
        // Bounce off and shove the truck clear, so it cannot sit inside the
        // crate grinding against it.
        const d = Math.max(0.001, Math.hypot(dx, dz));
        truck.x = crate.x - (dx / d) * reach;
        truck.z = crate.z - (dz / d) * reach;
        truck.speed = -truck.speed * 0.35;
        crate.shake = 1;
        setMessage("OOF. That crate is solid -- get a proper run-up!", 2.4);
      }
      return;
    }
  };

  const updateCoins = () => {
    if (!trailer.hooked) {
      return;
    }
    const bodies = hitBodies();
    for (let i = 0; i < coins.length; i += 1) {
      const c = coins[i];
      if (!c.alive || Math.abs(c.y - truck.y) > 4) {
        continue;
      }
      for (let b = 0; b < bodies.length; b += 1) {
        const body = bodies[b];
        const dx = c.x - body[0];
        const dz = c.z - body[1];
        const reach = 0.6 + body[2];
        if (dx * dx + dz * dz < reach * reach) {
          collectCoin(c);
          break;
        }
      }
    }
  };

  const updateTnt = () => {
    const bodies = hitBodies();
    for (let i = 0; i < tnt.length; i += 1) {
      const t = tnt[i];
      if (Math.abs(t.y - truck.y) > 3) {
        continue;
      }
      for (let b = 0; b < bodies.length; b += 1) {
        const body = bodies[b];
        const dx = t.x - body[0];
        const dz = t.z - body[1];
        const reach = 0.8 + body[2];
        if (dx * dx + dz * dz < reach * reach) {
          explodeTruck(t.x, t.z);
          return;
        }
      }
    }
  };

  const updateTruck = (dt) => {
    // Coins loaded in the trailer make the truck noticeably harder to drive:
    // less accel, lower top speed, mushier steering.
    const cargoLoad = trailer.hooked ? cargoLoadFor(coinsCollected) : 0;
    truck.cargoLoad = cargoLoad;
    const ACCEL = 18 * (1 - cargoLoad * 0.55);
    const MAX_FWD = (trailer.hooked ? 22 : 26) * (1 - cargoLoad * 0.3);
    const MAX_REV = 9 * (1 - cargoLoad * 0.25);
    const throttle = input.throttle;
    const steer = input.steer;

    if (throttle > 0.02) {
      truck.speed += ACCEL * throttle * dt * (truck.speed < 0 ? 2.2 : 1);
    } else if (throttle < -0.02) {
      truck.speed += ACCEL * throttle * dt * (truck.speed > 0 ? 2.2 : 0.7);
    } else {
      truck.speed -= truck.speed * 1.4 * dt;
    }
    truck.speed -= truck.speed * Math.abs(truck.speed) * (0.008 + cargoLoad * 0.01) * dt;
    truck.speed = clamp(truck.speed, -MAX_REV, MAX_FWD);
    if (Math.abs(truck.speed) < 0.05) {
      truck.speed = 0;
    }

    truck.steerAngle = lerp(truck.steerAngle, -steer * 0.5, 1 - Math.pow(0.001, dt));

    const grip = clamp(Math.abs(truck.speed) / 6, 0, 1);
    const turn =
      steer * 2.0 * grip * dt * (truck.speed < 0 ? -1 : 1) *
      (trailer.hooked ? 0.85 - cargoLoad * 0.35 : 1) *
      (truck.airborne ? 0.3 : 1);
    truck.yaw = wrapAngle(truck.yaw + turn);

    truck.x += Math.sin(truck.yaw) * truck.speed * dt;
    truck.z += Math.cos(truck.yaw) * truck.speed * dt;

    /*
      The fence is a hard wall from whichever side you are on, and the only
      hole in it is the tunnel. `outside` is only ever re-decided while the
      truck is down in the cut, so popping out the far end is what actually
      moves you into the big world -- you cannot cheat over the top.
    */
    const corridor = inTrench(truck.x, truck.z);
    const dist = Math.hypot(truck.x, truck.z);
    if (corridor) {
      truck.outside = dist > ARENA + 2.5;
      if (truck.outside && !escaped) {
        escaped = true;
        points += 500;
        updateScoreLabel();
        setMessage("You're OUT. Go and see how big this place is. +500", 5);
      }
      // Walls of the cut: once you are properly down in it you stay in it.
      if (truck.y < -1.0) {
        const s = tunnelS(truck.x, truck.z);
        const t = tunnelT(truck.x, truck.z);
        const limit = tunnel.hw - 1.15;
        if (Math.abs(t) > limit) {
          const fixed = tunnelXZ(s, Math.sign(t) * limit);
          truck.x = fixed[0];
          truck.z = fixed[1];
          truck.speed *= 0.86;
        }
      }
    } else if (!truck.outside && dist > ARENA) {
      truck.x = (truck.x / dist) * ARENA;
      truck.z = (truck.z / dist) * ARENA;
      truck.speed *= 0.5;
    } else if (truck.outside && dist < ARENA + 4) {
      truck.x = (truck.x / dist) * (ARENA + 4);
      truck.z = (truck.z / dist) * (ARENA + 4);
      truck.speed *= 0.5;
    }

    /* ------------------------------------------------------------ up/down */

    const ground = groundHeight(truck.x, truck.z);
    // Rate the ground under the truck is rising, measured between frames. On
    // the way up a hill this is the truck's real vertical speed, and carrying
    // it over the crest is what launches the truck instead of gluing it to
    // the far side.
    const climb = clamp((ground - truck.lastGround) / Math.max(dt, 0.0001), -60, 30);
    truck.lastGround = ground;

    truck.vy -= GRAVITY * dt;
    truck.y += truck.vy * dt;
    if (truck.y <= ground + 0.02) {
      if (truck.airborne && truck.vy < -6) {
        const impact = -truck.vy;
        truck.bodyPitch -= clamp(impact * 0.006, 0, 0.14);
        truck.speed *= impact > 22 ? 0.7 : 0.92;
        if (truck.airTime > 0.55) {
          const award = Math.round(truck.airTime * 60);
          points += award;
          if (truck.airTime > bestAir) {
            bestAir = truck.airTime;
          }
          setMessage(
            `${truck.airTime.toFixed(1)}s of air! +${award}`,
            1.6
          );
          updateScoreLabel();
        }
        for (let i = 0; i < 8; i += 1) {
          debris.push({
            x: truck.x + range(-1.2, 1.2),
            y: ground + 0.2,
            z: truck.z + range(-1.2, 1.2),
            vx: range(-3, 3),
            vy: range(1, 4),
            vz: range(-3, 3),
            yaw: range(0, 6.3),
            pitch: range(0, 6.3),
            roll: range(0, 6.3),
            spinY: range(-6, 6),
            spinX: range(-6, 6),
            spinZ: range(-6, 6),
            size: range(0.1, 0.22),
            color: [176, 168, 140],
            life: 0.5,
          });
        }
      }
      truck.y = ground;
      truck.vy = Math.max(climb, 0);
      truck.airborne = false;
      truck.airTime = 0;
    } else {
      truck.airborne = true;
      truck.airTime += dt;
    }
    // Never let the truck climb through the roof of the tunnel.
    const ceiling = lidCeiling(truck.x, truck.z);
    if (ceiling !== null && truck.y > ceiling - 2.1) {
      truck.y = ceiling - 2.1;
      if (truck.vy > 0) {
        truck.vy = 0;
      }
    }

    // Gravity pulling along the slope, so climbing a mountain costs you and
    // dropping off one is free speed.
    const probe = 2.4;
    const fx = Math.sin(truck.yaw) * probe;
    const fz = Math.cos(truck.yaw) * probe;
    const ahead = groundHeight(truck.x + fx, truck.z + fz);
    const behind = groundHeight(truck.x - fx, truck.z - fz);
    const grade = (ahead - behind) / (probe * 2);
    if (!truck.airborne) {
      truck.speed -= clamp(grade, -1.2, 1.2) * 15 * dt;
    }

    // Sit the body on the slope.
    const rx = Math.cos(truck.yaw) * probe;
    const rz = -Math.sin(truck.yaw) * probe;
    const left = groundHeight(truck.x - rx, truck.z - rz);
    const right = groundHeight(truck.x + rx, truck.z + rz);
    const wantPitch = truck.airborne ? 0 : Math.atan(grade);
    const wantRoll = truck.airborne ? 0 : Math.atan((right - left) / (probe * 2));
    const settle = 1 - Math.pow(0.0008, dt);
    truck.groundPitch = lerp(truck.groundPitch, clamp(wantPitch, -0.9, 0.9), settle);
    truck.groundRoll = lerp(truck.groundRoll, clamp(wantRoll, -0.7, 0.7), settle);

    // Cheap suspension: squat under acceleration, lean into turns, and sag a
    // little more under a heavy trailer.
    const targetPitch = clamp(-truck.speed * 0.004 - turn * 0, -0.08, 0.08) - cargoLoad * 0.04;
    truck.bodyPitch = lerp(truck.bodyPitch, targetPitch, 1 - Math.pow(0.02, dt));
    truck.bodyRoll = lerp(truck.bodyRoll, clamp(turn * 6, -0.09, 0.09), 1 - Math.pow(0.02, dt));
  };

  const dropTrailer = () => {
    if (!trailer.hooked) {
      return;
    }
    trailer.hooked = false;
    hookArmed = false;
    unhookButton.hidden = true;
    setMessage("Trailer dropped.");
  };

  // Sit the trailer on whatever it is standing over, and tip it along its own
  // length so it does not float nose-up on a hillside.
  const settleTrailer = (dt) => {
    const here = groundHeight(trailer.x, trailer.z);
    const want =
      trailer.hooked && truck.airborne ? Math.max(here, truck.y - 0.5) : here;
    const ease = 1 - Math.pow(0.0005, dt);
    // Settling downward is smoothed like suspension, but rising ground pushes
    // the trailer up immediately -- otherwise it lags a metre into a hillside
    // on the way up a mountain.
    trailer.y = Math.max(lerp(trailer.y, want, ease), here);
    const nose = groundHeight(
      trailer.x + Math.sin(trailer.yaw) * 2.2,
      trailer.z + Math.cos(trailer.yaw) * 2.2
    );
    const tail = groundHeight(
      trailer.x - Math.sin(trailer.yaw) * 2.2,
      trailer.z - Math.cos(trailer.yaw) * 2.2
    );
    trailer.pitch = lerp(
      trailer.pitch,
      truck.airborne ? 0 : clamp(Math.atan((nose - tail) / 4.4), -0.8, 0.8),
      ease
    );
  };

  const updateTrailer = () => {
    const hitch = hitchPoint();
    if (!trailer.hooked) {
      const coupling = couplingPoint();
      const d = Math.hypot(hitch[0] - coupling[0], hitch[1] - coupling[1]);
      // A dropped trailer cannot be picked up again until the truck has
      // actually pulled away from it.
      if (!hookArmed) {
        if (d > 7) {
          hookArmed = true;
        }
        return;
      }
      // Backing the hitch on is the satisfying way, but a magnetic hitch
      // means nobody gets stuck circling the trailer forever: come at it from
      // any side and the trailer swings into place behind the truck.
      const nose = Math.hypot(truck.x - coupling[0], truck.z - coupling[1]);
      if (d < 3 || nose < 4.5) {
        trailer.hooked = true;
        hookedOnce = true;
        trailer.yaw = truck.yaw;
        trailer.x = hitch[0] - Math.sin(truck.yaw) * TONGUE;
        trailer.z = hitch[1] - Math.cos(truck.yaw) * TONGUE;
        unhookButton.hidden = false;
        setMessage("Hooked up! Now go smash stuff.", 3);
      }
      return;
    }
    // The trailer's nose is pinned to the hitch; the box trails behind it.
    let yaw = Math.atan2(hitch[0] - trailer.x, hitch[1] - trailer.z);
    const rel = clamp(wrapAngle(yaw - truck.yaw), -1.35, 1.35);
    yaw = wrapAngle(truck.yaw + rel);
    trailer.yaw = yaw;
    trailer.x = hitch[0] - Math.sin(yaw) * TONGUE;
    trailer.z = hitch[1] - Math.cos(yaw) * TONGUE;
  };

  // Quietly stand smashed props back up once they are well out of sight, so
  // the field never runs out of things to flatten.
  /*
    The crate is meant to be found, not stumbled on by accident and not
    spelled out either. If somebody has been driving around a while without
    touching it, the status line starts muttering about it.
  */
  const updateHint = (dt) => {
    if (tunnel.open || !hookedOnce) {
      return;
    }
    hintTimer += dt;
    if (hintTimer < 42 || messageTimer > 0) {
      return;
    }
    hintTimer = 0;
    const dist = Math.hypot(truck.x - crate.x, truck.z - crate.z);
    setMessage(
      dist < 30
        ? "That big striped crate sounds hollow..."
        : "There is one crate out there far too big to be a crate.",
      4
    );
  };

  const updateRespawn = (dt) => {
    respawnTimer -= dt;
    if (respawnTimer > 0) {
      return;
    }
    respawnTimer = 2.5;
    const far = [];
    for (let i = 0; i < props.length; i += 1) {
      const p = props[i];
      if (!p.alive && Math.hypot(p.x - truck.x, p.z - truck.z) > 50) {
        far.push(p);
      }
    }
    if (far.length) {
      far[Math.floor(Math.random() * far.length)].alive = true;
    }
  };

  const updateDebris = (dt) => {
    for (let i = debris.length - 1; i >= 0; i -= 1) {
      const d = debris[i];
      d.life -= dt;
      if (d.life <= 0) {
        debris.splice(i, 1);
        continue;
      }
      d.vy -= 26 * dt;
      d.x += d.vx * dt;
      d.y += d.vy * dt;
      d.z += d.vz * dt;
      d.yaw += d.spinY * dt;
      d.pitch += d.spinX * dt;
      d.roll += d.spinZ * dt;
      const floor = groundHeight(d.x, d.z) + d.size * 0.8;
      if (d.y < floor) {
        d.y = floor;
        d.vy *= -0.34;
        d.vx *= 0.7;
        d.vz *= 0.7;
        d.spinY *= 0.6;
        d.spinX *= 0.6;
        d.spinZ *= 0.6;
        if (Math.abs(d.vy) < 1.2) {
          d.vy = 0;
        }
      }
    }
  };

  const updateCamera = (dt) => {
    // Hooked up, the camera has to clear the trailer, so it backs off and
    // climbs -- otherwise the trailer is all you can see. Down in the cut it
    // has to do the opposite and tuck right in behind, or it ends up buried
    // in a wall looking at dirt.
    const underground = truck.y < -0.9;
    const back = underground ? 8.5 : trailer.hooked ? 17 : 11;
    const height = underground ? 2.6 : trailer.hooked ? 7.2 : 5;
    const follow = 1 - Math.pow(0.0009, dt);
    cam.yaw = wrapAngle(cam.yaw + wrapAngle(truck.yaw - cam.yaw) * follow);

    const targetX = truck.x - Math.sin(cam.yaw) * back;
    const targetZ = truck.z - Math.cos(cam.yaw) * back;
    const move = 1 - Math.pow(0.0001, dt);
    cam.x = lerp(cam.x, targetX, move);
    cam.z = lerp(cam.z, targetZ, move);
    cam.y = lerp(cam.y, truck.y + height, move);

    // Never let the camera end up inside a hill, or above the tunnel roof.
    const under = groundHeight(cam.x, cam.z) + 2.2;
    if (cam.y < under) {
      cam.y = under;
    }
    const roof = lidCeiling(cam.x, cam.z);
    if (roof !== null && cam.y > roof - 0.5) {
      cam.y = roof - 0.5;
    }

    // Aim a little ahead of the truck so you can see what you are about to hit.
    const lookX = truck.x + Math.sin(truck.yaw) * 5;
    const lookZ = truck.z + Math.cos(truck.yaw) * 5;
    const flat = Math.max(1, Math.hypot(lookX - cam.x, lookZ - cam.z));
    cam.pitch = Math.atan2(cam.y - (truck.y + 1.4), flat);

    /*
      The giant is 60 metres tall, so at any range you would actually meet him
      his head sits well above the top of the frame. When he is close and
      roughly ahead, the camera cranes up to take him in -- the truck slides
      toward the bottom of the screen but never off it.
    */
    const gdx = giant.x - cam.x;
    const gdz = giant.z - cam.z;
    const gdist = Math.hypot(gdx, gdz);
    const gAngle = Math.abs(wrapAngle(Math.atan2(gdx, gdz) - cam.yaw));
    let craneTarget = 0;
    if (gAngle < 1.05) {
      // Exactly enough tilt to bring his hair to the top edge of the frame,
      // capped so the truck never slides off the bottom.
      const headAngle = Math.atan2(G_HEAD_Y + G_HEAD_HY + 2 - cam.y, Math.max(20, gdist));
      const needed = cam.pitch + headAngle - FOV / 2;
      craneTarget =
        clamp(needed, 0, 0.44) *
        clamp((1.05 - gAngle) / 0.5, 0, 1) *
        clamp((155 - gdist) / 35, 0, 1);
    }
    crane = lerp(crane, craneTarget, 1 - Math.pow(0.08, dt));
    cam.pitch -= crane;

    // Footfalls rattle the camera.
    if (shake > 0) {
      shake = Math.max(0, shake - dt * 1.9);
      const t = performance.now() / 1000;
      cam.x += Math.sin(t * 46) * shake * 0.55;
      cam.y += Math.sin(t * 61) * shake * 0.45;
      cam.z += Math.cos(t * 39) * shake * 0.55;
    }

    if (state === "exploding") {
      const t = performance.now() / 1000;
      const mag = explosionTimer * 0.9;
      cam.x += Math.sin(t * 37) * mag * 0.4 + Math.sin(t * 53 + 1) * mag * 0.2;
      cam.z += Math.cos(t * 41) * mag * 0.4 + Math.cos(t * 59 + 2) * mag * 0.2;
    }
    updateCamBasis();
  };

  /* --------------------------------------------------------------- input */

  const input = { throttle: 0, steer: 0, dragging: false, ox: 0, oy: 0, cx: 0, cy: 0 };
  const keys = new Set();

  const canvasPoint = (event) => {
    const rect = canvas.getBoundingClientRect();
    return [
      ((event.clientX - rect.left) / rect.width) * W,
      ((event.clientY - rect.top) / rect.height) * H,
    ];
  };

  const DEAD_ZONE = 10;
  const FULL_DRAG = 90;

  const readInput = () => {
    let throttle = 0;
    let steer = 0;
    if (input.dragging) {
      const dx = input.cx - input.ox;
      const dy = input.cy - input.oy;
      const mag = Math.hypot(dx, dy);
      if (mag > DEAD_ZONE) {
        throttle = clamp(-dy / FULL_DRAG, -1, 1);
        steer = clamp(dx / FULL_DRAG, -1, 1);
      }
    }
    if (keys.has("ArrowUp") || keys.has("w")) throttle = 1;
    if (keys.has("ArrowDown") || keys.has("s")) throttle = -1;
    if (keys.has("ArrowLeft") || keys.has("a")) steer = -1;
    if (keys.has("ArrowRight") || keys.has("d")) steer = 1;
    input.throttle = throttle;
    input.steer = steer;
  };

  const onPointerDown = (event) => {
    event.preventDefault();
    const [x, y] = canvasPoint(event);
    input.dragging = true;
    input.ox = x;
    input.oy = y;
    input.cx = x;
    input.cy = y;
  };

  const onPointerMove = (event) => {
    if (!input.dragging) {
      return;
    }
    event.preventDefault();
    const [x, y] = canvasPoint(event);
    input.cx = x;
    input.cy = y;
  };

  const onPointerUp = () => {
    input.dragging = false;
  };

  /* ----------------------------------------------------------------- HUD */

  const drawStick = () => {
    if (!input.dragging) {
      return;
    }
    const dx = clamp(input.cx - input.ox, -FULL_DRAG, FULL_DRAG);
    const dy = clamp(input.cy - input.oy, -FULL_DRAG, FULL_DRAG);
    ctx.save();
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(255,255,255,0.55)";
    ctx.beginPath();
    ctx.arc(input.ox, input.oy, FULL_DRAG * 0.8, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(input.ox, input.oy);
    ctx.lineTo(input.ox + dx, input.oy + dy);
    ctx.stroke();
    ctx.fillStyle = "rgba(255,255,255,0.75)";
    ctx.beginPath();
    ctx.arc(input.ox + dx, input.oy + dy, 16, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  };

  const drawHud = () => {
    ctx.save();
    ctx.font = "600 18px 'Trebuchet MS', sans-serif";
    ctx.textBaseline = "top";

    const speed = Math.round(Math.abs(truck.speed) * 3.2);
    ctx.fillStyle = "rgba(0,0,0,0.45)";
    ctx.fillRect(12, 12, 168, 34);
    ctx.fillStyle = "#fff";
    ctx.fillText(`${speed} mph`, 24, 20);

    if (!trailer.hooked) {
      const d = Math.round(Math.hypot(trailer.x - truck.x, trailer.z - truck.z));
      const text = `Trailer: ${d} m away`;
      const w = ctx.measureText(text).width + 24;
      ctx.fillStyle = "rgba(0,0,0,0.45)";
      ctx.fillRect(W - w - 12, 12, w, 34);
      ctx.fillStyle = "#ffe14a";
      ctx.fillText(text, W - w, 20);

      // Off-screen chevron pointing at the trailer.
      const angle = wrapAngle(Math.atan2(trailer.x - cam.x, trailer.z - cam.z) - cam.yaw);
      if (Math.abs(angle) > 0.5) {
        const side = angle > 0 ? 1 : -1;
        const x = W / 2 + side * (W / 2 - 44);
        const y = H / 2;
        ctx.fillStyle = "#ffe14a";
        ctx.beginPath();
        ctx.moveTo(x + side * 20, y);
        ctx.lineTo(x - side * 14, y - 22);
        ctx.lineTo(x - side * 14, y + 22);
        ctx.closePath();
        ctx.fill();
      }
    } else if (coinsCollected > 0) {
      const text = `Coins aboard: ${coinsCollected}`;
      const w = ctx.measureText(text).width + 24;
      ctx.fillStyle = "rgba(0,0,0,0.45)";
      ctx.fillRect(W - w - 12, 12, w, 34);
      ctx.fillStyle = "#ffe14a";
      ctx.fillText(text, W - w, 20);
    }

    // Out past the fence there is no fence to navigate by, so say how far out
    // you are and how high you have climbed, and point the way back.
    if (truck.outside) {
      const out = Math.round(Math.hypot(truck.x, truck.z));
      const text = `${out} m out  ·  ${Math.round(truck.y)} m up`;
      const w = ctx.measureText(text).width + 24;
      ctx.fillStyle = "rgba(0,0,0,0.45)";
      ctx.fillRect(12, 52, w, 34);
      ctx.fillStyle = "#bfe6ff";
      ctx.fillText(text, 24, 60);

      const exit = tunnelXZ(tunnel.sEnd + 2, 0);
      const angle = wrapAngle(Math.atan2(exit[0] - cam.x, exit[1] - cam.z) - cam.yaw);
      if (Math.abs(angle) > 0.6) {
        const side = angle > 0 ? 1 : -1;
        const x = W / 2 + side * (W / 2 - 44);
        const y = H / 2 + 74;
        ctx.fillStyle = "rgba(160,220,255,0.8)";
        ctx.beginPath();
        ctx.moveTo(x + side * 16, y);
        ctx.lineTo(x - side * 11, y - 17);
        ctx.lineTo(x - side * 11, y + 17);
        ctx.closePath();
        ctx.fill();
      }
    }

    if (truck.airborne && truck.airTime > 0.5) {
      ctx.font = "700 30px 'Trebuchet MS', sans-serif";
      const text = `AIR!  ${truck.airTime.toFixed(1)}s`;
      const w = ctx.measureText(text).width;
      ctx.fillStyle = "rgba(0,0,0,0.35)";
      ctx.fillRect(W / 2 - w / 2 - 14, H / 2 - 96, w + 28, 44);
      ctx.fillStyle = "#ffe14a";
      ctx.fillText(text, W / 2 - w / 2, H / 2 - 86);
      ctx.font = "600 18px 'Trebuchet MS', sans-serif";
    }

    // Giant warning: he is easy to miss when all you can see is a leg. He
    // cannot leave the field, so it is only worth saying while you are in it.
    const gDist = Math.hypot(giant.x - truck.x, giant.z - truck.z);
    if (!truck.outside && gDist < 62) {
      const near = gDist < 26;
      const text = near ? "GIANT ON TOP OF YOU!" : "Giant nearby";
      const w = ctx.measureText(text).width + 24;
      ctx.fillStyle = near ? "rgba(150,20,16,0.72)" : "rgba(0,0,0,0.45)";
      ctx.fillRect(W / 2 - w / 2, 12, w, 34);
      ctx.fillStyle = near && Math.floor(performance.now() / 220) % 2 ? "#ffd8d2" : "#ff6a58";
      ctx.fillText(text, W / 2 - w / 2 + 12, 20);

      const angle = wrapAngle(Math.atan2(giant.x - cam.x, giant.z - cam.z) - cam.yaw);
      if (Math.abs(angle) > 0.5) {
        const side = angle > 0 ? 1 : -1;
        const x = W / 2 + side * (W / 2 - 44);
        const y = H / 2 - 74;
        ctx.fillStyle = "#ff6a58";
        ctx.beginPath();
        ctx.moveTo(x + side * 20, y);
        ctx.lineTo(x - side * 14, y - 22);
        ctx.lineTo(x - side * 14, y + 22);
        ctx.closePath();
        ctx.fill();
      }
    }

    if (!input.dragging && !keys.size) {
      const hint = hookedOnce
        ? "Drag up to go, down to reverse, left and right to steer"
        : "Press and drag to drive. Go find the yellow trailer!";
      ctx.font = "600 20px 'Trebuchet MS', sans-serif";
      const w = ctx.measureText(hint).width;
      ctx.fillStyle = "rgba(0,0,0,0.45)";
      ctx.fillRect(W / 2 - w / 2 - 14, H - 56, w + 28, 36);
      ctx.fillStyle = "#fff";
      ctx.fillText(hint, W / 2 - w / 2, H - 48);
    }
    ctx.restore();
  };

  /* ---------------------------------------------------------------- loop */

  let running = false;
  let frameId = null;
  let lastTime = 0;

  const frame = (now) => {
    const dt = Math.min(0.05, (now - lastTime) / 1000) || 0.016;
    lastTime = now;

    readInput();
    if (state === "playing") {
      updateTruck(dt);
      updateTrailer();
      settleTrailer(dt);
      updateCrate(dt);
      updateCollisions();
      updateCoins();
      updateTnt();
      updateHint(dt);
    } else if (state === "exploding") {
      explosionTimer -= dt;
      const shake = clamp(explosionTimer, 0, 1);
      truck.bodyRoll = Math.sin(now / 40) * 0.18 * shake;
      truck.bodyPitch = Math.cos(now / 55) * 0.14 * shake;
      if (explosionTimer <= 0) {
        resetGame();
      }
    }
    updateGiant(dt);
    updateRespawn(dt);
    updateDebris(dt);
    updateCamera(dt);

    if (messageTimer > 0) {
      messageTimer -= dt;
      if (messageTimer <= 0) {
        statusLabel.textContent = truck.outside
          ? "Head for the mountains. Jump off something."
          : trailer.hooked
          ? "Smash everything!"
          : "Find the trailer and hook it up.";
      }
    }

    drawSky();
    drawGround();
    drawTerrainRelief();
    drawTrench();
    drawBoundary();
    // The world outside the fence is far bigger than the field, so nothing is
    // handed to the renderer unless it is close enough to matter.
    for (let i = 0; i < props.length; i += 1) {
      const p = props[i];
      if (!p.alive) {
        continue;
      }
      const dx = p.x - cam.x;
      const dz = p.z - cam.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > 215 * 215) {
        continue;
      }
      if (d2 > FAR_PROP * FAR_PROP) {
        drawPropFar(p);
      } else {
        drawProp(p);
      }
    }
    // A spinning coin is 12 polygons and reads as a yellow speck past about a
    // hundred metres, so it is not worth drawing further out than that.
    for (let i = 0; i < coins.length; i += 1) {
      const c = coins[i];
      if (c.alive && Math.abs(c.x - cam.x) < 100 && Math.abs(c.z - cam.z) < 100) {
        drawCoin(c);
      }
    }
    for (let i = 0; i < tnt.length; i += 1) {
      const t = tnt[i];
      if (Math.abs(t.x - cam.x) < 150 && Math.abs(t.z - cam.z) < 150) {
        drawTnt(t);
      }
    }
    drawCrate();
    drawDebris();
    drawTrailer();
    drawTruck();
    drawGiant();
    flushPolys();

    // Underground it should feel underground.
    const roofed = lidCeiling(cam.x, cam.z) !== null;
    const gloom = clamp(-truck.y / tunnel.depth, 0, 1) * (roofed ? 0.6 : 0.26);
    if (gloom > 0.01) {
      ctx.fillStyle = `rgba(10, 9, 14, ${gloom})`;
      ctx.fillRect(0, 0, W, H);
    }

    if (state === "exploding") {
      const alpha = clamp(explosionTimer / 1.7, 0, 1);
      ctx.fillStyle = `rgba(${deathTint[0]}, ${deathTint[1]}, ${deathTint[2]}, ${0.35 * alpha})`;
      ctx.fillRect(0, 0, W, H);
    }

    drawStick();
    drawHud();

    frameId = requestAnimationFrame(frame);
  };

  /* -------------------------------------------------------- modal wiring */

  const resetGame = () => {
    setSeed(Date.now());
    buildWorld();
    resetGiant();
    truck.x = 0;
    truck.y = 0;
    truck.z = 0;
    truck.vy = 0;
    truck.yaw = 0;
    truck.speed = 0;
    truck.steerAngle = 0;
    truck.bodyPitch = 0;
    truck.bodyRoll = 0;
    truck.groundPitch = 0;
    truck.groundRoll = 0;
    truck.cargoLoad = 0;
    truck.airborne = false;
    truck.airTime = 0;
    truck.outside = false;
    truck.lastGround = 0;
    cam.x = 0;
    cam.y = 5;
    cam.z = -11;
    cam.yaw = 0;
    smashed = 0;
    points = 0;
    coinsCollected = 0;
    hookedOnce = false;
    messageTimer = 0;
    hookArmed = true;
    respawnTimer = 0;
    state = "playing";
    explosionTimer = 0;
    escaped = false;
    hintTimer = 0;
    bestAir = 0;
    input.dragging = false;
    keys.clear();
    updateScoreLabel();
    statusLabel.textContent = "Find the trailer and hook it up.";
    unhookButton.hidden = true;
    updateCamBasis();
  };

  const openGame = () => {
    if (running) {
      return;
    }
    running = true;
    fitCanvas();
    modal.setAttribute("aria-hidden", "false");
    modal.classList.add("is-visible");
    launchButton.classList.add("is-hidden");
    resetGame();
    lastTime = performance.now();
    frameId = requestAnimationFrame(frame);
  };

  const closeGame = () => {
    if (!running) {
      return;
    }
    running = false;
    modal.setAttribute("aria-hidden", "true");
    modal.classList.remove("is-visible");
    launchButton.classList.remove("is-hidden");
    input.dragging = false;
    keys.clear();
    if (frameId) {
      cancelAnimationFrame(frameId);
      frameId = null;
    }
  };

  // Move and release listen on the window so a drag that wanders off the
  // canvas keeps steering, and letting go anywhere always stops the truck.
  canvas.addEventListener("pointerdown", onPointerDown);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointercancel", onPointerUp);
  canvas.addEventListener("contextmenu", (event) => event.preventDefault());
  window.addEventListener("blur", () => {
    input.dragging = false;
    keys.clear();
  });

  window.addEventListener("keydown", (event) => {
    if (!running) {
      return;
    }
    if (event.key === "Escape") {
      closeGame();
      return;
    }
    if (event.key === "u" || event.key === "U") {
      dropTrailer();
      return;
    }
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "w", "a", "s", "d"].includes(key)) {
      event.preventDefault();
      keys.add(key);
    }
  });
  window.addEventListener("keyup", (event) => {
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    keys.delete(key);
  });

  unhookButton.addEventListener("click", dropTrailer);

  launchButton.addEventListener("click", openGame);
  closeTargets.forEach((target) => target.addEventListener("click", closeGame));

  const placeLaunchButton = () => {
    const padding = 12;
    const size = launchButton.offsetWidth || 78;
    const maxX = Math.max(padding, window.innerWidth - size - padding);
    const maxY = Math.max(padding, window.innerHeight - size - padding);
    launchButton.style.transform = `translate(${Math.random() * maxX}px, ${Math.random() * maxY}px)`;
  };
  const driftLaunchButton = () => {
    placeLaunchButton();
    window.setTimeout(driftLaunchButton, 8000 + Math.random() * 5000);
  };
  window.addEventListener("resize", () => {
    placeLaunchButton();
    if (running) {
      fitCanvas();
    }
  });
  driftLaunchButton();
})();
