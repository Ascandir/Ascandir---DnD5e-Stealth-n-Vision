/* Ascandir - DnD5e Stealth n Vision – gemeinsamer Kleinkram */

export const MID = "ascandir-stealth-vision";
export const SOCKET = `module.${MID}`;
/** Status "Versteckt" aus dnd5e */
export const HIDING = "hiding";
/** Eigener Status "Versteckt+" (vom SL vergeben, Sichtkegel ignorieren die Figur) */
export const HIDING_PLUS = "ascandir-hiding-plus";
/** Modul-ID von "Ascandir - DnD5e NPC Behavior Automation" */
export const NPCB = "ascandir-npc-behavior";

export const setting = (key) => game.settings.get(MID, key);
export const isLeader = () => game.user.isGM && game.users.activeGM?.id === game.user.id;
export const num = (v, d = 0) => (v !== "" && v !== null && Number.isFinite(Number(v)) ? Number(v) : d);
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const esc = (s) => foundry.utils.escapeHTML ? foundry.utils.escapeHTML(String(s ?? "")) : String(s ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export const hasStatus = (actor, id) => !!actor?.statuses?.has?.(id);

export const normDeg = (d) => ((d % 360) + 360) % 360;
/** Kleinster Winkelabstand in Grad (0–180) */
export const angDiff = (a, b) => Math.abs(((b - a + 540) % 360) - 180);
/** Winkel a ein Stück (t = 0–1) in Richtung b drehen, auf dem kürzesten Weg */
export const angleLerp = (a, b, t) => normDeg(a + ((((b - a + 540) % 360) - 180) * t));

/** Mittelpunkt eines Tokens so, wie er gerade gezeichnet wird (auch mitten in einer Bewegung) */
export function liveCenter(token) {
  return { x: token.x + token.w / 2, y: token.y + token.h / 2 };
}

/** Passive Wahrnehmung eines Actors (null, wenn er keine hat) */
export function passivePerception(actor) {
  const prc = actor?.system?.skills?.prc;
  if (!prc) return null;
  const v = Number(prc.passive ?? (10 + Number(prc.total ?? prc.mod ?? 0)));
  return Number.isFinite(v) ? v : null;
}

/** Bild des dnd5e-Status "Versteckt" */
export function hidingImg() {
  return CONFIG.statusEffects.find((s) => s.id === HIDING)?.img ?? "systems/dnd5e/icons/svg/statuses/hiding.svg";
}

/** Statuswerte, bei denen eine Wache nichts mehr entdeckt */
export const BLIND_STATUSES = ["dead", "unconscious", "incapacitated", "paralyzed", "petrified", "stunned", "sleeping", "blinded"];
