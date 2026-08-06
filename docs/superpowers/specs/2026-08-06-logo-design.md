# Logo claude-omni-rc — design

Rinomina da `ollama-rc` a `claude-omni-rc`: il wordmark pixel-font viene
sostituito da un sistema mark + wordmark. Prima non esisteva un simbolo, quindi
favicon, avatar del bot Telegram e social preview GitHub non avevano nulla da
mostrare.

## Concetto

Finestra di terminale con il caret del prompt, e onde di segnale che escono
dall'angolo alto-destro: shell + remote control, cioe' letteralmente cosa fa il
progetto. La finestra e' **a contorno** (non piena): stesso spessore di tratto
delle lettere, cosi' mark e testo leggono come un unico oggetto.

## Sistema costruttivo

Tutto deriva da una griglia modulare, codificata in `scripts/gen-logo.py`:

| grandezza | valore |
| --- | --- |
| spessore tratto | 2 |
| raggio bowl lettere / finestra | 3 |
| baseline | 16 |
| x-height | 6 |
| ascendenti | 0 |
| avanzamento cella | 12 |
| onde (raggi dall'angolo 17,8) | 4.5 e 7.5 |

Le lettere di `claude-omni-rc` sono disegnate a mano su questa griglia, non
derivate da un font: nessun vincolo di licenza e terminali tagliati a 30 gradi
coerenti tra `c`, `e` ed `r`.

Nel lockup orizzontale la baseline del testo si allinea al **fondo della
finestra** (y=23), non al fondo delle onde: e' il bordo che l'occhio usa come
riga. L'allineamento ottico a sinistra usa il bordo destro della finestra
(x=18), non l'estremita' delle onde, che sono troppo leggere per fare margine.

## Colori

| ruolo | valore | note |
| --- | --- | --- |
| ink su fondo scuro | `#f0f6fc` | invariato rispetto al wordmark precedente |
| ink su fondo chiaro | `#101014` | invariato |
| accento (solo onde) | `#4ade80` | stesso verde gia' usato in `index.html` |

Il coral di Anthropic e' stato scartato: e' il colore brand di Anthropic su un
progetto di terze parti e si leggerebbe come endorsement ufficiale.

## Asset

Generati da `python3 scripts/gen-logo.py`. I nomi dei quattro wordmark sono
quelli di prima, quindi README e `index.html` non cambiano riferimenti.

| file | uso |
| --- | --- |
| `wordmark-{light,dark}.svg` | lockup orizzontale — README, landing desktop |
| `wordmark-mobile-{light,dark}.svg` | impilato — landing sotto i 760px |
| `mark-{light,dark}.svg` | solo simbolo — avatar bot Telegram, social preview |
| `favicon.svg` | favicon; colore via `prefers-color-scheme` |

La favicon **omette la barra** dentro la finestra: a 16px si impasta col caret.
E' l'unico adattamento di optical size del sistema.

## Verifica

Il mark va controllato a 16 / 20 / 32 / 64 px su fondo chiaro e scuro. Un mark
che non regge a 16px non passa: e' la dimensione a cui viene usato piu' spesso.
