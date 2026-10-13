/*
 * Ascandir - DnD5e Stealth n Vision
 *
 * 1. Heimlichkeitswurf + Status "Versteckt" → der SL sieht den Wert im Token-HUD (Rechtsklick).
 * 2. Angriff aus dem Versteck → automatisch Vorteil, wenn die Heimlichkeit über der passiven Wahrnehmung liegt.
 * 3. Sichtkegel für Token (nur SL, auf Wunsch für einzelne Spieler sichtbar). Der Kegel hat eine eigene
 *    Blickrichtung, der Token selbst wird nie gedreht. Was erkannt wird, stellt der SL pro Token ein
 *    (nur Gegner oder alle, auch Sichtbare, Namen ignorieren). Bei Erkennung: gelbes "!", Flüstern an den SL,
 *    Patrouille (NPC Behavior Automation) anhalten. Wer versteckt war, verliert "Versteckt";
 *    optional Pause + Kampf-Fenster.
 * 4. Status "Versteckt+" (Knopf im HUD, nur SL): Sichtkegel ignorieren diese Figur.
 *
 * Entdeckt wird nur beim aktiven SL-Client (auf der Szene, die er gerade ansieht).
 */

import { MID, SOCKET, HIDING, HIDING_PLUS, NPCB, setting, hasStatus, hidingImg, esc } from "./util.js";
import { registerStealthHooks, stealthHudElement, toggleHidingPlus } from "./stealth.js";
import {
  setupLayer, teardownLayer, refreshCone, refreshAllCones, queueRedraw, wallsChanged, forgetToken,
  trackMovement, facingChanged, scheduleCheck, resetDetection, onDetection, broadcastAlert, showAlert,
  coneConfig, tokenName, setFacing, facingTowards
} from "./cones.js";
import { ConeConfig, ViewerConfig, openCombatPrompt } from "./apps.js";

/* ------------------------------------------------------------------ */
/*  Einstellungen                                                      */
/* ------------------------------------------------------------------ */

Hooks.once("init", () => {
  const reg = (key, data) => game.settings.register(MID, key, { scope: "world", config: true, ...data });
  const redraw = () => queueRedraw();

  // Heimlichkeit
  reg("hudStealth", {
    name: "Heimlichkeit im Token-HUD",
    hint: "Zeigt dem SL beim Rechtsklick auf einen Token den gewürfelten Heimlichkeitswert (nur solange die Figur versteckt ist).",
    type: Boolean, default: true
  });
  reg("stealthWindow", {
    name: "Heimlichkeitswurf gilt (Minuten vor dem Verstecken)",
    hint: "Wird erst gewürfelt und dann „Versteckt“ gesetzt, zählt der Wurf nur, wenn er höchstens so alt ist. 0 = immer.",
    type: Number, default: 5, range: { min: 0, max: 60, step: 1 }
  });
  reg("attackAdvantage", {
    name: "Vorteil beim Angriff aus dem Versteck",
    hint: "Greift eine versteckte Figur an und ist ihre Heimlichkeit höher als die passive Wahrnehmung des Ziels, gilt der Angriff mit Vorteil.",
    type: Boolean, default: true
  });
  reg("revealOnAttack", {
    name: "Nach dem Angriff nicht mehr versteckt",
    hint: "Nach dem Angriffswurf wird „Versteckt“ automatisch entfernt (Regel aus dem Spielerhandbuch).",
    type: Boolean, default: false
  });

  // Sichtkegel
  reg("conesEnabled", {
    name: "Sichtkegel aktiv",
    hint: "Hauptschalter für Sichtkegel und automatisches Entdecken.",
    type: Boolean, default: true, onChange: redraw
  });
  reg("defaultRange", {
    name: "Standard-Reichweite (ft)",
    type: Number, default: 30, range: { min: 5, max: 300, step: 5 }
  });
  reg("defaultAngle", {
    name: "Standard-Öffnungswinkel (°)",
    type: Number, default: 90, range: { min: 10, max: 360, step: 5 }
  });
  reg("wallsBlock", {
    name: "Wände blockieren Sichtkegel",
    hint: "Hinter Wänden und geschlossenen Türen wird niemand entdeckt.",
    type: Boolean, default: true, onChange: redraw
  });
  reg("coneColor", {
    name: "Farbe der Sichtkegel",
    type: new foundry.data.fields.ColorField({ initial: "#f2c94c" }),
    default: "#f2c94c", onChange: redraw
  });
  reg("lookAtTarget", {
    name: "Bei Erkennung zum Ziel schauen",
    hint: "Der Sichtkegel des Wächters richtet sich auf die erkannte Figur aus (der Token selbst dreht sich nicht).",
    type: Boolean, default: true
  });
  reg("pausePatrol", {
    name: "Patrouille bei Erkennung anhalten",
    hint: "Für NSCs aus „Ascandir - DnD5e NPC Behavior Automation“. Im Chat bekommt der SL einen Knopf zum Fortsetzen.",
    type: Boolean, default: true
  });
  reg("pausePatrolSeconds", {
    name: "Patrouille anhalten für (Sekunden)",
    hint: "0 = bis der SL sie im Chat (oder im NPC-Behavior-Fenster) fortsetzt.",
    type: Number, default: 0, range: { min: 0, max: 300, step: 5 }
  });
  reg("autoTurn", {
    name: "Sichtkegel drehen sich in Laufrichtung",
    hint: "Nur der Kegel dreht sich, der Token bleibt, wie er ist. Zusammenspiel mit „Ascandir - DnD5e NPC Behavior Automation“.",
    type: String, default: "npc",
    choices: {
      off: "Aus",
      npc: "Nur NSCs mit aktivem NPC-Behavior",
      all: "Alle Token mit Sichtkegel"
    }
  });
  reg("alertDuration", {
    name: "Anzeigedauer des „!“ (Sekunden)",
    type: Number, default: 4, range: { min: 1, max: 15, step: 1 }
  });
  reg("chatNotice", {
    name: "Erkennung im Chat melden (nur SL)",
    type: Boolean, default: true
  });
  reg("autoCombat", {
    name: "Bei Entdeckung pausieren und Kampf vorbereiten",
    hint: "Nur wenn eine versteckte Figur entdeckt wird: Das Spiel wird pausiert und der SL wählt in einem Fenster aus, wer dem Kampf beitritt. Läuft in der Szene schon ein Kampf, passiert das nicht.",
    type: Boolean, default: false
  });
  game.settings.register(MID, "coneViewers", {
    scope: "world", config: false, type: Object, default: {}, onChange: redraw
  });
  game.settings.register(MID, "showCones", {
    name: "Sichtkegel anzeigen",
    hint: "Nur auf diesem Rechner. Auch über den Knopf in der Token-Leiste umschaltbar.",
    scope: "client", config: true, type: Boolean, default: true, onChange: redraw
  });
  game.settings.registerMenu(MID, "viewers", {
    name: "Sichtkegel für Spieler",
    label: "Spieler auswählen",
    hint: "Welche Spieler die Sichtkegel ebenfalls sehen dürfen.",
    icon: "fa-solid fa-users-viewfinder",
    type: ViewerConfig,
    restricted: true
  });
});

/* Eigener Status "Versteckt+" (nach dnd5e, damit dessen Statusliste schon steht) */
Hooks.once("setup", () => {
  if (CONFIG.statusEffects.some((s) => s.id === HIDING_PLUS)) return;
  CONFIG.statusEffects.push({
    id: HIDING_PLUS,
    name: "Versteckt+ (vom SL)",
    img: `modules/${MID}/icons/hiding-plus.svg`
  });
});

/* ------------------------------------------------------------------ */
/*  Erkennung                                                          */
/* ------------------------------------------------------------------ */

function combatRunningHere() {
  return game.combats?.some((c) => c.started && c.scene?.id === canvas.scene?.id) ?? false;
}

/** Läuft für diesen Token ein Verhalten aus "NPC Behavior Automation"? */
function npcApi(doc) {
  const mod = game.modules.get(NPCB);
  if (!mod?.active || !doc.getFlag(NPCB, "config")?.enabled) return null;
  return mod.api ?? null;
}

const resumeTimers = new Map();

/** Patrouille anhalten. Rückgabe: true, wenn angehalten wurde */
async function pausePatrol(doc) {
  if (!setting("pausePatrol")) return false;
  const api = npcApi(doc);
  if (!api) return false;
  const secs = Math.max(0, Number(setting("pausePatrolSeconds")) || 0);
  try {
    if (typeof api.pause === "function") {
      await api.pause(doc.id);
      clearTimeout(resumeTimers.get(doc.id));
      if (secs > 0) resumeTimers.set(doc.id, setTimeout(() => resumePatrol(doc.sceneId ?? doc.parent?.id, doc.id), secs * 1000));
    } else {
      api.brains?.get(doc.id)?.interrupt?.((secs || 600) * 1000);
    }
    return true;
  } catch (err) {
    console.warn(`${MID} | Patrouille konnte nicht angehalten werden`, err);
    return false;
  }
}

async function resumePatrol(sceneId, tokenId) {
  clearTimeout(resumeTimers.get(tokenId));
  resumeTimers.delete(tokenId);
  const doc = game.scenes.get(sceneId)?.tokens.get(tokenId);
  const api = game.modules.get(NPCB)?.api;
  if (!doc) return;
  if (typeof api?.resume === "function" && canvas.scene?.id === sceneId) await api.resume(tokenId);
  else await doc.update({ [`flags.${NPCB}.paused`]: false });
}

onDetection(async (finds) => {
  const paused = new Set();
  for (const { watcher, target, wasHidden } of finds) {
    broadcastAlert(watcher.id);
    if (setting("lookAtTarget")) {
      try { await setFacing(watcher.document, facingTowards(watcher, target)); } catch (err) { /* egal */ }
    }
    if (!paused.has(watcher.id) && await pausePatrol(watcher.document)) paused.add(watcher.id);
    if (wasHidden) {
      try {
        if (hasStatus(target.actor, HIDING)) await target.actor.toggleStatusEffect(HIDING, { active: false });
      } catch (err) {
        console.warn(`${MID} | „Versteckt“ konnte nicht entfernt werden`, err);
      }
    }
    if (setting("chatNotice")) {
      const verb = wasHidden ? "hat <strong>{t}</strong> entdeckt (war versteckt)!" : "hat <strong>{t}</strong> bemerkt.";
      const button = paused.has(watcher.id) && !(Number(setting("pausePatrolSeconds")) > 0)
        ? `<button type="button" class="asv-resume" data-scene="${canvas.scene.id}" data-token="${watcher.id}"><i class="fa-solid fa-play"></i> Patrouille fortsetzen</button>`
        : "";
      ChatMessage.create({
        content: `<div class="asv-chat"><p><i class="fa-solid fa-eye"></i> <strong>${tokenName(watcher)}</strong> ${verb.replace("{t}", tokenName(target))}</p>${paused.has(watcher.id) ? `<p class="asv-sub">Patrouille angehalten.</p>` : ""}${button}</div>`,
        whisper: ChatMessage.getWhisperRecipients("GM").map((u) => u.id),
        speaker: { alias: "Stealth n Vision" }
      });
    }
  }
  const discovered = finds.filter((f) => f.wasHidden);
  if (discovered.length && setting("autoCombat") && !combatRunningHere()) {
    if (!game.paused) game.togglePause(true, { broadcast: true });
    openCombatPrompt(discovered.map((f) => ({ watcher: f.watcher, hidden: f.target })));
  }
});

/* Knopf "Patrouille fortsetzen" in der Chatnachricht */
function wireChat(message, html) {
  const root = html instanceof HTMLElement ? html : html?.[0];
  root?.querySelectorAll?.(".asv-resume").forEach((btn) => {
    if (!game.user.isGM) return btn.remove();
    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      btn.disabled = true;
      await resumePatrol(btn.dataset.scene, btn.dataset.token);
      btn.innerHTML = `<i class="fa-solid fa-check"></i> Patrouille läuft wieder`;
    });
  });
}
Hooks.on("renderChatMessageHTML", wireChat);

/* ------------------------------------------------------------------ */
/*  Hooks                                                              */
/* ------------------------------------------------------------------ */

registerStealthHooks({
  onHidingChanged: () => scheduleCheck()
});

Hooks.once("ready", () => {
  game.socket.on(SOCKET, (data) => {
    if (data?.action === "alert" && data.sceneId === canvas.scene?.id) showAlert(data.tokenId);
  });
  game.modules.get(MID).api = {
    openCone: (tokenDoc) => new ConeConfig(tokenDoc).render(true),
    openViewers: () => new ViewerConfig().render(true),
    alert: (tokenId) => broadcastAlert(tokenId),
    check: () => scheduleCheck()
  };
  console.log(`${MID} | v${game.modules.get(MID)?.version} geladen`);
});

Hooks.on("canvasReady", () => {
  resetDetection();
  setupLayer();
  refreshAllCones();
  scheduleCheck();
});
Hooks.on("canvasTearDown", () => teardownLayer());

Hooks.on("refreshToken", (token) => {
  trackMovement(token);
  refreshCone(token);
  scheduleCheck();
});
Hooks.on("updateToken", (doc, changes) => {
  if (doc.parent !== canvas.scene) return;
  if (foundry.utils.hasProperty(changes, `flags.${MID}.facing`)) facingChanged(doc);
  if (foundry.utils.hasProperty(changes, `flags.${MID}`) || "hidden" in changes || "disposition" in changes || "name" in changes) {
    const t = doc.object;
    if (t) refreshCone(t);
    scheduleCheck();
  }
});
Hooks.on("deleteToken", (doc) => forgetToken(doc.id));
Hooks.on("sightRefresh", () => queueRedraw());

for (const hook of ["createWall", "updateWall", "deleteWall"]) Hooks.on(hook, () => wallsChanged());
Hooks.on("pauseGame", () => scheduleCheck());
Hooks.on("updateActor", () => scheduleCheck());

/* Token-HUD (Rechtsklick) – nur SL */
Hooks.on("renderTokenHUD", (hud, html) => {
  if (!game.user.isGM) return;
  const root = html instanceof HTMLElement ? html : html?.[0];
  const doc = hud.document ?? hud.object?.document;
  const actor = doc?.actor;
  if (!root || !doc) return;
  const left = root.querySelector(".col.left") ?? root.querySelector(".left");
  const right = root.querySelector(".col.right") ?? root.querySelector(".right");

  if (left && actor && setting("hudStealth") && !left.querySelector(".asv-stealth")) {
    left.append(stealthHudElement(actor));
  }

  if (right && setting("conesEnabled") && !right.querySelector(".asv-cone-btn")) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `control-icon asv-cone-btn ${coneConfig(doc) ? "active" : ""}`;
    btn.dataset.tooltip = "Sichtkegel";
    btn.innerHTML = `<i class="fa-solid fa-eye"></i>`;
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      new ConeConfig(doc).render(true);
    });
    right.append(btn);
  }

  if (right && actor?.hasPlayerOwner && !right.querySelector(".asv-hidingplus")) {
    const on = hasStatus(actor, HIDING_PLUS);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `control-icon asv-hidingplus ${on ? "active" : ""}`;
    btn.dataset.tooltip = on
      ? "Versteckt+ aktiv: Sichtkegel ignorieren diese Figur. Klick zum Aufheben."
      : "Versteckt+ (z. B. unterm Tisch, im Gebüsch): Sichtkegel ignorieren diese Figur.";
    btn.innerHTML = `<img src="${esc(hidingImg())}" alt=""><span class="asv-plus">+</span>`;
    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      await toggleHidingPlus(actor, !on);
      hud.render();
    });
    right.append(btn);
  }
});

/* Knopf in der Token-Werkzeugleiste: Sichtkegel ein/aus (für SL und freigegebene Spieler) */
Hooks.on("getSceneControlButtons", (controls) => {
  if (!game.user.isGM && !setting("coneViewers")?.[game.user.id]) return;
  const tokens = controls.tokens ?? controls.token;
  if (!tokens?.tools || Array.isArray(tokens.tools)) return;
  tokens.tools[`${MID}-cones`] = {
    name: `${MID}-cones`,
    title: "Sichtkegel anzeigen",
    icon: "fa-solid fa-eye",
    toggle: true,
    active: setting("showCones"),
    order: 95,
    onChange: (event, active) => game.settings.set(MID, "showCones", !!active)
  };
});
