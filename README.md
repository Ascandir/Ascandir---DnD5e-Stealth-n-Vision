# Ascandir - DnD5e Stealth n Vision

Heimlichkeit mit System für Foundry VTT (getestet mit v14.368 und dnd5e 6.0.6).

## Installation

In Foundry unter **Module installieren** diese Manifest-URL eintragen:

```
https://github.com/Ascandir/Ascandir---DnD5e-Stealth-n-Vision/releases/latest/download/module.json
```

## Was das Modul macht

### Heimlichkeitswert im Rechtsklick-Menü (nur SL)
- Würfelt eine Figur **Heimlichkeit** und hat den Status **Versteckt**, steht der Wert im Token-HUD links neben dem Token.
- Wird „Versteckt“ entfernt, ist das Kästchen wieder leer.
- Wurde erst gewürfelt und danach „Versteckt“ gesetzt, zählt der Wurf, wenn er nicht älter als 5 Minuten ist (einstellbar).
- Der SL kann den Wert im Kästchen ändern. Trägt er bei einer nicht versteckten Figur einen Wert ein, wird sie versteckt.
- Darunter steht die passive Wahrnehmung (WN) des Tokens.

### Angriff aus dem Versteck
- Greift eine versteckte Figur ein Ziel an und ist ihre Heimlichkeit **höher** als die passive Wahrnehmung des Ziels, gilt der Angriff automatisch mit **Vorteil**. Im Chat steht der Grund dabei.
- Optional: Nach dem Angriff ist die Figur nicht mehr versteckt.

### Sichtkegel
- Rechtsklick auf einen Token → Knopf mit dem Auge: Sichtkegel an, Reichweite, Öffnungswinkel, Blickrichtung. Mehrere ausgewählte Token lassen sich gleich mit einstellen.
- Der Kegel hat eine eigene Blickrichtung. **Der Token selbst wird nie gedreht.** Ist ein Token noch gedreht, gibt es im Fenster einen Knopf „Token gerade stellen“.
- Nur der SL sieht die Kegel. In den Moduleinstellungen kann er sie einzelnen Spielern freigeben. Jeder kann sie mit dem Augen-Knopf in der Token-Leiste für sich ausblenden.
- Wände und geschlossene Türen blockieren den Kegel.

#### Erkennung (pro Token einstellbar)
- **Nur Gegner** (entgegengesetzte Gesinnung: feindliche Wachen achten auf freundliche Figuren und umgekehrt, neutrale auf beide) oder **alle Gesinnungen**.
- **Auch nicht versteckte Token erkennen** (an/aus).
- **Namen ignorieren:** z. B. `Wirt; Barmaid; Stallbursche` (Token- oder Actor-Name, Groß-/Kleinschreibung egal).
- Bei Erkennung: gelbes **!** über dem Wächter, der Kegel schaut zum Ziel, der SL bekommt eine geflüsterte Chatnachricht.
- Nicht versteckte Figuren werden nur beim **Hineinlaufen** gemeldet (nicht dauernd, nicht im Kampf).
- Wer versteckt war, verliert „Versteckt“.
- Optional: Spiel pausieren und Kampf-Fenster öffnen – bei entdeckten Versteckten und bei sichtbaren Gegnern (entgegengesetzte Gesinnung). Im Fenster stehen nur Spielercharaktere, NSCs und Fahrzeuge.
- Optional: Bei **jeder** Erkennung das Spiel pausieren (auch ohne Kampf-Fenster).
- Unsichtbare, für Spieler versteckte und tote Token werden nicht erkannt. Blinde, bewusstlose oder tote Wachen erkennen niemanden.

#### Zusammenspiel mit NPC Behavior Automation
- Kegel laufender NSCs drehen sich in Laufrichtung (einstellbar: aus / nur NPC-Behavior / alle).
- Bei Erkennung wird die Patrouille angehalten. In der Chatnachricht gibt es einen Knopf **Patrouille fortsetzen**. Alternativ läuft sie nach einer einstellbaren Zeit von selbst weiter.
- Tipp: Im NPC-Behavior-Fenster „In Laufrichtung drehen“ ausgeschaltet lassen, sonst dreht das NPC-Modul den Token selbst.

### Versteckt+ (nur SL)
- Knopf im Rechtsklick-Menü von Spielerfiguren (Versteckt-Symbol mit Plus).
- Für Figuren, die sich so gut verstecken (unterm Tisch, im Gebüsch), dass ein Sichtkegel sie nicht findet. Wird „Versteckt“ entfernt, verschwindet auch „Versteckt+“.

## Hinweis
Entdeckt wird beim SL, und zwar auf der Szene, die er gerade ansieht.
