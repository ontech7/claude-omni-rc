#!/usr/bin/env python3
"""Genera gli asset del logo claude-omni-rc in assets/.

    python3 scripts/gen-logo.py

Il logo non e' un file disegnato a mano: e' costruito da questa griglia
modulare, quindi cambiare colore, spessore o spaziatura significa cambiare
una costante qui e rilanciare lo script.

Sistema costruttivo (unita' della griglia):
    tratto 2 · raggio bowl 3 · baseline 16 · x-height 6 · ascendenti 0
Mark e lettere condividono spessore e raggi: e' cio' che li fa leggere come
un unico sistema invece che "simbolo + font".
"""
import math
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "assets")

INK_DARK = "#f0f6fc"    # su fondo scuro
INK_LIGHT = "#101014"   # su fondo chiaro
ACCENT = "#4ade80"      # onde del segnale (stesso verde di index.html)

ADV = 12.0    # avanzamento cella
BASE = 16.0   # baseline
XH = 6.0      # top x-height
SW = 2.0      # spessore tratto

# punto sull'arco del bowl (centri 5,9 e 5,13, r=3) a 30 gradi: taglio dei
# terminali di c / e / r
P30X = 5 + 3 * math.cos(math.radians(30))
P30Y_T = 9 - 3 * math.sin(math.radians(30))
P30Y_B = 13 + 3 * math.sin(math.radians(30))


def p(d):
    return f'<path d="{d}"/>'


# --- alfabeto -------------------------------------------------------------
# Solo i glifi di "claude-omni-rc". Bowl a stadio: centerline x 2..8, y 6..16.
BOWL = "M2,13 V9 A3,3 0 0 1 8,9 V13 A3,3 0 0 1 2,13 Z"

GLYPHS = {
    "o": [p(BOWL)],
    "c": [p(f"M{P30X:.2f},{P30Y_T:.2f} A3,3 0 0 0 2,9 V13 A3,3 0 0 0 {P30X:.2f},{P30Y_B:.2f}")],
    "e": [p(f"M2,11 H8 V9 A3,3 0 0 0 2,9 V13 A3,3 0 0 0 {P30X:.2f},{P30Y_B:.2f}")],
    "a": [p(BOWL), p("M8,6 V16")],
    "d": [p(BOWL), p("M8,0 V16")],
    "u": [p("M2,6 V13 A3,3 0 0 0 8,13 V6"), p("M8,13 V16")],
    "n": [p("M2,16 V9 A3,3 0 0 1 8,9 V16")],
    "m": [p("M2,16 V7.5 A1.5,1.5 0 0 1 5,7.5 V16"), p("M5,7.5 A1.5,1.5 0 0 1 8,7.5 V16")],
    "i": [p("M5,6 V16"), '<circle cx="5" cy="2" r="1" stroke="none" fill="currentColor"/>'],
    "l": [p("M3.5,0 V13 A3,3 0 0 0 6.5,16 H7.5")],
    "r": [p(f"M2,16 V9 A3,3 0 0 1 {P30X:.2f},{P30Y_T:.2f}")],
    "-": [p("M2,11 H8")],
}

TEXT = "claude-omni-rc"
WORD_X0 = 1.0                              # bearing sinistro visivo
WORD_W = (len(TEXT) - 1) * ADV + 9.0 - WORD_X0
WORD_H = 18.0                              # visivo: ascendenti -1 .. baseline 17


def wordmark(ink):
    body = "".join(
        f'<g transform="translate({i * ADV:g},0)">{"".join(GLYPHS[ch])}</g>'
        for i, ch in enumerate(TEXT)
    )
    return (f'<g color="{ink}" fill="none" stroke="currentColor" stroke-width="{SW:g}" '
            f'stroke-linecap="round" stroke-linejoin="round">{body}</g>')


# --- mark -----------------------------------------------------------------
# Finestra di terminale a contorno: centerline x 1..17, y 8..22, r 3
# (visivo x 0..18, y 7..23). Le onde sono quarti di cerchio centrati
# sull'angolo alto-destro della finestra, quadrante nord-est.
WIN = dict(x=1, y=8, w=16, h=14, r=3)
CX, CY = 17.0, 8.0
WAVES = (4.5, 7.5)

CARET = "M4,12 L8.5,15 L4,18 Z"   # il prompt
BAR = "M10,18 H13"                # la riga digitata

MARK_W = CX + max(WAVES) + 1      # 25.5
MARK_H = 24.0                     # visivo 0..23


def mark(ink, accent=ACCENT, with_bar=True):
    w = WIN
    inner = (f'<rect x="{w["x"]}" y="{w["y"]}" width="{w["w"]}" height="{w["h"]}" rx="{w["r"]}"/>'
             f'<path d="{CARET}" stroke="none" fill="currentColor"/>')
    if with_bar:
        inner += p(BAR)
    waves = "".join(
        p(f"M{CX + r:g},{CY:g} A{r:g},{r:g} 0 0 0 {CX:g},{CY - r:g}") for r in WAVES
    )
    return (f'<g color="{ink}" fill="none" stroke="currentColor" stroke-width="{SW:g}" '
            f'stroke-linecap="round" stroke-linejoin="round">{inner}'
            f'<g stroke="{accent}">{waves}</g></g>')


# --- composizione ---------------------------------------------------------
GAP_H = 12.0   # mark -> wordmark, orizzontale
GAP_V = 12.0   # mark -> wordmark, impilato
PAD = 1.0

# la baseline del testo si allinea al fondo della finestra (23), non al fondo
# delle onde: e' il bordo che l'occhio usa come riga
DY = 23.0 - 17.0


def svg(vb_w, vb_h, body, scale=8):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" '
            f'viewBox="{-PAD:g} {-PAD:g} {vb_w:g} {vb_h:g}" '
            f'width="{vb_w * scale:g}" height="{vb_h * scale:g}" '
            f'role="img" aria-label="{TEXT}"><title>{TEXT}</title>{body}</svg>')


def lockup(ink):
    tx = 18.0 + GAP_H - WORD_X0   # 18 = bordo destro finestra (allineamento ottico)
    body = f'{mark(ink)}<g transform="translate({tx:g},{DY:g})">{wordmark(ink)}</g>'
    return svg(tx + WORD_X0 + WORD_W + PAD * 2, MARK_H + PAD * 2, body)


def stacked(ink):
    mx = (WORD_W - MARK_W) / 2
    body = (f'<g transform="translate({mx:g},0)">{mark(ink)}</g>'
            f'<g transform="translate({-WORD_X0:g},{MARK_H + GAP_V:g})">{wordmark(ink)}</g>')
    return svg(WORD_W + PAD * 2, MARK_H + GAP_V + WORD_H + PAD * 2, body)


def mark_only(ink):
    return svg(MARK_W + PAD * 2, MARK_H + PAD * 2, mark(ink))


def favicon():
    """A 16px la barra si impasta col caret: la variante favicon la omette.

    Il colore segue il tema del browser invece di essere fissato.
    """
    body = ('<style>:root{color:' + INK_LIGHT + '}'
            '@media(prefers-color-scheme:dark){:root{color:' + INK_DARK + '}}</style>'
            + mark("currentColor", with_bar=False))
    return svg(MARK_W + PAD * 2, MARK_H + PAD * 2, body, scale=2)


FILES = {
    "wordmark-light.svg": lambda: lockup(INK_LIGHT),
    "wordmark-dark.svg": lambda: lockup(INK_DARK),
    "wordmark-mobile-light.svg": lambda: stacked(INK_LIGHT),
    "wordmark-mobile-dark.svg": lambda: stacked(INK_DARK),
    "mark-light.svg": lambda: mark_only(INK_LIGHT),
    "mark-dark.svg": lambda: mark_only(INK_DARK),
    "favicon.svg": favicon,
}

if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else OUT
    os.makedirs(out, exist_ok=True)
    for name, build in FILES.items():
        with open(os.path.join(out, name), "w") as fh:
            fh.write(build())
        print(f"  {name}")
    print(f"{len(FILES)} file in {out}")
