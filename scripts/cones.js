/*
 * Sichtkegel: zeichnen (SL + freigegebene Spieler), in Laufrichtung drehen,
 * Figuren im Kegel erkennen (läuft nur beim aktiven SL).
 *
 * Der Kegel hat eine eigene Blickrichtung (Flag "facing"). Der Token selbst wird nie gedreht.
 */

import {
  MID, SOCKET, HIDING, HIDING_PLUS, NPCB, BLIND_STATUSES,
  setting, isLeader, num, clamp, hasStatus, normDeg, angDiff, angleLerp, liveCenter, esc
} from "./util.js";

const state = {
  layer: null,
  gfx: new Map(),        // tokenId → PIXI.Graphics
  polys: new Map(),      // tokenId → { key, poly }
  live: new Map(),       // tokenId → { facing, target, x, y, timer }
  wallVersion: 0,
  checkQueued: false,
  redrawQueued: false,
  inside: new Set(),     // "wächterId|zielId" – wer gerade im Kegel steht
  lastFired: new Map(),  // "wächterId|zielId" → Zeitpunkt der letzten Meldung
  primed: false,         // erste Prüfung nach dem Laden meldet bereits Sichtbare nicht
  warnedPoly: false
};

let detectionHandler = null;
export function onDetection(fn) { detectionHandler = fn; }

const PIXI8 = () => String(PIXI?.VERSION ?? "").startsWith("8");

/* ------------------------------------------------------------------ */
/*  Konfiguration                                                      */
/* ------------------------------------------------------------------ */

/** Namen aus "Name1; Name2" → Liste in Kleinbuchstaben */
export function parseNames(text) {
  return String(text ?? "").split(";").map((n) => n.trim().toLowerCase()).filter(Boolean);
}

/** Sichtkegel eines Tokens, oder null wenn keiner aktiv ist */
export function coneConfig(doc) {
  const f = doc?.getFlag?.(MID, "cone");
  if (!f?.enabled) return null;
  return {
    range: Math.max(1, num(f.range, setting("defaultRange"))),
    angle: clamp(num(f.angle, setting("defaultAngle")), 5, 360),
    detect: f.detect === "all" ? "all" : "enemies",
    visible: f.visible !== false,
    ignore: parseNames(f.ignore)
  };
}

export function rawConeConfig(doc) {
  const f = doc?.getFlag?.(MID, "cone") ?? {};
  return {
    enabled: !!f.enabled,
    range: num(f.range, setting("defaultRange")),
    angle: num(f.angle, setting("defaultAngle")),
    detect: f.detect === "all" ? "all" : "enemies",
    visible: f.visible !== false,
    ignore: String(f.ignore ?? "")
  };
}

export function userSeesCones(user = game.user) {
  if (!setting("conesEnabled") || !setting("showCones")) return false;
  if (user.isGM) return true;
  return !!setting("coneViewers")?.[user.id];
}

/** Soll sich der Kegel dieses Tokens beim Laufen mitdrehen? */
function autoTurnApplies(doc) {
  const mode = setting("autoTurn");
  if (mode === "all") return true;
  if (mode === "npc") return !!game.modules.get(NPCB)?.active && !!doc.getFlag(NPCB, "config")?.enabled;
  return false;
}

/** Gespeicherte Blickrichtung des Kegels (0° = nach unten/Süden, im Uhrzeigersinn) */
export function storedFacing(doc) {
  const f = doc?.getFlag?.(MID, "facing");
  return normDeg(num(f, num(doc?.rotation)));
}

/** Aktuelle Blickrichtung (während des Laufens die mitgedrehte) */
export function facingOf(token) {
  const live = state.live.get(token.id);
  return live ? live.facing : storedFacing(token.document);
}

/** Kegel in eine Richtung schauen lassen (nur das Flag, nie die Token-Drehung) */
export async function setFacing(doc, deg) {
  const v = Math.round(normDeg(deg));
  const l = state.live.get(doc.id);
  if (l) { l.facing = v; l.target = v; }
  if (angDiff(v, storedFacing(doc)) < 1 && doc.getFlag(MID, "facing") !== undefined) return;
  await doc.update({ [`flags.${MID}.facing`]: v });
}

/** Blickrichtung von a nach b */
export function facingTowards(a, b) {
  const ca = liveCenter(a), cb = liveCenter(b);
  return normDeg(Math.toDegrees(Math.atan2(cb.y - ca.y, cb.x - ca.x)) - 90);
}

/* ------------------------------------------------------------------ */
/*  Ebene für Zeichnungen                                              */
/* ------------------------------------------------------------------ */

export function setupLayer() {
  teardownLayer();
  const parent = canvas.interface ?? canvas.stage;
  const layer = new PIXI.Container();
  layer.name = `${MID}-layer`;
  layer.eventMode = "none";
  layer.sortableChildren = true;
  parent.addChild(layer);
  state.layer = layer;
  state.wallVersion++;
}

export function teardownLayer() {
  for (const g of state.gfx.values()) g.destroy();
  state.gfx.clear();
  state.polys.clear();
  for (const l of state.live.values()) clearTimeout(l.timer);
  state.live.clear();
  if (state.layer && !state.layer.destroyed) state.layer.destroy({ children: true });
  state.layer = null;
}

export function wallsChanged() {
  state.wallVersion++;
  queueRedraw();
  scheduleCheck();
}

/* ------------------------------------------------------------------ */
/*  Kegel berechnen                                                    */
/* ------------------------------------------------------------------ */

function simpleCone(c, radius, angle, facing) {
  const pts = [];
  if (angle >= 360) {
    for (let i = 0; i < 48; i++) {
      const a = (i / 48) * Math.PI * 2;
      pts.push(c.x + Math.cos(a) * radius, c.y + Math.sin(a) * radius);
    }
    return new PIXI.Polygon(pts);
  }
  const dir = Math.toRadians(facing + 90);
  const half = Math.toRadians(angle / 2);
  const steps = Math.max(6, Math.ceil(angle / 6));
  pts.push(c.x, c.y);
  for (let i = 0; i <= steps; i++) {
    const a = dir - half + (2 * half * i) / steps;
    pts.push(c.x + Math.cos(a) * radius, c.y + Math.sin(a) * radius);
  }
  return new PIXI.Polygon(pts);
}

/** Polygon des Sichtkegels (Wände schneiden ihn ab, wenn eingestellt) */
export function conePolygon(token, cfg = coneConfig(token.document)) {
  if (!cfg || !canvas?.dimensions) return null;
  const c = liveCenter(token);
  const facing = facingOf(token);
  const radius = cfg.range * canvas.dimensions.distancePixels + Math.max(token.w, token.h) / 2;
  const walls = !!setting("wallsBlock");
  const key = [Math.round(c.x), Math.round(c.y), Math.round(facing), Math.round(radius), cfg.angle, walls, state.wallVersion].join("|");
  const cached = state.polys.get(token.id);
  if (cached?.key === key) return cached.poly;

  let poly = null;
  if (walls) {
    try {
      const backend = CONFIG.Canvas.polygonBackends?.sight ?? foundry.canvas?.geometry?.ClockwiseSweepPolygon;
      poly = backend.create(
        { x: c.x, y: c.y, elevation: num(token.document.elevation) },
        { type: "sight", radius, angle: cfg.angle, rotation: facing }
      );
      if (!poly?.points?.length) poly = null;
    } catch (err) {
      if (!state.warnedPoly) console.warn(`${MID} | Sichtkegel ohne Wandberechnung (Fallback)`, err);
      state.warnedPoly = true;
      poly = null;
    }
  }
  poly ??= simpleCone(c, radius, cfg.angle, facing);
  state.polys.set(token.id, { key, poly });
  return poly;
}

/* ------------------------------------------------------------------ */
/*  Zeichnen                                                           */
/* ------------------------------------------------------------------ */

function coneColor() {
  try { const C = foundry.utils?.Color ?? globalThis.Color; return Number(C.from(setting("coneColor") || "#f2c94c")); } catch (err) { return 0xf2c94c; }
}

function drawPoly(g, poly, color, fillAlpha, lineAlpha) {
  g.clear();
  if (PIXI8() && typeof g.poly === "function") {
    g.poly(poly.points).fill({ color, alpha: fillAlpha }).stroke({ width: 2, color, alpha: lineAlpha });
  } else {
    g.lineStyle(2, color, lineAlpha);
    g.beginFill(color, fillAlpha);
    g.drawPolygon(poly.points);
    g.endFill();
  }
}

function removeGfx(id) {
  const g = state.gfx.get(id);
  if (g) g.destroy();
  state.gfx.delete(id);
}

/** Kegel eines Tokens neu berechnen und (falls sichtbar) zeichnen */
export function refreshCone(token) {
  if (!token?.document || !state.layer) return;
  const cfg = setting("conesEnabled") ? coneConfig(token.document) : null;
  if (!cfg) {
    removeGfx(token.id);
    state.polys.delete(token.id);
    return;
  }
  const visibleHere = userSeesCones() && (game.user.isGM || token.visible);
  if (!visibleHere) {
    removeGfx(token.id);
    return;
  }
  const poly = conePolygon(token, cfg);
  if (!poly) return;
  let g = state.gfx.get(token.id);
  if (!g || g.destroyed) {
    g = new PIXI.Graphics();
    g.eventMode = "none";
    state.layer.addChild(g);
    state.gfx.set(token.id, g);
  }
  const dim = token.document.hidden ? 0.5 : 1;
  drawPoly(g, poly, coneColor(), 0.14 * dim, 0.65 * dim);
}

export function refreshAllCones() {
  if (!canvas?.ready) return;
  const ids = new Set();
  for (const t of canvas.tokens.placeables) {
    ids.add(t.id);
    refreshCone(t);
  }
  for (const id of [...state.gfx.keys()]) if (!ids.has(id)) removeGfx(id);
}

export function queueRedraw() {
  if (state.redrawQueued) return;
  state.redrawQueued = true;
  setTimeout(() => {
    state.redrawQueued = false;
    refreshAllCones();
  }, 30);
}

export function forgetToken(id) {
  removeGfx(id);
  state.polys.delete(id);
  const l = state.live.get(id);
  if (l) clearTimeout(l.timer);
  state.live.delete(id);
  for (const key of [...state.inside]) if (key.includes(id)) state.inside.delete(key);
}

/* ------------------------------------------------------------------ */
/*  In Laufrichtung drehen                                             */
/* ------------------------------------------------------------------ */

/** Bei jedem Neuzeichnen eines Tokens: hat er sich bewegt? Dann Blickrichtung nachführen. */
export function trackMovement(token) {
  const doc = token.document;
  if (!coneConfig(doc) || !autoTurnApplies(doc)) {
    if (state.live.has(token.id)) forgetLive(token.id);
    return;
  }
  const c = liveCenter(token);
  let l = state.live.get(token.id);
  if (!l) {
    const f = storedFacing(doc);
    l = { facing: f, target: f, x: c.x, y: c.y, timer: null };
    state.live.set(token.id, l);
    return;
  }
  const dx = c.x - l.x, dy = c.y - l.y;
  const d = Math.hypot(dx, dy);
  if (d < 1.5) return;
  l.x = c.x;
  l.y = c.y;
  l.target = normDeg(Math.toDegrees(Math.atan2(dy, dx)) - 90);
  // Großer Sprung (ohne Animation): sofort hindrehen, sonst weich nachdrehen
  l.facing = d > (canvas.grid?.size ?? 100) * 0.9 ? l.target : angleLerp(l.facing, l.target, 0.35);
  if (isLeader()) {
    clearTimeout(l.timer);
    l.timer = setTimeout(() => persistFacing(token.id), 700);
  }
}

function forgetLive(id) {
  const l = state.live.get(id);
  if (l) clearTimeout(l.timer);
  state.live.delete(id);
}

/** Nach dem Stehenbleiben die Blickrichtung des Kegels speichern (Token bleibt, wie er ist) */
async function persistFacing(id) {
  const l = state.live.get(id);
  const doc = canvas.scene?.tokens.get(id);
  if (!l || !doc) return;
  l.facing = l.target;
  try {
    await setFacing(doc, l.target);
  } catch (err) {
    console.warn(`${MID} | Blickrichtung speichern fehlgeschlagen`, err);
  }
}

/** Blickrichtung wurde gespeichert (vom SL oder per Dialog) → übernehmen */
export function facingChanged(doc) {
  const l = state.live.get(doc.id);
  if (!l) return;
  const r = storedFacing(doc);
  l.facing = r;
  l.target = r;
}

/* ------------------------------------------------------------------ */
/*  Erkennen                                                           */
/* ------------------------------------------------------------------ */

export function scheduleCheck() {
  if (!isLeader() || state.checkQueued) return;
  state.checkQueued = true;
  setTimeout(() => {
    state.checkQueued = false;
    try { runCheck(); } catch (err) { console.error(`${MID} | Prüfung fehlgeschlagen`, err); }
  }, 120);
}

/** Nach Szenenwechsel: wer schon im Kegel steht, wird nicht sofort gemeldet */
export function resetDetection() {
  state.inside.clear();
  state.primed = false;
}

function canDetect(token) {
  const actor = token.actor;
  if (!actor) return false;
  return !BLIND_STATUSES.some((s) => hasStatus(actor, s));
}

/** Kann dieser Token überhaupt erkannt werden? */
function detectable(token) {
  const actor = token.actor;
  if (!actor || token.document.hidden) return false;
  const defeated = CONFIG.specialStatusEffects?.DEFEATED ?? "dead";
  if (hasStatus(actor, "dead") || hasStatus(actor, defeated)) return false;
  if (hasStatus(actor, HIDING_PLUS) || hasStatus(actor, "invisible")) return false;
  return true;
}

/** Gegner aus Sicht des Wächters: freundlich ↔ feindlich, neutrale Wächter achten auf beide */
function isEnemy(watcher, target) {
  const D = CONST.TOKEN_DISPOSITIONS;
  const w = watcher.document.disposition, t = target.document.disposition;
  if (w === D.HOSTILE) return t === D.FRIENDLY;
  if (w === D.FRIENDLY) return t === D.HOSTILE;
  if (w === D.NEUTRAL) return t === D.HOSTILE || t === D.FRIENDLY;
  return false;
}

function isIgnored(cfg, target) {
  if (!cfg.ignore.length) return false;
  const names = [target.document.name, target.actor?.name].filter(Boolean).map((n) => n.trim().toLowerCase());
  return names.some((n) => cfg.ignore.includes(n));
}

function insideCone(poly, token) {
  const c = liveCenter(token);
  const ox = token.w * 0.3, oy = token.h * 0.3;
  const pts = [[c.x, c.y], [c.x - ox, c.y - oy], [c.x + ox, c.y - oy], [c.x - ox, c.y + oy], [c.x + ox, c.y + oy]];
  return pts.some(([x, y]) => poly.contains(x, y));
}

function combatRunningHere() {
  return game.combats?.some((c) => c.started && c.scene?.id === canvas.scene?.id) ?? false;
}

function runCheck() {
  if (!setting("conesEnabled") || !canvas?.ready) return;
  const tokens = canvas.tokens.placeables;
  const watchers = tokens.filter((t) => coneConfig(t.document) && canDetect(t));
  const targets = tokens.filter(detectable);
  const now = Date.now();
  const inCombat = combatRunningHere();
  const seen = new Set();
  const finds = [];

  for (const w of watchers) {
    const cfg = coneConfig(w.document);
    let poly = null;
    for (const t of targets) {
      if (t === w || t.actor === w.actor) continue;
      const hidden = hasStatus(t.actor, HIDING);
      if (!hidden && !cfg.visible) continue;
      if (cfg.detect === "enemies" && !isEnemy(w, t)) continue;
      if (isIgnored(cfg, t)) continue;
      poly ??= conePolygon(w, cfg);
      if (!poly || !insideCone(poly, t)) continue;

      const key = `${w.id}|${t.id}`;
      seen.add(key);
      const isNew = !state.inside.has(key);
      const cooled = now - (state.lastFired.get(key) ?? 0) > 10000;
      // Versteckte werden immer entdeckt; Sichtbare nur beim Hineinlaufen (nicht direkt nach dem Laden, nicht im Kampf)
      const report = hidden || (isNew && cooled && state.primed && !inCombat);
      if (report && (hidden ? cooled || isNew : true)) {
        state.lastFired.set(key, now);
        finds.push({ watcher: w, target: t, wasHidden: hidden });
      }
    }
  }
  state.inside = seen;
  state.primed = true;
  if (finds.length) detectionHandler?.(finds);
}

/* ------------------------------------------------------------------ */
/*  Gelbes "!" über dem Entdecker                                      */
/* ------------------------------------------------------------------ */

export function broadcastAlert(tokenId) {
  game.socket.emit(SOCKET, { action: "alert", sceneId: canvas.scene?.id, tokenId });
  showAlert(tokenId);
}

export function showAlert(tokenId) {
  const token = canvas.tokens?.get(tokenId);
  if (!token || !state.layer) return;
  if (!game.user.isGM && !token.visible) return;
  const size = Math.max(42, Math.round(token.h * 0.75));
  const style = {
    fontFamily: "Signika, sans-serif",
    fontSize: size,
    fontWeight: "900",
    fill: "#ffd21f",
    stroke: PIXI8() ? { color: "#1a1200", width: Math.round(size / 8) } : "#1a1200",
    strokeThickness: Math.round(size / 8),
    dropShadow: true,
    dropShadowColor: "#000000",
    dropShadowBlur: 6,
    dropShadowDistance: 2
  };
  let txt;
  try {
    txt = PIXI8() ? new PIXI.Text({ text: "!", style }) : new PIXI.Text("!", style);
  } catch (err) {
    txt = new PIXI.Text("!", style);
  }
  txt.anchor.set(0.5, 1);
  txt.zIndex = 10;
  state.layer.addChild(txt);
  const dur = Math.max(1, num(setting("alertDuration"), 4)) * 1000;
  const start = performance.now();
  const ticker = canvas.app.ticker;
  const tick = () => {
    const el = performance.now() - start;
    if (el > dur || txt.destroyed || token.destroyed) {
      ticker.remove(tick);
      if (!txt.destroyed) txt.destroy();
      return;
    }
    const c = liveCenter(token);
    const pop = el < 180 ? 0.4 + 0.6 * (el / 180) : 1;
    const hop = Math.abs(Math.sin(el / 160)) * 14 * Math.max(0, 1 - el / 1200);
    txt.scale.set(pop);
    txt.position.set(c.x, token.y - 4 - hop);
    txt.alpha = el > dur - 500 ? Math.max(0, (dur - el) / 500) : 1;
  };
  ticker.add(tick);
}

/* Für Chat-Nachrichten */
export const tokenName = (t) => esc(t?.document?.name ?? t?.name ?? "?");
