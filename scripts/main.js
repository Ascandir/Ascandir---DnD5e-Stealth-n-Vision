/*
 * Ascandir - DnD5e Stealth n Vision
 *
 * 1. Heimlichkeitswurf + Status "Versteckt" → der SL sieht den Wert im Token-HUD (Rechtsklick).
 * 2. Angriff aus dem Versteck → automatisch Vorteil, wenn die Heimlichkeit über der passiven Wahrnehmung liegt.
 * 3. Sichtkegel für Token (nur SL, auf Wunsch für einzelne Spieler sichtbar). Wer versteckt hineinläuft,
 *    wird entdeckt: Status weg, gelbes "!" über dem Entdecker, optional Pause + Kampf-Fenster.
 *    Mit "NPC Behavior Automation" drehen sich die Kegel in Laufrichtung.
 * 4. Status "Versteckt+" (Knopf im HUD, nur SL): Sichtkegel ignorieren diese Figur.
 *
 * Entdeckt wird nur beim aktiven SL-Client (auf der Szene, die er gerade ansieht).
 */

import { MID, SOCKET, HIDING, HIDING_PLUS, setting, isLeader, hasStatus, hidingImg, esc } from "./util.js";
import { registerStealthHooks, stealthHudElement, toggleHidingPlus } from "./stealth.js";
import {
  setupLayer, teardownLayer, refreshCone, refreshAllCones, queueRedraw, wallsChanged, forgetToken,
  trackMovement, rotationChanged, scheduleCheck, onDetection, broadcastAlert, showAlert, coneConfig, tokenName
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
  reg("ignoreSameDisposition", {
    name: "Nur Gegner entdecken",
    hint: "Ein Sichtkegel entdeckt nur Figuren mit anderer Gesinnung (freundlich/neutral/feindlich) als sein Token.",
    type: Boolean, default: true
  });
  reg("autoTurn", {
    name: "Sichtkegel drehen sich in Laufrichtung",
    hint: "Zusammenspiel mit „Ascandir - DnD5e NPC Behavior Automation“: Kegel laufender NSCs schauen dorthin, wohin sie gehen.",
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
    name: "Entdeckung im Chat melden (nur SL)",
    type: Boolean, default: true
  });
  reg("autoCombat", {
    name: "Bei Entdeckung pausieren und Kampf vorbereiten",
    hint: "Das Spiel wird pausiert und der SL bekommt ein Fenster, in dem er auswählt, wer dem Kampf beitritt. Läuft in der Szene schon ein Kampf, passiert das nicht.",
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
/*  Entdeckung                                                         */
/* ------------------------------------------------------------------ */

function combatRunningHere() {
  return game.combats?.some((c) => c.started && c.scene?.id === canvas.scene?.id) ?? false;
}

onDetection(async (finds) => {
  for (const { watcher, hidden } of finds) {
    broadcastAlert(watcher.id);
    if (setting("chatNotice")) {
      ChatMessage.create({
        content: `<p class="asv-chat"><i class="fa-solid fa-eye"></i> <strong>${tokenName(watcher)}</strong> hat <strong>${tokenName(hidden)}</strong> entdeckt!</p>`,
        whisper: ChatMessage.getWhisperRecipients("GM").map((u) => u.id),
        speaker: { alias: "Stealth n Vision" }
      });
    }
    try {
      if (hasStatus(hidden.actor, HIDING)) await hidden.actor.toggleStatusEffect(HIDING, { active: false });
    } catch (err) {
      console.warn(`${MID} | „Versteckt“ konnte nicht entfernt werden`, err);
    }
  }
  if (setting("autoCombat") && !combatRunningHere()) {
    if (!game.paused) game.togglePause(true, { broadcast: true });
    openCombatPrompt(finds);
  }
});

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
  if ("rotation" in changes) rotationChanged(doc);
  if (foundry.utils.hasProperty(changes, `flags.${MID}`) || "hidden" in changes || "rotation" in changes) {
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
