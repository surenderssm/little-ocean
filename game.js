/* Original procedural artwork and synthesized audio. No network or saved data. */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const canvas = $("ocean");
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    $("welcome").innerHTML = "<h1>One little hiccup</h1><p>Your browser cannot draw this ocean. Please open index.html in a modern browser.</p>";
    return;
  }
  const H = 720;
  const WORLD = 3500;
  const GOAL = WORLD - 200;
  const NEED = 12;
  const TAU = Math.PI * 2;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  const mix = (a, b, t) => a + (b - a) * t;
  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const levels = [
    { name: "Sunbeam Reef", reward: "Sunbeam explorer" },
    { name: "Coral Gardens", reward: "Coral caretaker" },
    { name: "Starlight Cove", reward: "Ocean superstar" },
  ];
  let W = 1280;
  let time = 0;
  let lastTime = 0;
  let mode = "welcome";
  let levelIndex = 0;
  let levelStartScore = 0;
  let score = 0;
  let collected = 0;
  let hearts = 5;
  let camera = 0;
  let tipSeconds = 0;
  let toastSeconds = 0;
  let collectibles = [];
  let obstacles = [];
  let secrets = [];
  let particles = [];
  let ripples = [];
  let player = {};
  let drag = null;
  let priorFocus = null;
  let hudCache = "";
  let playerScale = .82;
  let palette = {};
  const keys = new Set();
  const heldPointers = new Map();
  const bubbles = Array.from({ length: 34 }, (_, i) => ({
    x: ((i * 197 + 31) % 1297) / 1297,
    y: (i * 137 + 17) % H,
    r: 2 + i % 5,
    speed: 10 + i % 14,
  }));
  const fish = Array.from({ length: 13 }, (_, i) => ({
    x: (i * 293) % 1700, y: 145 + (i * 93) % 400,
    speed: 9 + i % 6 * 4, size: 9 + i % 4 * 3, dir: i % 2 ? 1 : -1,
  }));

  function readPalette() {
    const style = getComputedStyle(document.documentElement);
    const names = {
      top: "ocean-top", mid: "ocean-mid", deep: "ocean-deep",
      foam: "foam", ink: "ink", sand: "sand", coral: "coral", plant: "plant",
      blue: "link", rose: "accent", gold: "warning", green: "success",
    };
    // Resolve color-mix() through the browser before using Canvas gradients.
    const probe = document.createElement("span");
    probe.hidden = true;
    document.body.append(probe);
    for (const [key, name] of Object.entries(names)) {
      probe.style.color = style.getPropertyValue(`--cp-${name}`);
      palette[key] = getComputedStyle(probe).color;
    }
    probe.remove();
  }

  class OceanAudio {
    constructor() {
      this.context = null;
      this.enabled = true;
      this.nextNote = 0;
      this.note = 0;
    }
    updateButton() {
      $("sound").setAttribute("aria-label", this.enabled ? "Mute sound" : "Turn sound on");
      $("sound").title = this.enabled ? "Mute sound" : "Turn sound on";
      $("sound").setAttribute("aria-pressed", String(this.enabled));
      $("sound").querySelector("use").setAttribute("href", this.enabled ? "#i-sound" : "#i-muted");
    }
    async start() {
      if (!this.enabled) return false;
      if (!this.context) {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (!AudioContext) {
          this.enabled = false;
          this.updateButton();
          showToast("Sound isn't supported here. You can still play!");
          return false;
        }
        try {
          this.context = new AudioContext();
          this.master = this.context.createGain();
          this.master.gain.value = 0.17;
          this.master.connect(this.context.destination);
        } catch (error) {
          console.warn("Ocean audio could not start:", error);
          this.enabled = false;
          this.updateButton();
          showToast("Sound couldn't start. You can still play!");
          return false;
        }
      }
      try {
        await this.context.resume();
      } catch (error) {
        console.warn("Ocean audio could not resume:", error);
        this.enabled = false;
        this.updateButton();
        showToast("Tap sound again to try turning it on.");
        return false;
      }
      this.master.gain.setTargetAtTime(this.enabled ? 0.17 : 0, this.context.currentTime, .06);
      this.nextNote = this.context.currentTime;
      return this.enabled;
    }
    async toggle() {
      this.enabled = !this.enabled;
      this.updateButton();
      if (!this.enabled) {
        if (this.context) this.master.gain.setTargetAtTime(0, this.context.currentTime, .06);
        return;
      }
      if (await this.start()) this.effect("collect");
    }
    tone(frequency, start, duration, volume = .25, type = "sine") {
      const oscillator = this.context.createOscillator();
      const gain = this.context.createGain();
      oscillator.type = type;
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(volume, start + .025);
      gain.gain.exponentialRampToValueAtTime(.001, start + duration);
      oscillator.connect(gain);
      gain.connect(this.master);
      oscillator.start(start);
      oscillator.stop(start + duration + .02);
      oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
    }
    effect(kind) {
      if (!this.enabled || !this.context || this.context.state !== "running") return;
      const t = this.context.currentTime;
      const notes = {
        collect: [659, 988], pearl: [784, 1175, 1568], chest: [523, 659, 784, 1047],
        burst: [262, 392, 523, 784], bump: [220, 196],
        win: [523, 659, 784, 1047, 1319], secret: [587, 784, 988, 1175],
      }[kind] || [659];
      notes.forEach((f, i) => this.tone(f, t + i * .075, .32, .22));
    }
    update() {
      if (!this.enabled || !this.context || this.context.state !== "running" || mode !== "playing") return;
      const now = this.context.currentTime;
      if (this.nextNote < now) this.nextNote = now;
      const melody = [523, 659, 784, 659, 587, 0, 659, 784, 880, 784, 659, 0, 587, 659, 523, 0];
      while (this.nextNote < now + .15) {
        const pitch = melody[this.note % melody.length];
        if (pitch) this.tone(pitch, this.nextNote, 1.1, .075);
        if (this.note % 4 === 0) this.tone(this.note % 8 ? 196 : 131, this.nextNote, 1.9, .13);
        this.note++;
        this.nextNote += .48;
      }
    }
  }
  const audio = new OceanAudio();

  function resize() {
    const rect = $("stage").getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = H * rect.width / rect.height;
    playerScale = clamp(360 / rect.height, .82, 1.05);
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    ctx.setTransform(canvas.height / H, 0, 0, canvas.height / H, 0, 0);
    if (mode === "playing" || mode === "paused") {
      camera = clamp(player.x - W * .35, 0, WORLD - W);
    }
  }

  function resetInput() {
    keys.clear();
    heldPointers.clear();
    drag = null;
    document.querySelectorAll(".direction").forEach((el) => el.classList.remove("held"));
  }
  function showToast(message) {
    $("toast").textContent = message;
    $("toast").classList.add("show");
    toastSeconds = 3.2;
  }
  function setMode(next) {
    mode = next;
    window.dispatchEvent(new CustomEvent("ocean:mode", { detail: { mode: next } }));
    resetInput();
    $("welcome").hidden = next !== "welcome";
    $("blue-name").hidden = next !== "welcome";
    $("hud").hidden = next === "welcome";
    $("play-controls").hidden = next !== "playing";
    $("game-tip").hidden = next !== "playing";
    $("modal").hidden = next === "welcome" || next === "playing";
    $("toast").classList.remove("show");
    if (next === "playing") canvas.focus({ preventScroll: true });
  }

  function startGame() {
    void audio.start();
    window.dispatchEvent(new CustomEvent("ocean:adventure"));
    levelIndex = 0;
    score = 0;
    hearts = 5;
    loadLevel();
  }

  function loadLevel() {
    levelStartScore = score;
    collected = 0;
    tipSeconds = 9;
    camera = 0;
    player = { x: 150, y: 345, vx: 0, vy: 0, face: 1, tilt: 0, invincible: 2, burst: 0, cooldown: 0, happy: 0 };
    particles = [];
    ripples = [];
    collectibles = [];
    obstacles = [];
    secrets = [{ x: 1250, y: 555, found: false, hinted: false }, { x: 2610, y: 530, found: false, hinted: false }];
    for (let i = 0; i < 36; i++) {
      const x = 340 + i * 77;
      const y = 310 + Math.sin(i * .49 + levelIndex) * 157 + Math.cos(i * .83) * 32;
      const type = i % 11 === 8 ? "chest" : i % 4 === 2 ? "pearl" : "star";
      collectibles.push({ x, y, baseY: y, type, taken: false, phase: i * .7 });
    }
    for (let i = 0; i < 8 + levelIndex * 3; i++) {
      const x = 680 + i * (235 - levelIndex * 35);
      const rock = i % 3 === 2;
      obstacles.push({
        x, y: rock ? 590 : 210 + (i * 103 + levelIndex * 81) % 280,
        baseY: rock ? 590 : 210 + (i * 103 + levelIndex * 81) % 280,
        type: rock ? "rock" : "jelly", phase: i * 1.4, r: rock ? 44 : 28,
      });
    }
    $("game-tip").textContent = "Collect 12 treasures, then find the rainbow arch!";
    $("level-name").textContent = levels[levelIndex].name;
    document.querySelectorAll(".reef-stop").forEach((el, i) => {
      el.classList.toggle("active", i === levelIndex);
      el.classList.toggle("complete", i < levelIndex);
    });
    setMode("playing");
    updateHUD(true);
    $("announcement").textContent = `${levels[levelIndex].name}. Collect 12 treasures. Arrow keys to swim. Space for a bubble burst.`;
  }

  function updateHUD(force = false) {
    const cache = `${score}-${hearts}-${collected}-${Math.ceil(player.cooldown)}`;
    if (!force && hudCache === cache) return;
    hudCache = cache;
    $("score").textContent = score;
    $("collection").textContent = collected >= NEED ? "Rainbow arch unlocked!" : `${collected} / ${NEED} treasures`;
    $("quest-progress").style.width = `${Math.min(collected / NEED, 1) * 100}%`;
    $("hearts").innerHTML = Array.from({ length: 5 }, (_, i) => `<svg class="${i < hearts ? "" : "empty"}" aria-hidden="true"><use href="#i-heart"/></svg>`).join("");
    $("hearts").setAttribute("aria-label", `${hearts} out of 5 hearts`);
    $("burst").disabled = player.cooldown > 0;
    $("burst-label").textContent = player.cooldown > 0 ? `Ready in ${Math.ceil(player.cooldown)}s` : "Bubble burst";
  }

  function showModal(kind) {
    priorFocus = document.activeElement;
    setMode(kind);
    const data = {
      paused: ["\u224b", "TAKE A BREATHER", "Just floating.", "Your ocean friends will wait right here.", "Keep swimming", "Start a new adventure"],
      restart: ["\u21bb", "A FRESH LITTLE START", "Start again?", "This begins a new adventure at Sunbeam Reef. Your points will start at zero.", "Start again", "Keep swimming"],
      level: ["\u2736", "A LITTLE REEF. A BIG DISCOVERY.", "You made a splash!", `${levels[levelIndex].name} is sparkling thanks to you. Ready to see what's next?`, "Next reef", "Start a new adventure"],
      gameover: ["\u2661", "EVERY EXPLORER TAKES A BREAK", "You're doing great.", "That was a wonderful swim! Let's try this reef again with five fresh hearts.", "Try this reef again", "Start a new adventure"],
      victory: ["\u2605", "THREE REEFS. ONE AMAZING YOU.", "Ocean superstar!", "You explored the whole ocean! Blue couldn't have done it without you.", "Play again", "Back to the ocean"],
    }[kind];
    $("modal-emblem").textContent = data[0];
    $("modal-eyebrow").textContent = data[1];
    $("modal-title").textContent = data[2];
    $("modal-copy").textContent = data[3];
    $("modal-primary").firstChild.textContent = `${data[4]} `;
    $("modal-secondary").textContent = data[5];
    $("reward-row").hidden = !["level", "victory", "gameover"].includes(kind);
    $("reward-row").textContent = kind === "victory" ? `3 explorer badges  \u00b7  ${score} points` : kind === "level" ? `${levels[levelIndex].reward}  \u00b7  ${score} points` : `${score} points  \u00b7  ${collected} treasures`;
    $("modal-primary").focus({ preventScroll: true });
    $("announcement").textContent = `${data[2]} ${data[3]}`;
  }
  function resume() {
    setMode("playing");
    if (priorFocus && priorFocus !== canvas && !priorFocus.closest("[hidden]")) priorFocus.focus({ preventScroll: true });
  }
  function completeLevel() {
    score += 100;
    audio.effect("win");
    for (let i = 0; i < 65; i++) addParticle(player.x, player.y, "confetti");
    updateHUD(true);
    showModal(levelIndex === levels.length - 1 ? "victory" : "level");
    if (mode === "victory") document.querySelectorAll(".reef-stop").forEach((el) => el.classList.add("complete"));
  }
  function bubbleBurst() {
    if (mode !== "playing" || player.cooldown > 0) return;
    player.cooldown = 3.5;
    player.burst = .95;
    player.happy = 1.5;
    ripples.push({ x: player.x, y: player.y, life: .8, max: .8 });
    audio.effect("burst");
    for (let i = 0; i < 16; i++) addParticle(player.x, player.y, "bubble");
    for (const secret of secrets) {
      if (!secret.found && distance(secret, player) < 190) {
        secret.found = true;
        score += 75;
        hearts = Math.min(5, hearts + 1);
        for (let i = 0; i < 3; i++) {
          collectibles.push({ x: secret.x + (i - 1) * 47, y: secret.y - 100, baseY: secret.y - 100, type: "pearl", taken: false, phase: i });
        }
        audio.effect("secret");
        showToast("A secret pearl garden! +75 and a little love");
        for (let i = 0; i < 24; i++) addParticle(secret.x, secret.y - 20, "confetti");
      }
    }
    updateHUD();
  }

  function addParticle(x, y, kind, text = "") {
    if (particles.length >= 180) return;
    const angle = Math.random() * TAU;
    const speed = 35 + Math.random() * 130;
    particles.push({
      x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed - 35,
      life: kind === "text" ? 1.3 : .65 + Math.random() * .6,
      max: 1.3, size: 2 + Math.random() * 5, kind, text,
      color: ["gold", "foam", "coral", "plant"][Math.floor(Math.random() * 4)],
    });
  }

  function collect(item) {
    item.taken = true;
    const value = item.type === "chest" ? 50 : item.type === "pearl" ? 20 : 10;
    score += value;
    collected++;
    player.happy = 1.2;
    audio.effect(item.type === "star" ? "collect" : item.type);
    addParticle(item.x, item.y - 15, "text", `+${value}`);
    for (let i = 0; i < 9; i++) addParticle(item.x, item.y, "spark");
    if (collected === NEED) {
      showToast("Wonderful! Follow the arrow to the rainbow arch!");
      $("game-tip").textContent = "Rainbow arch unlocked! Keep swimming right.";
      tipSeconds = 10000;
    } else if (collected === 4) showToast("Look at you go, little explorer!");
    else if (collected === 8) showToast("You're making the ocean sparkle!");
  }

  function update(dt) {
    if (toastSeconds > 0) {
      toastSeconds -= dt;
      if (toastSeconds <= 0) $("toast").classList.remove("show");
    }
    if (mode !== "playing") return;
    tipSeconds -= dt;
    $("game-tip").hidden = tipSeconds <= 0;
    player.invincible = Math.max(0, player.invincible - dt);
    player.burst = Math.max(0, player.burst - dt);
    player.cooldown = Math.max(0, player.cooldown - dt);
    player.happy = Math.max(0, player.happy - dt);
    let dx = Number(keys.has("right")) - Number(keys.has("left"));
    let dy = Number(keys.has("down")) - Number(keys.has("up"));
    for (const direction of heldPointers.values()) {
      if (direction === "right") dx++;
      if (direction === "left") dx--;
      if (direction === "down") dy++;
      if (direction === "up") dy--;
    }
    if (drag) {
      const targetX = drag.x + camera;
      const deltaX = targetX - player.x;
      const deltaY = drag.y - player.y;
      const length = Math.hypot(deltaX, deltaY);
      if (length > 8) { dx = deltaX / Math.max(length, 65); dy = deltaY / Math.max(length, 65); }
    }
    const length = Math.hypot(dx, dy);
    if (length > 1) { dx /= length; dy /= length; }
    const speed = player.burst > 0 ? 410 : 255;
    const smooth = 1 - Math.exp(-dt * 9);
    player.vx = mix(player.vx, dx * speed, smooth);
    player.vy = mix(player.vy, dy * speed, smooth);
    const playerEdge = Math.ceil(90 * playerScale);
    player.x = clamp(player.x + player.vx * dt, playerEdge, WORLD - playerEdge);
    player.y = clamp(player.y + player.vy * dt, 135, 597);
    if (Math.abs(player.vx) > 15) player.face = player.vx > 0 ? 1 : -1;
    player.tilt = mix(player.tilt, clamp(player.vy / 900, -.27, .27), smooth);
    const targetCamera = clamp(player.x - W * .36, 0, Math.max(0, WORLD - W));
    camera = mix(camera, targetCamera, 1 - Math.exp(-dt * 5));

    for (const item of collectibles) {
      if (item.taken) continue;
      item.y = item.baseY + Math.sin(time * 2 + item.phase) * 9;
      if (player.burst > 0 && distance(player, item) < 160) {
        item.x = mix(item.x, player.x, dt * 5);
        item.baseY = mix(item.baseY, player.y, dt * 5);
      }
      if (distance(player, item) < 51) collect(item);
    }
    for (const obstacle of obstacles) {
      obstacle.y = obstacle.baseY + (obstacle.type === "jelly" ? Math.sin(time * 1.6 + obstacle.phase) * (22 + levelIndex * 8) : 0);
      if (!player.invincible && !player.burst && distance(player, obstacle) < obstacle.r + 26) {
        hearts--;
        player.invincible = 2.5;
        player.vx = (player.x < obstacle.x ? -1 : 1) * 240;
        player.vy = -100;
        player.x = clamp(player.x + (player.x < obstacle.x ? -35 : 35), playerEdge, WORLD - playerEdge);
        audio.effect("bump");
        showToast(hearts === 1 ? "One little heart left. Bubble burst keeps you safe!" : "Oops, a little bump! You've got this.");
        for (let i = 0; i < 8; i++) addParticle(player.x, player.y, "bubble");
        if (hearts <= 0) { updateHUD(true); showModal("gameover"); return; }
      }
    }
    for (const secret of secrets) {
      if (!secret.found && !secret.hinted && distance(secret, player) < 175 && toastSeconds <= 0) {
        secret.hinted = true;
        showToast("That shell is sparkling... try Bubble burst!");
      }
    }
    if (player.x > GOAL - 20 && Math.abs(player.y - 345) < 150) {
      if (collected >= NEED) { completeLevel(); return; }
      if (toastSeconds <= 0) showToast(`Find ${NEED - collected} more treasures to open the arch!`);
    }
    if (player.x > WORLD - 300 && collected < NEED) {
      $("game-tip").textContent = "Swim back left to find more treasures. You can do it!";
      tipSeconds = 10000;
    }
    updateHUD();
  }

  function updateEffects(dt) {
    // Keep celebrations moving during rewards, but freeze the ocean when paused.
    if (["paused", "restart", "gameover"].includes(mode)) return;
    particles = particles.filter((p) => p.life > 0);
    for (const p of particles) {
      p.life -= dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.kind === "text") p.vy = -44;
      else p.vy += (p.kind === "bubble" ? -50 : 90) * dt;
    }
    ripples = ripples.filter((r) => r.life > 0);
    for (const ripple of ripples) ripple.life -= dt;
  }

  function ellipse(x, y, rx, ry, color, rotation = 0) {
    ctx.fillStyle = palette[color] || color;
    ctx.beginPath();
    ctx.ellipse(x, y, rx, ry, rotation, 0, TAU);
    ctx.fill();
  }
  function path(points, color, width = 1) {
    ctx.strokeStyle = palette[color] || color;
    ctx.lineWidth = width;
    ctx.lineCap = "round";
    ctx.beginPath();
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      if (i === 0) ctx.moveTo(...p);
      else if (p.length === 4) ctx.quadraticCurveTo(...p);
      else if (p.length === 6) ctx.bezierCurveTo(...p);
      else ctx.lineTo(...p);
    }
    ctx.stroke();
  }
  function star(x, y, r, color = "gold", rotation = 0) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rotation);
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const angle = i * Math.PI / 5 - Math.PI / 2;
      const radius = i % 2 ? r * .48 : r;
      const px = Math.cos(angle) * radius;
      const py = Math.sin(angle) * radius;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fillStyle = palette[color];
    ctx.fill();
    ctx.restore();
  }
  function text(label, x, y, size, color = "foam", align = "center", weight = 750) {
    ctx.font = `${weight} ${size}px "Segoe UI", Aptos, sans-serif`;
    ctx.fillStyle = palette[color];
    ctx.textAlign = align;
    ctx.fillText(label, x, y);
  }

  function drawFish(x, y, size, direction, color) {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(direction, 1);
    ellipse(0, 0, size * 1.5, size * .65, color);
    ctx.fillStyle = palette[color];
    ctx.beginPath(); ctx.moveTo(-size, 0); ctx.lineTo(-size * 2.1, -size * .7); ctx.lineTo(-size * 2.1, size * .7); ctx.fill();
    ellipse(size * .83, -size * .15, size * .13, size * .13, "ink");
    ctx.globalAlpha *= .4;
    ellipse(-size * .2, size * .1, size * .4, size * .3, "foam", -.3);
    ctx.restore();
  }

  function drawKelp(x, y, height, color, seed) {
    const sway = Math.sin(time * .8 + seed) * (reducedMotion ? 1 : 12);
    ctx.save();
    path([[x, y], [x - 10, y - height * .5, x + sway, y - height]], color, 5);
    for (let i = 1; i < 7; i++) {
      const yy = y - height * i / 7;
      const side = i % 2 ? 1 : -1;
      ellipse(x + sway * i / 7 + side * 13, yy, 24, 8, color, side * -.6);
    }
    ctx.restore();
  }
  function drawCoral(x, y, scale, color, phase) {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(scale, scale);
    const sway = Math.sin(time * .8 + phase) * (reducedMotion ? 0 : 2);
    path([[0, 0], [sway, -70], [sway - 2, -126]], color, 15);
    path([[0, -44], [-32, -62], [-36 + sway, -97]], color, 13);
    path([[-33, -72], [-58, -82], [-61, -108]], color, 9);
    path([[0, -77], [28, -87], [30 + sway, -134]], color, 11);
    path([[29, -104], [48, -110], [51, -127]], color, 8);
    path([[-3, -96], [-20, -103], [-18 + sway, -139]], color, 8);
    ctx.globalAlpha = .25;
    path([[-3, -20], [-3, -65], [-4, -111]], "foam", 3);
    ctx.restore();
  }

  function drawBackground(welcome) {
    const gradient = ctx.createLinearGradient(0, 0, 0, H);
    gradient.addColorStop(0, levelIndex === 2 && !welcome ? palette.deep : palette.top);
    gradient.addColorStop(.55, levelIndex === 1 && !welcome ? palette.deep : palette.mid);
    gradient.addColorStop(1, palette.deep);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, W, H);

    ctx.save();
    ctx.globalAlpha = reducedMotion ? .065 : .065 + Math.sin(time * .3) * .014;
    ctx.fillStyle = palette.foam;
    for (let i = 0; i < 5; i++) {
      const x = i * W * .27 + W * .14;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x + 24, 0); ctx.lineTo(x - 135, H); ctx.lineTo(x - 355, H); ctx.fill();
    }
    ctx.restore();
    ctx.save();
    ctx.globalAlpha = .12;
    for (let i = 0; i < 10; i++) {
      const x = ((i * 237 - camera * .15) % (W + 300) + W + 300) % (W + 300) - 100;
      drawKelp(x, 650, 140 + i % 4 * 38, "foam", i);
    }
    ctx.restore();
    for (const f of fish) {
      const x = ((f.x + time * f.speed * f.dir - camera * .3) % (W + 140) + W + 140) % (W + 140) - 70;
      ctx.save();
      ctx.globalAlpha = welcome ? .35 : .45;
      drawFish(x, f.y + Math.sin(time + f.x) * 8, f.size, f.dir, f.size % 2 ? "sand" : "foam");
      ctx.restore();
    }
    // Distant dunes, then two gently overlapping foreground sandbanks.
    for (let layer = 0; layer < 3; layer++) {
      ctx.save();
      ctx.globalAlpha = layer === 0 ? .13 : layer === 1 ? .35 : 1;
      ctx.fillStyle = layer === 2 ? palette.sand : palette.foam;
      const base = 625 + layer * 24;
      ctx.beginPath(); ctx.moveTo(0, H);
      for (let x = 0; x <= W + 40; x += 40) {
        ctx.lineTo(x, base + Math.sin((x + camera * (.15 + layer * .12)) / 230 + layer * 3) * 19);
      }
      ctx.lineTo(W, H); ctx.closePath(); ctx.fill();
      ctx.restore();
    }
    const offset = camera * .8;
    for (let i = -1; i < Math.ceil(W / 240) + 2; i++) {
      const worldIndex = i + Math.floor(offset / 240);
      const x = i * 240 - offset % 240;
      const y = 689 + Math.sin(worldIndex * 5) * 10;
      ctx.save();
      ctx.globalAlpha = .7;
      drawKelp(x + 100, y - 10, 95 + (Math.abs(worldIndex) % 3) * 27, "plant", worldIndex);
      ctx.restore();
      drawCoral(x, y, .65 + Math.abs(worldIndex) % 3 * .15, worldIndex % 2 ? "coral" : "rose", worldIndex);
      if (levelIndex === 1 && !welcome) {
        drawCoral(x + 135, y + 8, .48, "coral", worldIndex + 2);
        for (let j = 0; j < 3; j++) ellipse(x + 170 + j * 15, y - 16, 10, 25 + j * 6, "rose", (j - 1) * .3);
      }
      if (worldIndex % 2 === 0) {
        ellipse(x + 65, y + 6, 30, 13, "deep");
        for (let j = 0; j < 5; j++) ellipse(x + 45 + j * 10, y - 10 - j % 3 * 10, 6, 20 + j % 2 * 10, "gold", (j - 2) * .15);
      }
      ctx.save(); ctx.globalAlpha = .4;
      star(x + 170, y + 7, 12, "coral", worldIndex);
      ellipse(x + 200, y + 10, 12, 4, "foam");
      ctx.restore();
    }
    ctx.save();
    ctx.lineWidth = 1.5;
    for (const b of bubbles) {
      const yy = (b.y - time * b.speed % H + H) % H;
      const xx = b.x * W + Math.sin(time * .6 + b.y) * 12;
      ctx.globalAlpha = .2;
      ctx.strokeStyle = palette.foam;
      ctx.beginPath(); ctx.arc(xx, yy, b.r, 0, TAU); ctx.stroke();
      ctx.globalAlpha = .3;
      ellipse(xx - b.r * .3, yy - b.r * .35, b.r * .22, b.r * .14, "foam", -.5);
    }
    ctx.restore();
    if (levelIndex === 2 && !welcome) {
      ctx.save(); ctx.globalAlpha = .6;
      for (let i = 0; i < 35; i++) {
        const x = ((i * 163 - camera * .4) % (W + 20) + W + 20) % (W + 20);
        const y = 120 + i * 71 % 420;
        const r = 1 + (Math.sin(time * 2 + i) + 1) * 1.5;
        star(x, y, r, "foam", time * .1);
      }
      ctx.restore();
    }
  }

  function drawBlue(x, y, scale, face = 1, tilt = 0, happy = false, invincible = false, burst = false) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(tilt * face);
    ctx.scale(scale * face, scale);
    if (invincible) ctx.globalAlpha = .65 + Math.sin(time * 18) * .25;
    const flap = Math.sin(time * 5) * 6;
    // A round-bodied original creature with petal fins, a curl, and a pearl belly.
    ctx.save(); ctx.translate(-52, 18); ctx.rotate(Math.sin(time * 5) * .15);
    ellipse(-10, -11, 30, 14, "blue", .65);
    ellipse(-12, 10, 29, 13, "blue", -.6);
    ctx.restore();
    ellipse(-18, 53 + flap * .35, 25, 13, "blue", -.35);
    ellipse(38, 48 - flap * .4, 23, 12, "blue", .35);
    const body = ctx.createRadialGradient(14, -25, 8, 0, 4, 86);
    body.addColorStop(0, palette.top);
    body.addColorStop(.52, palette.blue);
    body.addColorStop(1, palette.deep);
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.moveTo(-61, -7);
    ctx.bezierCurveTo(-68, -43, -45, -67, -10, -64);
    ctx.bezierCurveTo(23, -78, 64, -52, 69, -15);
    ctx.bezierCurveTo(88, 34, 57, 65, 12, 65);
    ctx.bezierCurveTo(-37, 68, -70, 46, -61, -7);
    ctx.fill();
    ctx.save();
    ctx.globalAlpha *= .65;
    ellipse(9, 33, 39, 26, "top");
    ctx.restore();
    ctx.save(); ctx.rotate(-.07 + flap * .008);
    ellipse(-58, 12, 14, 30, "blue", -.65);
    ctx.globalAlpha *= .22; ellipse(-61, 8, 5, 19, "foam", -.6);
    ctx.restore();
    ellipse(65, 21, 12, 26, "blue", -.45 + flap * .015);
    // The tiny crest is deliberately unlike the movie character's silhouette.
    path([[-16, -60], [-27, -84, -8, -84], [6, -84, 0, -68]], "blue", 12);
    ctx.save(); ctx.globalAlpha *= .25;
    ellipse(-27, -43, 18, 6, "foam", -.35);
    ctx.restore();
    const blink = Math.sin(time * 1.17) > .994;
    for (const ex of [-22, 32]) {
      if (blink) {
        path([[ex - 12, -9], [ex, -15, ex + 12, -9]], "ink", 4);
      } else {
        ellipse(ex, -10, 20.5, 24.5, "foam", ex < 0 ? -.08 : .08);
        ellipse(ex + 5, -8, 12, 16, "ink");
        ellipse(ex + 7, -13, 5, 6, "foam");
        ellipse(ex + 1, -3, 2.5, 2.5, "foam");
      }
    }
    ctx.save(); ctx.globalAlpha *= .55;
    ellipse(-39, 17, 11, 6, "coral", -.15);
    ellipse(53, 17, 11, 6, "coral", .15);
    ctx.restore();
    ctx.save(); ctx.globalAlpha *= .6;
    for (const [x, y] of [[-43, 16], [-35, 18], [49, 18], [57, 16]]) {
      ellipse(x, y, 1.5, 1.5, "foam");
    }
    ctx.restore();
    if (happy || burst) {
      ellipse(8, 23, 12, 11, "ink");
      ellipse(8, 29, 8, 4, "coral");
    } else path([[-3, 22], [8, 34, 20, 21]], "ink", 3);
    ellipse(2, 7, 2.5, 2, "deep");
    ellipse(13, 7, 2.5, 2, "deep");
    if (burst) {
      ctx.save(); ctx.globalAlpha = .35;
      ctx.strokeStyle = palette.foam; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.ellipse(0, 0, 90, 85, 0, 0, TAU); ctx.stroke();
      ctx.restore();
    }
    ctx.restore();
  }

  function drawJelly(obstacle) {
    const { x, y, phase } = obstacle;
    const color = levelIndex === 2 ? "foam" : "coral";
    ctx.save();
    ctx.translate(x, y);
    ctx.globalAlpha = .8;
    for (let j = 0; j < 4; j++) {
      const xx = (j - 1.5) * 13;
      const sway = Math.sin(time * 3 + j + phase) * 9;
      path([[xx, 9], [xx + sway, 31, xx - sway, 54]], color, 3);
    }
    const grad = ctx.createLinearGradient(0, -35, 0, 20);
    grad.addColorStop(0, palette.foam);
    grad.addColorStop(.35, palette[color]);
    grad.addColorStop(1, palette.rose);
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.moveTo(-35, 10); ctx.bezierCurveTo(-40, -44, 40, -44, 35, 10); ctx.quadraticCurveTo(0, 23, -35, 10); ctx.fill();
    ellipse(-11, 0, 2.5, 3, "ink"); ellipse(11, 0, 2.5, 3, "ink");
    path([[-3, 7], [0, 10, 4, 7]], "ink", 1.6);
    ctx.globalAlpha = .45; ellipse(-11, -17, 8, 4, "foam", -.4);
    ctx.restore();
  }
  function drawRock(obstacle) {
    const { x, y } = obstacle;
    ctx.save();
    ellipse(x + 3, y + 38, 57, 12, "deep");
    const grad = ctx.createLinearGradient(x, y - 50, x + 20, y + 40);
    grad.addColorStop(0, palette.top); grad.addColorStop(1, palette.deep);
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.moveTo(x - 49, y + 30); ctx.bezierCurveTo(x - 56, y - 30, x - 14, y - 62, x + 16, y - 35); ctx.quadraticCurveTo(x + 55, y - 28, x + 52, y + 28); ctx.closePath(); ctx.fill();
    ctx.globalAlpha = .25; ellipse(x - 10, y - 28, 22, 6, "foam", -.3);
    ctx.restore();
  }
  function drawTreasure(item) {
    ctx.save();
    ctx.translate(item.x, item.y);
    const glow = ctx.createRadialGradient(0, 0, 1, 0, 0, 40);
    ctx.globalAlpha = .2 + Math.sin(time * 3 + item.phase) * .04;
    glow.addColorStop(0, palette[item.type === "pearl" ? "foam" : "gold"]);
    glow.addColorStop(1, "transparent");
    ctx.fillStyle = glow; ctx.fillRect(-40, -40, 80, 80);
    ctx.globalAlpha = 1;
    if (item.type === "star") {
      star(0, 0, 19, "gold", Math.sin(time * 2 + item.phase) * .15);
      star(-2, -3, 11, "sand", Math.sin(time * 2 + item.phase) * .15);
    } else if (item.type === "pearl") {
      const grad = ctx.createRadialGradient(-4, -5, 1, 0, 0, 15);
      grad.addColorStop(0, palette.foam); grad.addColorStop(.6, palette.foam); grad.addColorStop(1, palette.coral);
      ellipse(0, 0, 13, 13, grad);
      ellipse(-4, -5, 4, 3, "foam");
    } else {
      ctx.rotate(Math.sin(time * 2) * .05);
      ctx.fillStyle = palette.gold; ctx.beginPath(); ctx.roundRect(-20, -9, 40, 27, 4); ctx.fill();
      ctx.fillStyle = palette.sand; ctx.beginPath(); ctx.roundRect(-21, -19, 42, 18, [9, 9, 2, 2]); ctx.fill();
      path([[-12, -16], [-12, 15]], "coral", 3); path([[12, -16], [12, 15]], "coral", 3);
      ellipse(0, 0, 4, 5, "foam");
    }
    ctx.restore();
  }
  function drawShell(secret) {
    ctx.save();
    ctx.translate(secret.x, secret.y);
    if (!secret.found) {
      ctx.globalAlpha = .55 + Math.sin(time * 3) * .2;
      star(0, -34, 11, "foam", time * .3);
    }
    ctx.globalAlpha = 1;
    for (let i = 0; i < 7; i++) {
      const angle = (i - 3) * .23;
      ellipse(Math.sin(angle) * 22, -Math.cos(angle) * 12, 8, secret.found ? 30 : 18, "coral", angle);
    }
    path([[-25, 8], [0, 17, 25, 8]], "sand", 5);
    if (secret.found) ellipse(0, -14, 11, 10, "foam");
    if (!secret.found && distance(player, secret) < 200) text("Bubble burst?", 0, -62, 16, "foam");
    ctx.restore();
  }
  function drawGate() {
    ctx.save();
    ctx.translate(GOAL, 345);
    const unlocked = collected >= NEED;
    ctx.globalAlpha = unlocked ? .9 : .4;
    const colors = ["coral", "gold", "foam", "plant", "blue"];
    colors.forEach((color, i) => {
      ctx.strokeStyle = palette[color]; ctx.lineWidth = 9;
      ctx.beginPath(); ctx.ellipse(0, 0, 94 - i * 8, 144 - i * 6, 0, Math.PI, TAU);
      ctx.stroke();
    });
    for (const side of [-1, 1]) {
      ellipse(side * 89, 128, 28, 17, "sand");
      drawCoral(side * 90, 131, .6, "coral", side);
      path([[side * 94, 0], [side * 94, 120]], "sand", 12);
    }
    if (unlocked) {
      for (let i = 0; i < 9; i++) {
        const a = i / 9 * TAU + time;
        star(Math.cos(a) * 65, Math.sin(a) * 105, 4 + Math.sin(time * 3 + i) * 2, "foam");
      }
      text("This way, Blue!", 0, -182, 21, "foam");
    } else text(`${NEED - collected} more treasures`, 0, -179, 18, "foam");
    ctx.restore();
  }
  function drawEffects() {
    for (const ripple of ripples) {
      ctx.save(); ctx.globalAlpha = ripple.life / ripple.max * .65;
      ctx.lineWidth = 3; ctx.strokeStyle = palette.foam;
      ctx.beginPath(); ctx.arc(ripple.x, ripple.y, (1 - ripple.life / ripple.max) * 190 + 20, 0, TAU); ctx.stroke();
      ctx.restore();
    }
    for (const p of particles) {
      ctx.save(); ctx.globalAlpha = clamp(p.life / .6, 0, 1);
      if (p.kind === "text") text(p.text, p.x, p.y, 23, "sand", "center", 900);
      else if (p.kind === "bubble") {
        ctx.lineWidth = 1.5; ctx.strokeStyle = palette.foam;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, TAU); ctx.stroke();
      } else star(p.x, p.y, p.size, p.color, p.life * 3);
      ctx.restore();
    }
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);
    const welcome = mode === "welcome";
    drawBackground(welcome);
    if (welcome) {
      const stageWidth = $("stage").clientWidth;
      const narrow = stageWidth < 760;
      const small = stageWidth < 420;
      const x = W * (small ? .78 : narrow ? .72 : .735);
      const y = small ? 545 : narrow ? 500 : 377;
      const scale = narrow ? (small ? 1.65 : 1.75) : Math.min(2.2, W / 560);
      ctx.save(); ctx.globalAlpha = .12;
      ellipse(x, y + 147, 110, 17, "deep");
      ctx.restore();
      drawBlue(x, y + Math.sin(time * 1.6) * (reducedMotion ? 0 : 10), scale, 1, Math.sin(time) * .04, Math.sin(time * .4) > .4);
      const decorations = [[-130, -40, 15], [122, 76, 11], [88, -100, 8]];
      for (const [xx, yy, r] of decorations) {
        star(x + xx * .9, y + yy + Math.sin(time * 1.7 + xx) * 8, r, "sand", time * .1);
      }
      return;
    }
    ctx.save();
    ctx.translate(-camera, 0);
    for (const secret of secrets) if (Math.abs(secret.x - camera - W / 2) < W / 2 + 120) drawShell(secret);
    drawGate();
    for (const item of collectibles) if (!item.taken && item.x > camera - 60 && item.x < camera + W + 60) drawTreasure(item);
    for (const obstacle of obstacles) if (obstacle.x > camera - 100 && obstacle.x < camera + W + 100) {
      if (obstacle.type === "jelly") drawJelly(obstacle); else drawRock(obstacle);
    }
    if (player.burst > 0) {
      ctx.save(); ctx.globalAlpha = .16;
      drawBlue(player.x - player.vx * .08, player.y - player.vy * .08, playerScale, player.face, player.tilt, true);
      ctx.restore();
    }
    drawBlue(player.x, player.y + Math.sin(time * 2) * 2, playerScale, player.face, player.tilt, player.happy > 0, player.invincible > 0, player.burst > 0);
    drawEffects();
    ctx.restore();
    if (collected >= NEED && player.x < GOAL - W * .4) {
      const x = W - 44;
      const y = 340;
      ctx.save(); ctx.globalAlpha = .85;
      ellipse(x, y, 24, 24, "foam");
      path([[x - 10, y], [x + 10, y]], "blue", 3);
      path([[x + 3, y - 7], [x + 10, y], [x + 3, y + 7]], "blue", 3);
      ctx.restore();
    }
    // Journey line shows where Blue is, not a timer.
    ctx.save(); ctx.globalAlpha = .7;
    const mapWidth = Math.min(220, W * .25);
    const mapX = (W - mapWidth) / 2;
    path([[mapX, 691], [mapX + mapWidth, 691]], "foam", 3);
    ellipse(mapX + player.x / WORLD * mapWidth, 691, 5, 5, "gold");
    ctx.restore();
  }

  function frame(timestamp) {
    const dt = Math.min((timestamp - (lastTime || timestamp)) / 1000, .04);
    lastTime = timestamp;
    if (!["paused", "restart", "gameover"].includes(mode)) time += dt * (reducedMotion && mode === "welcome" ? .2 : 1);
    update(dt);
    updateEffects(dt);
    audio.update();
    draw();
    requestAnimationFrame(frame);
  }

  const keyDirections = {
    ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right",
    w: "up", s: "down", a: "left", d: "right",
  };
  window.addEventListener("keydown", (event) => {
    const direction = keyDirections[event.key] || keyDirections[event.key.toLowerCase()];
    const onButton = event.target instanceof Element && Boolean(event.target.closest("button"));
    if (event.key === "Tab" && !$("modal").hidden) {
      const buttons = [...$("modal").querySelectorAll("button:not(:disabled)")];
      const first = buttons[0], last = buttons[buttons.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
    if (mode === "playing" && (direction || (event.code === "Space" && !onButton))) event.preventDefault();
    if (event.repeat && ["Escape", "p", "P", " "].includes(event.key)) return;
    if (event.key === "Escape" || event.key.toLowerCase() === "p") {
      if (mode === "playing") showModal("paused");
      else if (mode === "paused" || mode === "restart") resume();
      return;
    }
    if (mode !== "playing") return;
    if (direction) keys.add(direction);
    if (event.code === "Space" && !onButton) bubbleBurst();
  });
  window.addEventListener("keyup", (event) => {
    const direction = keyDirections[event.key] || keyDirections[event.key.toLowerCase()];
    if (direction) keys.delete(direction);
  });
  window.addEventListener("blur", () => { if (mode === "playing") showModal("paused"); resetInput(); });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && mode === "playing") showModal("paused");
  });
  for (const button of document.querySelectorAll("[data-direction]")) {
    button.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      if (mode !== "playing") return;
      button.setPointerCapture(event.pointerId);
      heldPointers.set(event.pointerId, button.dataset.direction);
      button.classList.add("held");
    });
    const release = (event) => {
      heldPointers.delete(event.pointerId);
      button.classList.remove("held");
    };
    button.addEventListener("pointerup", release);
    button.addEventListener("pointercancel", release);
    button.addEventListener("lostpointercapture", release);
  }
  function pointerPosition(event) {
    const rect = canvas.getBoundingClientRect();
    return { x: (event.clientX - rect.left) / rect.width * W, y: (event.clientY - rect.top) / rect.height * H, id: event.pointerId };
  }
  canvas.addEventListener("pointerdown", (event) => {
    if (mode !== "playing") return;
    event.preventDefault();
    canvas.focus({ preventScroll: true });
    canvas.setPointerCapture(event.pointerId);
    drag = pointerPosition(event);
  });
  canvas.addEventListener("pointermove", (event) => { if (drag && drag.id === event.pointerId) drag = pointerPosition(event); });
  const releaseDrag = (event) => { if (drag && drag.id === event.pointerId) drag = null; };
  canvas.addEventListener("pointerup", releaseDrag);
  canvas.addEventListener("pointercancel", releaseDrag);
  canvas.addEventListener("lostpointercapture", releaseDrag);
  $("play").addEventListener("click", startGame);
  $("pause").addEventListener("click", () => { if (mode === "playing") showModal("paused"); });
  $("restart").addEventListener("click", () => { if (mode === "playing") showModal("restart"); });
  $("burst").addEventListener("click", bubbleBurst);
  $("sound").addEventListener("click", () => audio.toggle());
  $("modal-primary").addEventListener("click", () => {
    if (mode === "paused") resume();
    else if (mode === "level") { levelIndex++; hearts = Math.min(5, hearts + 1); loadLevel(); }
    else if (mode === "gameover") { hearts = 5; score = levelStartScore; loadLevel(); }
    else startGame();
  });
  $("modal-secondary").addEventListener("click", () => {
    if (mode === "restart") resume();
    else if (mode === "victory") {
      levelIndex = 0;
      document.querySelectorAll(".reef-stop").forEach((el, i) => {
        el.classList.toggle("active", i === 0);
        el.classList.remove("complete");
      });
      setMode("welcome");
      $("play").focus({ preventScroll: true });
    }
    else startGame();
  });
  readPalette();
  new MutationObserver(readPalette).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  new ResizeObserver(resize).observe($("stage"));
  resize();
  requestAnimationFrame(frame);
})();
